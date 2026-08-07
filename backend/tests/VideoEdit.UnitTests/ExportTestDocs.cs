using System.Text.Json;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;

namespace VideoEdit.UnitTests;

/// <summary>
/// Export testleri için TimelineDoc üreticileri. Her doküman prod yoluyla AYNI şekilde
/// TimelineJson.Options üzerinden serialize→deserialize edilir (Job.TimelineSnapshot jsonb →
/// DTO yolunun birebir taklidi) — compiler'a hep "tel üzerinden gelmiş" DTO girer.
/// </summary>
internal static class ExportTestDocs
{
    public static readonly Guid AssetA = Guid.Parse("00000000-0000-0000-0000-0000000000a1");
    public static readonly Guid AssetB = Guid.Parse("00000000-0000-0000-0000-0000000000b2");

    public static TimelineDoc Roundtrip(TimelineDoc doc)
    {
        var json = JsonSerializer.Serialize(doc, TimelineJson.Options);
        return JsonSerializer.Deserialize<TimelineDoc>(json, TimelineJson.Options)!;
    }

    public static string ToJson(TimelineDoc doc) => JsonSerializer.Serialize(doc, TimelineJson.Options);

    public static TimelineDoc Doc(
        Guid? projectId = null,
        int width = 1920, int height = 1080,
        int fpsNum = 30, int fpsDen = 1,
        string backgroundColor = "#000000",
        bool trackMuted = false,
        params Clip[] clips) => Roundtrip(new TimelineDoc
    {
        SchemaVersion = 1,
        ProjectId = projectId ?? Guid.Parse("00000000-0000-0000-0000-00000000c001"),
        Settings = new ProjectSettings
        {
            Width = width,
            Height = height,
            Fps = new Rational { Num = fpsNum, Den = fpsDen },
            AudioSampleRate = 48000,
            BackgroundColor = backgroundColor,
        },
        Tracks =
        [
            new Track
            {
                Id = Guid.Parse("00000000-0000-0000-0000-0000000000f1"),
                Type = TrackType.Video,
                Muted = trackMuted,
                Hidden = false,
                Locked = false,
                Clips = [.. clips],
            },
        ],
        Markers = [],
    });

    /// <summary>M3-geçerli video klip (rate=1, transform/opacity default, keyframe/effect yok).</summary>
    public static MediaClip VideoClip(
        Guid assetId, long timelineStartUs, long sourceInUs, long sourceOutUs,
        ClipAudio? audio = null) => new()
    {
        Id = Guid.CreateVersion7(),
        Kind = MediaClipKind.Video,
        AssetId = assetId,
        TimelineStartUs = timelineStartUs,
        TimelineDurationUs = sourceOutUs - sourceInUs,
        SourceInUs = sourceInUs,
        SourceOutUs = sourceOutUs,
        Speed = new MediaClipSpeed { Rate = 1 },
        Transform = DefaultTransform(),
        Keyframes = new KeyframeTracks(),
        Effects = [],
        Opacity = 1,
        Audio = audio,
    };

    public static ClipAudio Audio(
        double volume = 1, long fadeInUs = 0, long fadeOutUs = 0, bool muted = false) => new()
    {
        Volume = volume,
        FadeInUs = fadeInUs,
        FadeOutUs = fadeOutUs,
        Muted = muted,
    };

    public static Transform DefaultTransform() => new()
    {
        X = 0,
        Y = 0,
        Scale = 1,
        RotationDeg = 0,
        AnchorX = 0.5,
        AnchorY = 0.5,
    };
}
