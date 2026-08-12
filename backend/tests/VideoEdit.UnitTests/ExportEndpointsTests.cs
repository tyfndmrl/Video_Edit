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

    private async Task<Project> SeedProjectAsync(Guid? owner = null, string? timelineJson = null)
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
        return project;
    }

    /// <summary>
    /// Depodaki GERÇEK <c>fonts/manifest.json</c> — font ön kontrolü (M4 dalga-2 bulgu #1d)
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
        // (Geçiş + metin/şekil/çıkartma M4 dalga 2'de; hız + renk + transform/opaklık VE SES
        // SEVİYESİ keyframe'leri M5'te DESTEKLENİR; aşağıdaki *_Accepted testleri onları
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

    [Fact]
    public async Task StartExport_UnknownFontId_Returns422_BeforeQueueing()
    {
        // M4 dalga-2 denetimi, bulgu #1(d): manifestte olmayan bir fontId raster aşamasında
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
        // M4 dalga 2: editör artık geçiş + metin/şekil/çıkartma üretiyor — ön-doğrulama
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
        // M4 dalga 1: editör artık çok katman üretiyor — ön-doğrulama bunu REDDETMEMELİ.
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

    // ---------- Raster katman tavanı (3. tur denetim, blocker 2) ----------

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
    public async Task StartExport_MeasurementFailure_DoesNotRejectAValidDocument()
    {
        // Ölçüm bir ALTYAPI işidir (font kökü, manifest, Skia). Patlarsa doğrulama alt sınıra
        // düşer — kullanıcının belgesi YANLIŞ 422 yemez.
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: ExportTestDocs.TextClip(0, 1_000_000))));

        var result = await CallStartAsync(project.Id, measurer: new ThrowingTextMeasurer());

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(result);
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
    private sealed class FakeTextMeasurer(double widthPx, double heightPx) : ITextRasterService
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
                0, 0, widthPx, heightPx, false);
    }

    /// <summary>Kurulu font yokmuş gibi davranan ölçer (altyapı hatası → alt sınıra düşülür).</summary>
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
            throw FontNotFoundException.UnknownId("roboto", "(test)", []);
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
