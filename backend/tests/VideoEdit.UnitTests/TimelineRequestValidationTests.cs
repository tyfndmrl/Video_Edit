using System.Text.Json;
using VideoEdit.Api.Endpoints;
using VideoEdit.Contracts;

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
