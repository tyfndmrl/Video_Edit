using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Api.Endpoints;
using VideoEdit.Contracts;
using VideoEdit.Domain.Entities;
using VideoEdit.Domain.Services;
using VideoEdit.Infrastructure;

namespace VideoEdit.UnitTests;

/// <summary>
/// SaveTimeline yüzeysel doğrulaması + Create audioSampleRate whitelist'i + sayfalama
/// normalizasyonu. Tam şema doğrulaması client'ta (zod) — buradaki amaç DB'ye açıkça
/// bozuk/aşırı doküman yazılmasını ve integer overflow'ları engellemek.
/// </summary>
public class TimelineRequestValidationTests
{
    private static readonly Guid ProjectId = Guid.Parse("0198c0de-0000-7000-8000-0000000000aa");

    private static JsonElement Doc(string json) => JsonDocument.Parse(json).RootElement;

    private static string ValidDocJson(Guid projectId, int trackCount = 0, int clipsPerTrack = 0)
    {
        var clips = string.Join(",", Enumerable.Range(0, clipsPerTrack).Select(_ => "{}"));
        var track = $$"""{"id":"00000000-0000-0000-0000-000000000001","type":"video","clips":[{{clips}}]}""";
        var tracks = string.Join(",", Enumerable.Repeat(track, trackCount));
        return $$"""
            {"schemaVersion":1,"projectId":"{{projectId:D}}","settings":{},"tracks":[{{tracks}}],"markers":[]}
            """;
    }

    // ---------- audioSampleRate whitelist (Create) ----------

    [Theory]
    [InlineData(44100)]
    [InlineData(48000)]
    public void AllowedAudioSampleRates_Accepted(int rate) =>
        Assert.True(TimelineRequestValidation.IsAllowedAudioSampleRate(rate));

    [Theory]
    [InlineData(8000)]
    [InlineData(22050)]
    [InlineData(44099)]
    [InlineData(96000)]
    [InlineData(192000)]
    [InlineData(0)]
    [InlineData(-48000)]
    public void OtherAudioSampleRates_Rejected(int rate) =>
        Assert.False(TimelineRequestValidation.IsAllowedAudioSampleRate(rate));

    // ---------- SaveTimeline yüzeysel doğrulama ----------

    [Fact]
    public void EmptyTimelineBuilderOutput_PassesValidation()
    {
        using var doc = EmptyTimeline.Create(ProjectId, 1920, 1080, 30, 1, 48000);
        var errors = TimelineRequestValidation.ValidateTimelinePayload(doc.RootElement, ProjectId);
        Assert.Empty(errors);
    }

    [Fact]
    public void SchemaVersionOtherThanOne_Fails()
    {
        var timeline = Doc(ValidDocJson(ProjectId).Replace("\"schemaVersion\":1", "\"schemaVersion\":2"));
        var errors = TimelineRequestValidation.ValidateTimelinePayload(timeline, ProjectId);
        Assert.Contains("timeline.schemaVersion", errors.Keys);
    }

    [Fact]
    public void MissingSchemaVersion_Fails()
    {
        var timeline = Doc($$"""{"projectId":"{{ProjectId:D}}","tracks":[]}""");
        var errors = TimelineRequestValidation.ValidateTimelinePayload(timeline, ProjectId);
        Assert.Contains("timeline.schemaVersion", errors.Keys);
    }

    [Fact]
    public void ProjectIdMismatchWithRoute_Fails()
    {
        var timeline = Doc(ValidDocJson(Guid.CreateVersion7()));
        var errors = TimelineRequestValidation.ValidateTimelinePayload(timeline, ProjectId);
        Assert.Contains("timeline.projectId", errors.Keys);
    }

    [Fact]
    public void ProjectIdCaseInsensitiveMatch_Passes()
    {
        var timeline = Doc(ValidDocJson(ProjectId).Replace(ProjectId.ToString("D"), ProjectId.ToString("D").ToUpperInvariant()));
        var errors = TimelineRequestValidation.ValidateTimelinePayload(timeline, ProjectId);
        Assert.Empty(errors);
    }

    [Fact]
    public void TracksMissingOrNotArray_Fails()
    {
        var missing = Doc($$"""{"schemaVersion":1,"projectId":"{{ProjectId:D}}"}""");
        Assert.Contains("timeline.tracks",
            TimelineRequestValidation.ValidateTimelinePayload(missing, ProjectId).Keys);

        var notArray = Doc(
            """{"schemaVersion":1,"projectId":"__ID__","tracks":{}}""".Replace("__ID__", ProjectId.ToString("D")));
        Assert.Contains("timeline.tracks",
            TimelineRequestValidation.ValidateTimelinePayload(notArray, ProjectId).Keys);
    }

    [Fact]
    public void TrackCountAtLimit_Passes_OverLimit_Fails()
    {
        var atLimit = Doc(ValidDocJson(ProjectId, trackCount: TimelineRequestValidation.MaxTracks));
        Assert.Empty(TimelineRequestValidation.ValidateTimelinePayload(atLimit, ProjectId));

        var overLimit = Doc(ValidDocJson(ProjectId, trackCount: TimelineRequestValidation.MaxTracks + 1));
        Assert.Contains("timeline.tracks",
            TimelineRequestValidation.ValidateTimelinePayload(overLimit, ProjectId).Keys);
    }

    [Fact]
    public void TotalClipCountAtLimit_Passes_OverLimit_Fails()
    {
        // 40 track x 50 clip = 2000 (sınırda).
        var atLimit = Doc(ValidDocJson(ProjectId, trackCount: 40, clipsPerTrack: 50));
        Assert.Empty(TimelineRequestValidation.ValidateTimelinePayload(atLimit, ProjectId));

        // 41 track x 50 clip = 2050 > 2000.
        var overLimit = Doc(ValidDocJson(ProjectId, trackCount: 41, clipsPerTrack: 50));
        Assert.Contains("timeline.clips",
            TimelineRequestValidation.ValidateTimelinePayload(overLimit, ProjectId).Keys);
    }

    [Fact]
    public void NonObjectTimeline_Fails()
    {
        var errors = TimelineRequestValidation.ValidateTimelinePayload(Doc("[]"), ProjectId);
        Assert.Contains("timeline", errors.Keys);
    }

    [Fact]
    public void BodyLimit_IsTwoMegabytes() =>
        Assert.Equal(2L * 1024 * 1024, TimelineRequestValidation.MaxTimelineBodyBytes);

    // ---------- Sayfalama ----------

    [Theory]
    [InlineData(0, 20, 1, 20, 0)]
    [InlineData(-5, 0, 1, 1, 0)]
    [InlineData(1, 1000, 1, 100, 0)]
    [InlineData(3, 20, 3, 20, 40)]
    public void NormalizePaging_ClampsInputs(int page, int pageSize, int expPage, int expPageSize, int expSkip)
    {
        var (p, ps, skip) = TimelineRequestValidation.NormalizePaging(page, pageSize);
        Assert.Equal(expPage, p);
        Assert.Equal(expPageSize, ps);
        Assert.Equal(expSkip, skip);
    }

    [Fact]
    public void NormalizePaging_MaxPageTimesMaxPageSize_DoesNotOverflow()
    {
        // int.MaxValue * 100, int'e sığmaz — long üzerinden hesap + int.MaxValue clamp.
        var (_, _, skip) = TimelineRequestValidation.NormalizePaging(int.MaxValue, 100);
        Assert.Equal(int.MaxValue, skip);
        Assert.True(skip >= 0);
    }
}

/// <summary>
/// SaveTimeline optimistic-concurrency SÖZLEŞME PİNİ (autosave'in 409 dalı).
/// <para>
/// Sözleşme (istemcinin çakışma diyaloğu buna dayanır — features/timeline çakışma tespiti):
/// doğru <c>baseRevision</c> ile PUT 200 döner ve revision tam 1 artar; BAYAT
/// <c>baseRevision</c> ile PUT 409 döner ve gövde GÜNCEL dokümanı + GÜNCEL revision'ı
/// taşır (istemci "başka sekmede değişti" diyaloğunu bu gövdeyle kurar); 409 sunucudaki
/// dokümanı DEĞİŞTİRMEZ (kaybolan-güncelleme yok). Bu sınıf eklenene kadar dal yalnız
/// canlıda ölçülmüştü, birim pini yoktu (DURUM §5 risk kaydı).
/// </para>
/// <para>
/// Kurulum CrossUserAccessTests deseni: Sqlite in-memory + handler'ların doğrudan
/// çağrılması (handler'lar bu yüzden internal). Sqlite'ta JsonDocument/DateTimeOffset
/// converter'ları AppDbContext'in test-provider dalından gelir.
/// </para>
/// </summary>
public sealed class SaveTimelineRevisionContractTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly Guid _ownerId = Guid.CreateVersion7();

    public SaveTimelineRevisionContractTests()
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

    private ClaimsPrincipal Owner =>
        new(new ClaimsIdentity([new Claim("sub", _ownerId.ToString("D"))], "test"));

    /// <summary>
    /// Yüzeysel doğrulamayı GEÇEN, tek satırlık (whitespace'siz) doküman — raw-text
    /// eşitliği kararlı olsun diye. <paramref name="marker"/> track id'sidir: V1/V2
    /// gövdeleri birbirinden ayırt edilebilir kalır.
    /// </summary>
    private static string DocJson(Guid projectId, string marker) =>
        $$"""{"schemaVersion":1,"projectId":"{{projectId:D}}","settings":{},"tracks":[{"id":"{{marker}}","type":"video","clips":[]}],"markers":[]}""";

    private async Task<Project> SeedOwnedProjectAsync()
    {
        var projectId = Guid.CreateVersion7();
        var project = new Project
        {
            Id = projectId,
            OwnerId = _ownerId,
            Name = "409 pin projesi",
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

    private async Task<IResult> SaveAsync(Guid projectId, long baseRevision, string docJson)
    {
        using var doc = JsonDocument.Parse(docJson);
        return await ProjectEndpoints.SaveTimeline(
            projectId,
            new SaveTimelineRequest(baseRevision, doc.RootElement.Clone()),
            Owner, _db, new SnapshotPolicy(), TimeProvider.System, CancellationToken.None);
    }

    private Project Reload(Guid projectId) =>
        _db.Projects.AsNoTracking().Single(p => p.Id == projectId);

    [Fact]
    public async Task SaveTimeline_WithCurrentBaseRevision_Returns200_AndIncrementsRevision()
    {
        var project = await SeedOwnedProjectAsync();
        var v1 = DocJson(project.Id, "v1");

        var result = await SaveAsync(project.Id, baseRevision: 0, v1);

        var ok = Assert.IsType<Ok<SaveTimelineResponse>>(result);
        Assert.Equal(1, ok.Value!.RevisionNumber);

        var reloaded = Reload(project.Id);
        Assert.Equal(1, reloaded.RevisionNumber);
        Assert.Equal(v1, reloaded.Timeline.RootElement.GetRawText());
    }

    [Fact]
    public async Task SaveTimeline_WithStaleBaseRevision_Returns409_WithCurrentDocument_AndDoesNotWrite()
    {
        var project = await SeedOwnedProjectAsync();
        var v1 = DocJson(project.Id, "v1");
        Assert.IsType<Ok<SaveTimelineResponse>>(await SaveAsync(project.Id, 0, v1)); // sunucu: rev 1 = V1

        var revisionRowsBefore = _db.ProjectRevisions.AsNoTracking().Count(r => r.ProjectId == project.Id);

        // Bayat istek: baseRevision 0 (sunucu 1'de) + FARKLI bir gövde (V2). Concurrency
        // filtresi olmasaydı bu istek V2'yi yazar, "son yazan kazanır"a düşerdik.
        var v2 = DocJson(project.Id, "v2");
        var result = await SaveAsync(project.Id, baseRevision: 0, v2);

        // 409 + gövde GÜNCEL durumu taşır: istemci diyaloğu revision'ı ve dokümanı buradan okur.
        var conflict = Assert.IsType<Conflict<TimelineConflictResponse>>(result);
        Assert.Equal(1, conflict.Value!.RevisionNumber);
        Assert.Equal(v1, conflict.Value.Timeline.GetRawText());

        // Kurban DEĞİŞMEDİ: doküman V1, revision 1, snapshot satırı doğmadı.
        var reloaded = Reload(project.Id);
        Assert.Equal(1, reloaded.RevisionNumber);
        Assert.Equal(v1, reloaded.Timeline.RootElement.GetRawText());
        Assert.Equal(revisionRowsBefore,
            _db.ProjectRevisions.AsNoTracking().Count(r => r.ProjectId == project.Id));
    }

    [Fact]
    public async Task SaveTimeline_WithAheadBaseRevision_Returns409_WithCurrentDocument()
    {
        // Eşitlik pini: filtre "==" olmalı, "<=" değil — sunucunun İLERİSİNDEN gelen
        // baseRevision (karışmış istemci) de yazamaz ve güncel dokümanla 409 alır.
        var project = await SeedOwnedProjectAsync();
        var v1 = DocJson(project.Id, "v1");
        Assert.IsType<Ok<SaveTimelineResponse>>(await SaveAsync(project.Id, 0, v1));

        var result = await SaveAsync(project.Id, baseRevision: 5, DocJson(project.Id, "v2"));

        var conflict = Assert.IsType<Conflict<TimelineConflictResponse>>(result);
        Assert.Equal(1, conflict.Value!.RevisionNumber);
        Assert.Equal(v1, conflict.Value.Timeline.GetRawText());
        Assert.Equal(v1, Reload(project.Id).Timeline.RootElement.GetRawText());
    }
}
