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
using Microsoft.Extensions.Logging.Abstractions;
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

        var hub = new RecordingHubContext();
        var result = await AssetEndpoints.SoftDelete(
            asset.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System, hub,
            NullLoggerFactory.Instance, CancellationToken.None);

        Assert.IsType<NoContent>(result);
        var reloaded = Reload(asset.Id);
        Assert.Equal(AssetStatus.Processing, reloaded.Status); // guard: Failed'a çekilmedi
        Assert.NotNull(reloaded.DeletedAt); // ama silme isteği yerine getirildi
        Assert.Single(hub.Sent); // yarışı kaybeden dal da GERÇEK silmedir → tek duyuru
    }

    [Fact]
    public async Task SoftDelete_ActiveUpload_AbortsAndSoftDeletes()
    {
        var asset = await SeedUploadingAssetAsync();

        var hub = new RecordingHubContext();
        var result = await AssetEndpoints.SoftDelete(
            asset.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System, hub,
            NullLoggerFactory.Instance, CancellationToken.None);

        Assert.IsType<NoContent>(result);
        Assert.Contains(("abort", asset.StorageKey), _storage.Calls);
        var reloaded = Reload(asset.Id);
        Assert.Equal(AssetStatus.Failed, reloaded.Status);
        Assert.NotNull(reloaded.DeletedAt);
        // Uploading dalı da kitaplık satırı düşüren gerçek bir silmedir → duyuru burada da doğar.
        var sent = Assert.Single(hub.Sent);
        Assert.Equal(JobProgressChannel.UserGroup(_userId), sent.Group);
    }

    // ---------- gelistirme-3 #2a: silme duyurusu (assetRemoved) ----------

    [Fact]
    public async Task SoftDelete_PublishesAssetRemovedOnlyToTheOwnersFeedGroup()
    {
        // IDOR aynası (yayın tarafı): olay YALNIZ sahibinin user:{id} feed grubuna gider —
        // başka hiçbir grup (job:/asset:/başka kullanıcı) hedeflenmez. Süreç-içi gönderim
        // olduğu için ölçüm yüzeyi RecordingHubContext'tir (forwarder testleriyle aynı sahte).
        var asset = await SeedUploadingAssetAsync();
        await using (var rival = NewContext())
        {
            var a = await rival.Assets.SingleAsync(x => x.Id == asset.Id);
            a.TransitionTo(AssetStatus.Uploaded);
            a.TransitionTo(AssetStatus.Processing);
            a.TransitionTo(AssetStatus.Ready);
            a.UploadId = null;
            await rival.SaveChangesAsync();
        }

        var hub = new RecordingHubContext();
        var result = await AssetEndpoints.SoftDelete(
            asset.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System, hub,
            NullLoggerFactory.Instance, CancellationToken.None);

        Assert.IsType<NoContent>(result);
        var sent = Assert.Single(hub.Sent);
        Assert.Equal(JobProgressChannel.UserGroup(_userId), sent.Group);
        Assert.Equal(JobProgressChannel.HubMethodAssetRemoved, sent.Method);
        var message = Assert.IsType<AssetRemovedMessage>(Assert.Single(sent.Args));
        Assert.Equal(asset.Id, message.AssetId);
    }

    [Fact]
    public async Task SoftDelete_SecondDelete_DoesNotPublishAgain()
    {
        // Duyuru yalnız durum DEĞİŞTİREN silmede doğar: ikinci DELETE (satır zaten silinmiş,
        // sahiplik filtresi 404 döner) feed'e ikinci olay üretmez — pasif sekmede
        // yinelenen cerrahi/invalidate tetiklenmez.
        var asset = await SeedUploadingAssetAsync();
        var hub = new RecordingHubContext();

        var first = await AssetEndpoints.SoftDelete(
            asset.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System, hub,
            NullLoggerFactory.Instance, CancellationToken.None);
        var second = await AssetEndpoints.SoftDelete(
            asset.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System, hub,
            NullLoggerFactory.Instance, CancellationToken.None);

        Assert.IsType<NoContent>(first);
        Assert.IsType<NotFound>(second);
        Assert.Single(hub.Sent);
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
            project.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System,
            NullLoggerFactory.Instance, CancellationToken.None);

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
            project.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System,
            NullLoggerFactory.Instance, CancellationToken.None);

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

    // ---------- media-urls manifest kaynağı: DB kolonu + storage yedeği ----------
    // Asset.FilmstripManifest sözleşmesi: kolon doluysa sprites[] DB'den çözülür ve
    // storage'a HİÇ gidilmez; kolon NULL (geriye dönük asset) ise manifest.json storage'dan
    // okunur. İki yol da aynı yanıt şeklini üretir — istemci ayırt edemez.

    private const string TwoSpriteManifest =
        """{"intervalUs":1000000,"tileW":160,"tileH":90,"cols":30,"rows":10,"frameCount":600,"sprites":["sprite_1.jpg","sprite_2.jpg"]}""";

    [Fact]
    public async Task MediaUrls_AssetWithDbManifest_ServesSpritesWithoutStorageRead()
    {
        var project = await SeedProjectAsync();
        var asset = await SeedReadyAssetAsync(_userId, withDbManifest: true);
        await LinkAssetAsync(project.Id, asset.Id);

        var result = await AssetEndpoints.MediaUrls(
            project.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System,
            NullLoggerFactory.Instance, CancellationToken.None);

        var ok = Assert.IsType<Ok<MediaUrlsResponse>>(result);
        var urls = ok.Value!.Assets[asset.Id.ToString("D")];
        Assert.NotNull(urls.Sprites);
        Assert.Equal(2, urls.Sprites!.Count);
        var dir = $"u/{_userId}/a/{asset.Id}/filmstrip";
        Assert.Equal($"https://fake/{dir}/sprite_1.jpg?sig=get", urls.Sprites["sprite_1.jpg"]);
        Assert.Equal($"https://fake/{dir}/sprite_2.jpg?sig=get", urls.Sprites["sprite_2.jpg"]);
        Assert.Equal(0, _storage.OpenReadCount); // çağrı anında storage GET YOK
    }

    [Fact]
    public async Task MediaUrls_LegacyAssetWithNullDbManifest_FallsBackToStorageManifest()
    {
        var project = await SeedProjectAsync();
        var asset = await SeedReadyAssetAsync(_userId, withDbManifest: false); // kolon NULL
        await LinkAssetAsync(project.Id, asset.Id);
        _storage.ManifestJson = TwoSpriteManifest;

        var result = await AssetEndpoints.MediaUrls(
            project.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System,
            NullLoggerFactory.Instance, CancellationToken.None);

        var ok = Assert.IsType<Ok<MediaUrlsResponse>>(result);
        var urls = ok.Value!.Assets[asset.Id.ToString("D")];
        Assert.NotNull(urls.Sprites); // eski asset HÂLÂ tam yanıt alır
        Assert.Equal(2, urls.Sprites!.Count);
        Assert.Equal(1, _storage.OpenReadCount); // yedek yol: tek manifest GET
    }

    // ---------- B8: tembel backfill — yedek yol kendi kendini iyileştirir ----------

    /// <summary>
    /// ASIL İDDİA (B8): yedek yol manifest'i storage'dan okuduğunda içerik
    /// Assets.FilmstripManifest kolonuna da yazılır → aynı asset'in İKİNCİ media-urls
    /// çağrısı DB kademesinden çözülür. Kanıt OpenReadCount: ilk çağrıda 1, ikincide HÂLÂ 1.
    /// </summary>
    [Fact]
    public async Task MediaUrls_FallbackRead_BackfillsTheColumn_SecondCallServesFromDb()
    {
        var project = await SeedProjectAsync();
        var asset = await SeedReadyAssetAsync(_userId, withDbManifest: false); // kolon NULL
        await LinkAssetAsync(project.Id, asset.Id);
        _storage.ManifestJson = TwoSpriteManifest;

        var first = await AssetEndpoints.MediaUrls(
            project.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System,
            NullLoggerFactory.Instance, CancellationToken.None);
        var firstOk = Assert.IsType<Ok<MediaUrlsResponse>>(first);
        Assert.Equal(1, _storage.OpenReadCount);

        // Kolon dolduruldu ve içerik storage'daki manifest'in TA KENDİSİ.
        var reloaded = Reload(asset.Id);
        Assert.NotNull(reloaded.FilmstripManifest);
        Assert.Equal(TwoSpriteManifest, reloaded.FilmstripManifest!.RootElement.GetRawText());

        // İkinci çağrı: storage GET YOK, yanıt şekli birebir aynı (istemci ayırt edemez).
        var second = await AssetEndpoints.MediaUrls(
            project.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System,
            NullLoggerFactory.Instance, CancellationToken.None);
        var secondOk = Assert.IsType<Ok<MediaUrlsResponse>>(second);
        Assert.Equal(1, _storage.OpenReadCount); // hâlâ 1 — DB kademesi

        var firstUrls = firstOk.Value!.Assets[asset.Id.ToString("D")];
        var secondUrls = secondOk.Value!.Assets[asset.Id.ToString("D")];
        Assert.Equal(firstUrls.Sprites!.Count, secondUrls.Sprites!.Count);
        Assert.Equal(firstUrls.Sprites["sprite_1.jpg"], secondUrls.Sprites["sprite_1.jpg"]);
        Assert.Equal(firstUrls.FilmstripManifest, secondUrls.FilmstripManifest);
    }

    /// <summary>
    /// BEST-EFFORT yarısı: backfill yazımı başarısız olursa (bozuk JSON — JsonDocument.Parse
    /// backfill'de patlar) yanıt DÜŞMEZ, kolon NULL kalır ve yedek yol sonraki çağrıda da
    /// çalışmaya devam eder (OpenReadCount büyümeye devam eder). Bugünkü davranışla aynı:
    /// bozuk manifest'te sprites zaten üretilmiyordu.
    /// </summary>
    [Fact]
    public async Task MediaUrls_BackfillFailure_DoesNotBreakTheFallbackResponse()
    {
        var project = await SeedProjectAsync();
        var asset = await SeedReadyAssetAsync(_userId, withDbManifest: false);
        await LinkAssetAsync(project.Id, asset.Id);
        _storage.ManifestJson = "bu-json-degil{{{"; // GET başarılı, parse başarısız

        var first = await AssetEndpoints.MediaUrls(
            project.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System,
            NullLoggerFactory.Instance, CancellationToken.None);

        var ok = Assert.IsType<Ok<MediaUrlsResponse>>(first); // yanıt 200 — backfill hatası yutuldu
        Assert.Null(ok.Value!.Assets[asset.Id.ToString("D")].Sprites); // bugünkü davranış
        Assert.Null(Reload(asset.Id).FilmstripManifest); // çöp yazılmadı

        var second = await AssetEndpoints.MediaUrls(
            project.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System,
            NullLoggerFactory.Instance, CancellationToken.None);
        Assert.IsType<Ok<MediaUrlsResponse>>(second);
        Assert.Equal(2, _storage.OpenReadCount); // yedek yol bozulmadı: yine storage'a gitti
    }

    /// <summary>
    /// YARIŞ KORUMASI: yedek yol manifest'i okurken işleme hattı (ör. yeniden işleme) kolona
    /// KENDİ kopyasını yazarsa backfill onu EZMEZ — yazım "kolon hâlâ NULL" şartlıdır.
    /// FakeStorage'ın OnOpenRead kancası tam okuma anında kolonu doldurarak yarışı kurar.
    /// </summary>
    [Fact]
    public async Task MediaUrls_Backfill_DoesNotClobberAConcurrentPipelineWrite()
    {
        var project = await SeedProjectAsync();
        var asset = await SeedReadyAssetAsync(_userId, withDbManifest: false);
        await LinkAssetAsync(project.Id, asset.Id);
        const string pipelineManifest = """{"sprites":["sprite_9.jpg"]}""";
        _storage.ManifestJson = TwoSpriteManifest;
        _storage.OnOpenRead = () =>
        {
            using var ctx = NewContext();
            var row = ctx.Assets.Single(a => a.Id == asset.Id);
            row.FilmstripManifest = JsonDocument.Parse(pipelineManifest);
            ctx.SaveChanges();
        };

        var result = await AssetEndpoints.MediaUrls(
            project.Id, PrincipalFor(_userId), _db, _storage, TimeProvider.System,
            NullLoggerFactory.Instance, CancellationToken.None);

        Assert.IsType<Ok<MediaUrlsResponse>>(result);
        // İşleme hattının yazdığı kopya DURUYOR — backfill eski okumasıyla üzerine yazmadı.
        Assert.Equal(pipelineManifest, Reload(asset.Id).FilmstripManifest!.RootElement.GetRawText());
    }

    // ---------- Yardımcılar ----------

    /// <summary>
    /// withDbManifest: null = filmstrip'siz asset (varsayılan, eski testler);
    /// true = FilmstripKey + DB manifest kolonu dolu; false = FilmstripKey var, kolon NULL
    /// (geriye dönük asset — storage-yedek yolunu tetikler).
    /// </summary>
    private async Task<Asset> SeedReadyAssetAsync(Guid owner, bool? withDbManifest = null)
    {
        var asset = Asset.Create(
            owner, AssetKind.Video, "clip.mp4", "video/mp4", 1024, DateTimeOffset.UtcNow);
        asset.Status = AssetStatus.Ready;
        if (withDbManifest is not null)
        {
            asset.FilmstripKey = $"u/{owner}/a/{asset.Id}/filmstrip/manifest.json";
            if (withDbManifest == true)
            {
                asset.FilmstripManifest = JsonDocument.Parse(TwoSpriteManifest);
            }
        }

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

        /// <summary>OpenReadAsync bu JSON'u döndürür; null ise 404 fırlatır (obje yok).</summary>
        public string? ManifestJson { get; set; }
        public int OpenReadCount { get; private set; }

        /// <summary>Okuma ANINDA koşturulan kanca — backfill yarış testinin enjeksiyon noktası.</summary>
        public Action? OnOpenRead { get; set; }

        public Task<StorageDownload> OpenReadAsync(string key, CancellationToken ct = default)
        {
            OpenReadCount++;
            OnOpenRead?.Invoke();
            if (ManifestJson is null)
            {
                throw new AmazonS3Exception("not found") { StatusCode = HttpStatusCode.NotFound };
            }

            var bytes = System.Text.Encoding.UTF8.GetBytes(ManifestJson);
            var stream = new MemoryStream(bytes);
            return Task.FromResult(new StorageDownload(stream, bytes.Length, stream));
        }

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
