using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Export;

namespace VideoEdit.UnitTests;

/// <summary>
/// §2.6 örtme optimizasyonlarının (taban-tuval atlaması; sonraki bacakta örtülen-katman
/// budaması) ÜYELİK yüklemi testleri. Bu defterin ana yönü NEGATİFTİR: yüklemin HER olgusu
/// tek tek eksiltilir ve optimizasyonun ATEŞLENMEDİĞİ (taban tuvalin aynen kurulduğu)
/// gösterilir — "ölçüm yokluğu optimizasyon üretmez" (baş mimar kararı: olgu bilinmiyorsa
/// budama/atlama YOK; kaynak olgular worker'ın TAZE yerel-dosya probe'undan gelir, DB
/// defterinden DEĞİL). Bayt-aynılık kanıtı canlı-ffmpeg tarafında:
/// <c>ExportRenderGoldenTests.BaseCanvasSkip_IsByteIdentical_OnTheRealisticTopology</c>.
/// </summary>
public sealed class ExportCoverOptimizationTests
{
    private static readonly Guid Bottom = ExportTestDocs.AssetA;
    private static readonly Guid Top = ExportTestDocs.AssetB;

    /// <summary>Tuvale (1920×1080) tam oturan, alfasız, kare-piksel kaynak olguları.</summary>
    private static ExportAssetSource FullFacts(string path) => new(
        path, HasAudio: false, "bt709", "bt709",
        SourceWidth: 1920, SourceHeight: 1080, PixelFormat: "yuv420p", SarNum: 1, SarDen: 1);

    private static Dictionary<Guid, ExportAssetSource> Sources(ExportAssetSource bottom) => new()
    {
        [Bottom] = bottom,
        [Top] = FullFacts("assets/top.mp4"),
    };

    /// <summary>
    /// İki katman: altta timeline'ı baştan sona kaplayan tam-kare video, üstte PiP.
    /// Taban klip istenirse değiştirilebilir (yüklem olgularını tek tek bozmak için).
    /// </summary>
    private static TimelineDoc TwoLayerDoc(MediaClip? bottomClip = null) =>
        ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(Top, 1_000_000, 0, 3_000_000,
                    transform: ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.35)),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                bottomClip ?? ExportTestDocs.VideoClip(Bottom, 0, 0, 4_000_000),
            ]),
        ]);

    private static string Graph(TimelineDoc doc, Dictionary<Guid, ExportAssetSource> sources) =>
        ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p).FilterGraphScript;

    [Fact]
    public void FullFacts_SkipTheBaseCanvas_AndKeepTheRemainingOverlay()
    {
        var script = Graph(TwoLayerDoc(), Sources(FullFacts("assets/a.mp4")));

        Assert.DoesNotContain("[base]", script);
        Assert.DoesNotContain("color=c=", script); // taban tuval kaynağı hiç kurulmaz
        // Kalan kompozisyon AYNEN: üst katman taban run'ın ÜSTÜNE overlay edilir.
        Assert.Contains("[v0][v1]overlay=", script);
        // Atlama hızlı yola GİRMEZ: kompozisyon RGB rejimi korunur (§6.3).
        Assert.Contains("format=rgba", script);
        Assert.Contains(":format=rgb", script);
    }

    public static TheoryData<string> MissingFactNames() =>
    [
        "olgu-null", "aspect-1919", "alfali-yuva420p", "bilinmeyen-pixfmt",
        "sar-2-1", "sar-bilinmiyor",
    ];

    [Theory]
    [MemberData(nameof(MissingFactNames))]
    public void AnyMissingOrForeignSourceFact_KeepsTheBaseCanvas(string name)
    {
        // Yüklemin KAYNAK yarısı: olgular tek tek eksiltilir/yabancılaştırılır → atlama YOK.
        ExportAssetSource bottom = name switch
        {
            "olgu-null" => new("assets/a.mp4", false, "bt709", "bt709"),
            "aspect-1919" => FullFacts("assets/a.mp4") with { SourceWidth = 1919 },
            "alfali-yuva420p" => FullFacts("assets/a.mp4") with { PixelFormat = "yuva420p" },
            "bilinmeyen-pixfmt" => FullFacts("assets/a.mp4") with { PixelFormat = "acayipfmt" },
            "sar-2-1" => FullFacts("assets/a.mp4") with { SarNum = 2, SarDen = 1 },
            "sar-bilinmiyor" => FullFacts("assets/a.mp4") with { SarNum = 0, SarDen = 0 },
            _ => throw new ArgumentOutOfRangeException(nameof(name)),
        };

        var script = Graph(TwoLayerDoc(), Sources(bottom));
        Assert.Contains("[base]", script);
        Assert.Contains("[base][v0]overlay=", script);
    }

    [Fact]
    public void NonOpaqueBottomClip_KeepsTheBaseCanvas()
    {
        var clip = ExportTestDocs.VideoClip(Bottom, 0, 0, 4_000_000, opacity: 0.999);
        var script = Graph(TwoLayerDoc(clip), Sources(FullFacts("assets/a.mp4")));
        Assert.Contains("[base]", script);
    }

    [Fact]
    public void AnimatedBottomClip_KeepsTheBaseCanvas()
    {
        var clip = ExportTestDocs.VideoClip(Bottom, 0, 0, 4_000_000);
        clip.Keyframes = new KeyframeTracks
        {
            Opacity = [ExportTestDocs.Kf(0, 1), ExportTestDocs.Kf(4_000_000, 0.5)],
        };
        var script = Graph(TwoLayerDoc(clip), Sources(FullFacts("assets/a.mp4")));
        Assert.Contains("[base]", script);
    }

    [Fact]
    public void BottomRunThatDoesNotSpanTheWholeTimeline_KeepsTheBaseCanvas()
    {
        // Taban 1 sn'de başlar → [0,1) penceresinde arka planı yalnız tuval verebilir.
        var clip = ExportTestDocs.VideoClip(Bottom, 1_000_000, 0, 3_000_000);
        var script = Graph(TwoLayerDoc(clip), Sources(FullFacts("assets/a.mp4")));
        Assert.Contains("[base]", script);
    }

    [Fact]
    public void BottomPipThatDoesNotCoverTheCanvas_KeepsTheBaseCanvas()
    {
        var clip = ExportTestDocs.VideoClip(Bottom, 0, 0, 4_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5));
        var script = Graph(TwoLayerDoc(clip), Sources(FullFacts("assets/a.mp4")));
        Assert.Contains("[base]", script);
    }

    [Fact]
    public void SingleFullCoverRun_StillTakesTheFastPath_NotTheCanvasSkip()
    {
        // Atlama KOMPOZİSYON rejimine aittir; tek-run belge olgular TAM olsa da eski hızlı
        // yolda kalır (yuv420p letterbox — §6.3 rejimi ve golden'ları değişmez).
        var doc = ExportTestDocs.Doc(
            clips: ExportTestDocs.VideoClip(Bottom, 0, 0, 4_000_000));
        var script = Graph(doc, new Dictionary<Guid, ExportAssetSource>
        {
            [Bottom] = FullFacts("assets/a.mp4"),
        });
        Assert.DoesNotContain("[base]", script);
        Assert.Contains("format=yuv420p", script); // hızlı yol imzası
        Assert.DoesNotContain(":format=rgb", script);
    }
}
