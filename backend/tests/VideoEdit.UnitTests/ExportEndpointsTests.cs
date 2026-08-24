using System.Security.Claims;
using System.Text.Json;
using Hangfire;
using Hangfire.States;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Api.Endpoints;
using VideoEdit.Contracts;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Storage;
using VideoEdit.Media.Export;
using VideoEdit.Media.Text;

namespace VideoEdit.UnitTests;

/// <summary>
/// ExportEndpoints davranış testleri (AssetEndpointsTests deseni: Sqlite in-memory + sahteler):
///  - POST exports: 202 + snapshot GÖMÜLÜ job + tek enqueue; sahiplik 404; cap 429;
///    desteklenmeyen doküman 422 (kuyruğa çöp atılmaz — job satırı da yazılmaz);
///  - GET /api/jobs/{id}: sahiplik; Succeeded export'ta 24h presigned downloadUrl;
///  - POST cancel: Queued/Running → Canceled + Hangfire delete; terminal → 409;
///  - GET exports listesi: yalnız o projenin export job'ları, sayfalı.
/// </summary>
public sealed class ExportEndpointsTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly RecordingJobClient _jobs = new();
    private readonly FakeExportStorage _storage = new();
    private readonly Guid _userId = Guid.CreateVersion7();

    public ExportEndpointsTests()
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

    /// <param name="seedAssets">
    /// Dokümanın atıfta bulunduğu her asset için kütüphanede bir satır oluşturulsun mu
    /// (varsayılan: evet). Senkron <c>asset-missing</c> kapısı eklenmeden ÖNCE bu testlerin
    /// çoğu var OLMAYAN asset'lere atıf yapıyordu ve API onları 202 ile kabul ediyordu; iş
    /// worker'da <c>asset-missing</c> ile düşerdi. Artık kapı API'de olduğu için "geçerli
    /// belge" testleri gerçek bir kütüphaneyle koşmak ZORUNDADIR — aksi halde ölçtükleri şey
    /// kabul değil, kaza eseri geçen bir ret olurdu.
    /// </param>
    private async Task<Project> SeedProjectAsync(
        Guid? owner = null, string? timelineJson = null, bool seedAssets = true)
    {
        var projectId = Guid.CreateVersion7();
        timelineJson ??= ExportTestDocs.ToJson(ExportTestDocs.Doc(
            projectId: projectId,
            clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000)));
        var project = new Project
        {
            Id = projectId,
            OwnerId = owner ?? _userId,
            Name = "test",
            Timeline = JsonDocument.Parse(timelineJson),
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        _db.Projects.Add(project);
        await _db.SaveChangesAsync();

        if (seedAssets)
        {
            await SeedReferencedAssetsAsync(timelineJson);
        }

        return project;
    }

    /// <summary>
    /// Dokümanın atıfta bulunduğu her asset için "sağlıklı" bir kütüphane satırı yazar
    /// (1920x1080, 1 saat, sesli). Zaten satırı olan id ATLANIR — testler kendi özel
    /// satırlarını (ör. afiş boyutu) <see cref="SeedAssetAsync"/> ile ÖNCE kurabilir.
    /// <para>
    /// Satırın TÜRÜ belgedeki kullanımından gelir (<see cref="ExportTestDocs.AssetKindFor"/>):
    /// çıkartma/görsel klibi bir GÖRSEL satırını, ses klibi bir SES satırını gösterir. Gerçek
    /// kütüphanede başka türlüsü kurulamaz ve <c>asset-clip-type</c> kapısı da bunu şart koşar.
    /// </para>
    /// </summary>
    private async Task SeedReferencedAssetsAsync(string timelineJson)
    {
        var doc = JsonSerializer.Deserialize<VideoEdit.Contracts.Timeline.TimelineDoc>(
            timelineJson, VideoEdit.Contracts.TimelineJson.Options)!;
        foreach (var id in ExportCompiler.ReferencedAssetIds(doc))
        {
            if (_db.Assets.Any(a => a.Id == id))
            {
                continue;
            }

            var kind = ExportTestDocs.AssetKindFor(doc, id);
            await SeedAssetAsync(
                id, 1920, 1080,
                // Görselin süresi ve sesi YOKTUR (ProcessAssetJob.GateByKind) — fixture
                // gerçek kütüphaneden ayrışmamalı.
                durationMicros: kind == AssetKind.Image ? null : 3_600_000_000,
                hasAudio: kind != AssetKind.Image,
                kind: kind);
        }
    }

    /// <summary>
    /// Depodaki GERÇEK <c>fonts/manifest.json</c> — font ön kontrolü (metin-overlay denetimi bulgu #1d)
    /// gerçek küratörlü id'lerle koşsun diye. Sağlayıcı yükleyemezse kontrol atlanır ve
    /// testler eskisi gibi davranır.
    /// </summary>
    private static readonly FontManifestProvider Fonts = new();

    /// <summary>
    /// Ölçüm yolu VARSAYILAN OLARAK YOKTUR (null): birim testleri kurulu font istemez ve
    /// kapının font-bağımsız ALT SINIR yarısını ölçer. Ölçümlü yol
    /// <see cref="StartExport_MeasuredTextWiderThanTheCeiling_Returns422_BeforeQueueing"/>'de
    /// sahte bir ölçerle sürülür.
    /// </summary>
    private Task<IResult> CallStartAsync(
        Guid projectId, string? profile = "1080p", ITextRasterService? measurer = null) =>
        ExportEndpoints.StartExport(
            projectId, new CreateExportRequest(profile), PrincipalFor(_userId), _db, _jobs,
            TimeProvider.System, Fonts, measurer, CancellationToken.None);

    // ---------- POST /api/projects/{id}/exports ----------

    [Fact]
    public async Task StartExport_ValidTimeline_Returns202_EmbedsSnapshot_EnqueuesOnce()
    {
        var project = await SeedProjectAsync();

        var result = await CallStartAsync(project.Id);

        var accepted = Assert.IsType<Accepted<ExportJobCreatedResponse>>(result);
        var job = _db.Jobs.Single(j => j.Id == accepted.Value!.JobId);
        Assert.Equal(JobType.Export, job.Type);
        Assert.Equal(JobStatus.Queued, job.Status);
        Assert.Equal(project.Id, job.ProjectId);
        Assert.Equal("1080p", job.ExportProfile);
        Assert.NotNull(job.HangfireJobId);
        Assert.Equal(1, _jobs.CreateCount);

        // Snapshot GÖMÜLÜDÜR (referans değil) — proje timeline'ı ile bayt-bayt aynı.
        Assert.NotNull(job.TimelineSnapshot);
        Assert.Equal(
            project.Timeline.RootElement.GetRawText(),
            job.TimelineSnapshot!.RootElement.GetRawText());
    }

    [Fact]
    public async Task StartExport_ForeignProject_Returns404()
    {
        var project = await SeedProjectAsync(owner: Guid.CreateVersion7());
        var result = await CallStartAsync(project.Id);
        Assert.IsType<NotFound>(result);
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_UnknownProfile_Returns400()
    {
        var project = await SeedProjectAsync();
        var result = await CallStartAsync(project.Id, profile: "8k-hdr");
        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status400BadRequest, problem.StatusCode);
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Theory]
    [InlineData("720p")]
    [InlineData("2160p")]
    public async Task StartExport_LandscapeProfiles_AreAcceptedOnTheDefaultCanvas_AndPersisted(
        string profile)
    {
        // Yeni profiller varsayılan (1920x1080, 16:9) tuvalde kuyruğa girer ve
        // İŞ KAYDINA profil ADI yazılır — worker o adı TryParse ile geri çözer.
        var project = await SeedProjectAsync();

        var accepted = Assert.IsType<Accepted<ExportJobCreatedResponse>>(
            await CallStartAsync(project.Id, profile: profile));
        Assert.Equal(profile, _db.Jobs.Single(j => j.Id == accepted.Value!.JobId).ExportProfile);
    }

    [Fact]
    public async Task StartExport_ProfileAspectMismatch_Returns422_WithTheFourthSentenceClass()
    {
        // 'dikey' (1080x1920) 16:9 tuvale uymaz: senkron tipli 422 — başlık BELGEYE değil
        // SEÇİME baktıran dördüncü cümle sınıfıdır, gövde uyumlu profilleri sayar.
        var project = await SeedProjectAsync();

        var problem = Assert.IsType<ProblemHttpResult>(
            await CallStartAsync(project.Id, profile: "dikey"));
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("export-profile-aspect", problem.ProblemDetails.Extensions["feature"]);
        Assert.Equal("Export profile does not match the project canvas.", problem.ProblemDetails.Title);
        Assert.Contains("1080p, 720p, 2160p", problem.ProblemDetails.Detail);
        Assert.Empty(_db.Jobs.ToList());
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_VerticalProfile_IsAcceptedOnAPortraitCanvas()
    {
        // Madalyonun öteki yüzü: 9:16 tuvalde 'dikey' kuyruğa girer (yanlış ret yok).
        var projectId = Guid.CreateVersion7();
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(ExportTestDocs.Doc(
            projectId: projectId,
            width: 1080, height: 1920,
            clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000))));

        var accepted = Assert.IsType<Accepted<ExportJobCreatedResponse>>(
            await CallStartAsync(project.Id, profile: "dikey"));
        Assert.Equal("dikey", _db.Jobs.Single(j => j.Id == accepted.Value!.JobId).ExportProfile);
    }

    [Fact]
    public async Task StartExport_ConcurrentCapReached_Returns429()
    {
        var project = await SeedProjectAsync();
        var now = DateTimeOffset.UtcNow;
        _db.Jobs.Add(Job.Create(JobType.Export, _userId, now, projectId: project.Id));
        var running = Job.Create(JobType.Export, _userId, now, projectId: project.Id);
        running.Status = JobStatus.Running;
        _db.Jobs.Add(running);
        await _db.SaveChangesAsync();

        var result = await CallStartAsync(project.Id);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status429TooManyRequests, problem.StatusCode);
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_TerminalJobsDoNotCountTowardCap()
    {
        var project = await SeedProjectAsync();
        var now = DateTimeOffset.UtcNow;
        foreach (var status in new[] { JobStatus.Succeeded, JobStatus.Failed, JobStatus.Canceled })
        {
            var job = Job.Create(JobType.Export, _userId, now, projectId: project.Id);
            job.Status = status;
            _db.Jobs.Add(job);
        }

        await _db.SaveChangesAsync();

        var result = await CallStartAsync(project.Id);
        Assert.IsType<Accepted<ExportJobCreatedResponse>>(result);
    }

    [Fact]
    public async Task StartExport_UnsupportedFeature_Returns422_WithoutQueueingGarbage()
    {
        // Kapsam dışı özellik — compiler ön-doğrulaması API'de koşar, kuyruğa hiç girmez.
        // (Geçiş + metin/şekil/çıkartma, hız + renk + transform/opaklık VE SES
        // SEVİYESİ keyframe'leri DESTEKLENİR; aşağıdaki *_Accepted testleri onları
        // sabitler. Burada kalan tipli hata kullanılır: ses klibine GÖRSEL opacity keyframe'i.)
        var clip = ExportTestDocs.AudioClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Keyframes = new VideoEdit.Contracts.Timeline.KeyframeTracks
        {
            Opacity = [ExportTestDocs.Kf(0, 1), ExportTestDocs.Kf(500_000, 0)],
        };
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.MultiTrackDoc(
            [
                ExportTestDocs.VideoTrack(clips:
                [
                    ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000),
                ]),
                ExportTestDocs.AudioTrack(clips: [clip]),
            ])));

        var result = await CallStartAsync(project.Id);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Contains("keyframe", problem.ProblemDetails.Detail, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(_db.Jobs.ToList()); // job satırı yazılmadı
        Assert.Equal(0, _jobs.CreateCount); // kuyruğa çöp atılmadı
    }

    /// <summary>
    /// Senkron kapıların defterini besleyen asset satırı. <paramref name="width"/>/
    /// <paramref name="height"/> null bırakılırsa "asset hâlâ işleniyor" hali simüle edilir
    /// (geometri kapısı ATLANMALI, yanlış 422 üretmemeli).
    /// </summary>
    private async Task SeedAssetAsync(
        Guid id, int? width, int? height,
        long? durationMicros = 3_600_000_000, string fileName = "banner.mp4",
        bool hasAudio = true, AssetKind kind = AssetKind.Video,
        AssetStatus status = AssetStatus.Ready)
    {
        _db.Assets.Add(new Asset
        {
            Id = id,
            OwnerId = _userId,
            Status = status,
            Kind = kind,
            OriginalFileName = fileName,
            StorageKey = $"u/{_userId}/a/{id}/original/source.mp4",
            ContentType = "video/mp4",
            SizeBytes = 1024,
            Width = width,
            Height = height,
            DurationMicros = durationMicros,
            HasAudio = hasAudio,
            CreatedAt = DateTimeOffset.UtcNow,
            ReadyAt = DateTimeOffset.UtcNow,
        });
        await _db.SaveChangesAsync();
    }

    /// <summary>1920x1080 tuvalde tek afiş klibi — <paramref name="scale"/> kapının kolu.</summary>
    private Task<Project> SeedBannerProjectAsync(double scale) => SeedProjectAsync(
        timelineJson: ExportTestDocs.ToJson(ExportTestDocs.Doc(clips:
            ExportTestDocs.VideoClip(
                ExportTestDocs.AssetA, 0, 0, 1_000_000,
                transform: ExportTestDocs.Transform(scale: scale)))));

    [Fact]
    public async Task StartExport_DegenerateLayer_Returns422_BeforeQueueing()
    {
        // Dejenerelik denetiminin ASIL BULGUSU. 1920x100 afiş + ölçek 0.010 → kutu 19x11; ffmpeg'in
        // sığdırdığı yükseklik 0.99 px'e düşer, filtre o ekseni 0 hesaplar ve katmanı 18x100
        // çizer. Kapı olmasaydı: PUT 200 → POST 202 → dakikalar sonra kartta "Başarısız"
        // (ffmpeg -22). Kural artık SENKRON: iş kuyruğa HİÇ girmez.
        await SeedAssetAsync(ExportTestDocs.AssetA, 1920, 100);
        var project = await SeedBannerProjectAsync(0.010);

        var result = await CallStartAsync(project.Id);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("degenerate-layer", problem.ProblemDetails.Extensions["feature"]);
        // Mesaj NEDENİ (kaynağın oranı) ve EYLEMİ (tek ve kesin bir sayı) taşımalı.
        Assert.Contains("1920x100", problem.ProblemDetails.Detail);
        Assert.Contains("en az 0.011", problem.ProblemDetails.Detail);
        Assert.Empty(_db.Jobs.ToList());   // job satırı yazılmadı
        Assert.Equal(0, _jobs.CreateCount); // kuyruğa çöp atılmadı
    }

    [Fact]
    public async Task StartExport_ScaleJustAboveTheDegenerateThreshold_IsAccepted()
    {
        // Kapının bir ızgara adımı ÜSTÜ kabul edilmeli — aksi halde 422 mesajının önerdiği sayı
        // yalan olurdu. Eşik: (ceil(1920/100) - 0.5)/1920 = 0.010156 → 0.011.
        await SeedAssetAsync(ExportTestDocs.AssetA, 1920, 100);
        var project = await SeedBannerProjectAsync(0.011);

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
    }

    [Fact]
    public async Task StartExport_NormalAspectSource_IsUnaffectedAtTheSmallestWritableScale()
    {
        // Kapı yalnız AŞIRI oranlı kaynakları görür. 16:9 bir video, editörün yazabildiği EN
        // KÜÇÜK ölçekte (0.01) bile dejenere olamaz — normal kullanıcı için davranış değişmez.
        await SeedAssetAsync(ExportTestDocs.AssetA, 1920, 1080);
        var project = await SeedBannerProjectAsync(0.010);

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
    }

    [Fact]
    public async Task StartExport_DegenerateLayerButUnknownSourceSize_IsStillAccepted()
    {
        // "Ölçüm yokluğu yanlış ret üretmez" presedanı (ExportCompiler.Validate'in
        // sourceSizes/overlayMeasurer sözleşmesiyle aynı):
        // asset hâlâ işleniyorsa Width/Height NULL'dur → kapı ATLANIR. Yarışta yanlış 422
        // vermektense worker'daki ffprobe yarısına bırakılır.
        await SeedAssetAsync(ExportTestDocs.AssetA, null, null);
        var project = await SeedBannerProjectAsync(0.010);

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
    }

    [Fact]
    public async Task StartExport_ForeignAsset_Returns422_AssetMissing()
    {
        // Defter SAHİPLİK filtresinden geçer. İki sonucu birden sabitler:
        //  (a) başkasının satırı GEOMETRİ kapısını besleyemez (aksi halde bir kullanıcı, id
        //      tahmin ederek başkasının belgesini reddettirebilirdi) — dolayısıyla 1920x100
        //      afiş boyutu burada HİÇ okunmaz ve ret 'degenerate-layer' DEĞİLDİR;
        //  (b) sahibi olmadığın bir varlığa atıf artık SENKRON 'asset-missing'tir. Eskiden
        //      POST 202 dönüyordu ve iş worker'da aynı kodla düşüyordu.
        _db.Assets.Add(new Asset
        {
            Id = ExportTestDocs.AssetA,
            OwnerId = Guid.CreateVersion7(), // BAŞKASININ
            Status = AssetStatus.Ready,
            Kind = AssetKind.Video,
            OriginalFileName = "banner.mp4",
            StorageKey = "u/x/a/y/original/source.mp4",
            ContentType = "video/mp4",
            SizeBytes = 1024,
            Width = 1920,
            Height = 100,
            CreatedAt = DateTimeOffset.UtcNow,
        });
        await _db.SaveChangesAsync();
        var project = await SeedProjectAsync(
            timelineJson: ExportTestDocs.ToJson(ExportTestDocs.Doc(clips:
                ExportTestDocs.VideoClip(
                    ExportTestDocs.AssetA, 0, 0, 1_000_000,
                    transform: ExportTestDocs.Transform(scale: 0.010)))),
            seedAssets: false);

        var problem = Assert.IsType<ProblemHttpResult>(await CallStartAsync(project.Id));
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("asset-missing", problem.ProblemDetails.Extensions["feature"]);
        Assert.Empty(_db.Jobs.ToList());
        Assert.Equal(0, _jobs.CreateCount);
    }

    // ---------- Asset OLGULARINA dayanan senkron kapılar (bu tur) ----------

    [Fact]
    public async Task StartExport_DeletedAsset_Returns422_BeforeQueueing()
    {
        // Soft-delete edilmiş varlık defterde YOKTUR → 'asset-missing'. Eskiden POST 202
        // dönüyor, iş worker'da aynı kodla düşüyordu.
        await SeedAssetAsync(ExportTestDocs.AssetA, 1920, 1080);
        var asset = _db.Assets.Single(a => a.Id == ExportTestDocs.AssetA);
        asset.DeletedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync();

        var project = await SeedProjectAsync(seedAssets: false);

        var problem = Assert.IsType<ProblemHttpResult>(await CallStartAsync(project.Id));
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("asset-missing", problem.ProblemDetails.Extensions["feature"]);
        Assert.Contains(ExportTestDocs.AssetA.ToString(), problem.ProblemDetails.Detail);
        Assert.Empty(_db.Jobs.ToList());
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_AssetStillProcessing_IsNotMissing()
    {
        // YANLIŞ RET KONTROLÜ. Satır VAR ama ölçüleri henüz yok (Width/Height/Duration null,
        // Status=Processing). 'asset-missing' SATIR YOKLUĞUNA bakar, alan yokluğuna değil;
        // ayrıca 'asset-not-ready' BİLEREK senkron değildir — iş kuyruktan alınana kadar
        // asset Ready olabilir.
        await SeedAssetAsync(ExportTestDocs.AssetA, null, null, durationMicros: null);
        var asset = _db.Assets.Single(a => a.Id == ExportTestDocs.AssetA);
        asset.Status = AssetStatus.Processing;
        await _db.SaveChangesAsync();

        var project = await SeedProjectAsync(seedAssets: false);

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
    }

    [Fact]
    public async Task StartExport_ClipReadingPastTheSourceEnd_Returns422_BeforeQueueing()
    {
        // Kural eskiden YALNIZ worker'daydı (indirme + ffprobe SONRASI). Aynı sayı DB'de
        // duruyordu: Asset.DurationMicros'u ProcessAssetJob MediaProbe.DurationUs'ten yazar.
        await SeedAssetAsync(ExportTestDocs.AssetA, 1920, 1080, durationMicros: 10_000_000);
        var project = await SeedProjectAsync(
            timelineJson: ExportTestDocs.ToJson(ExportTestDocs.Doc(clips:
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 12_000_000, 20_000_000))),
            seedAssets: false);

        var problem = Assert.IsType<ProblemHttpResult>(await CallStartAsync(project.Id));
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("source-out-of-range", problem.ProblemDetails.Extensions["feature"]);
        Assert.Contains("20000000", problem.ProblemDetails.Detail); // istenen
        Assert.Contains("10000000", problem.ProblemDetails.Detail); // gerçek süre
        Assert.Empty(_db.Jobs.ToList());
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_ClipEndingExactlyAtTheSourceEnd_IsAccepted()
    {
        // SINIRIN ÖBÜR YANI: kaynağın tam sonuna kadar okuyan klip REDDEDİLMEZ. (Worker'daki
        // kapı 1 çıktı frame'i tolerans tanır ve senkron kapı AYNI fonksiyonu çağırır.)
        await SeedAssetAsync(ExportTestDocs.AssetA, 1920, 1080, durationMicros: 10_000_000);
        var project = await SeedProjectAsync(
            timelineJson: ExportTestDocs.ToJson(ExportTestDocs.Doc(clips:
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 10_000_000))),
            seedAssets: false);

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
    }

    [Fact]
    public async Task StartExport_SourceRangeGateSkippedWhenDurationUnknown()
    {
        // "Ölçüm yokluğu yanlış ret üretmez": süre kolonu boşsa (asset hâlâ işleniyor) kapı
        // ATLANIR ve worker'ın ffprobe yarısı emniyet kemeri kalır.
        await SeedAssetAsync(ExportTestDocs.AssetA, 1920, 1080, durationMicros: null);
        var project = await SeedProjectAsync(
            timelineJson: ExportTestDocs.ToJson(ExportTestDocs.Doc(clips:
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 12_000_000, 20_000_000))),
            seedAssets: false);

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
    }

    [Fact]
    public async Task StartExport_LutEffectPointingAtANonCubeAsset_Returns422_BeforeQueueing()
    {
        // ÖLÇÜLEN KUSUR: bu belge TİPLİ HATA BİLE ÜRETMİYORDU — worker .cube sanıp bir .mp4
        // yolunu lut3d'ye veriyor, ffmpeg 'ffmpeg-failed: exited with code -22' ile ölüyordu.
        await SeedAssetAsync(ExportTestDocs.AssetA, 1920, 1080);
        await SeedAssetAsync(ExportTestDocs.AssetC, 1920, 1080, fileName: "holiday-clip.mp4");
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Effects = [ExportTestDocs.Lut(ExportTestDocs.AssetC)];
        var project = await SeedProjectAsync(
            timelineJson: ExportTestDocs.ToJson(ExportTestDocs.Doc(clips: clip)),
            seedAssets: false);

        var problem = Assert.IsType<ProblemHttpResult>(await CallStartAsync(project.Id));
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("lut-asset-type", problem.ProblemDetails.Extensions["feature"]);
        Assert.Contains("holiday-clip.mp4", problem.ProblemDetails.Detail);
        Assert.Contains(".cube", problem.ProblemDetails.Detail);
        Assert.Empty(_db.Jobs.ToList());
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_LutEffectPointingAtACubeAsset_IsAccepted()
    {
        // SINIRIN ÖBÜR YANI: gerçek bir .cube reddedilMEZ (kapı "LUT yasak" demiyor).
        await SeedAssetAsync(ExportTestDocs.AssetA, 1920, 1080);
        await SeedAssetAsync(ExportTestDocs.AssetC, 1920, 1080, fileName: "Teal-Orange.CUBE");
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Effects = [ExportTestDocs.Lut(ExportTestDocs.AssetC)];
        var project = await SeedProjectAsync(
            timelineJson: ExportTestDocs.ToJson(ExportTestDocs.Doc(clips: clip)),
            seedAssets: false);

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
    }

    [Fact]
    public async Task StartExport_TransitionWithDifferentPlacements_Returns422_BeforeQueueing()
    {
        // "Kural yalnız Compile'da yaşıyor" sınıfının ölçülen üyelerinden biri: bu belge
        // POST 202 alıyor, iş worker'da düşüyordu. Kural artık Validate'te.
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5));
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000,
            transform: ExportTestDocs.Transform(scale: 0.25));
        ExportTestDocs.Link(a, b, 400_000);
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: [a, b])));

        var problem = Assert.IsType<ProblemHttpResult>(await CallStartAsync(project.Id));
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Contains("yerleşimi", problem.ProblemDetails.Detail);
        Assert.Empty(_db.Jobs.ToList());
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_TransitionWithTheSamePlacement_IsAccepted()
    {
        // SINIRIN ÖBÜR YANI: aynı yerleşimli geçiş (editörün ürettiği şekil) kabul edilir.
        var placement = ExportTestDocs.Transform(scale: 0.5);
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000,
            transform: placement);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000,
            transform: placement);
        ExportTestDocs.Link(a, b, 400_000);
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: [a, b])));

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
    }

    [Fact]
    public async Task StartExport_SharedSampleBudget_Returns422_AndTheSuggestedFixIsAccepted()
    {
        // İŞ 3'ÜN HTTP KARŞILIĞI. Aynı belge iki kez: eğrili easing → 422 (paylaşımlı bütçe
        // mesajıyla), YALNIZ easing lineere çevrilmiş hali → 202. Yani 422'nin önerdiği eylem
        // GERÇEKTEN çalışıyor — mesajın vaadi ölçülüyor, iddia edilmiyor.
        var curved = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.CurvedScaleDoc(clipCount: 17)));

        var problem = Assert.IsType<ProblemHttpResult>(await CallStartAsync(curved.Id));
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("keyframe-sample-budget", problem.ProblemDetails.Extensions["feature"]);
        Assert.Contains("ORTAK örnekleme bütçesini aşıyor", problem.ProblemDetails.Detail);
        Assert.Contains("TÜM kliplere", problem.ProblemDetails.Detail);
        Assert.Contains("LİNEER yapın", problem.ProblemDetails.Detail);
        Assert.Empty(_db.Jobs.ToList());

        var linear = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.LinearScaleDoc(clipCount: 17)));
        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(linear.Id));
    }

    [Fact]
    public async Task StartExport_VolumeKeyframeBudget_IsNotChargedWhenTheSourceHasNoAudio()
    {
        // Ses bütçesinin EMNİYETLİ yönü: derleyici ses zincirini yalnız kaynakta stream VARSA
        // kurar. Defterde HasAudio=false ise kapı o kanalı SAYMAZ — eksik saymak kapıyı
        // zayıflatır, fazla saymak YANLIŞ RET üretirdi.
        var doc = VolumeBudgetDoc(clipCount: 40);
        await SeedAssetAsync(ExportTestDocs.AssetA, 1920, 1080, hasAudio: false);
        var silent = await SeedProjectAsync(
            timelineJson: ExportTestDocs.ToJson(doc), seedAssets: false);
        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(silent.Id));

        // Aynı belge, sesli kaynak → bütçe aşılır ve mesaj SES kanalının işe yarayan eylemini
        // söyler (lineer easing ses tarafında bütçeyi düşürmez).
        _db.Assets.Single(a => a.Id == ExportTestDocs.AssetA).HasAudio = true;
        await _db.SaveChangesAsync();
        var audible = await SeedProjectAsync(
            timelineJson: ExportTestDocs.ToJson(doc), seedAssets: false);

        var problem = Assert.IsType<ProblemHttpResult>(await CallStartAsync(audible.Id));
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("keyframe-sample-budget", problem.ProblemDetails.Extensions["feature"]);
        Assert.Contains("ses seviyesi (volume) animasyonu", problem.ProblemDetails.Detail);
        Assert.Contains("daha AZ klipte", problem.ProblemDetails.Detail);
        Assert.Contains("DÜŞÜRMEZ", problem.ProblemDetails.Detail);
    }

    /// <summary>
    /// <paramref name="clipCount"/> adet 60 sn'lik sesli video klip, her birinde volume
    /// keyframe'i. 60 sn @30fps = 1800 örnek/klip → 40 klip = 72 000 &gt; 60 000.
    /// </summary>
    private static VideoEdit.Contracts.Timeline.TimelineDoc VolumeBudgetDoc(int clipCount)
    {
        const long durationUs = 60_000_000;
        var clips = new List<VideoEdit.Contracts.Timeline.Clip>(clipCount);
        for (var i = 0; i < clipCount; i++)
        {
            var clip = ExportTestDocs.VideoClip(
                ExportTestDocs.AssetA, i * durationUs, 0, durationUs,
                audio: ExportTestDocs.Audio());
            clip.Keyframes = new VideoEdit.Contracts.Timeline.KeyframeTracks
            {
                Volume = [ExportTestDocs.Kf(0, 1.0), ExportTestDocs.Kf(durationUs, 0.2)],
            };
            clips.Add(clip);
        }

        return ExportTestDocs.Doc(clips: [.. clips]);
    }

    // ---------- Keyframe zamanının klip süresi ÜST SINIRI ----------

    [Fact]
    public async Task StartExport_KeyframeBeyondTheClipDuration_Returns422_BeforeQueueing()
    {
        // ÖLÇÜLEN KUSUR: zod belge kapısı bu dokümanı "keyframe timeUs 9600000 is outside
        // [0, 5000000]" ile reddederken C# hiçbir katmanda üst sınıra bakmıyordu — ham API'yle
        // PUT 200 + POST 202 + iş succeeded, ama çıktı SESSİZCE YANLIŞTI: opacity rampası klip
        // süresinin ötesinde tanımlı olduğundan ffmpeg animasyonu son örneklenen değerde (~0.52
        // alpha) donduruyordu. Kapı artık senkron ve zod'la aynı cümleyi kurar. Sayılar ölçülen
        // vakanın kendisidir: 5 sn'lik klip, 9.6 sn'de keyframe.
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 5_000_000);
        clip.Keyframes = new VideoEdit.Contracts.Timeline.KeyframeTracks
        {
            Opacity = [ExportTestDocs.Kf(0, 0), ExportTestDocs.Kf(2_500_000, 0.5),
                       ExportTestDocs.Kf(9_600_000, 1)],
        };
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: clip)));

        var problem = Assert.IsType<ProblemHttpResult>(await CallStartAsync(project.Id));
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Contains("outside [0, 5000000]", problem.ProblemDetails.Detail);
        Assert.Contains("9600000", problem.ProblemDetails.Detail);
        Assert.Empty(_db.Jobs.ToList());    // job satırı yazılmadı
        Assert.Equal(0, _jobs.CreateCount); // kuyruğa çöp atılmadı
    }

    [Fact]
    public async Task StartExport_KeyframeExactlyAtTheClipDuration_IsAccepted()
    {
        // SINIRIN ÖBÜR YANI (zod paritesi): üst sınır KAPSAYICIDIR — timeUs == süre, editörün
        // rampaları bitirdiği olağan yerdir; zod da kabul eder, kapı da REDDETMEMELİ.
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 5_000_000);
        clip.Keyframes = new VideoEdit.Contracts.Timeline.KeyframeTracks
        {
            Opacity = [ExportTestDocs.Kf(0, 0), ExportTestDocs.Kf(5_000_000, 1)],
        };
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: clip)));

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
    }

    [Fact]
    public async Task StartExport_VolumeKeyframeBeyondTheClipDuration_Returns422_BeforeQueueing()
    {
        // Kapı TEK NOKTADAN kurulur (KeyframeCompiler.Track): ses seviyesi kanalı görsel
        // kanallarla AYNI yoldan geçer. Bu test o tekliği HTTP düzeyinde ölçer — volume
        // keyframe'i de süre ötesinde 422 alır, kuyruğa girmez.
        var clip = ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 5_000_000, ExportTestDocs.Audio());
        clip.Keyframes = new VideoEdit.Contracts.Timeline.KeyframeTracks
        {
            Volume = [ExportTestDocs.Kf(0, 1), ExportTestDocs.Kf(9_600_000, 0)],
        };
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: clip)));

        var problem = Assert.IsType<ProblemHttpResult>(await CallStartAsync(project.Id));
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Contains("outside [0, 5000000]", problem.ProblemDetails.Detail);
        Assert.Empty(_db.Jobs.ToList());
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_UnknownFontId_Returns422_BeforeQueueing()
    {
        // Metin-overlay denetimi, bulgu #1(d): manifestte olmayan bir fontId raster aşamasında
        // 'font-missing' ile düşer — dakikalar sonra. Ön kontrol onu KUYRUĞA HİÇ SOKMAZ.
        // ('inter' tam olarak editörün eski varsayılanıydı; sunucuda hiç var olmadı.)
        Assert.NotNull(Fonts.Manifest);
        var clip = ExportTestDocs.TextClip(0, 1_000_000);
        clip.Text!.FontId = "inter";
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: clip)));

        var result = await CallStartAsync(project.Id);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Contains("inter", problem.ProblemDetails.Detail);
        Assert.Equal("font-missing", problem.ProblemDetails.Extensions["feature"]);
        Assert.Empty(_db.Jobs.ToList());
        Assert.Equal(0, _jobs.CreateCount);
    }

    [FontFact]
    public async Task StartExport_UnknownFontId_WithALiveMeasurer_StillReturns422_NotA503()
    {
        // BU TESTİN VAR OLMA SEBEBİ: yukarıdaki test ölçer VERMEDEN koşar, yani CANLI ölçüm
        // yolunu hiç sürmez. Canlı ölçerle aynı belge (bilinmeyen fontId) ölçümü PATLATIR;
        // ölçüm hatası KURULUM arızası sayıldığı sürece kullanıcı 503 "yeniden deneyin" alır
        // ve o istek asla çalışmaz — kusur belgededir, kurulumda değil.
        //
        // Ölçer GERÇEKTİR (SkiaOverlayRasterService): sahte bir ölçer bu kusuru gösteremez,
        // çünkü kusur tam olarak "gerçek ölçerin fırlattığı FontNotFoundException'ın nasıl
        // sınıflandırıldığı"dır. 'inter' editörün ESKİ varsayılanıdır — bu belge uydurma
        // değil, sahadaki eski projelerin taşıdığı belgedir.
        Assert.NotNull(Fonts.Manifest);
        Assert.DoesNotContain("inter", Fonts.Manifest!.Fonts.Keys, StringComparer.Ordinal);

        var clip = ExportTestDocs.TextClip(0, 1_000_000);
        clip.Text!.FontId = "inter";
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: clip)));

        using var measurer = TestFonts.CreateService();
        var problem = Assert.IsType<ProblemHttpResult>(
            await CallStartAsync(project.Id, measurer: measurer));

        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("font-missing", problem.ProblemDetails.Extensions["feature"]);
        Assert.Empty(_db.Jobs.ToList());
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_UnknownFontId_IsAnsweredWithoutMeasuringAnything()
    {
        // ÖN KONTROLÜN SIRASININ ÖLÇÜLEBİLİR SONUCU. Manifest tek başına KESİN cevabı
        // veriyorken (id manifestte yok → bu belge hiçbir kurulumda render edilemez) ölçüm
        // DENENMEZ. Sıra tersine dönerse aynı belge önce ölçümü patlatır; cevabın doğru
        // kalması o zaman tamamen ikinci mekanizmaya (derleyicinin istisna sınıflandırması)
        // bağlı olur ve 503'e kayma riski geri gelir.
        //
        // NOT: 422'nin kendisi bu sırayı KANITLAMAZ (ölçüm patlasa da tipli hata aynı kodu
        // verir) — kanıt ölçerin HİÇ ÇAĞRILMAMASIDIR.
        Assert.NotNull(Fonts.Manifest);
        var clip = ExportTestDocs.TextClip(0, 1_000_000);
        clip.Text!.FontId = "inter";
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: clip)));

        var measurer = new CountingTextMeasurer();
        var problem = Assert.IsType<ProblemHttpResult>(
            await CallStartAsync(project.Id, measurer: measurer));

        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("font-missing", problem.ProblemDetails.Extensions["feature"]);
        Assert.Equal(0, measurer.MeasureCalls);
    }

    [Fact]
    public async Task StartExport_KnownFontId_DoesReachTheMeasurer()
    {
        // Yukarıdaki "0 çağrı" iddiasının negatif kontrolü: sayaç her belgede 0 kalmıyor.
        // Bu olmadan MeasureCalls==0, ölçerin hiç bağlanmamış olmasıyla da açıklanabilirdi.
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: ExportTestDocs.TextClip(0, 1_000_000))));

        var measurer = new CountingTextMeasurer();
        Assert.IsType<Accepted<ExportJobCreatedResponse>>(
            await CallStartAsync(project.Id, measurer: measurer));

        Assert.Equal(1, measurer.MeasureCalls);
    }

    [FontFact]
    public async Task StartExport_CuratedFontIdWithALiveMeasurer_IsAccepted()
    {
        // Yukarıdaki 422'nin negatif kontrolü: CANLI ölçer her metni reddetmiyor. Ölçüm
        // gerçekten koşuyor (kurulu bir fontla) ve belge kuyruğa giriyor — yani 422 ölçüm
        // yolunun kendisinden değil, YALNIZ bilinmeyen fontId'den doğuyor.
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: ExportTestDocs.TextClip(0, 1_000_000))));

        using var measurer = TestFonts.CreateService();
        Assert.IsType<Accepted<ExportJobCreatedResponse>>(
            await CallStartAsync(project.Id, measurer: measurer));
    }

    [Fact]
    public async Task StartExport_CuratedFontId_IsAccepted()
    {
        // Negatif kontrolün diğer yarısı: küratörlü id 422 YEMEZ (ön kontrol her metni
        // reddetmiyor, yalnız manifestte olmayanı).
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: ExportTestDocs.TextClip(0, 1_000_000))));

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
    }

    [Fact]
    public async Task StartExport_SplitClipsFromTheEditor_Accepted()
    {
        // TESLİM RED BLOCKER'ININ HTTP KARŞILIĞI. Aşağıdaki üç klip uydurma değildir:
        // apps/editor/e2e/frame-grid.spec.ts, 30 fps'lik VARSAYILAN projede GERÇEK fare +
        // GERÇEK klavye ile bir klibi iki kez böldüğünde dokümanda tam olarak bu değerler
        // oluşur (ortadaki klip 1 kare: frame 1861 -> 1862, yani 33_334 µs).
        //
        // Eski kapı SÜREYİ ızgarada istiyordu ve bu istek bu belgeyi
        //   "clip ... is not aligned to the project frame grid (30/1 fps):
        //    timelineStartUs=62033333, timelineDurationUs=33334"
        // diyerek 422 ile geri çeviriyordu — kullanıcı klibi bölüyor, kaydediyor (PUT 200),
        // sonra dışa aktaramıyordu. Kapı KENARLARA taşındı; bu belge artık kuyruğa girer.
        var doc = ExportTestDocs.Doc(fpsNum: 30, fpsDen: 1, clips: [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 60_000_000, 0, 2_033_333),
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 62_033_333, 2_033_333, 2_066_667),
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 62_066_667, 2_066_667, 6_000_000),
        ]);
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(doc));

        var result = await CallStartAsync(project.Id);

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(result);
    }

    [Fact]
    public async Task StartExport_ClipEdgeOffFrameGrid_Returns422_WithoutQueueingGarbage()
    {
        // Kapının diğer yarısı: KENAR ızgara dışındaysa belge hâlâ reddedilir (kapı
        // gevşetilmedi, YERİ değişti). Başlangıç 60_000_001 → hiçbir kare sınırı değil.
        var doc = ExportTestDocs.Doc(fpsNum: 30, fpsDen: 1,
            clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 60_000_001, 0, 2_000_000));
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(doc));

        var result = await CallStartAsync(project.Id);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Contains("edges are not on the project frame grid", problem.ProblemDetails.Detail);
        Assert.Empty(_db.Jobs);
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_TransitionsAndOverlayClips_Accepted()
    {
        // Editör geçiş + metin/şekil/çıkartma üretiyor — ön-doğrulama
        // bunları REDDETMEMELİ (aksi halde kullanıcı emeğini kaybeder).
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000);
        ExportTestDocs.Link(a, b, 400_000);
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.OverlayTrack(clips:
            [
                ExportTestDocs.TextClip(0, 1_000_000),
                ExportTestDocs.StickerClip(ExportTestDocs.AssetC, 1_000_000, 1_000_000),
            ]),
            ExportTestDocs.VideoTrack(clips: [a, b]),
        ]);
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(doc));

        var result = await CallStartAsync(project.Id);

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(result);
    }

    [Fact]
    public async Task StartExport_MultipleLayers_Accepted()
    {
        // Editör çok katman üretiyor — ön-doğrulama bunu REDDETMEMELİ.
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 1_000_000,
                    transform: ExportTestDocs.Transform(x: 0.25, scale: 0.4), opacity: 0.75),
            ]),
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000)]),
            ExportTestDocs.AudioTrack(clips:
                [ExportTestDocs.AudioClip(ExportTestDocs.AssetC, 0, 0, 2_000_000)]),
        ]);
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(doc));

        var result = await CallStartAsync(project.Id);

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(result);
        Assert.Single(_db.Jobs.ToList());
        Assert.Equal(1, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_EmptyExtraTracks_Accepted()
    {
        // Editörün +V/+A ile eklediği BOŞ track'ler export'u 422'ye düşürmez — yok sayılır.
        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        doc.Tracks.Add(new VideoEdit.Contracts.Timeline.Track
        {
            Id = Guid.CreateVersion7(),
            Type = VideoEdit.Contracts.Timeline.TrackType.Overlay,
            Clips = [],
        });
        doc.Tracks.Add(new VideoEdit.Contracts.Timeline.Track
        {
            Id = Guid.CreateVersion7(),
            Type = VideoEdit.Contracts.Timeline.TrackType.Audio,
            Clips = [],
        });
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(doc));

        var result = await CallStartAsync(project.Id);

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(result);
        Assert.Equal(1, _jobs.CreateCount);
    }

    // ---------- Raster katman tavanı ----------

    [Fact]
    public async Task StartExport_HugeTextLayer_Returns422_BeforeQueueing()
    {
        // BLOCKER'IN HTTP KARŞILIĞI. Baş mimarın canlı ölçümü tam olarak buydu: fontSizePx
        // 2000 + tek uzun satır + scale 4 → PUT 200, POST /exports 202, ve iş worker'da
        // düştü. Kural artık Validate'te: kutu ALT SINIRI bile 2000*1.2*4 = 9600 px, yani
        // 8192 tavanını kesinlikle aşıyor → 422, kuyruğa hiç girmiyor. (Ölçer VERİLMEDİ:
        // kapı fontlar kurulu olmadan da tutuyor.)
        var clip = ExportTestDocs.TextClip(0, 1_000_000,
            content: new string('A', 400),
            transform: ExportTestDocs.Transform(scale: 4));
        clip.Text!.FontSizePx = 2000;
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: clip)));

        var result = await CallStartAsync(project.Id);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("transform-scale", problem.ProblemDetails.Extensions["feature"]);
        Assert.Contains("8192", problem.ProblemDetails.Detail);
        Assert.Empty(_db.Jobs.ToList()); // job satırı yazılmadı
        Assert.Equal(0, _jobs.CreateCount); // kuyruğa çöp atılmadı
    }

    [Fact]
    public async Task StartExport_MeasuredTextWiderThanTheCeiling_Returns422_BeforeQueueing()
    {
        // Alt sınırın GÖREMEDİĞİ vaka: kutu YÜKSEKLİKTEN değil GENİŞLİKTEN taşıyor (uzun tek
        // satır, küçük punto). Genişliğin font-bağımsız bir alt sınırı yoktur → kapı ancak
        // ÖLÇÜM yolu varsa tutar. Sahte ölçer gerçek fontlara ihtiyaç duymadan o yolu sürer.
        var clip = ExportTestDocs.TextClip(0, 1_000_000, content: new string('W', 3000));
        clip.Text!.FontSizePx = 100; // alt sınır yüksekliği yalnız 120 px → kapıyı tetiklemez
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: clip)));

        // Ölçer YOKken belge kabul edilir (alt sınır kapısı bu vakayı göremez) —
        // negatif kontrolün yarısı: aşağıdaki 422 ölçümden geliyor, başka bir şeyden değil.
        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
        _db.Jobs.RemoveRange(_db.Jobs);
        await _db.SaveChangesAsync();

        var result = await CallStartAsync(
            project.Id, measurer: new FakeTextMeasurer(widthPx: 165_000, heightPx: 120));

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("overlay-too-large", problem.ProblemDetails.Extensions["feature"]);
        Assert.Empty(_db.Jobs.ToList());
    }

    [Fact]
    public async Task StartExport_SystemFontMeasurement_DoesNotDecideTheCeiling()
    {
        // Ölçülen denetim bulgusu. Küratörlü TTF kurulu DEĞİLKEN ölçüm bir SİSTEM fontuyla yapılır ve
        // o kutu, worker'ın çizeceği küratörlü kutunun ne üst ne alt sınırıdır — ÖLÇÜLDÜ
        // (Windows 11 + SkiaSharp 3.116.1, küratörlü set ↔ Arial/Segoe UI/Times New Roman;
        // 4 fontId × 3 punto × 2 ağırlık × 5 metin): bbox genişliği -21,1% … +7,9%, yüksekliği
        // en çok 3,8% ayrışıyor. Kapı ona güvenirse 8192 px'lik üst sınır KURULUM DURUMUNA
        // bağlanır: aynı belge fontları indirilmiş makinede kabul, indirilmemişte RET alır.
        //
        // Kural: pinlenmemiş ölçüm kutuyu KESİNLEŞTİRMEZ; kapı font-bağımsız alt sınıra düşer.
        // (Gerçek tavan render anında çizilen rasterin GERÇEK kutusuyla sorulmaya devam eder.)
        var clip = ExportTestDocs.TextClip(0, 1_000_000, content: new string('W', 3000));
        clip.Text!.FontSizePx = 100; // alt sınır yüksekliği 120 px → alt sınır kapısı tetiklenmez
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: clip)));

        var result = await CallStartAsync(
            project.Id,
            measurer: new FakeTextMeasurer(widthPx: 165_000, heightPx: 120, deterministic: false));

        // Aynı sayılar PİNLİ ölçümle 422 üretiyordu
        // (StartExport_MeasuredTextWiderThanTheCeiling_Returns422_BeforeQueueing) — fark
        // yalnız ölçümün belirlenimciliğinden geliyor.
        Assert.IsType<Accepted<ExportJobCreatedResponse>>(result);
        Assert.Single(_db.Jobs.ToList());

        // VE 503 DEĞİL: ölçüm patlamadı, yalnız pinli değil. 503 olsaydı fontları indirilmemiş
        // her kurulumda metin içeren HER export isteği reddedilirdi.
        Assert.Equal(1, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_SystemFontMeasurement_StillRejectsWhatTheLowerBoundCanSee()
    {
        // Kapı KAPANMIYOR, yalnız font-bağımsız yarısına düşüyor: yükseklikten taşan kutu
        // (fontSizePx × lineHeight × satır) ölçerden BAĞIMSIZ kesindir ve reddedilmeye devam eder.
        var clip = ExportTestDocs.TextClip(0, 1_000_000, content: "TEK SATIR");
        clip.Text!.FontSizePx = 9000; // alt sınır yüksekliği 10800 px > 8192
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: clip)));

        var problem = Assert.IsType<ProblemHttpResult>(await CallStartAsync(
            project.Id,
            measurer: new FakeTextMeasurer(widthPx: 10, heightPx: 10, deterministic: false)));

        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("overlay-too-large", problem.ProblemDetails.Extensions["feature"]);
        Assert.Empty(_db.Jobs.ToList());
    }

    [Fact]
    public async Task StartExport_MeasurementFailure_Returns503_NotBlamingTheDocument()
    {
        // İŞ 4 KARARI. Ölçüm bir ALTYAPI işidir (font kökü, manifest, Skia) ve patladığında:
        //  - metin katmanı kapıları alt sınıra düşer (gerçek ihlaller görünmez olur),
        //  - worker aynı Skia + font köküne muhtaç olduğu için metin export'u ZATEN düşer.
        // Eski davranış "202 → dakikalar → başarısız"tı. Yeni davranış SENKRON 503:
        // kullanıcı anında öğrenir, iş kuyruğa girmez, ama belge SUÇLANMAZ (422 değil) —
        // kusur kurulumdadır ve istek yeniden denenebilir.
        //
        // ÖLÇER GERÇEKTEN KURULUM ARIZASI MODELLER (FontNotFoundException.FileMissing: id
        // manifestte tanımlı, TTF diskte yok). Belge kaynaklı ölçüm hatasının karşılığı artık
        // 422'dir — bkz. StartExport_MeasurerDoesNotKnowTheFont_Returns422_NotA503.
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: ExportTestDocs.TextClip(0, 1_000_000))));

        var problem = Assert.IsType<ProblemHttpResult>(
            await CallStartAsync(project.Id, measurer: new ThrowingTextMeasurer()));

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, problem.StatusCode);
        Assert.Equal("text-measure-unavailable", problem.ProblemDetails.Extensions["feature"]);
        Assert.Empty(_db.Jobs.ToList());
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_MeasurerDoesNotKnowTheFont_Returns422_NotA503()
    {
        // 503'ÜN DAR OLDUĞUNUN İKİNCİ YARISI (yukarıdaki testin AYNADAKİ hali): ölçüm YİNE
        // patlıyor, ama bu kez sebep kurulum değil BELGE — ölçerin manifestinde böyle bir
        // fontId yok. Belgedeki id API'nin manifestinde VARDIR ('roboto'), yani ön kontrol
        // bu belgeyi geçirir ve karar derleyicinin sınıflandırmasına kalır.
        //
        // İki okuyucunun ayrışması yapay değildir: API sürecinin FontManifestProvider'ı ile
        // ölçerin kendi manifesti ayrı ayrı yüklenir (biri açılışta, diğeri ilk kullanımda) —
        // dosya arada değişirse ya da worker/API farklı font köklerine bakarsa ayrışırlar.
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: ExportTestDocs.TextClip(0, 1_000_000))));

        var problem = Assert.IsType<ProblemHttpResult>(
            await CallStartAsync(project.Id, measurer: new UnknownFontMeasurer()));

        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Equal("font-missing", problem.ProblemDetails.Extensions["feature"]);
        Assert.Empty(_db.Jobs.ToList());
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_MeasurementFailureWithoutTextClips_IsUnaffected()
    {
        // İŞ 4 kararının SINIRI (negatif kontrol): 503 yalnız ÖLÇÜM GEREKTİREN klipler için
        // doğar. Şeklin kutusu sözleşme gereği proje karesidir (ölçüm YOK) ve medya klibi
        // rastere hiç girmez — patlayan bir ölçer bu belgeleri etkilemez.
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.MultiTrackDoc(
            [
                ExportTestDocs.OverlayTrack(clips: [ExportTestDocs.ShapeClip(0, 1_000_000)]),
                ExportTestDocs.VideoTrack(clips:
                    [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000)]),
            ])));

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(
            await CallStartAsync(project.Id, measurer: new ThrowingTextMeasurer()));
    }

    [Fact]
    public async Task StartExport_NoMeasurerRegistered_KeepsTheOldLenientBehaviour()
    {
        // 503 kararı "ölçüm DENENDİ ve BAŞARISIZ oldu" olgusuna bağlıdır. Hiç ölçer
        // kaydedilmemiş bir kurulumda (birim testlerinin varsayılanı) davranış DEĞİŞMEZ:
        // kapı alt sınırdan sorulur, belge kabul edilir.
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: ExportTestDocs.TextClip(0, 1_000_000))));

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
    }

    [Fact]
    public async Task StartExport_NormalTextLayer_IsStillAccepted()
    {
        // Kapının negatif kontrolü: 64 px / tek satır / scale 2 (= 153.6 px kutu) REDDEDİLMEZ.
        var clip = ExportTestDocs.TextClip(0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 2));
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: clip)));

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
    }

    [Fact]
    public async Task StartExport_InvalidTextFill_Returns422_BeforeQueueing()
    {
        // ÖLÇÜLDÜ (ham API, düzeltmeden önce): POST 202 → worker dakikalar sonra
        // 'overlay-unsupported-clip' ile failed. Renk dilbilgisi SAF DOKÜMAN kuralıdır —
        // ne dosya, ne asset, ne font gerekir — dolayısıyla senkron kapıda yaşamalıdır.
        var clip = ExportTestDocs.TextClip(0, 1_000_000);
        clip.Text!.Fill = "rgb(1,2,3)"; // şema #RGB / #RRGGBB / #RRGGBBAA ister
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: clip)));

        var problem = Assert.IsType<ProblemHttpResult>(await CallStartAsync(project.Id));

        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        // Kod raster hattının koduyla AYNI: kusur aynı, kapı farklı.
        Assert.Equal("overlay-unsupported-clip", problem.ProblemDetails.Extensions["feature"]);
        Assert.Contains("text.fill", problem.ProblemDetails.Detail, StringComparison.Ordinal);
        Assert.Empty(_db.Jobs.ToList());
        Assert.Equal(0, _jobs.CreateCount);
    }

    [Fact]
    public async Task StartExport_OverlayColorsOnAHiddenTrack_AreNotJudged()
    {
        // KAPININ SINIRI (negatif kontrol). Gizli track'in metni HİÇ rasterlenmez
        // (OverlayRasterPlanner.Collect onu atlar) — dolayısıyla geçersiz rengi de export'u
        // düşürmez. Kapı burada da reddetseydi, GÖRÜNMEYEN bir klip yüzünden geçerli bir
        // belge geri çevrilirdi (çok-katman denetimindeki "atıl klip" hatasının aynısı).
        var hidden = ExportTestDocs.TextClip(0, 1_000_000);
        hidden.Text!.Fill = "rgb(1,2,3)";
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.OverlayTrack(hidden: true, clips: [hidden]),
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000)]),
        ]);
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(doc));

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await CallStartAsync(project.Id));
    }

    [Fact]
    public async Task StartExport_EmptyTimeline_Returns422()
    {
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(ExportTestDocs.Doc()));
        var result = await CallStartAsync(project.Id);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
    }

    // ---------- GET /api/jobs/{id} ----------

    [Fact]
    public async Task GetJob_SucceededExport_IncludesDownloadUrl()
    {
        var project = await SeedProjectAsync();
        var job = Job.Create(JobType.Export, _userId, DateTimeOffset.UtcNow, projectId: project.Id,
            exportProfile: "1080p");
        job.Status = JobStatus.Succeeded;
        job.OutputKey = $"exports/{project.Id:D}/{job.Id:D}.mp4";
        job.ProgressPercent = 100;
        job.ProgressStage = "done";
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        var result = await ExportEndpoints.GetJob(
            job.Id, PrincipalFor(_userId), _db, _storage, CancellationToken.None);

        var ok = Assert.IsType<Ok<ExportJobDto>>(result);
        Assert.Equal("succeeded", ok.Value!.Status);
        Assert.Equal(100, ok.Value.ProgressPercent);
        Assert.Equal($"https://fake-exports/{job.OutputKey}?sig=get", ok.Value.DownloadUrl);
    }

    [Fact]
    public async Task GetJob_RunningExport_HasProgressButNoDownloadUrl()
    {
        var job = Job.Create(JobType.Export, _userId, DateTimeOffset.UtcNow, projectId: Guid.NewGuid());
        job.Status = JobStatus.Running;
        job.ProgressPercent = 42;
        job.ProgressStage = "render";
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        var result = await ExportEndpoints.GetJob(
            job.Id, PrincipalFor(_userId), _db, _storage, CancellationToken.None);

        var ok = Assert.IsType<Ok<ExportJobDto>>(result);
        Assert.Equal("running", ok.Value!.Status);
        Assert.Equal(42, ok.Value.ProgressPercent);
        Assert.Equal("render", ok.Value.ProgressStage);
        Assert.Null(ok.Value.DownloadUrl);
    }

    [Fact]
    public async Task GetJob_ForeignJob_Returns404()
    {
        var job = Job.Create(JobType.Export, Guid.CreateVersion7(), DateTimeOffset.UtcNow);
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        var result = await ExportEndpoints.GetJob(
            job.Id, PrincipalFor(_userId), _db, _storage, CancellationToken.None);
        Assert.IsType<NotFound>(result);
    }

    // ---------- POST /api/jobs/{id}/cancel ----------

    [Fact]
    public async Task CancelJob_QueuedExport_MarksCanceledAndDeletesHangfireJob()
    {
        var job = Job.Create(JobType.Export, _userId, DateTimeOffset.UtcNow, projectId: Guid.NewGuid());
        job.HangfireJobId = "hf-42";
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        var result = await ExportEndpoints.CancelJob(
            job.Id, PrincipalFor(_userId), _db, _jobs, TimeProvider.System, CancellationToken.None);

        var ok = Assert.IsType<Ok<ExportCancelResponse>>(result);
        Assert.Equal("canceled", ok.Value!.Status);
        var reloaded = _db.Jobs.AsNoTracking().Single(j => j.Id == job.Id);
        Assert.Equal(JobStatus.Canceled, reloaded.Status);
        Assert.NotNull(reloaded.CompletedAt);
        Assert.Equal(("hf-42", nameof(DeletedState)), _jobs.StateChanges.Single());
    }

    [Fact]
    public async Task CancelJob_TerminalJob_Returns409()
    {
        var job = Job.Create(JobType.Export, _userId, DateTimeOffset.UtcNow);
        job.Status = JobStatus.Succeeded;
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        var result = await ExportEndpoints.CancelJob(
            job.Id, PrincipalFor(_userId), _db, _jobs, TimeProvider.System, CancellationToken.None);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status409Conflict, problem.StatusCode);
        Assert.Empty(_jobs.StateChanges);
    }

    [Fact]
    public async Task CancelJob_ProcessAssetJob_Returns409()
    {
        var job = Job.Create(JobType.ProcessAsset, _userId, DateTimeOffset.UtcNow, assetId: Guid.NewGuid());
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        var result = await ExportEndpoints.CancelJob(
            job.Id, PrincipalFor(_userId), _db, _jobs, TimeProvider.System, CancellationToken.None);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status409Conflict, problem.StatusCode);
    }

    // ---------- GET /api/projects/{id}/exports ----------

    [Fact]
    public async Task ListForProject_ReturnsOnlyThisProjectsExports_Paged()
    {
        var project = await SeedProjectAsync();
        var otherProject = await SeedProjectAsync();
        var now = DateTimeOffset.UtcNow;
        for (var i = 0; i < 3; i++)
        {
            _db.Jobs.Add(Job.Create(JobType.Export, _userId, now.AddMinutes(i), projectId: project.Id));
        }

        _db.Jobs.Add(Job.Create(JobType.Export, _userId, now, projectId: otherProject.Id));
        _db.Jobs.Add(Job.Create(JobType.ProcessAsset, _userId, now, assetId: Guid.NewGuid()));
        await _db.SaveChangesAsync();

        var result = await ExportEndpoints.ListForProject(
            project.Id, PrincipalFor(_userId), _db, _storage, CancellationToken.None,
            page: 1, pageSize: 2);

        var ok = Assert.IsType<Ok<PagedResult<ExportJobDto>>>(result);
        Assert.Equal(3, ok.Value!.TotalCount);
        Assert.Equal(2, ok.Value.Items.Count);
        Assert.All(ok.Value.Items, dto => Assert.Equal(project.Id, dto.ProjectId));
    }

    [Fact]
    public async Task ListForProject_ForeignProject_Returns404()
    {
        var project = await SeedProjectAsync(owner: Guid.CreateVersion7());
        var result = await ExportEndpoints.ListForProject(
            project.Id, PrincipalFor(_userId), _db, _storage, CancellationToken.None);
        Assert.IsType<NotFound>(result);
    }

    // ---------- Sahteler ----------

    /// <summary>
    /// Sabit bbox döndüren ölçer — ön kapının ÖLÇÜMLÜ yolunu kurulu font olmadan sürer.
    /// <c>RenderAsync</c> ÇAĞRILMAMALIDIR (ön kapı yalnız ölçer): çağrılırsa test patlar.
    /// </summary>
    /// <param name="deterministic">
    /// Ölçümün KÜRATÖRLÜ (sürüm pinli) bir fontla yapılıp yapılmadığı — gerçek serviste
    /// <c>FontFile.Deterministic</c>'ten gelir.
    /// </param>
    private sealed class FakeTextMeasurer(double widthPx, double heightPx, bool deterministic = true)
        : ITextRasterService
    {
        public Task<RasterResult> RenderAsync(
            VideoEdit.Contracts.Timeline.Clip clip,
            VideoEdit.Contracts.Timeline.ProjectSettings settings,
            string outputPath, CancellationToken ct = default) =>
            throw new InvalidOperationException("Ön kapı raster ÜRETMEMELİ, yalnız ölçmeli.");

        public TextLayout Measure(
            VideoEdit.Contracts.Timeline.TextClipText text,
            VideoEdit.Contracts.Timeline.ProjectSettings settings) =>
            new([], text.FontSizePx * text.LineHeight, widthPx, heightPx,
                0, 0, widthPx, heightPx, false)
            {
                FontIsDeterministic = deterministic,
            };
    }

    /// <summary>
    /// KURULUM arızası: küratörlü TTF indirilmemiş. <c>FileMissing</c> fabrikası kullanılır ve
    /// bu seçim testin ölçtüğü şeyi belirler — <c>UnknownId</c> fabrikası "manifestte böyle bir
    /// id yok" der, yani BELGE hatasıdır ve 503 değil 422 üretmelidir. Eski hali tam olarak o
    /// karışıklığı taşıyordu: adı/açıklaması "font kurulu değil" derken fırlattığı istisna
    /// belge hatasıydı, dolayısıyla 503'ün DARLIĞINI hiç sınamıyordu.
    /// </summary>
    private sealed class ThrowingTextMeasurer : ITextRasterService
    {
        public Task<RasterResult> RenderAsync(
            VideoEdit.Contracts.Timeline.Clip clip,
            VideoEdit.Contracts.Timeline.ProjectSettings settings,
            string outputPath, CancellationToken ct = default) =>
            throw new InvalidOperationException("Ön kapı raster ÜRETMEMELİ, yalnız ölçmeli.");

        public TextLayout Measure(
            VideoEdit.Contracts.Timeline.TextClipText text,
            VideoEdit.Contracts.Timeline.ProjectSettings settings) =>
            throw FontNotFoundException.FileMissing(
                "roboto", "400", "/opt/videoedit/fonts/roboto/Roboto-Regular.ttf");
    }

    /// <summary>
    /// Ölçüm DENENDİ Mİ sorusunu yanıtlayan sayaç. Makul bir kutu döndürür (kapıları
    /// tetiklemez), tek işi çağrı sayısını tutmaktır.
    /// </summary>
    private sealed class CountingTextMeasurer : ITextRasterService
    {
        public int MeasureCalls { get; private set; }

        public Task<RasterResult> RenderAsync(
            VideoEdit.Contracts.Timeline.Clip clip,
            VideoEdit.Contracts.Timeline.ProjectSettings settings,
            string outputPath, CancellationToken ct = default) =>
            throw new InvalidOperationException("Ön kapı raster ÜRETMEMELİ, yalnız ölçmeli.");

        public TextLayout Measure(
            VideoEdit.Contracts.Timeline.TextClipText text,
            VideoEdit.Contracts.Timeline.ProjectSettings settings)
        {
            MeasureCalls++;
            return new([], text.FontSizePx * text.LineHeight, 200, 80, 0, 0, 200, 80, false);
        }
    }

    /// <summary>
    /// BELGE hatası: ölçerin manifestinde böyle bir fontId YOK. API'nin kendi manifest
    /// okuyucusuyla ölçerin okuyucusu AYRIŞTIĞINDA (ya da API tarafı manifesti hiç
    /// okuyamadığında) ulaşılan tek dal budur — kapının cevabı hangi okuyucunun fark ettiğine
    /// göre değişmemelidir.
    /// </summary>
    private sealed class UnknownFontMeasurer : ITextRasterService
    {
        public Task<RasterResult> RenderAsync(
            VideoEdit.Contracts.Timeline.Clip clip,
            VideoEdit.Contracts.Timeline.ProjectSettings settings,
            string outputPath, CancellationToken ct = default) =>
            throw new InvalidOperationException("Ön kapı raster ÜRETMEMELİ, yalnız ölçmeli.");

        public TextLayout Measure(
            VideoEdit.Contracts.Timeline.TextClipText text,
            VideoEdit.Contracts.Timeline.ProjectSettings settings) =>
            throw FontNotFoundException.UnknownId(
                text.FontId, "(ölçerin manifesti)", ["baska-font"]);
    }

    /// <summary>Create + ChangeState çağrılarını kaydeden Hangfire istemcisi.</summary>
    private sealed class RecordingJobClient : IBackgroundJobClient
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

    /// <summary>Yalnız export presign yüzeyi kullanılan sahte depolama.</summary>
    private sealed class FakeExportStorage : IStorageService
    {
        public string PresignExportGet(string key) => $"https://fake-exports/{key}?sig=get";

        public Task UploadExportAsync(string key, string filePath, string contentType, CancellationToken ct = default) =>
            Task.CompletedTask;

        public Task<string> CreateMultipartUploadAsync(string key, string contentType, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public string PresignUploadPart(string key, string uploadId, int partNumber) =>
            throw new NotSupportedException();

        public Task CompleteMultipartUploadAsync(
            string key, string uploadId, IReadOnlyList<StorageCompletedPart> parts, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task AbortMultipartUploadAsync(string key, string uploadId, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task<IReadOnlyList<StorageUploadedPart>> ListPartsAsync(
            string key, string uploadId, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task<StorageObjectInfo?> HeadObjectAsync(string key, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public string PresignGet(string key) => $"https://fake/{key}?sig=get";

        public Task DeletePrefixAsync(string prefix, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task DeleteObjectAsync(string key, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task<StorageDownload> OpenReadAsync(string key, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task UploadFileAsync(string key, string filePath, string contentType, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task EnsureBucketsExistAsync(CancellationToken ct = default) => Task.CompletedTask;
    }
}
