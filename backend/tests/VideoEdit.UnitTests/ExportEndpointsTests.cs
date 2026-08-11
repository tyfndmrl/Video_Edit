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

    private Task<IResult> CallStartAsync(Guid projectId, string? profile = "1080p") =>
        ExportEndpoints.StartExport(
            projectId, new CreateExportRequest(profile), PrincipalFor(_userId), _db, _jobs,
            TimeProvider.System, CancellationToken.None);

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
        // Kapsam dışı özellik (keyframe — M5) — compiler ön-doğrulaması API'de koşar,
        // kuyruğa hiç girmez. (Geçiş ve metin/şekil/çıkartma M4 dalga 2'de DESTEKLENİR;
        // aşağıdaki StartExport_TransitionsAndOverlayClips_Accepted onları sabitler.)
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Keyframes = new VideoEdit.Contracts.Timeline.KeyframeTracks
        {
            Opacity =
            [
                new VideoEdit.Contracts.Timeline.Keyframe
                {
                    TimeUs = 0,
                    Value = 0,
                    Easing = new VideoEdit.Contracts.Timeline.EasingLinear { Type = "linear" },
                },
            ],
        };
        var project = await SeedProjectAsync(timelineJson: ExportTestDocs.ToJson(
            ExportTestDocs.Doc(clips: clip)));

        var result = await CallStartAsync(project.Id);

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
        Assert.Contains("keyframe", problem.ProblemDetails.Detail, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(_db.Jobs.ToList()); // job satırı yazılmadı
        Assert.Equal(0, _jobs.CreateCount); // kuyruğa çöp atılmadı
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
