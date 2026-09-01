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

    // ───────────── ÖRTÜLEN-KATMAN BUDAMASI (§2.6 — 2026-09-01 perf turu) ─────────────

    private static readonly Guid Middle = ExportTestDocs.AssetC;

    /// <summary>
    /// Budama topolojisi (render sırası alttan üste = giriş sırası):
    ///  [0] taban: tam-kare video [0,4) — cutaway'in penceresine SIĞMAZ → budanAMAZ;
    ///  [1] ÖRTÜLEN orta katman: PiP [1.5,2.5) + SES — pencere ⊆ cutaway → video zinciri budanır;
    ///  [2] örtücü cutaway: tam-kare video [1,3).
    /// Cutaway klibi istenirse değiştirilir (yüklemi tek tek bozmak için).
    /// </summary>
    private static TimelineDoc CutawayDoc(
        MediaClip? cutaway = null, MediaClip? middle = null) => ExportTestDocs.MultiTrackDoc(
    [
        ExportTestDocs.VideoTrack(clips:
        [
            cutaway ?? ExportTestDocs.VideoClip(Top, 1_000_000, 0, 2_000_000),
        ]),
        ExportTestDocs.VideoTrack(clips:
        [
            middle ?? ExportTestDocs.VideoClip(Middle, 1_500_000, 0, 1_000_000,
                ExportTestDocs.Audio(),
                transform: ExportTestDocs.Transform(x: 0.2, y: 0.2, scale: 0.3)),
        ]),
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(Bottom, 0, 0, 4_000_000),
        ]),
    ]);

    private static Dictionary<Guid, ExportAssetSource> CutawaySources(
        ExportAssetSource? cutawaySource = null) => new()
    {
        [Bottom] = FullFacts("assets/a.mp4"),
        [Middle] = new("assets/c.mp4", HasAudio: true, "bt709", "bt709"),
        [Top] = cutawaySource ?? FullFacts("assets/top.mp4"),
    };

    [Fact]
    public void CoveredLayer_IsPruned_ButItsAudioAndInputSurvive()
    {
        var script = Graph(CutawayDoc(), CutawaySources());

        // Orta katmanın VİDEO zinciri yok: girişi [1] (render sırası: alt=0, orta=1, üst=2).
        Assert.DoesNotContain("[1:v]", script);
        // SESİ AYNEN duruyor (örtülen katman görünmez ama DUYULUR — §2.6).
        Assert.Contains("[1:a]", script);
        // Taban ve örtücü zincirleri yerinde; taban tam-span örtücü olduğu için tuval de atlanır.
        Assert.Contains("[0:v]", script);
        Assert.Contains("[2:v]", script);
        Assert.DoesNotContain("[base]", script);
        // Kompozisyon topolojisi korunur: kalan tek overlay örtücünün overlay'idir.
        Assert.Contains("[v0][v2]overlay=", script);
    }

    [Fact]
    public void PruningDecision_NeverTouchesTheInputList()
    {
        // "Girişler DOKUNULMAZ": budama yalnız filtergraph satırlarını düşürür — giriş listesi
        // (ffmpeg -i argümanları) olgulu/olgusuz derlemede BİREBİR aynı kalır.
        var doc = CutawayDoc();
        var withFacts = ExportCompiler.Compile(doc, CutawaySources(), ExportProfile.Hd1080p);
        var factless = ExportCompiler.Compile(doc, new Dictionary<Guid, ExportAssetSource>
        {
            [Bottom] = new("assets/a.mp4", false, "bt709", "bt709"),
            [Middle] = new("assets/c.mp4", true, "bt709", "bt709"),
            [Top] = new("assets/top.mp4", false, "bt709", "bt709"),
        }, ExportProfile.Hd1080p);

        Assert.Equal(
            factless.Inputs.Select(i => string.Join(' ', i.ToArgs())),
            withFacts.Inputs.Select(i => string.Join(' ', i.ToArgs())));
    }

    public static TheoryData<string> UnqualifiedCovererNames() =>
    [
        "olgu-null", "aspect-1919", "alfali-yuva420p", "sar-2-1", "opacity-0999",
        "keyframeli-ortucu", "pencere-tasan-orta",
    ];

    [Theory]
    [MemberData(nameof(UnqualifiedCovererNames))]
    public void UnqualifiedCoverer_NeverPrunesTheCoveredLayer(string name)
    {
        // Yüklemin HER olgusu tek tek düşürülür → budama ATEŞLENMEZ (orta katmanın video
        // zinciri [1:v] yerinde kalır). Baş mimar kararının negatif seti.
        var (doc, sources) = name switch
        {
            "olgu-null" => (CutawayDoc(),
                CutawaySources(new ExportAssetSource("assets/top.mp4", false, "bt709", "bt709"))),
            "aspect-1919" => (CutawayDoc(),
                CutawaySources(FullFacts("assets/top.mp4") with { SourceWidth = 1919 })),
            "alfali-yuva420p" => (CutawayDoc(),
                CutawaySources(FullFacts("assets/top.mp4") with { PixelFormat = "yuva420p" })),
            "sar-2-1" => (CutawayDoc(),
                CutawaySources(FullFacts("assets/top.mp4") with { SarNum = 2, SarDen = 1 })),
            "opacity-0999" => (CutawayDoc(
                    ExportTestDocs.VideoClip(Top, 1_000_000, 0, 2_000_000, opacity: 0.999)),
                CutawaySources()),
            "keyframeli-ortucu" => (CutawayDoc(AnimatedCoverer()), CutawaySources()),
            "pencere-tasan-orta" => (CutawayDoc(
                    middle: ExportTestDocs.VideoClip(Middle, 500_000, 0, 1_000_000,
                        ExportTestDocs.Audio(),
                        transform: ExportTestDocs.Transform(x: 0.2, y: 0.2, scale: 0.3))),
                CutawaySources()),
            _ => throw new ArgumentOutOfRangeException(nameof(name)),
        };

        var script = Graph(doc, sources);
        Assert.Contains("[1:v]", script);
    }

    private static MediaClip AnimatedCoverer()
    {
        var clip = ExportTestDocs.VideoClip(Top, 1_000_000, 0, 2_000_000);
        clip.Keyframes = new KeyframeTracks
        {
            Opacity = [ExportTestDocs.Kf(0, 1), ExportTestDocs.Kf(2_000_000, 0.5)],
        };
        return clip;
    }

    [Fact]
    public void CovererBelowTheLayer_NeverPrunesUpward()
    {
        // Örtücü ALTTAYSA üsttekini budayamaz (overlay sırası): örtücü tam-kare [0,4),
        // ÜSTÜNDE pencere-içi PiP — PiP kalmalı.
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(Middle, 1_000_000, 0, 1_000_000,
                    transform: ExportTestDocs.Transform(x: 0.2, y: 0.2, scale: 0.3)),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(Bottom, 0, 0, 4_000_000),
            ]),
        ]);
        var script = Graph(doc, new Dictionary<Guid, ExportAssetSource>
        {
            [Bottom] = FullFacts("assets/a.mp4"),
            [Middle] = new("assets/c.mp4", false, "bt709", "bt709"),
        });

        // Alt run taban-tuval atlamasını alır ama üst PiP AYNEN overlay edilir.
        Assert.Contains("[1:v]", script);
        Assert.Contains("overlay=", script);
    }

    [Fact]
    public void AdjacentCoverersOnSeparateTracks_DoNotPruneByWindowUnion()
    {
        // PENCERE BİRLEŞİMİ YOK (§2.6 kapsam beyanı): [0,2) ve [2,4) iki AYRI track'te iki
        // tam-kare örtücü; orta katmanın penceresi [1,3) yalnız İKİSİNİN BİRLEŞİMİYLE
        // kapsanır → budama YAPILMAZ.
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(Top, 0, 0, 2_000_000),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(Top, 2_000_000, 2_000_000, 4_000_000),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(Middle, 1_000_000, 0, 2_000_000,
                    transform: ExportTestDocs.Transform(x: 0.2, y: 0.2, scale: 0.3)),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(Bottom, 0, 0, 4_000_000),
            ]),
        ]);
        var script = Graph(doc, new Dictionary<Guid, ExportAssetSource>
        {
            [Bottom] = FullFacts("assets/a.mp4"),
            [Middle] = new("assets/c.mp4", false, "bt709", "bt709"),
            [Top] = FullFacts("assets/top.mp4"),
        });

        // Orta katman (render sırasında giriş 1) YERİNDE.
        Assert.Contains("[1:v]", script);
    }

    [Fact]
    public void FullSpanTopCoverer_PrunesEverythingBelow_ButKeepsTheBaseCanvasTopology()
    {
        // En üst run [0,4) tam-kare örtücü → alttaki HER pencere kapsanır ve budanır; geriye
        // tek sağ kalan run kalır. Bayt kanıtı "taban + overlay" topolojisi için kurulduğundan
        // atlama BURADA yapılmaz: örtücü, taban tuvale NORMAL overlay edilir (overlay'siz düz
        // çıkış encoder'a farklı ara formattan iner — 2026-08-24 bisect'inin bayt-farkı sınıfı).
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(Top, 0, 0, 4_000_000),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(Bottom, 0, 0, 4_000_000),
            ]),
        ]);
        var script = Graph(doc, new Dictionary<Guid, ExportAssetSource>
        {
            [Bottom] = FullFacts("assets/a.mp4"),
            [Top] = FullFacts("assets/top.mp4"),
        });

        Assert.DoesNotContain("[0:v]", script); // alt katman budandı
        Assert.Contains("[base]", script);      // tuval + tek overlay topolojisi korunur
        Assert.Contains("[base][v1]overlay=", script);
    }
}
