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
    public static readonly Guid AssetC = Guid.Parse("00000000-0000-0000-0000-0000000000c3");

    public static TimelineDoc Roundtrip(TimelineDoc doc)
    {
        var json = JsonSerializer.Serialize(doc, TimelineJson.Options);
        return JsonSerializer.Deserialize<TimelineDoc>(json, TimelineJson.Options)!;
    }

    public static string ToJson(TimelineDoc doc) => JsonSerializer.Serialize(doc, TimelineJson.Options);

    /// <summary>Tek video track'li doküman (M3 fixture'larının kısayolu).</summary>
    public static TimelineDoc Doc(
        Guid? projectId = null,
        int width = 1920, int height = 1080,
        int fpsNum = 30, int fpsDen = 1,
        string backgroundColor = "#000000",
        bool trackMuted = false,
        params Clip[] clips) => MultiTrackDoc(
        projectId: projectId,
        width: width, height: height,
        fpsNum: fpsNum, fpsDen: fpsDen,
        backgroundColor: backgroundColor,
        tracks: [VideoTrack(muted: trackMuted, clips: clips)]);

    /// <summary>
    /// Çok katmanlı doküman. tracks[0] EN ÜST katmandır (şema sözleşmesi, docs/design/01 §1.2) —
    /// render sırası sondan başadır.
    /// </summary>
    public static TimelineDoc MultiTrackDoc(
        Track[] tracks,
        Guid? projectId = null,
        int width = 1920, int height = 1080,
        int fpsNum = 30, int fpsDen = 1,
        string backgroundColor = "#000000") => Roundtrip(new TimelineDoc
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
        Tracks = [.. tracks],
        Markers = [],
    });

    public static Track VideoTrack(bool muted = false, bool hidden = false, params Clip[] clips) =>
        MakeTrack(TrackType.Video, muted, hidden, clips);

    public static Track AudioTrack(bool muted = false, bool hidden = false, params Clip[] clips) =>
        MakeTrack(TrackType.Audio, muted, hidden, clips);

    public static Track OverlayTrack(bool muted = false, bool hidden = false, params Clip[] clips) =>
        MakeTrack(TrackType.Overlay, muted, hidden, clips);

    private static Track MakeTrack(TrackType type, bool muted, bool hidden, Clip[] clips) => new()
    {
        Id = Guid.CreateVersion7(),
        Type = type,
        Muted = muted,
        Hidden = hidden,
        Locked = false,
        Clips = [.. clips],
    };

    /// <summary>Geçerli video klip (rate=1, keyframe/effect yok; transform/opaklık verilebilir).</summary>
    public static MediaClip VideoClip(
        Guid assetId, long timelineStartUs, long sourceInUs, long sourceOutUs,
        ClipAudio? audio = null, Transform? transform = null, double opacity = 1) => new()
    {
        Id = Guid.CreateVersion7(),
        Kind = MediaClipKind.Video,
        AssetId = assetId,
        TimelineStartUs = timelineStartUs,
        TimelineDurationUs = sourceOutUs - sourceInUs,
        SourceInUs = sourceInUs,
        SourceOutUs = sourceOutUs,
        Speed = new MediaClipSpeed { Rate = 1 },
        Transform = transform ?? DefaultTransform(),
        Keyframes = new KeyframeTracks(),
        Effects = [],
        Opacity = opacity,
        Audio = audio,
    };

    /// <summary>
    /// Görsel (still image) klibi. Editörün ürettiği şeklin birebir aynısı (timelineOps
    /// buildClipFromAsset): sourceIn = 0, sourceOut = klip süresi (varsayılan 4 sn) — bu aralık
    /// dosyada bir zaman aralığına KARŞILIK GELMEZ, yalnız süre modelidir; audio DAİMA null.
    /// </summary>
    public static MediaClip ImageClip(
        Guid assetId, long timelineStartUs, long durationUs,
        Transform? transform = null, double opacity = 1) => new()
    {
        Id = Guid.CreateVersion7(),
        Kind = MediaClipKind.Image,
        AssetId = assetId,
        TimelineStartUs = timelineStartUs,
        TimelineDurationUs = durationUs,
        SourceInUs = 0,
        SourceOutUs = durationUs,
        Speed = new MediaClipSpeed { Rate = 1 },
        Transform = transform ?? DefaultTransform(),
        Keyframes = new KeyframeTracks(),
        Effects = [],
        Opacity = opacity,
        Audio = null,
    };

    /// <summary>Ses klibi (audio track içeriği) — görsel katman üretmez, yalnız mikse girer.</summary>
    public static MediaClip AudioClip(
        Guid assetId, long timelineStartUs, long sourceInUs, long sourceOutUs,
        ClipAudio? audio = null) => new()
    {
        Id = Guid.CreateVersion7(),
        Kind = MediaClipKind.Audio,
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

    public static Transform Transform(
        double x = 0, double y = 0, double scale = 1, double rotationDeg = 0,
        double anchorX = 0.5, double anchorY = 0.5) => new()
    {
        X = x,
        Y = y,
        Scale = scale,
        RotationDeg = rotationDeg,
        AnchorX = anchorX,
        AnchorY = anchorY,
    };
}
