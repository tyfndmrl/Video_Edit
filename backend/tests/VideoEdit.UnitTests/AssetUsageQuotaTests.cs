using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using VideoEdit.Api.Assets;
using VideoEdit.Api.Endpoints;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;

namespace VideoEdit.UnitTests;

/// <summary>
/// M6 — asset silme UX'inin sunucu tarafı: kullanım kontrolü (GET /api/assets/{id}/usage)
/// ve kota özeti (GET /api/quota).
///
/// Kritik davranışlar:
///  - kullanım sayımı KLİP bazındadır (aynı asset'ten 3 klip = 3), proje bazında gruplanır;
///  - başkasının asset'i 404 (hangi projelerde kullanıldığı sızmaz);
///  - başkasının/silinmiş projesi taranmaz;
///  - bozuk/eksik timeline dokümanı sayımı patlatmaz (silme onayı 500 vermez);
///  - kota özeti InitUpload'ın kota tanımıyla aynıdır (Failed dahil, soft-delete hariç).
/// </summary>
public sealed class AssetUsageQuotaTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly Guid _userId = Guid.CreateVersion7();
    private readonly Guid _otherUserId = Guid.CreateVersion7();

    public AssetUsageQuotaTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }

    private static ClaimsPrincipal PrincipalFor(Guid userId) =>
        new(new ClaimsIdentity([new Claim("sub", userId.ToString("D"))], "test"));

    // ---------- usage ----------

    [Fact]
    public async Task Usage_CountsClipsPerProject_AndSkipsProjectsWithoutTheAsset()
    {
        var asset = await SeedAssetAsync();
        var other = await SeedAssetAsync(fileName: "other.mp4");

        var a = await SeedProjectAsync("A projesi", TimelineWith(
            [[asset.Id, asset.Id], [asset.Id]])); // iki track: 2 + 1 klip
        var b = await SeedProjectAsync("B projesi", TimelineWith([[asset.Id]]));
        await SeedProjectAsync("C projesi", TimelineWith([[other.Id]])); // başka asset

        var result = await AssetEndpoints.Usage(
            asset.Id, PrincipalFor(_userId), _db, CancellationToken.None);

        var ok = Assert.IsType<Ok<AssetUsageResponse>>(result);
        var projects = ok.Value!.Projects;
        Assert.Equal(2, projects.Count);
        Assert.Equal([a.Id, b.Id], projects.Select(p => p.Id).ToArray()); // ada göre sıralı
        Assert.Equal(3, projects[0].ClipCount);
        Assert.Equal("A projesi", projects[0].Name);
        Assert.Equal(1, projects[1].ClipCount);
    }

    [Fact]
    public async Task Usage_UnusedAsset_ReturnsEmptyList()
    {
        var asset = await SeedAssetAsync();
        await SeedProjectAsync("Boş proje", TimelineWith([[]]));

        var result = await AssetEndpoints.Usage(
            asset.Id, PrincipalFor(_userId), _db, CancellationToken.None);

        var ok = Assert.IsType<Ok<AssetUsageResponse>>(result);
        Assert.Empty(ok.Value!.Projects);
    }

    [Fact]
    public async Task Usage_StickerClipsCount_TooAndIgnoresClipsWithoutAssetId()
    {
        var asset = await SeedAssetAsync(kind: AssetKind.Image, fileName: "logo.png");
        // Aynı doküman: 1 sticker (assetId taşır) + 1 metin klibi (assetId YOK).
        var timeline = JsonDocument.Parse($$"""
        {
          "schemaVersion": 1,
          "tracks": [
            { "id": "t1", "clips": [
              { "id": "c1", "kind": "sticker", "assetId": "{{asset.Id:D}}" },
              { "id": "c2", "kind": "text", "text": { "content": "merhaba" } }
            ] }
          ]
        }
        """);
        var project = await SeedProjectAsync("Sticker projesi", timeline);

        var result = await AssetEndpoints.Usage(
            asset.Id, PrincipalFor(_userId), _db, CancellationToken.None);

        var ok = Assert.IsType<Ok<AssetUsageResponse>>(result);
        var usage = Assert.Single(ok.Value!.Projects);
        Assert.Equal(project.Id, usage.Id);
        Assert.Equal(1, usage.ClipCount);
    }

    [Fact]
    public async Task Usage_OtherUsersAsset_Returns404()
    {
        var asset = await SeedAssetAsync(owner: _otherUserId);
        await SeedProjectAsync("Kurbanın projesi", TimelineWith([[asset.Id]]), owner: _otherUserId);

        var result = await AssetEndpoints.Usage(
            asset.Id, PrincipalFor(_userId), _db, CancellationToken.None);

        Assert.IsType<NotFound>(result);
    }

    [Fact]
    public async Task Usage_IgnoresOtherUsersAndDeletedProjects()
    {
        var asset = await SeedAssetAsync();
        await SeedProjectAsync("Başkasının projesi", TimelineWith([[asset.Id]]), owner: _otherUserId);
        await SeedProjectAsync("Silinmiş proje", TimelineWith([[asset.Id]]), deleted: true);
        var live = await SeedProjectAsync("Yaşayan proje", TimelineWith([[asset.Id]]));

        var result = await AssetEndpoints.Usage(
            asset.Id, PrincipalFor(_userId), _db, CancellationToken.None);

        var ok = Assert.IsType<Ok<AssetUsageResponse>>(result);
        var usage = Assert.Single(ok.Value!.Projects);
        Assert.Equal(live.Id, usage.Id);
    }

    /// <summary>
    /// Silme onayı, bozuk bir dokümanda 500 vermek yerine "kullanılmıyor" demeli:
    /// ham JSON gezintisi tanımadığı şekilleri atlar.
    /// </summary>
    [Theory]
    [InlineData("{}")]
    [InlineData("""{ "tracks": null }""")]
    [InlineData("""{ "tracks": [ { "clips": "bozuk" } ] }""")]
    [InlineData("""{ "tracks": [ { "clips": [ { "assetId": 42 }, { "assetId": "not-a-guid" }, null ] } ] }""")]
    [InlineData("[1,2,3]")]
    public void CountAssetClips_MalformedDocument_ReturnsZeroWithoutThrowing(string json)
    {
        using var doc = JsonDocument.Parse(json);
        Assert.Equal(0, AssetEndpoints.CountAssetClips(doc, Guid.CreateVersion7()));
    }

    // ---------- quota ----------

    [Fact]
    public async Task QuotaSummary_SumsNonDeletedAssets_IncludingFailed()
    {
        await SeedAssetAsync(sizeBytes: 100);
        var failed = await SeedAssetAsync(sizeBytes: 30, fileName: "failed.mp4");
        failed.Fail("probe-failed");
        var softDeleted = await SeedAssetAsync(sizeBytes: 500, fileName: "gone.mp4");
        softDeleted.DeletedAt = DateTimeOffset.UtcNow;
        await SeedAssetAsync(sizeBytes: 999, fileName: "other-user.mp4", owner: _otherUserId);
        await _db.SaveChangesAsync();

        var result = await AssetEndpoints.QuotaSummary(
            PrincipalFor(_userId), _db,
            Options.Create(new QuotasOptions { MaxTotalBytesPerUser = 1000, MaxConcurrentUploads = 3 }),
            CancellationToken.None);

        var ok = Assert.IsType<Ok<QuotaSummaryResponse>>(result);
        Assert.Equal(130, ok.Value!.UsedBytes); // 100 + 30 (Failed dahil), soft-delete hariç
        Assert.Equal(2, ok.Value.AssetCount);
        Assert.Equal(1000, ok.Value.MaxBytes);
        Assert.Equal(3, ok.Value.MaxConcurrentUploads);
    }

    [Fact]
    public async Task QuotaSummary_NoAssets_ReturnsZeroUsage()
    {
        var result = await AssetEndpoints.QuotaSummary(
            PrincipalFor(_userId), _db, Options.Create(new QuotasOptions()),
            CancellationToken.None);

        var ok = Assert.IsType<Ok<QuotaSummaryResponse>>(result);
        Assert.Equal(0, ok.Value!.UsedBytes);
        Assert.Equal(0, ok.Value.AssetCount);
    }

    /// <summary>
    /// Gösterge ile ret aynı sayıyı konuşmalı: kota özeti "dolu" derken InitUpload'ın
    /// kabul etmesi (ya da tersi) kullanıcı için yalandır.
    /// </summary>
    [Fact]
    public async Task QuotaSummary_MatchesInitUploadRejectionBoundary()
    {
        await SeedAssetAsync(sizeBytes: 80);
        var quotas = Options.Create(new QuotasOptions { MaxTotalBytesPerUser = 100 });
        var project = await SeedProjectAsync("Kota", TimelineWith([[]]));

        var summary = Assert.IsType<Ok<QuotaSummaryResponse>>(await AssetEndpoints.QuotaSummary(
            PrincipalFor(_userId), _db, quotas, CancellationToken.None));
        var remaining = summary.Value!.MaxBytes - summary.Value.UsedBytes;
        Assert.Equal(20, remaining);

        // Kalan alan kadar dosya geçer, 1 bayt fazlası geçmez.
        var rejected = await AssetEndpoints.InitUpload(
            project.Id, new VideoEdit.Contracts.InitAssetUploadRequest("big.mp4", remaining + 1, "video/mp4"),
            PrincipalFor(_userId), _db, new NoopStorage(), quotas, TimeProvider.System,
            CancellationToken.None);
        Assert.Equal(StatusCodes.Status403Forbidden, Assert.IsType<ProblemHttpResult>(rejected).StatusCode);
    }

    // ---------- yardımcılar ----------

    private async Task<Asset> SeedAssetAsync(
        long sizeBytes = 1024, string fileName = "clip.mp4", AssetKind kind = AssetKind.Video,
        Guid? owner = null)
    {
        var asset = Asset.Create(
            owner ?? _userId, kind, fileName, "video/mp4", sizeBytes, DateTimeOffset.UtcNow);
        _db.Assets.Add(asset);
        await _db.SaveChangesAsync();
        return asset;
    }

    private async Task<Project> SeedProjectAsync(
        string name, JsonDocument timeline, Guid? owner = null, bool deleted = false)
    {
        var project = new Project
        {
            Id = Guid.CreateVersion7(),
            OwnerId = owner ?? _userId,
            Name = name,
            Timeline = timeline,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
            DeletedAt = deleted ? DateTimeOffset.UtcNow : null,
        };
        _db.Projects.Add(project);
        await _db.SaveChangesAsync();
        return project;
    }

    /// <summary>Track başına klip assetId listesi -> minimal ama şema-şekilli timeline.</summary>
    private static JsonDocument TimelineWith(Guid[][] tracks)
    {
        var trackJson = tracks.Select((clips, ti) =>
        {
            var clipJson = clips.Select((assetId, ci) =>
                $$"""{ "id": "clip-{{ti}}-{{ci}}", "kind": "video", "assetId": "{{assetId:D}}" }""");
            return $$"""{ "id": "track-{{ti}}", "type": "video", "clips": [{{string.Join(",", clipJson)}}] }""";
        });
        return JsonDocument.Parse(
            $$"""{ "schemaVersion": 1, "tracks": [{{string.Join(",", trackJson)}}], "markers": [] }""");
    }

    /// <summary>InitUpload kota sınırı testi için: kota reddi S3'e HİÇ dokunmadan olmalı.</summary>
    private sealed class NoopStorage : VideoEdit.Infrastructure.Storage.IStorageService
    {
        public Task<string> CreateMultipartUploadAsync(string key, string contentType, CancellationToken ct = default) =>
            throw new InvalidOperationException("Kota reddi S3'e dokunmamalı.");

        public string PresignUploadPart(string key, string uploadId, int partNumber) => "";

        public Task CompleteMultipartUploadAsync(
            string key, string uploadId,
            IReadOnlyList<VideoEdit.Infrastructure.Storage.StorageCompletedPart> parts,
            CancellationToken ct = default) => Task.CompletedTask;

        public Task AbortMultipartUploadAsync(string key, string uploadId, CancellationToken ct = default) =>
            Task.CompletedTask;

        public Task<IReadOnlyList<VideoEdit.Infrastructure.Storage.StorageUploadedPart>> ListPartsAsync(
            string key, string uploadId, CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<VideoEdit.Infrastructure.Storage.StorageUploadedPart>>([]);

        public Task<VideoEdit.Infrastructure.Storage.StorageObjectInfo?> HeadObjectAsync(
            string key, CancellationToken ct = default) =>
            Task.FromResult<VideoEdit.Infrastructure.Storage.StorageObjectInfo?>(null);

        public string PresignGet(string key) => "";

        public Task DeletePrefixAsync(string prefix, CancellationToken ct = default) => Task.CompletedTask;

        public Task DeleteObjectAsync(string key, CancellationToken ct = default) => Task.CompletedTask;

        public Task<VideoEdit.Infrastructure.Storage.StorageDownload> OpenReadAsync(
            string key, CancellationToken ct = default) => throw new NotSupportedException();

        public Task UploadFileAsync(string key, string filePath, string contentType, CancellationToken ct = default) =>
            Task.CompletedTask;

        public Task UploadExportAsync(string key, string filePath, string contentType, CancellationToken ct = default) =>
            Task.CompletedTask;

        public string PresignExportGet(string key) => "";

        public Task EnsureBucketsExistAsync(CancellationToken ct = default) => Task.CompletedTask;
    }
}
