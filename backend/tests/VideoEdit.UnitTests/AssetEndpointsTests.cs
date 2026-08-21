using System.Net;
using System.Security.Claims;
using System.Text.Json;
using Amazon.S3;
using Hangfire;
using Hangfire.States;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using VideoEdit.Api.Assets;
using VideoEdit.Api.Endpoints;
using VideoEdit.Contracts;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Storage;

namespace VideoEdit.UnitTests;

/// <summary>
/// AssetEndpoints upload yaşam döngüsü davranış testleri (Sqlite in-memory + sahte storage):
///  - Complete size-mismatch → obje R2'den silinir + asset Failed && soft-deleted (kota bypass fix);
///  - InitUpload kotası Failed dahil silinmemiş TÜM asset'leri sayar;
///  - idempotent complete (NoSuchUpload + obje mevcut/boyut eşit → başarı, çift enqueue yok);
///  - durum-korumalı geçişler (yarışı kaybeden Failed'a çekmez / ikinci job enqueue etmez);
///  - S3 4xx hataları (InvalidPart vb.) 422'ye haritalanır, 500'e düşmez.
/// </summary>
public sealed class AssetEndpointsTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly FakeStorage _storage = new();
    private readonly CountingJobClient _jobs = new();
    private readonly Guid _userId = Guid.CreateVersion7();

    public AssetEndpointsTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = NewContext();
        _db.Database.EnsureCreated();
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }

    private AppDbContext NewContext() =>
        new(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);

    private static ClaimsPrincipal PrincipalFor(Guid userId) =>
        new(new ClaimsIdentity([new Claim("sub", userId.ToString("D"))], "test"));

    private async Task<Asset> SeedUploadingAssetAsync(long sizeBytes = 1024, Guid? owner = null)
    {
        var asset = Asset.Create(
            owner ?? _userId, AssetKind.Video, "clip.mp4", "video/mp4", sizeBytes, DateTimeOffset.UtcNow);
        asset.UploadId = "upload-1";
        _db.Assets.Add(asset);
        await _db.SaveChangesAsync();
        return asset;
    }

    private Asset Reload(Guid assetId)
    {
        using var ctx = NewContext();
        return ctx.Assets.AsNoTracking().Single(a => a.Id == assetId);
    }

    private Task<IResult> CallCompleteAsync(Asset asset) =>
        AssetEndpoints.Complete(
            asset.Id,
            new CompleteUploadRequest([new CompletedPartDto(1, "etag-1")]),
            PrincipalFor(_userId), _db, _storage, _jobs, TimeProvider.System, CancellationToken.None);

    // ---------- Bulgu 1: size-mismatch → obje silinir + soft-delete (kota bypass fix) ----------

    [Fact]
    public async Task Complete_SizeMismatch_DeletesObjectAndSoftDeletesAsset()
    {
        var asset = await SeedUploadingAssetAsync(sizeBytes: 1024);
        _storage.HeadResult = new StorageObjectInfo(999); // beyandan farklı

        var result = await CallCompleteAsync(asset);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Contains(asset.StorageKey, _storage.DeletedObjectKeys); // obje R2'de BIRAKILMAZ

        var reloaded = Reload(asset.Id);
        Assert.Equal(AssetStatus.Failed, reloaded.Status);
        Assert.Equal("size-mismatch", reloaded.FailureReason);
        Assert.Null(reloaded.UploadId);
        Assert.NotNull(reloaded.DeletedAt); // soft-delete → kotadan düşer
        Assert.Equal(0, _jobs.EnqueueCount);
    }

    [Fact]
    public async Task Complete_HeadMissing_FailsAndSoftDeletesWithoutDeleteCall()
    {
        var asset = await SeedUploadingAssetAsync();
        _storage.HeadResult = null; // obje hiç oluşmamış

        var result = await CallCompleteAsync(asset);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Empty(_storage.DeletedObjectKeys); // silinecek obje yok

        var reloaded = Reload(asset.Id);
        Assert.Equal(AssetStatus.Failed, reloaded.Status);
        Assert.NotNull(reloaded.DeletedAt);
    }

    [Fact]
    public async Task InitUpload_QuotaCountsFailedNonDeletedAssets()
    {
        // Failed ama soft-delete edilmemiş asset (objesi R2'de duruyor olabilir) kotaya SAYILIR.
        var failed = await SeedUploadingAssetAsync(sizeBytes: 80);
        failed.Fail("probe-failed");
        failed.UploadId = null;
        await _db.SaveChangesAsync();

        var project = await SeedProjectAsync();
        var quotas = Options.Create(new QuotasOptions { MaxTotalBytesPerUser = 100 });

        var result = await AssetEndpoints.InitUpload(
            project.Id, new InitAssetUploadRequest("new.mp4", 50, "video/mp4"),
            PrincipalFor(_userId), _db, _storage, quotas, TimeProvider.System, CancellationToken.None);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status403Forbidden, problem.StatusCode); // 80 + 50 > 100
    }

    [Fact]
    public async Task InitUpload_SoftDeletedFailedAsset_DoesNotCountTowardQuota()
    {
        var failed = await SeedUploadingAssetAsync(sizeBytes: 80);
        failed.Fail("aborted");
        failed.UploadId = null;
        failed.DeletedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync();

        var project = await SeedProjectAsync();
        var quotas = Options.Create(new QuotasOptions { MaxTotalBytesPerUser = 100 });

        var result = await AssetEndpoints.InitUpload(
            project.Id, new InitAssetUploadRequest("new.mp4", 50, "video/mp4"),
            PrincipalFor(_userId), _db, _storage, quotas, TimeProvider.System, CancellationToken.None);

        Assert.IsType<Created<InitAssetUploadResponse>>(result);
    }

    // ---------- Bulgu 2: idempotent complete ----------

    [Fact]
    public async Task Complete_NoSuchUpload_ObjectExistsWithMatchingSize_ProceedsAsSuccess()
    {
        var asset = await SeedUploadingAssetAsync(sizeBytes: 1024);
        _storage.CompleteException = S3Error("NoSuchUpload", HttpStatusCode.NotFound);
        _storage.HeadResult = new StorageObjectInfo(1024); // önceki complete objeyi yazmış

        var result = await CallCompleteAsync(asset);

        var ok = Assert.IsType<Ok<CompleteUploadResponse>>(result);
        Assert.Equal("processing", ok.Value!.Status);
        Assert.Equal(1, _jobs.EnqueueCount); // asset hâlâ Uploading idi → job enqueue edilir

        var reloaded = Reload(asset.Id);
        Assert.Equal(AssetStatus.Processing, reloaded.Status);
        Assert.Null(reloaded.UploadId);
        Assert.NotNull(reloaded.ProcessingStartedAt);
    }

    [Fact]
    public async Task Complete_NoSuchUpload_ObjectMissing_Returns409()
    {
        var asset = await SeedUploadingAssetAsync();
        _storage.CompleteException = S3Error("NoSuchUpload", HttpStatusCode.NotFound);
        _storage.HeadResult = null;

        var result = await CallCompleteAsync(asset);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status409Conflict, problem.StatusCode);
        Assert.Equal(AssetStatus.Uploading, Reload(asset.Id).Status); // durum bozulmaz
        Assert.Equal(0, _jobs.EnqueueCount);
    }

    [Fact]
    public async Task Complete_NoSuchUpload_ObjectSizeMismatch_Returns409()
    {
        var asset = await SeedUploadingAssetAsync(sizeBytes: 1024);
        _storage.CompleteException = S3Error("NoSuchUpload", HttpStatusCode.NotFound);
        _storage.HeadResult = new StorageObjectInfo(555);

        var result = await CallCompleteAsync(asset);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status409Conflict, problem.StatusCode);
        Assert.Equal(0, _jobs.EnqueueCount);
    }

    [Fact]
    public async Task Complete_Success_TransitionsToProcessingAndEnqueuesOnce()
    {
        var asset = await SeedUploadingAssetAsync(sizeBytes: 1024);
        _storage.HeadResult = new StorageObjectInfo(1024);

        var result = await CallCompleteAsync(asset);

        var ok = Assert.IsType<Ok<CompleteUploadResponse>>(result);
        Assert.Equal("processing", ok.Value!.Status);
        Assert.Equal(1, _jobs.EnqueueCount);

        var reloaded = Reload(asset.Id);
        Assert.Equal(AssetStatus.Processing, reloaded.Status);
        Assert.Null(reloaded.UploadId);
        Assert.NotNull(reloaded.ProcessingStartedAt);
        Assert.Null(reloaded.DeletedAt);

        using var ctx = NewContext();
        var job = ctx.Jobs.AsNoTracking().Single(j => j.AssetId == asset.Id);
        Assert.Equal(JobType.ProcessAsset, job.Type);
        Assert.NotNull(job.HangfireJobId);
    }

    // ---------- Bulgu 3: durum-korumalı yarış guard'ları ----------

    [Fact]
    public async Task Complete_LosesRaceAfterS3Complete_ReturnsCurrentStatusWithoutSecondEnqueue()
    {
        var asset = await SeedUploadingAssetAsync(sizeBytes: 1024);
        _storage.HeadResult = new StorageObjectInfo(1024);

        // S3 complete başarılı olurken rakip istek asset'i Processing'e çekmiş olsun:
        _storage.OnCompleteMultipart = async () =>
        {
            await using var rival = NewContext();
            var a = await rival.Assets.SingleAsync(x => x.Id == asset.Id);
            a.TransitionTo(AssetStatus.Uploaded);
            a.TransitionTo(AssetStatus.Processing);
            a.UploadId = null;
            await rival.SaveChangesAsync();
        };

        var result = await CallCompleteAsync(asset);

        // Guard 0 satır döner → idempotent 200, ama İKİNCİ job enqueue EDİLMEZ.
        var ok = Assert.IsType<Ok<CompleteUploadResponse>>(result);
        Assert.Equal("processing", ok.Value!.Status);
        Assert.Equal(0, _jobs.EnqueueCount);

        using var ctx = NewContext();
        Assert.Empty(ctx.Jobs.AsNoTracking().Where(j => j.AssetId == asset.Id).ToList());
    }

    [Fact]
    public async Task Abort_ActiveUpload_SoftDeletesAndCleansStorage()
    {
        var asset = await SeedUploadingAssetAsync();

        var result = await AssetEndpoints.Abort(
            asset.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System, CancellationToken.None);

        Assert.IsType<NoContent>(result);
        Assert.Contains(("abort", asset.StorageKey), _storage.Calls);
        Assert.Contains(asset.StorageKey, _storage.DeletedObjectKeys); // yarı-kalmış obje temizliği

        var reloaded = Reload(asset.Id);
        Assert.Equal(AssetStatus.Failed, reloaded.Status);
        Assert.Equal("aborted", reloaded.FailureReason);
        Assert.Null(reloaded.UploadId);
        Assert.NotNull(reloaded.DeletedAt);
    }

    [Fact]
    public async Task Abort_AfterCompleteWonRace_DoesNotFailAssetAndDoesNotTouchObject()
    {
        var asset = await SeedUploadingAssetAsync();
        // Rakip complete kazanmış: Status artık Processing (upload aktif görünse de guard korur).
        await using (var rival = NewContext())
        {
            var a = await rival.Assets.SingleAsync(x => x.Id == asset.Id);
            a.TransitionTo(AssetStatus.Uploaded);
            a.TransitionTo(AssetStatus.Processing);
            a.UploadId = null;
            await rival.SaveChangesAsync();
        }

        var result = await AssetEndpoints.Abort(
            asset.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System, CancellationToken.None);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status409Conflict, problem.StatusCode);
        Assert.Empty(_storage.DeletedObjectKeys); // canlı objeye dokunulmaz
        Assert.Equal(AssetStatus.Processing, Reload(asset.Id).Status); // Failed'a ÇEKİLMEZ
    }

    [Fact]
    public async Task SoftDelete_UploadingAssetRacedByComplete_KeepsProcessingStatusButDeletes()
    {
        var asset = await SeedUploadingAssetAsync();
        await using (var rival = NewContext())
        {
            var a = await rival.Assets.SingleAsync(x => x.Id == asset.Id);
            a.TransitionTo(AssetStatus.Uploaded);
            a.TransitionTo(AssetStatus.Processing);
            a.UploadId = null;
            await rival.SaveChangesAsync();
        }

        var result = await AssetEndpoints.SoftDelete(
            asset.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System, CancellationToken.None);

        Assert.IsType<NoContent>(result);
        var reloaded = Reload(asset.Id);
        Assert.Equal(AssetStatus.Processing, reloaded.Status); // guard: Failed'a çekilmedi
        Assert.NotNull(reloaded.DeletedAt); // ama silme isteği yerine getirildi
    }

    [Fact]
    public async Task SoftDelete_ActiveUpload_AbortsAndSoftDeletes()
    {
        var asset = await SeedUploadingAssetAsync();

        var result = await AssetEndpoints.SoftDelete(
            asset.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System, CancellationToken.None);

        Assert.IsType<NoContent>(result);
        Assert.Contains(("abort", asset.StorageKey), _storage.Calls);
        var reloaded = Reload(asset.Id);
        Assert.Equal(AssetStatus.Failed, reloaded.Status);
        Assert.NotNull(reloaded.DeletedAt);
    }

    // ---------- Bulgu 4: S3 hata haritalama ----------

    [Fact]
    public async Task Complete_InvalidPart_Returns422NotServerError()
    {
        var asset = await SeedUploadingAssetAsync();
        _storage.CompleteException = S3Error("InvalidPart", HttpStatusCode.BadRequest);

        var result = await CallCompleteAsync(asset);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal(AssetStatus.Uploading, Reload(asset.Id).Status); // upload aktif kalır → retry
        Assert.Equal(0, _jobs.EnqueueCount);
    }

    [Fact]
    public async Task Complete_InvalidPartOrder_Returns422()
    {
        var asset = await SeedUploadingAssetAsync();
        _storage.CompleteException = S3Error("InvalidPartOrder", HttpStatusCode.BadRequest);

        var result = await CallCompleteAsync(asset);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
    }

    [Fact]
    public async Task Complete_OtherS3ClientError_MapsTo422()
    {
        var asset = await SeedUploadingAssetAsync();
        _storage.CompleteException = S3Error("EntityTooSmall", HttpStatusCode.BadRequest);

        var result = await CallCompleteAsync(asset);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
    }

    [Fact]
    public async Task Complete_S3ServerError_PropagatesToGlobalHandler()
    {
        var asset = await SeedUploadingAssetAsync();
        _storage.CompleteException = S3Error("InternalError", HttpStatusCode.InternalServerError);

        await Assert.ThrowsAsync<AmazonS3Exception>(() => CallCompleteAsync(asset));
    }

    // ---------- M2 (savunma derinliği): media-urls / list sahiplik filtresi ----------
    // Değişmez "ProjectAssets asla cross-user satır içermez" tek noktadan (InitUpload)
    // korunur; bu testler o değişmez delinse bile sorgunun cross-user satırı ELEDİĞİNİ
    // sabitler. Filtre kaldırılırsa (a.OwnerId == userId düşerse) ikisi de KIRMIZI döner.

    [Fact]
    public async Task MediaUrls_OmitsCrossUserAssetEvenWhenLinkedToOwnProject()
    {
        var project = await SeedProjectAsync();
        var mine = await SeedReadyAssetAsync(_userId);
        var foreign = await SeedReadyAssetAsync(Guid.CreateVersion7()); // başka kullanıcı
        await LinkAssetAsync(project.Id, mine.Id);
        await LinkAssetAsync(project.Id, foreign.Id); // değişmezi kasten del

        var result = await AssetEndpoints.MediaUrls(
            project.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System, CancellationToken.None);

        var ok = Assert.IsType<Ok<MediaUrlsResponse>>(result);
        var keys = ok.Value!.Assets.Keys;
        Assert.Contains(mine.Id.ToString("D"), keys);
        Assert.DoesNotContain(foreign.Id.ToString("D"), keys); // sızıntı yok
    }

    [Fact]
    public async Task MediaUrls_ReturnsAllOwnReadyAssets_NoFalseReject()
    {
        var project = await SeedProjectAsync();
        var a = await SeedReadyAssetAsync(_userId);
        var b = await SeedReadyAssetAsync(_userId);
        await LinkAssetAsync(project.Id, a.Id);
        await LinkAssetAsync(project.Id, b.Id);

        var result = await AssetEndpoints.MediaUrls(
            project.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System, CancellationToken.None);

        var ok = Assert.IsType<Ok<MediaUrlsResponse>>(result);
        Assert.Equal(2, ok.Value!.Assets.Count);
        Assert.Contains(a.Id.ToString("D"), ok.Value.Assets.Keys);
        Assert.Contains(b.Id.ToString("D"), ok.Value.Assets.Keys);
    }

    // Not: asset ListForProject'in sahiplik filtresi de aynı turda eklendi ama birim testi
    // BURADA yok — sorgu AddedAt (DateTimeOffset) ile sıralıyor ve Sqlite test provider'ı bu
    // sıralamayı çeviremiyor (aynı sınır ExportEndpoints.ListForProject'te Id'ye geçilerek
    // aşılmıştı). O düzeltme canlı Postgres'te ham API ile ölçüldü (cross-user satır enjekte →
    // /assets yanıtında görünmüyor).

    // ---------- Yardımcılar ----------

    private async Task<Asset> SeedReadyAssetAsync(Guid owner)
    {
        var asset = Asset.Create(
            owner, AssetKind.Video, "clip.mp4", "video/mp4", 1024, DateTimeOffset.UtcNow);
        asset.Status = AssetStatus.Ready;
        _db.Assets.Add(asset);
        await _db.SaveChangesAsync();
        return asset;
    }

    private async Task LinkAssetAsync(Guid projectId, Guid assetId)
    {
        _db.ProjectAssets.Add(new ProjectAsset
        {
            ProjectId = projectId, AssetId = assetId, AddedAt = DateTimeOffset.UtcNow,
        });
        await _db.SaveChangesAsync();
    }

    private async Task<Project> SeedProjectAsync()
    {
        var project = new Project
        {
            Id = Guid.CreateVersion7(),
            OwnerId = _userId,
            Name = "test",
            Timeline = JsonDocument.Parse("{}"),
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        _db.Projects.Add(project);
        await _db.SaveChangesAsync();
        return project;
    }

    private static AmazonS3Exception S3Error(string errorCode, HttpStatusCode statusCode) =>
        new($"fake {errorCode}") { ErrorCode = errorCode, StatusCode = statusCode };

    /// <summary>IStorageService sahtesi — davranışı test başına ayarlanır, çağrılar kaydedilir.</summary>
    private sealed class FakeStorage : IStorageService
    {
        public StorageObjectInfo? HeadResult { get; set; }
        public AmazonS3Exception? CompleteException { get; set; }
        public Func<Task>? OnCompleteMultipart { get; set; }
        public List<string> DeletedObjectKeys { get; } = [];
        public List<(string Op, string Key)> Calls { get; } = [];

        public Task<string> CreateMultipartUploadAsync(string key, string contentType, CancellationToken ct = default)
        {
            Calls.Add(("create", key));
            return Task.FromResult("upload-fake");
        }

        public string PresignUploadPart(string key, string uploadId, int partNumber) =>
            $"https://fake/{key}?part={partNumber}";

        public async Task CompleteMultipartUploadAsync(
            string key, string uploadId, IReadOnlyList<StorageCompletedPart> parts, CancellationToken ct = default)
        {
            Calls.Add(("complete", key));
            if (OnCompleteMultipart is not null)
            {
                await OnCompleteMultipart();
            }

            if (CompleteException is not null)
            {
                throw CompleteException;
            }
        }

        public Task AbortMultipartUploadAsync(string key, string uploadId, CancellationToken ct = default)
        {
            Calls.Add(("abort", key));
            return Task.CompletedTask;
        }

        public Task<IReadOnlyList<StorageUploadedPart>> ListPartsAsync(
            string key, string uploadId, CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<StorageUploadedPart>>([]);

        public Task<StorageObjectInfo?> HeadObjectAsync(string key, CancellationToken ct = default)
        {
            Calls.Add(("head", key));
            return Task.FromResult(HeadResult);
        }

        public string PresignGet(string key) => $"https://fake/{key}?sig=get";

        public Task DeletePrefixAsync(string prefix, CancellationToken ct = default)
        {
            Calls.Add(("delete-prefix", prefix));
            return Task.CompletedTask;
        }

        public Task DeleteObjectAsync(string key, CancellationToken ct = default)
        {
            Calls.Add(("delete-object", key));
            DeletedObjectKeys.Add(key);
            return Task.CompletedTask;
        }

        public Task<StorageDownload> OpenReadAsync(string key, CancellationToken ct = default) =>
            throw new AmazonS3Exception("not found") { StatusCode = HttpStatusCode.NotFound };

        public Task UploadFileAsync(string key, string filePath, string contentType, CancellationToken ct = default) =>
            Task.CompletedTask;

        public Task UploadExportAsync(string key, string filePath, string contentType, CancellationToken ct = default)
        {
            Calls.Add(("upload-export", key));
            return Task.CompletedTask;
        }

        public string PresignExportGet(string key) => $"https://fake-exports/{key}?sig=get";

        public Task EnsureBucketsExistAsync(CancellationToken ct = default) => Task.CompletedTask;
    }

    /// <summary>Enqueue çağrılarını sayan Hangfire istemcisi (çift-enqueue regresyonunu yakalar).</summary>
    private sealed class CountingJobClient : IBackgroundJobClient
    {
        public int EnqueueCount { get; private set; }

        public string Create(Hangfire.Common.Job job, IState state)
        {
            EnqueueCount++;
            return Guid.NewGuid().ToString("N");
        }

        public bool ChangeState(string jobId, IState state, string expectedState) => true;
    }
}
