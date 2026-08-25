using System.Reflection;
using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using Hangfire;
using Hangfire.States;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Routing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using VideoEdit.Api.Assets;
using VideoEdit.Api.Endpoints;
using VideoEdit.Contracts;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Domain.Services;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Storage;
using VideoEdit.Media.Text;

namespace VideoEdit.UnitTests;

/// <summary>
/// IDOR REGRESYON PAKETİ — tek dosyada TAM sahiplik matrisi (M1 denetiminden beri açık borç).
/// <para>
/// Kurgu: kurban A her kaynak türünden birine sahiptir (proje, revizyon, hazır asset,
/// aktif upload, export işi); saldırgan B, A'nın id'lerini BİLİR (id'ler gizli değildir —
/// UUIDv7 loglara/URL'lere sızabilir) ve her kimlik-doğrulamalı ucu A'nın id'siyle çağırır.
/// Beklenti mevcut ürün desenidir: sahiplik ihlali 404 NotFound (403 DEĞİL — kaynağın
/// VARLIĞI da sızdırılmaz; bkz. FindOwnedAsync/OwnsProjectAsync/RequestedBy filtreleri)
/// ve kurbanın durumu DEĞİŞMEZ (rename/delete/timeline/cancel yazmaz, job/revizyon satırı
/// doğmaz).
/// </para>
/// <para>
/// Depo sahtesi (<see cref="TrappedStorage"/>) HER çağrıda fırlatır: sahiplik reddi S3'e
/// hiç dokunmamalı — test yeşilse presign/complete/abort çağrısı YAPILMADIĞI da kanıtlanmıştır
/// (imzalı URL sızıntısının tek kaynağı presign'dır). Kuyruk sahtesi de sayar: reddedilen
/// istek Hangfire'a iş sokamaz.
/// </para>
/// <para>
/// Bu matrisin uç envanteriyle EŞLEŞTİĞİ el yazısı listeye değil MEKANİK kaynağa bağlıdır:
/// <see cref="CrossUserEndpointInventoryTests"/> rota tablosunu gerçek Map*Endpoints
/// metotlarını koşturarak kurar ve buradaki test adlarıyla defter üzerinden karşılaştırır —
/// yeni bir kimlik-doğrulamalı uç buraya test eklemeden YEŞİL KALAMAZ.
/// </para>
/// </summary>
public sealed class CrossUserAccessTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly Guid _victimId = Guid.CreateVersion7();   // A — kaynakların sahibi
    private readonly Guid _attackerId = Guid.CreateVersion7(); // B — id'leri bilen ama sahibi olmayan
    private readonly CountingJobClient _jobs = new();
    private readonly TrappedStorage _storage = new();
    private static readonly FontManifestProvider Fonts = new();

    public CrossUserAccessTests()
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

    private ClaimsPrincipal Attacker => PrincipalFor(_attackerId);

    // ---------- Projeler ----------

    [Fact]
    public async Task Project_GetById_ForeignProject_Returns404()
    {
        var project = await SeedVictimProjectAsync();

        var result = await ProjectEndpoints.GetById(project.Id, Attacker, _db, CancellationToken.None);

        // Yalın NotFound (gövdesiz): ne timeline ne ad — kaynağın varlığı bile teyit edilmez.
        Assert.IsType<NotFound>(result);
    }

    [Fact]
    public async Task Project_Rename_ForeignProject_Returns404_AndNameUnchanged()
    {
        var project = await SeedVictimProjectAsync(name: "Kurbanın projesi");

        var result = await ProjectEndpoints.Rename(
            project.Id, new UpdateProjectRequest("ele geçirildi"), Attacker, _db,
            TimeProvider.System, CancellationToken.None);

        Assert.IsType<NotFound>(result);
        Assert.Equal("Kurbanın projesi",
            _db.Projects.AsNoTracking().Single(p => p.Id == project.Id).Name);
    }

    [Fact]
    public async Task Project_Delete_ForeignProject_Returns404_AndProjectStillAlive()
    {
        var project = await SeedVictimProjectAsync();

        var result = await ProjectEndpoints.SoftDelete(
            project.Id, Attacker, _db, TimeProvider.System, CancellationToken.None);

        Assert.IsType<NotFound>(result);
        Assert.Null(_db.Projects.AsNoTracking().Single(p => p.Id == project.Id).DeletedAt);
    }

    [Fact]
    public async Task Project_SaveTimeline_ForeignProject_Returns404_AndTimelineUnchanged()
    {
        var project = await SeedVictimProjectAsync();
        var originalTimeline = _db.Projects.AsNoTracking()
            .Single(p => p.Id == project.Id).Timeline.RootElement.GetRawText();

        // EN TEHLİKELİ girdi: yüzeysel doğrulamayı GEÇEN (schemaVersion/projectId/tracks doğru)
        // ve baseRevision'ı kurbanın GERÇEK revizyonuna eşit istek — sahiplik filtresi olmasaydı
        // bu istek yazardı. 404, reddin doğrulamadan değil sahiplikten geldiğini kanıtlar.
        using var forged = JsonDocument.Parse($$"""
        {
          "schemaVersion": 1,
          "projectId": "{{project.Id:D}}",
          "tracks": [ { "id": "hijack", "type": "video", "clips": [] } ]
        }
        """);
        var result = await ProjectEndpoints.SaveTimeline(
            project.Id,
            new SaveTimelineRequest(project.RevisionNumber, forged.RootElement.Clone()),
            Attacker, _db, new SnapshotPolicy(), TimeProvider.System, CancellationToken.None);

        // 409 Conflict dalı DEĞİL (o dal güncel dokümanı döndürür ve yalnız SAHİBE açıktır) —
        // yabancı için yol yalın 404'te biter, doküman sızmaz.
        Assert.IsType<NotFound>(result);
        var reloaded = _db.Projects.AsNoTracking().Single(p => p.Id == project.Id);
        Assert.Equal(originalTimeline, reloaded.Timeline.RootElement.GetRawText());
        Assert.Equal(project.RevisionNumber, reloaded.RevisionNumber);
        Assert.Empty(_db.ProjectRevisions.AsNoTracking().Where(r => r.ProjectId == project.Id));
    }

    [Fact]
    public async Task Project_ListRevisions_ForeignProject_Returns404()
    {
        var project = await SeedVictimProjectAsync();
        await SeedVictimRevisionAsync(project);

        var result = await ProjectEndpoints.ListRevisions(
            project.Id, Attacker, _db, CancellationToken.None);

        // Boş 200 liste DEĞİL: projenin varlığı da revizyon meta verisi de sızmaz.
        Assert.IsType<NotFound>(result);
    }

    [Fact]
    public async Task Project_GetRevision_ForeignProject_Returns404()
    {
        var project = await SeedVictimProjectAsync();
        var revision = await SeedVictimRevisionAsync(project);

        var result = await ProjectEndpoints.GetRevision(
            project.Id, revision.RevisionNumber, Attacker, _db, CancellationToken.None);

        Assert.IsType<NotFound>(result); // revizyonun TAM timeline gövdesi sızmaz
    }

    [Fact]
    public async Task Project_CreateCheckpoint_ForeignProject_Returns404_AndWritesNoRevisionRow()
    {
        var project = await SeedVictimProjectAsync();

        var result = await ProjectEndpoints.CreateCheckpoint(
            project.Id, new CreateCheckpointRequest("saldırgan etiketi"), Attacker, _db,
            TimeProvider.System, CancellationToken.None);

        Assert.IsType<NotFound>(result);
        Assert.Empty(_db.ProjectRevisions.AsNoTracking().Where(r => r.ProjectId == project.Id));
    }

    [Fact]
    public async Task Project_Restore_ForeignProject_Returns404_AndProjectUntouched()
    {
        var project = await SeedVictimProjectAsync();
        var revision = await SeedVictimRevisionAsync(project);
        var originalTimeline = _db.Projects.AsNoTracking()
            .Single(p => p.Id == project.Id).Timeline.RootElement.GetRawText();

        var result = await ProjectEndpoints.Restore(
            project.Id, new RestoreRequest(revision.RevisionNumber), Attacker, _db,
            TimeProvider.System, CancellationToken.None);

        Assert.IsType<NotFound>(result);
        var reloaded = _db.Projects.AsNoTracking().Single(p => p.Id == project.Id);
        Assert.Equal(project.RevisionNumber, reloaded.RevisionNumber);
        Assert.Equal(originalTimeline, reloaded.Timeline.RootElement.GetRawText());
        // PreRestore snapshot'ı da doğmamalı: tek revizyon, bizim seed'imiz.
        Assert.Single(_db.ProjectRevisions.AsNoTracking().Where(r => r.ProjectId == project.Id));
    }

    [Fact]
    public async Task Project_List_OmitsForeignProjects()
    {
        // Yabancı-id parametresi olmayan koleksiyon ucu: sızıntı yolu filtresiz listelemedir.
        // Ad işareti bilerek ASCII: JsonSerializer Türkçe karakterleri \uXXXX kaçışlar ve
        // kaçışlanmış gövdede Türkçe işaret aramak denetimi boşa (vacuous) çevirirdi.
        var project = await SeedVictimProjectAsync(name: "victim-secret-project");

        var result = await ProjectEndpoints.List(Attacker, _db, CancellationToken.None);

        var ok = Assert.IsType<Ok<PagedResult<ProjectSummaryDto>>>(result);
        Assert.Equal(0, ok.Value!.TotalCount);
        Assert.Empty(ok.Value.Items);
        AssertBodyDoesNotLeak(ok.Value, project.Id.ToString("D"), "victim-secret-project");
    }

    // ---------- Asset'ler ----------

    [Fact]
    public async Task Asset_InitUpload_ForeignProject_Returns404_WithoutAssetRowOrStorageCall()
    {
        var project = await SeedVictimProjectAsync();

        var result = await AssetEndpoints.InitUpload(
            project.Id, new InitAssetUploadRequest("attack.mp4", 1024, "video/mp4"),
            Attacker, _db, _storage, Quotas(), TimeProvider.System, CancellationToken.None);

        // TrappedStorage her S3 çağrısında fırlatır: 404'e istisnasız ulaşmak
        // "multipart upload hiç başlatılmadı" kanıtıdır.
        Assert.IsType<NotFound>(result);
        Assert.Empty(_db.Assets.AsNoTracking().Where(a => a.OwnerId == _attackerId));
        Assert.Empty(_db.ProjectAssets.AsNoTracking().Where(pa => pa.ProjectId == project.Id));
    }

    [Fact]
    public async Task Asset_ListForProject_ForeignProject_Returns404()
    {
        var project = await SeedVictimProjectAsync();
        await SeedVictimAssetAsync(status: AssetStatus.Ready, linkTo: project);

        var result = await AssetEndpoints.ListForProject(
            project.Id, Attacker, _db, CancellationToken.None);

        Assert.IsType<NotFound>(result); // asset meta verisi (dosya adı/boyut) sızmaz
    }

    [Fact]
    public async Task Asset_MediaUrls_ForeignProject_Returns404_LeaksNoPresignedUrl()
    {
        var project = await SeedVictimProjectAsync();
        await SeedVictimAssetAsync(status: AssetStatus.Ready, linkTo: project);

        var result = await AssetEndpoints.MediaUrls(
            project.Id, Attacker, _db, _storage, TimeProvider.System,
            Microsoft.Extensions.Logging.Abstractions.NullLoggerFactory.Instance, CancellationToken.None);

        // İmzalı URL'nin tek üreticisi presign'dır ve TrappedStorage'ta patlar —
        // yalın 404, tek bir URL bile imzalanmadan reddedildiğini kanıtlar.
        Assert.IsType<NotFound>(result);
    }

    [Fact]
    public async Task Asset_PresignParts_ForeignAsset_Returns404()
    {
        var asset = await SeedVictimAssetAsync(); // Uploading + UploadId dolu

        var result = await AssetEndpoints.PresignParts(
            asset.Id, new PresignPartsRequest([1]), Attacker, _db, _storage, CancellationToken.None);

        Assert.IsType<NotFound>(result); // part URL'si imzalanmadı (TrappedStorage)
    }

    [Fact]
    public async Task Asset_Complete_ForeignAsset_Returns404_AndUploadStaysActive()
    {
        var asset = await SeedVictimAssetAsync();

        var result = await AssetEndpoints.Complete(
            asset.Id, new CompleteUploadRequest([new CompletedPartDto(1, "etag-1")]),
            Attacker, _db, _storage, _jobs, TimeProvider.System, CancellationToken.None);

        Assert.IsType<NotFound>(result);
        var reloaded = _db.Assets.AsNoTracking().Single(a => a.Id == asset.Id);
        Assert.Equal(AssetStatus.Uploading, reloaded.Status); // durum çalınmadı
        Assert.NotNull(reloaded.UploadId);
        Assert.Equal(0, _jobs.CreateCount); // ProcessAsset işi kuyruğa sokulamadı
    }

    [Fact]
    public async Task Asset_Abort_ForeignAsset_Returns404_AndUploadStaysActive()
    {
        var asset = await SeedVictimAssetAsync();

        var result = await AssetEndpoints.Abort(
            asset.Id, Attacker, _db, _storage, TimeProvider.System, CancellationToken.None);

        Assert.IsType<NotFound>(result);
        var reloaded = _db.Assets.AsNoTracking().Single(a => a.Id == asset.Id);
        Assert.Equal(AssetStatus.Uploading, reloaded.Status);
        Assert.Null(reloaded.DeletedAt); // kurbanın yüklemesi düşürülemedi
    }

    [Fact]
    public async Task Asset_UploadStatus_ForeignAsset_Returns404()
    {
        var asset = await SeedVictimAssetAsync();

        var result = await AssetEndpoints.UploadStatus(
            asset.Id, Attacker, _db, _storage, CancellationToken.None);

        Assert.IsType<NotFound>(result); // ListParts çağrılmadı → part/etag listesi sızmaz
    }

    [Fact]
    public async Task Asset_GetById_ForeignAsset_Returns404()
    {
        var asset = await SeedVictimAssetAsync(status: AssetStatus.Ready);

        var result = await AssetEndpoints.GetById(asset.Id, Attacker, _db, CancellationToken.None);

        Assert.IsType<NotFound>(result); // dosya adı/boyut/probe meta verisi sızmaz
    }

    [Fact]
    public async Task Asset_Usage_ForeignAsset_Returns404()
    {
        // AssetUsageQuotaTests.Usage_OtherUsersAsset_Returns404'ün matristeki karşılığı:
        // asset'in HANGİ projelerde kullanıldığı (proje adları!) sızmaz.
        var project = await SeedVictimProjectAsync();
        var asset = await SeedVictimAssetAsync(status: AssetStatus.Ready, linkTo: project);

        var result = await AssetEndpoints.Usage(asset.Id, Attacker, _db, CancellationToken.None);

        Assert.IsType<NotFound>(result);
    }

    [Fact]
    public async Task Asset_Delete_ForeignAsset_Returns404_AndAssetStillAlive()
    {
        var asset = await SeedVictimAssetAsync(status: AssetStatus.Ready);

        var result = await AssetEndpoints.SoftDelete(
            asset.Id, Attacker, _db, _storage, TimeProvider.System, CancellationToken.None);

        // Sahibin "zaten silinmiş" idempotent 204 yolu yabancıya AÇILMAZ: yalın 404.
        Assert.IsType<NotFound>(result);
        Assert.Null(_db.Assets.AsNoTracking().Single(a => a.Id == asset.Id).DeletedAt);
    }

    [Fact]
    public async Task Quota_OmitsForeignAssets()
    {
        // Koleksiyon ucu: B'nin kota özeti A'nın depolamasını SAYAMAZ (aksi yön —
        // A'nın asset'i B'nin kotasını doldurması — da aynı filtrenin ihlali olurdu).
        await SeedVictimAssetAsync(status: AssetStatus.Ready, sizeBytes: 4096);

        var result = await AssetEndpoints.QuotaSummary(
            Attacker, _db, Quotas(), CancellationToken.None);

        var ok = Assert.IsType<Ok<QuotaSummaryResponse>>(result);
        Assert.Equal(0, ok.Value!.UsedBytes);
        Assert.Equal(0, ok.Value.AssetCount);
    }

    // ---------- Export'lar ----------

    [Fact]
    public async Task Export_Start_ForeignProject_Returns404_AndWritesNoJobRow()
    {
        var project = await SeedVictimProjectAsync();

        var result = await ExportEndpoints.StartExport(
            project.Id, new CreateExportRequest("1080p"), Attacker, _db, _jobs,
            TimeProvider.System, Fonts, overlayMeasurer: null, CancellationToken.None);

        Assert.IsType<NotFound>(result);
        Assert.Empty(_db.Jobs.AsNoTracking().Where(j => j.ProjectId == project.Id));
        Assert.Equal(0, _jobs.CreateCount); // kurbanın adına render başlatılamaz
    }

    [Fact]
    public async Task Export_ListForProject_ForeignProject_Returns404_LeaksNoDownloadUrl()
    {
        var project = await SeedVictimProjectAsync();
        await SeedVictimExportJobAsync(project, JobStatus.Succeeded);

        var result = await ExportEndpoints.ListForProject(
            project.Id, Attacker, _db, _storage, CancellationToken.None);

        // TrappedStorage.PresignExportGet fırlatır: yalın 404 = tek bir indirme URL'si
        // bile imzalanmadı.
        Assert.IsType<NotFound>(result);
    }

    [Fact]
    public async Task Export_GetJob_ForeignJob_Returns404_LeaksNoDownloadUrl()
    {
        var project = await SeedVictimProjectAsync();
        var job = await SeedVictimExportJobAsync(project, JobStatus.Succeeded);

        var result = await ExportEndpoints.GetJob(
            job.Id, Attacker, _db, _storage, CancellationToken.None);

        Assert.IsType<NotFound>(result); // ne durum/hata mesajı ne presigned downloadUrl
    }

    [Fact]
    public async Task Export_CancelJob_ForeignJob_Returns404_AndJobStaysQueued()
    {
        var project = await SeedVictimProjectAsync();
        var job = await SeedVictimExportJobAsync(project, JobStatus.Queued);

        var result = await ExportEndpoints.CancelJob(
            job.Id, Attacker, _db, _jobs, TimeProvider.System, CancellationToken.None);

        Assert.IsType<NotFound>(result);
        var reloaded = _db.Jobs.AsNoTracking().Single(j => j.Id == job.Id);
        Assert.Equal(JobStatus.Queued, reloaded.Status); // kurbanın export'u iptal ettirilemez
        Assert.Null(reloaded.CompletedAt);
        Assert.Empty(_jobs.StateChanges); // Hangfire tarafına da dokunulmadı
    }

    // ---------- Seed yardımcıları ----------

    private async Task<Project> SeedVictimProjectAsync(string name = "Kurbanın projesi")
    {
        var projectId = Guid.CreateVersion7();
        var project = new Project
        {
            Id = projectId,
            OwnerId = _victimId,
            Name = name,
            Timeline = EmptyTimeline.Create(projectId, 1920, 1080, 30, 1, 48000),
            RevisionNumber = 0,
            FrameRateNum = 30,
            FrameRateDen = 1,
            Width = 1920,
            Height = 1080,
            AudioSampleRate = 48000,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        _db.Projects.Add(project);
        await _db.SaveChangesAsync();
        return project;
    }

    private async Task<ProjectRevision> SeedVictimRevisionAsync(Project project)
    {
        var revision = ProjectRevision.Create(
            project.Id, project.RevisionNumber,
            JsonDocument.Parse(project.Timeline.RootElement.GetRawText()),
            RevisionKind.Checkpoint, _victimId, DateTimeOffset.UtcNow, "kurban checkpoint");
        _db.ProjectRevisions.Add(revision);
        await _db.SaveChangesAsync();
        return revision;
    }

    /// <param name="status">
    /// Varsayılan Uploading (UploadId dolu): presign/complete/abort/upload-status uçları
    /// yalnız aktif upload'da anlamlıdır — 404'ün 409'a (upload-not-active) DEĞİL sahipliğe
    /// dayandığını kanıtlamak için kurbanın upload'ı gerçekten aktif kurulur.
    /// </param>
    private async Task<Asset> SeedVictimAssetAsync(
        AssetStatus status = AssetStatus.Uploading, Project? linkTo = null, long sizeBytes = 1024)
    {
        var asset = Asset.Create(
            _victimId, AssetKind.Video, "kurban.mp4", "video/mp4", sizeBytes, DateTimeOffset.UtcNow);
        if (status == AssetStatus.Uploading)
        {
            asset.UploadId = "victim-upload-1";
        }
        else
        {
            asset.Status = status;
        }

        _db.Assets.Add(asset);
        if (linkTo is not null)
        {
            _db.ProjectAssets.Add(new ProjectAsset
            {
                ProjectId = linkTo.Id,
                AssetId = asset.Id,
                AddedAt = DateTimeOffset.UtcNow,
            });
        }

        await _db.SaveChangesAsync();
        return asset;
    }

    private async Task<Job> SeedVictimExportJobAsync(Project project, JobStatus status)
    {
        var job = Job.Create(
            JobType.Export, _victimId, DateTimeOffset.UtcNow,
            projectId: project.Id, exportProfile: "1080p");
        job.Status = status;
        job.HangfireJobId = "hf-victim-1";
        if (status == JobStatus.Succeeded)
        {
            job.OutputKey = $"exports/{project.Id:D}/{job.Id:D}.mp4";
            job.ProgressPercent = 100;
        }

        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();
        return job;
    }

    private static IOptions<QuotasOptions> Quotas() => Options.Create(new QuotasOptions());

    /// <summary>
    /// Gövde sızıntı denetimi: 200 dönen koleksiyon uçlarında yanıt JSON'ında kurbana ait
    /// hiçbir işaret (id, ad, storage key) geçmemeli.
    /// </summary>
    private static void AssertBodyDoesNotLeak(object body, params string[] victimMarkers)
    {
        var json = JsonSerializer.Serialize(body);
        foreach (var marker in victimMarkers)
        {
            // ASCII şartı denetimin kendisini korur: JsonSerializer ASCII dışını \uXXXX
            // kaçışlar ve kaçışlanmış gövdede ham Türkçe işaret aramak hep 'geçer'di.
            Assert.True(marker.All(char.IsAscii),
                $"Sızıntı işareti ASCII olmalı (JSON kaçışlaması yüzünden): '{marker}'");
            Assert.DoesNotContain(marker, json, StringComparison.OrdinalIgnoreCase);
        }
    }

    // ---------- Sahteler ----------

    /// <summary>Create/ChangeState çağrılarını sayan Hangfire istemcisi (ExportEndpointsTests deseni).</summary>
    private sealed class CountingJobClient : IBackgroundJobClient
    {
        public int CreateCount { get; private set; }
        public List<(string JobId, string State)> StateChanges { get; } = [];

        public string Create(Hangfire.Common.Job job, IState state)
        {
            CreateCount++;
            return Guid.NewGuid().ToString("N");
        }

        public bool ChangeState(string jobId, IState state, string expectedState)
        {
            StateChanges.Add((jobId, state.GetType().Name));
            return true;
        }
    }

    /// <summary>
    /// HER üyesi fırlatan depolama: sahiplik reddi S3'e (presign dahil) hiç dokunmamalı.
    /// Testin yeşil olması "reddedilen istek depo yüzeyine ulaşmadı" kanıtıdır.
    /// </summary>
    private sealed class TrappedStorage : IStorageService
    {
        private static Exception Trap() =>
            new InvalidOperationException("Sahiplik reddi depolamaya DOKUNMAMALI.");

        public Task<string> CreateMultipartUploadAsync(string key, string contentType, CancellationToken ct = default) =>
            throw Trap();

        public string PresignUploadPart(string key, string uploadId, int partNumber) => throw Trap();

        public Task CompleteMultipartUploadAsync(
            string key, string uploadId, IReadOnlyList<StorageCompletedPart> parts, CancellationToken ct = default) =>
            throw Trap();

        public Task AbortMultipartUploadAsync(string key, string uploadId, CancellationToken ct = default) =>
            throw Trap();

        public Task<IReadOnlyList<StorageUploadedPart>> ListPartsAsync(
            string key, string uploadId, CancellationToken ct = default) => throw Trap();

        public Task<StorageObjectInfo?> HeadObjectAsync(string key, CancellationToken ct = default) => throw Trap();

        public string PresignGet(string key) => throw Trap();

        public Task DeletePrefixAsync(string prefix, CancellationToken ct = default) => throw Trap();

        public Task DeleteObjectAsync(string key, CancellationToken ct = default) => throw Trap();

        public Task<StorageDownload> OpenReadAsync(string key, CancellationToken ct = default) => throw Trap();

        public Task UploadFileAsync(string key, string filePath, string contentType, CancellationToken ct = default) =>
            throw Trap();

        public Task UploadExportAsync(string key, string filePath, string contentType, CancellationToken ct = default) =>
            throw Trap();

        public string PresignExportGet(string key) => throw Trap();

        public Task EnsureBucketsExistAsync(CancellationToken ct = default) => throw Trap();
    }
}

/// <summary>
/// TAMLIK MUHAFIZI (ExportGateInventoryTests defter deseni) — uç envanteri EL YAZISI listeyle
/// değil MEKANİK kaynakla eşleşir.
/// <para>
/// Rota tablosu, ürünün KENDİ <c>Map*Endpoints</c> metotları (refleksiyonla keşfedilip boş bir
/// <see cref="WebApplication"/> üzerinde koşturularak) kurulur — Program.cs'in çağırdığı
/// metotların aynısı. Her uç şu üç defterden TAM BİRİNDE olmak zorundadır:
/// </para>
/// <list type="number">
///   <item><b>CrossUserCovered</b> — kimlik-doğrulamalı uç; <see cref="CrossUserAccessTests"/>'te
///     sahiplik testi VAR ve test metodunun varlığı + [Fact] taşıdığı refleksiyonla doğrulanır
///     (test silinir/adı değişirse muhafız kırmızı).</item>
///   <item><b>AuthenticatedExempt</b> — kimlik-doğrulamalı ama rota parametresi OLMAYAN uç;
///     yazılı gerekçe zorunlu ve desende '{' varsa muafiyet REDDEDİLİR (id alan uç asla muaf
///     olamaz — muafiyet IDOR kör noktası açamaz).</item>
///   <item><b>AnonymousByDesign</b> — bilinçli anonim uç; yazılı gerekçe zorunlu. Yeni bir uç
///     yanlışlıkla RequireAuthorization'sız eklenirse bu defterde olmayacağı için muhafız
///     kırmızı olur.</item>
/// </list>
/// <para>
/// Kör nokta kapatma: Program.cs kaynak taramasıyla (a) çağrılan Map*Endpoints kümesinin
/// keşfedilen kümeyle BİREBİR eşleştiği, (b) Program.cs'te grup sınıfları dışında satır-içi
/// rota tanımlanmadığı (MapOpenApi hariç) doğrulanır — muhafızın görmediği bir uç mapleme
/// yolu kalmaz.
/// </para>
/// </summary>
public sealed class CrossUserEndpointInventoryTests
{
    private sealed record RouteRow(string Method, string Pattern, bool RequiresAuth);

    // ───────────────────────────── DEFTERLER ─────────────────────────────

    /// <summary>Kimlik-doğrulamalı uç → CrossUserAccessTests'teki sahiplik testi.</summary>
    private static readonly Dictionary<string, string> CrossUserCovered = new(StringComparer.Ordinal)
    {
        ["GET /api/projects"] = nameof(CrossUserAccessTests.Project_List_OmitsForeignProjects),
        ["GET /api/projects/{id:guid}"] = nameof(CrossUserAccessTests.Project_GetById_ForeignProject_Returns404),
        ["PATCH /api/projects/{id:guid}"] = nameof(CrossUserAccessTests.Project_Rename_ForeignProject_Returns404_AndNameUnchanged),
        ["DELETE /api/projects/{id:guid}"] = nameof(CrossUserAccessTests.Project_Delete_ForeignProject_Returns404_AndProjectStillAlive),
        ["PUT /api/projects/{id:guid}/timeline"] = nameof(CrossUserAccessTests.Project_SaveTimeline_ForeignProject_Returns404_AndTimelineUnchanged),
        ["GET /api/projects/{id:guid}/revisions"] = nameof(CrossUserAccessTests.Project_ListRevisions_ForeignProject_Returns404),
        ["GET /api/projects/{id:guid}/revisions/{rev:long}"] = nameof(CrossUserAccessTests.Project_GetRevision_ForeignProject_Returns404),
        ["POST /api/projects/{id:guid}/revisions"] = nameof(CrossUserAccessTests.Project_CreateCheckpoint_ForeignProject_Returns404_AndWritesNoRevisionRow),
        ["POST /api/projects/{id:guid}/restore"] = nameof(CrossUserAccessTests.Project_Restore_ForeignProject_Returns404_AndProjectUntouched),
        ["POST /api/projects/{projectId:guid}/assets"] = nameof(CrossUserAccessTests.Asset_InitUpload_ForeignProject_Returns404_WithoutAssetRowOrStorageCall),
        ["GET /api/projects/{projectId:guid}/assets"] = nameof(CrossUserAccessTests.Asset_ListForProject_ForeignProject_Returns404),
        ["GET /api/projects/{projectId:guid}/media-urls"] = nameof(CrossUserAccessTests.Asset_MediaUrls_ForeignProject_Returns404_LeaksNoPresignedUrl),
        ["POST /api/assets/{id:guid}/parts/presign"] = nameof(CrossUserAccessTests.Asset_PresignParts_ForeignAsset_Returns404),
        ["GET /api/assets/{id:guid}/usage"] = nameof(CrossUserAccessTests.Asset_Usage_ForeignAsset_Returns404),
        ["POST /api/assets/{id:guid}/complete"] = nameof(CrossUserAccessTests.Asset_Complete_ForeignAsset_Returns404_AndUploadStaysActive),
        ["POST /api/assets/{id:guid}/abort"] = nameof(CrossUserAccessTests.Asset_Abort_ForeignAsset_Returns404_AndUploadStaysActive),
        ["GET /api/assets/{id:guid}/upload/status"] = nameof(CrossUserAccessTests.Asset_UploadStatus_ForeignAsset_Returns404),
        ["GET /api/assets/{id:guid}"] = nameof(CrossUserAccessTests.Asset_GetById_ForeignAsset_Returns404),
        ["DELETE /api/assets/{id:guid}"] = nameof(CrossUserAccessTests.Asset_Delete_ForeignAsset_Returns404_AndAssetStillAlive),
        ["GET /api/quota"] = nameof(CrossUserAccessTests.Quota_OmitsForeignAssets),
        ["POST /api/projects/{projectId:guid}/exports"] = nameof(CrossUserAccessTests.Export_Start_ForeignProject_Returns404_AndWritesNoJobRow),
        ["GET /api/projects/{projectId:guid}/exports"] = nameof(CrossUserAccessTests.Export_ListForProject_ForeignProject_Returns404_LeaksNoDownloadUrl),
        ["GET /api/jobs/{id:guid}"] = nameof(CrossUserAccessTests.Export_GetJob_ForeignJob_Returns404_LeaksNoDownloadUrl),
        ["POST /api/jobs/{id:guid}/cancel"] = nameof(CrossUserAccessTests.Export_CancelJob_ForeignJob_Returns404_AndJobStaysQueued),
    };

    /// <summary>
    /// Kimlik-doğrulamalı ama rota parametresi OLMAYAN uçlar — cross-user id verilebilecek
    /// bir girdi taşımaz. Desende '{' görülürse muafiyet geçersizdir (aşağıda zorlanır).
    /// </summary>
    private static readonly Dictionary<string, string> AuthenticatedExempt = new(StringComparer.Ordinal)
    {
        ["POST /api/projects"] =
            "Yeni kaynak oluşturur; sahip her zaman token'daki kullanıcıdır (OwnerId = "
            + "principal.GetUserId()) ve istek yabancı bir kaynak id'si taşımaz.",
        ["GET /api/auth/me"] =
            "Kimlik yalnız token'ın 'sub' claim'inden gelir; istek hiçbir kaynak id'si taşımaz "
            + "— dönebileceği tek kayıt çağıranın kendi kullanıcı satırıdır.",
    };

    /// <summary>Bilinçli anonim uçlar — gerekçeler uçların kendi belgelerinden.</summary>
    private static readonly Dictionary<string, string> AnonymousByDesign = new(StringComparer.Ordinal)
    {
        ["GET /health"] =
            "Compose healthcheck'i oturumsuz koşar; cevap kullanıcı verisi içermez "
            + "(HealthEndpoints sınıf belgesi).",
        ["POST /api/auth/register"] = "Kayıt tanımı gereği oturum öncesidir; 'auth' rate limit'i frenler.",
        ["POST /api/auth/login"] = "Giriş tanımı gereği oturum öncesidir; 'auth' rate limit'i frenler.",
        ["POST /api/auth/refresh"] =
            "Kimlik HttpOnly refresh cookie'sinin KENDİSİDİR (ham token'ı bilmek = oturumun "
            + "sahibi olmak); access token süresi dolmuşken de çalışmalı (AuthEndpoints belgesi).",
        ["POST /api/auth/refresh/logout"] =
            "Refresh ucuyla aynı kimlik modeli: cookie'deki token iptal edilir; süresi dolmuş "
            + "access token'la da çıkış çalışmalı (AuthEndpoints belgesi).",
        ["GET /api/fonts"] =
            "Küratörlü katalog kullanıcıya özel veri içermez ve editör oturum AÇILMADAN yükler "
            + "(FontEndpoints sınıf belgesi: 'kullanıcı verisi taşıyan hiçbir uç bu gruba eklenmemeli').",
        ["GET /api/fonts/{fontId}/{styleKey}.ttf"] =
            "OFL/Apache lisanslı, sürüm pinli TTF dosyaları — herkese açık statik içerik; "
            + "manifest dışı id'ler dosya sistemi yoklamasına izin vermeden 404 alır.",
    };

    // ───────────────────────────── MUHAFIZ ─────────────────────────────

    [Fact]
    public void EveryEndpointIsEitherCrossUserTestedOrExplicitlyExempt()
    {
        var routes = BuildRouteTable();
        Assert.NotEmpty(routes);

        var failures = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var route in routes)
        {
            var key = $"{route.Method} {route.Pattern}";
            if (!seen.Add(key))
            {
                continue; // aynı desen+metot iki kez maplenemez zaten; defter tek satır bekler
            }

            var ledgers = (CrossUserCovered.ContainsKey(key) ? 1 : 0)
                          + (AuthenticatedExempt.ContainsKey(key) ? 1 : 0)
                          + (AnonymousByDesign.ContainsKey(key) ? 1 : 0);
            if (ledgers > 1)
            {
                failures.Add($"{key}: birden fazla defterde — satır tek defterde olmalı.");
                continue;
            }

            if (route.RequiresAuth)
            {
                if (CrossUserCovered.TryGetValue(key, out var testName))
                {
                    if (!FactExists(typeof(CrossUserAccessTests), testName))
                    {
                        failures.Add(
                            $"{key}: defter '{testName}' testine işaret ediyor ama "
                            + "CrossUserAccessTests'te [Fact] taşıyan böyle bir metot YOK.");
                    }
                }
                else if (AuthenticatedExempt.TryGetValue(key, out var reason))
                {
                    if (key.Contains('{'))
                    {
                        failures.Add(
                            $"{key}: rota parametresi taşıyan kimlik-doğrulamalı uç MUAF OLAMAZ "
                            + "— cross-user testi yazın (muafiyet IDOR kör noktası açar).");
                    }

                    if (string.IsNullOrWhiteSpace(reason))
                    {
                        failures.Add($"{key}: muafiyet gerekçesi BOŞ olamaz.");
                    }
                }
                else
                {
                    failures.Add(
                        $"{key}: kimlik-doğrulamalı uç hiçbir defterde YOK. Ya CrossUserAccessTests'e "
                        + "sahiplik testi ekleyip CrossUserCovered'a yazın ya da (yalnız parametresiz "
                        + "uçlar için) AuthenticatedExempt'e yazılı gerekçe ekleyin.");
                }
            }
            else if (!AnonymousByDesign.TryGetValue(key, out var anonReason)
                     || string.IsNullOrWhiteSpace(anonReason))
            {
                failures.Add(
                    $"{key}: ANONİM uç AnonymousByDesign defterinde değil — RequireAuthorization "
                    + "unutulmuş olabilir; bilinçliyse yazılı gerekçeyle deftere ekleyin.");
            }
        }

        // Ters yön: defterde olup rota tablosunda olmayan satır BAYATTIR (uç silindi/deseni değişti).
        foreach (var stale in CrossUserCovered.Keys
                     .Concat(AuthenticatedExempt.Keys)
                     .Concat(AnonymousByDesign.Keys)
                     .Where(k => !seen.Contains(k)))
        {
            failures.Add($"{stale}: defter satırının karşılığı rota tablosunda YOK (bayat satır — silin/güncelleyin).");
        }

        Assert.True(failures.Count == 0,
            "Uç envanteri defterle eşleşmiyor:\n - " + string.Join("\n - ", failures)
            + "\n\nMevcut rota tablosu:\n" + string.Join(
                "\n", routes.Select(r => $"{(r.RequiresAuth ? "[auth]" : "[anon]")} {r.Method} {r.Pattern}")));
    }

    /// <summary>
    /// Kör nokta kapısı: Program.cs'in map ettiği uç sınıfları kümesi, muhafızın refleksiyonla
    /// keşfettiği kümeyle BİREBİR aynı olmalı; ve Program.cs grup sınıfları dışında satır-içi
    /// rota tanımlayamaz (tek bilinçli istisna: dev-only MapOpenApi). Aksi halde muhafız
    /// görmediği bir rota tablosuna 'tam' derdi.
    /// </summary>
    [Fact]
    public void ProgramMapsExactlyTheDiscoveredEndpointClasses_AndNoInlineRoutes()
    {
        var source = File.ReadAllText(
            TestVectorFiles.Resolve("backend/src/VideoEdit.Api/Program.cs"));

        var mappedInProgram = Regex.Matches(source, @"app\.(Map\w+Endpoints)\(\)")
            .Select(m => m.Groups[1].Value)
            .ToHashSet(StringComparer.Ordinal);
        var discovered = DiscoverMapMethods().Select(m => m.Name).ToHashSet(StringComparer.Ordinal);

        Assert.True(mappedInProgram.SetEquals(discovered),
            "Program.cs'in map ettiği uç sınıfları muhafızın keşfettiğiyle eşleşmiyor.\n"
            + $"Program.cs: {string.Join(", ", mappedInProgram.Order(StringComparer.Ordinal))}\n"
            + $"Keşfedilen: {string.Join(", ", discovered.Order(StringComparer.Ordinal))}\n"
            + "Yeni uç sınıfı 'public static class ...' + 'public static IEndpointRouteBuilder "
            + "Map*Endpoints(this IEndpointRouteBuilder)' imzasını taşımalı ki muhafız görsün.");

        var inlineRoutes = Regex.Matches(source, @"\.(Map\w*)\(")
            .Select(m => m.Groups[1].Value)
            .Where(name => name is not "MapOpenApi"
                           && !Regex.IsMatch(name, @"^Map\w+Endpoints$"))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        Assert.True(inlineRoutes.Count == 0,
            "Program.cs'te grup sınıfları dışında rota tanımı var (muhafız bunları GÖREMEZ): "
            + string.Join(", ", inlineRoutes)
            + "\nRotayı bir *Endpoints sınıfına taşıyın.");
    }

    // ───────────────────────────── Rota tablosu kurulumu ─────────────────────────────

    /// <summary>
    /// Ürünün Map*Endpoints metotlarını boş bir WebApplication üzerinde koşturup gerçek rota
    /// tablosunu döker. Delegeler HİÇ ÇAĞRILMAZ; yalnız desen + HTTP metodu + yetki metadata'sı
    /// okunur. Handler'ların enjekte ettiği servis TİPLERİ sahte fabrikalarla kaydedilir:
    /// RequestDelegateFactory, DI'da kayıtlı olmayan karmaşık parametreyi GÖVDE sayar ve
    /// "birden çok gövde" hatası verir (container'ın kendi IServiceProviderIsService'i kayıtla
    /// ezilemez). Fabrikaların hepsi fırlatır — resolve edilmedikleri de böylece kanıtlıdır.
    /// Yeni bir uç YENİ bir servis tipi enjekte ederse bu test o parametrenin adını söyleyen
    /// RDF hatasıyla kırmızı olur: tipi aşağıya eklemek yeterlidir.
    /// </summary>
    private static IReadOnlyList<RouteRow> BuildRouteTable()
    {
        var builder = WebApplication.CreateEmptyBuilder(new WebApplicationOptions());
        builder.Services.AddLogging();
        builder.Services.AddRouting();
        RegisterHandlerServiceTypes(builder.Services);
        // Boş builder sunucu kaydetmez ama WebApplication kurucusu IServer ister; uygulama
        // hiç BAŞLATILMAZ — sahte sunucu yalnız Build()'i geçirir.
        builder.Services.AddSingleton<Microsoft.AspNetCore.Hosting.Server.IServer>(new NoopServer());
        using var app = builder.Build();

        foreach (var map in DiscoverMapMethods())
        {
            map.Invoke(null, [app]);
        }

        return ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(ds => ds.Endpoints)
            .OfType<RouteEndpoint>()
            .SelectMany(e =>
            {
                var methods = e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? ["*"];
                var requiresAuth = e.Metadata.GetMetadata<IAllowAnonymous>() is null
                                   && e.Metadata.GetMetadata<IAuthorizeData>() is not null;
                var pattern = "/" + (e.RoutePattern.RawText ?? "").Trim('/');
                return methods.Select(m => new RouteRow(m, pattern, requiresAuth));
            })
            .OrderBy(r => r.Pattern, StringComparer.Ordinal)
            .ThenBy(r => r.Method, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>
    /// VideoEdit.Api assembly'sindeki tüm uç mapleme metotları: public static sınıf üstünde
    /// <c>Map*Endpoints(this IEndpointRouteBuilder)</c>. Program.cs de uçlarını yalnız bu
    /// imzayla map eder (yukarıdaki kaynak taraması bunu ayrıca zorlar).
    /// </summary>
    private static IReadOnlyList<MethodInfo> DiscoverMapMethods() =>
        [.. typeof(ProjectEndpoints).Assembly.GetTypes()
            .Where(t => t is { IsAbstract: true, IsSealed: true, IsPublic: true })
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Static))
            .Where(m => m.Name.StartsWith("Map", StringComparison.Ordinal)
                        && m.Name.EndsWith("Endpoints", StringComparison.Ordinal)
                        && m.GetParameters() is [{ } p]
                        && p.ParameterType == typeof(IEndpointRouteBuilder))
            .OrderBy(m => m.Name, StringComparer.Ordinal)];

    private static bool FactExists(Type testClass, string methodName) =>
        testClass.GetMethod(methodName, BindingFlags.Public | BindingFlags.Instance) is { } method
        && method.GetCustomAttributes(inherit: true).Any(a => a is FactAttribute);

    /// <summary>Handler imzalarında geçen DI servis tipleri — yalnız "bu tip bir servistir" cevabı için.</summary>
    private static void RegisterHandlerServiceTypes(IServiceCollection services)
    {
        AddTrap<AppDbContext>(services);
        AddTrap<IStorageService>(services);
        AddTrap<ISnapshotPolicy>(services);
        AddTrap<IBackgroundJobClient>(services);
        AddTrap<FontManifestProvider>(services);
        AddTrap<TimeProvider>(services);
        AddTrap<Microsoft.AspNetCore.Identity.UserManager<AppUser>>(services);
        AddTrap<VideoEdit.Infrastructure.Auth.IRefreshTokenService>(services);
        AddTrap<VideoEdit.Api.Auth.JwtTokenService>(services);
    }

    private static void AddTrap<T>(IServiceCollection services) where T : class =>
        services.AddScoped<T>(_ => throw new InvalidOperationException(
            "Muhafız delegeleri asla ÇAĞIRMAZ — bu servis resolve edilmemeliydi."));

    private sealed class NoopServer : Microsoft.AspNetCore.Hosting.Server.IServer
    {
        public Microsoft.AspNetCore.Http.Features.IFeatureCollection Features { get; } =
            new Microsoft.AspNetCore.Http.Features.FeatureCollection();

        public Task StartAsync<TContext>(
            Microsoft.AspNetCore.Hosting.Server.IHttpApplication<TContext> application,
            CancellationToken cancellationToken) where TContext : notnull =>
            throw new InvalidOperationException("Muhafız uygulamayı asla BAŞLATMAZ.");

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public void Dispose()
        {
        }
    }
}
