using System.Globalization;
using System.Text;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Export;

namespace VideoEdit.UnitTests;

/// <summary>
/// FilterGraph Compiler snapshot testleri: sabit fixture dokümanları → üretilen
/// girişler + filtergraph script + çıktı argümanları, repoya commit'li beklenen dosyalarla
/// (tests/ExportSnapshots/*.txt) BİREBİR karşılaştırılır. Dosya yoksa üretilir ve test
/// "snapshot üretildi" olarak geçer — ilk koşuda snapshot'lar oluşur, sonraki koşular sabitler.
/// </summary>
public sealed class ExportCompilerSnapshotTests
{
    private static readonly string SnapshotDir =
        TestVectorFiles.Resolve("backend/tests/VideoEdit.UnitTests/ExportSnapshots");

    // ---------- Fixture dokümanları ----------

    private static TimelineDoc SingleClip() => ExportTestDocs.Doc(
        clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 10_000_000, 18_000_000));

    private static TimelineDoc MultiClipContiguous() => ExportTestDocs.Doc(
        clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000,
                ExportTestDocs.Audio()),
            // Aynı asset'ten ikinci klip = İKİNCİ ayrı -i girişi (tasarım 04 §2.1).
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 2_000_000, 5_000_000, 8_000_000,
                ExportTestDocs.Audio()),
        ]);

    private static TimelineDoc WithGaps() => ExportTestDocs.Doc(
        clips:
        [
            // İlk klip 1 sn'de başlar → baştaki boşlukta taban tuval görünür.
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 1_000_000, 0, 2_000_000),
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 4_000_000, 2_000_000, 4_000_000),
        ]);

    private static TimelineDoc MutedAudio() => ExportTestDocs.Doc(
        clips:
        [
            // Klip sesi VAR ama muted → ses zinciri üretilmez → anullsrc yolu.
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 3_000_000,
                ExportTestDocs.Audio(muted: true)),
        ]);

    private static TimelineDoc AudioFades() => ExportTestDocs.Doc(
        clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 3_000_000,
                ExportTestDocs.Audio(volume: 0.5, fadeInUs: 500_000, fadeOutUs: 1_000_000)),
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 3_000_000, 0, 2_000_000,
                ExportTestDocs.Audio(volume: 2)),
        ]);

    private static TimelineDoc HdrSource() => ExportTestDocs.Doc(
        clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000,
            ExportTestDocs.Audio()));

    private static TimelineDoc NtscFps() => ExportTestDocs.Doc(
        fpsNum: 30000, fpsDen: 1001,
        clips:
        [
            // 60 frame @29.97 = 2.002 sn; klipler frame grid'i üstünde.
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_002_000,
                ExportTestDocs.Audio(fadeOutUs: 500_500)),
        ]);

    private static TimelineDoc NtscGap() => ExportTestDocs.Doc(
        fpsNum: 30000, fpsDen: 1001,
        clips:
        [
            // Klip1: 30 frame (1001000 µs). Boşluk: 2 frame — µs-farkı kesirlidir (66733.3 µs),
            // frame defteri + trim=end_frame olmadan ±1 frame kayma üretebilir (denetim reprosu).
            // Klip2: frame 32'de başlar (1067733 µs — grid'de), 60 frame sürer.
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_001_000,
                ExportTestDocs.Audio()),
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_067_733, 2_000_000, 4_002_000,
                ExportTestDocs.Audio(volume: 0.5)),
        ]);

    // ---------- M4 dalga 1: çok katman fixture'ları ----------

    /// <summary>İki tam-kare video katmanı: tracks[0] EN ÜST — render sırası sondan başa.</summary>
    private static TimelineDoc TwoVideoLayers() => ExportTestDocs.MultiTrackDoc(
    [
        // ÜST katman: 1-3 sn arası görünür; altındaki taban katmanı bu pencerede örter.
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_000_000, 0, 2_000_000,
                ExportTestDocs.Audio()),
        ]),
        // ALT (taban) katman: 0-4 sn tam kare.
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 4_000_000,
                ExportTestDocs.Audio()),
        ]),
    ]);

    /// <summary>Transform'lu PiP: ölçek 0.35, sağ üst çeyreğe taşınmış (rendering-semantics §2).</summary>
    private static TimelineDoc PipTransform() => ExportTestDocs.MultiTrackDoc(
    [
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_000_000, 0, 2_000_000,
                transform: ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.35)),
        ]),
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 4_000_000,
                ExportTestDocs.Audio()),
        ]),
    ]);

    /// <summary>Opaklık + dönme: alpha'lı katman format=rgba + colorchannelmixer + rotate.</summary>
    private static TimelineDoc LayerOpacity() => ExportTestDocs.MultiTrackDoc(
    [
        // ÜST: yarı saydam, 30° döndürülmüş, sol alt çapalı (çapa telafisi pad'i üretir).
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 0, 0, 2_000_000,
                transform: ExportTestDocs.Transform(scale: 0.5, rotationDeg: 30, anchorX: 0, anchorY: 1),
                opacity: 0.5),
        ]),
        // ORTA: yarı saydam ama dönmesiz (yalnız colorchannelmixer).
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000, opacity: 0.25),
        ]),
        // ALT: opak taban.
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
        ]),
    ]);

    /// <summary>
    /// hidden track GÖRSEL üretmez ama SES üretmeye devam eder; muted track ses üretmez
    /// (apps/editor resolve.ts semantiği — hidden yalnız görsel gizlemedir).
    /// </summary>
    private static TimelineDoc HiddenAndMutedTracks() => ExportTestDocs.MultiTrackDoc(
    [
        // ÜST: gizli — overlay YOK, ses VAR.
        ExportTestDocs.VideoTrack(hidden: true, clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000, ExportTestDocs.Audio()),
        ]),
        // ORTA: susturulmuş — overlay VAR, ses YOK.
        ExportTestDocs.VideoTrack(muted: true, clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 0, 0, 2_000_000, ExportTestDocs.Audio()),
        ]),
        // ALT: normal.
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
        ]),
    ]);

    /// <summary>
    /// Denetim #1 reprosu: OPAK katman, ALPHA'lı katmanın ÜSTÜNDE. Katman başına format
    /// seçiminde alt overlay RGB'de, üst overlay yuv420'de blend ederdi → zincirin ortasında
    /// RGB↔YUV dönüşümü ve gözle görülür renk kayması (gerçek render ölçümü: MSE 187 > 60).
    /// Sözleşme: format seçimi GRAFİK BAŞINADIR — tüm overlay'ler :format=rgb.
    /// </summary>
    private static TimelineDoc OpaqueOverAlpha() => ExportTestDocs.MultiTrackDoc(
    [
        // ÜST: tamamen OPAK PiP (alpha yok, dönme yok) — alttaki alpha'lı katmanın üstüne biner.
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000,
                transform: ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.5)),
        ]),
        // ORTA: yarı saydam tam kare katman (grafiğin alpha taşıyan tek katmanı).
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 0, 0, 2_000_000, opacity: 0.5),
        ]),
        // ALT: opak taban.
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
        ]),
    ]);

    /// <summary>Video track + audio track miksi: ses klibi görsel katman ÜRETMEZ.</summary>
    private static TimelineDoc AudioTrackMix() => ExportTestDocs.MultiTrackDoc(
    [
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 3_000_000, ExportTestDocs.Audio()),
        ]),
        ExportTestDocs.AudioTrack(clips:
        [
            ExportTestDocs.AudioClip(ExportTestDocs.AssetC, 0, 0, 4_000_000,
                ExportTestDocs.Audio(volume: 0.35, fadeOutUs: 1_000_000)),
        ]),
    ]);

    private static Dictionary<Guid, ExportAssetSource> SdrSources(bool hasAudio = true) => new()
    {
        [ExportTestDocs.AssetA] = new ExportAssetSource("assets/a.mp4", hasAudio, "bt709", "bt709"),
        [ExportTestDocs.AssetB] = new ExportAssetSource("assets/b.mp4", hasAudio, "bt709", "bt709"),
        [ExportTestDocs.AssetC] = new ExportAssetSource("assets/c.mp4", hasAudio, "bt709", "bt709"),
    };

    private static Dictionary<Guid, ExportAssetSource> HdrSources() => new()
    {
        [ExportTestDocs.AssetA] = new ExportAssetSource("assets/hdr.mov", true, "smpte2084", "bt2020"),
    };

    public static TheoryData<string> FixtureNames() =>
    [
        "single-clip", "multi-clip-contiguous", "with-gaps",
        "muted-audio", "audio-fades", "hdr-source", "ntsc-fps", "ntsc-gap",
        "two-video-layers", "pip-transform", "layer-opacity",
        "hidden-muted-tracks", "audio-track-mix", "opaque-over-alpha",
    ];

    private static (TimelineDoc Doc, Dictionary<Guid, ExportAssetSource> Sources) Fixture(string name) =>
        name switch
        {
            "single-clip" => (SingleClip(), SdrSources(hasAudio: false)),
            "multi-clip-contiguous" => (MultiClipContiguous(), SdrSources()),
            "with-gaps" => (WithGaps(), SdrSources(hasAudio: false)),
            "muted-audio" => (MutedAudio(), SdrSources()),
            "audio-fades" => (AudioFades(), SdrSources()),
            "hdr-source" => (HdrSource(), HdrSources()),
            "ntsc-fps" => (NtscFps(), SdrSources()),
            "ntsc-gap" => (NtscGap(), SdrSources()),
            "two-video-layers" => (TwoVideoLayers(), SdrSources()),
            "pip-transform" => (PipTransform(), SdrSources()),
            "layer-opacity" => (LayerOpacity(), SdrSources()),
            "hidden-muted-tracks" => (HiddenAndMutedTracks(), SdrSources()),
            "audio-track-mix" => (AudioTrackMix(), SdrSources()),
            "opaque-over-alpha" => (OpaqueOverAlpha(), SdrSources()),
            _ => throw new ArgumentOutOfRangeException(nameof(name)),
        };

    // ---------- Snapshot testleri ----------

    [Theory]
    [MemberData(nameof(FixtureNames))]
    public void Compile_MatchesSnapshot(string name)
    {
        var (doc, sources) = Fixture(name);
        var compiled = ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p);
        var actual = Render(compiled);

        Directory.CreateDirectory(SnapshotDir);
        var snapshotPath = Path.Combine(SnapshotDir, name + ".txt");
        if (!File.Exists(snapshotPath))
        {
            File.WriteAllText(snapshotPath, actual);
            return; // ilk koşu: snapshot üretildi — sonraki koşular birebir karşılaştırır
        }

        var expected = File.ReadAllText(snapshotPath).Replace("\r\n", "\n");
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void Compile_IsDeterministic_AcrossRuns()
    {
        var first = Render(ExportCompiler.Compile(LayerOpacity(), SdrSources(), ExportProfile.Hd1080p));
        var second = Render(ExportCompiler.Compile(LayerOpacity(), SdrSources(), ExportProfile.Hd1080p));
        Assert.Equal(first, second);
    }

    [Fact]
    public void Compile_UnderTurkishCulture_ProducesIdenticalOutput()
    {
        // TR locale ondalık ayracı virgüldür — script'e "0,5" sızarsa ffmpeg patlar (tuzak #1).
        // Fixture transform/opaklık/açı içerir: yeni geometri literal'leri de kapsanır.
        var invariant = Render(ExportCompiler.Compile(LayerOpacity(), SdrSources(), ExportProfile.Hd1080p));

        var culture = CultureInfo.CurrentCulture;
        var uiCulture = CultureInfo.CurrentUICulture;
        try
        {
            CultureInfo.CurrentCulture = new CultureInfo("tr-TR");
            CultureInfo.CurrentUICulture = new CultureInfo("tr-TR");
            var turkish = Render(ExportCompiler.Compile(LayerOpacity(), SdrSources(), ExportProfile.Hd1080p));
            Assert.Equal(invariant, turkish);
            Assert.DoesNotContain(",5", turkish); // virgüllü ondalık yok
        }
        finally
        {
            CultureInfo.CurrentCulture = culture;
            CultureInfo.CurrentUICulture = uiCulture;
        }
    }

    // ---------- Derleme kararlarının nokta doğrulamaları ----------

    [Fact]
    public void Compile_SameAssetTwice_ProducesTwoInputs_WithInputLevelTrim()
    {
        var compiled = ExportCompiler.Compile(MultiClipContiguous(), SdrSources(), ExportProfile.Hd1080p);

        Assert.Equal(2, compiled.Inputs.Count); // aynı dosya, iki ayrı -i girişi
        Assert.Equal("assets/a.mp4", compiled.Inputs[0].Path);
        Assert.Equal("assets/a.mp4", compiled.Inputs[1].Path);
        Assert.Equal(["-ss", "5.000000", "-t", "3.000000", "-i", "assets/a.mp4"],
            compiled.Inputs[1].ToArgs());
        Assert.DoesNotContain("-to", compiled.ToFfmpegArgs("graph.txt", "out.mp4")); // daima -t
    }

    [Fact]
    public void Compile_Gaps_ShowTheBackgroundCanvas_PinnedToFrameLedger()
    {
        var compiled = ExportCompiler.Compile(WithGaps(), SdrSources(hasAudio: false), ExportProfile.Hd1080p);

        // Boşluklar ayrı segment ÜRETMEZ: taban tuval tüm timeline boyunca (6 sn = 180 frame)
        // akar, klipler üstüne bindirilir; klipsiz aralıkta tuval görünür.
        Assert.Contains(
            "color=c=0x000000:s=1920x1080:r=30/1:d=6.033333,trim=end_frame=180,"
            + "format=rgba,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[base]",
            compiled.FilterGraphScript);
        Assert.DoesNotContain("concat=", compiled.FilterGraphScript);

        // Klipler frame defterine sabitlenir (2 sn @30fps = 60 frame) ve timeline'daki
        // yerlerine setpts ile kaydırılır.
        Assert.Contains("fps=30/1,trim=end_frame=60,scale=1920:1080:", compiled.FilterGraphScript);
        Assert.Contains("setpts=PTS-STARTPTS+1.000000/TB", compiled.FilterGraphScript);
        Assert.Contains("setpts=PTS-STARTPTS+4.000000/TB", compiled.FilterGraphScript);

        // Kompozisyon SONRASI setparams çıktı frame'lerini BT.709/tv işaretler.
        Assert.Contains(
            "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[vout]",
            compiled.FilterGraphScript);
        Assert.Equal(6_000_000, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Compile_NtscGap_FrameLedgerProducesExactFrameCounts()
    {
        // Denetim reprosu: 30000/1001'de klip sınırlarının µs-farkı kesirlidir; frame defteri
        // trim=end_frame ile TAM frame sayısını sabitler.
        var compiled = ExportCompiler.Compile(NtscGap(), SdrSources(), ExportProfile.Hd1080p);

        Assert.Contains("fps=30000/1001,trim=end_frame=30,", compiled.FilterGraphScript); // klip1
        Assert.Contains("fps=30000/1001,trim=end_frame=60,", compiled.FilterGraphScript); // klip2
        // adelay frame defterinden: klip2 frame 32 → 1067733 µs → 1068 ms (half-up).
        Assert.Contains("adelay=1068|1068", compiled.FilterGraphScript);
        // Taban tuval de aynı defterden: 92 frame.
        Assert.Contains("trim=end_frame=92,", compiled.FilterGraphScript);
        Assert.Equal(3_069_733, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Validate_ClipOffProjectFrameGrid_ThrowsInvalidTimeline()
    {
        // Güvenlik ağı: editör grid'de üretir; grid dışı start/duration frame defterini bozar
        // ve sessiz snap yerine sözleşme ihlali olarak görünür olmalıdır.
        var offStart = ExportTestDocs.Doc(fpsNum: 30000, fpsDen: 1001,
            clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 50_000, 0, 1_001_000));
        Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(offStart));

        var offDuration = ExportTestDocs.Doc(fpsNum: 30000, fpsDen: 1001,
            clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000)); // 29.97 frame
        Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(offDuration));
    }

    [Fact]
    public void Compile_HdrSource_UsesNormativeColorChain()
    {
        var compiled = ExportCompiler.Compile(HdrSource(), HdrSources(), ExportProfile.Hd1080p);
        // ColorChain.HdrToSdr sabiti (rendering-semantics §6.2) zincirin başında AYNEN yer alır.
        Assert.Contains(VideoEdit.Media.Recipes.ColorChain.HdrToSdr, compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_NoAudibleClips_UsesAnullsrc()
    {
        var compiled = ExportCompiler.Compile(MutedAudio(), SdrSources(), ExportProfile.Hd1080p);
        Assert.Contains("anullsrc=channel_layout=stereo:sample_rate=48000", compiled.FilterGraphScript);
        Assert.DoesNotContain("amix", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_AudioMix_UsesNormalizeZeroAndLimiter()
    {
        var compiled = ExportCompiler.Compile(AudioFades(), SdrSources(), ExportProfile.Hd1080p);
        Assert.Contains("amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.98[aout]",
            compiled.FilterGraphScript);
        Assert.Contains("volume=0.5", compiled.FilterGraphScript);
        Assert.Contains("afade=t=in:st=0:d=0.500000:curve=tri", compiled.FilterGraphScript);
        Assert.Contains("afade=t=out:st=2.000000:d=1.000000:curve=tri", compiled.FilterGraphScript);
        Assert.Contains("adelay=3000|3000", compiled.FilterGraphScript);
    }

    // ---------- M4 dalga 1: çok katman kompozisyonu ----------

    [Fact]
    public void Compile_MultipleTracks_ComposeBottomToTop_TracksZeroIsTopmost()
    {
        // Şema sözleşmesi (docs/design/01 §1.2): tracks[0] EN ÜST katmandır → overlay zinciri
        // taban tuvalden başlayıp SONDAN BAŞA ilerler; en son bindirilen katman en üsttedir.
        var compiled = ExportCompiler.Compile(TwoVideoLayers(), SdrSources(), ExportProfile.Hd1080p);

        // Alt katman (tracks[1] = AssetA, 4 sn) ilk giriştir ve tuvale ilk bindirilir.
        Assert.Equal("assets/a.mp4", compiled.Inputs[0].Path);
        Assert.Equal("assets/b.mp4", compiled.Inputs[1].Path);
        Assert.Contains("[base][v0]overlay=", compiled.FilterGraphScript);
        Assert.Contains("[c0][v1]overlay=", compiled.FilterGraphScript);
        Assert.Contains("[c1]setparams=", compiled.FilterGraphScript);

        // Üst katman (AssetB) 1-3 sn penceresinde görünür; bitiş yarım frame geri çekilir.
        Assert.Contains("enable='between(t,1.000000,2.983334)'", compiled.FilterGraphScript);
        Assert.Contains("setpts=PTS-STARTPTS+1.000000/TB", compiled.FilterGraphScript);

        // Süre alt katmanın sonu; iki klibin sesi de mikse girer.
        Assert.Equal(4_000_000, compiled.ExpectedDurationUs);
        Assert.Contains("amix=inputs=2:", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_PipTransform_UsesNormativePlacementFormula()
    {
        // rendering-semantics §2: fit=contain × scale tek ölçekte; P = (W/2 + x*W, H/2 + y*H);
        // overlay_x = P.x - anchorX*w. 1920x1080, scale 0.35, x=0.25, y=-0.25, çapa merkez:
        //   kutu   = (round(1920*0.35), round(1080*0.35)) = (672, 378)
        //   P      = (960 + 480, 540 - 270) = (1440, 270)
        var compiled = ExportCompiler.Compile(PipTransform(), SdrSources(), ExportProfile.Hd1080p);

        Assert.Contains(
            "scale=672:378:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic",
            compiled.FilterGraphScript);
        Assert.Contains("overlay=x=1440-0.5*w:y=270-0.5*h:", compiled.FilterGraphScript);
        // Opak PiP de rgba ile girer ve RGB'de blend edilir: kompozisyon modu grafik başınadır,
        // katman başına DEĞİL (denetim #1) — 4:2:0 tuval overlay konumunu çift piksele kırpardı.
        Assert.Contains("format=rgba,settb=AVTB,setpts=PTS-STARTPTS+1.000000/TB[v1]",
            compiled.FilterGraphScript);
        Assert.DoesNotContain("format=yuv420p", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_CompositeColorMode_IsGraphWide_NotPerLayer()
    {
        // Denetim #1 (HIGH): opak katman alpha'lı katmanın ÜSTÜNDE. Katman başına seçimde üst
        // overlay :format=rgb ALMAZDI ve zincirin ortasında RGB↔YUV dönüşümü oluşurdu.
        // Sözleşme: HER overlay :format=rgb, HER katman format=rgba, taban tuval de rgba.
        foreach (var name in new[]
                 {
                     "opaque-over-alpha", "layer-opacity", "pip-transform", "two-video-layers",
                     "single-clip", "with-gaps", "hidden-muted-tracks",
                 })
        {
            var (doc, sources) = Fixture(name);
            var script = ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p).FilterGraphScript;
            var overlays = script.Split(";\n").Where(l => l.Contains("]overlay=")).ToList();
            Assert.NotEmpty(overlays);
            Assert.All(overlays, line =>
                Assert.True(line.Contains(":format=rgb[", StringComparison.Ordinal),
                    $"{name}: overlay RGB'de blend etmiyor → {line}"));

            // Alt örneklenmiş (4:2:0) ara format grafiğin HİÇBİR yerinde olmamalı: overlay
            // normalize_xy x/y'yi chroma adımına kırpar → opak/alpha katmanlar farklı piksele
            // otururdu (denetim #15).
            Assert.DoesNotContain("format=yuv420p", script);
            Assert.DoesNotContain(":format=yuv420[", script);
        }
    }

    [Fact]
    public void Compile_EveryLayerChain_DeclaresBt709BeforeAnyFormatConversion()
    {
        // §6.1 "untagged SDR = BT.709/tv" varsayımı RGB'ye geçişten ÖNCE beyan edilmezse
        // swscale kendi varsayılanını kullanır (SD'de BT.601) ve kompozisyon renkleri kayar.
        var (doc, sources) = Fixture("opaque-over-alpha");
        var script = ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p).FilterGraphScript;

        foreach (var line in script.Split(";\n").Where(l => l.Contains(":v]")))
        {
            var declaration = line.IndexOf(ExportCompiler.SourceColorParams, StringComparison.Ordinal);
            var conversion = line.IndexOf("format=rgba", StringComparison.Ordinal);
            Assert.True(declaration >= 0, $"katman renk beyanı yok → {line}");
            Assert.True(declaration < conversion,
                $"renk beyanı format dönüşümünden SONRA geliyor (dönüşümü etkilemez) → {line}");
        }
    }

    [Fact]
    public void Compile_OpacityAndRotation_UseStraightAlphaChain()
    {
        var compiled = ExportCompiler.Compile(LayerOpacity(), SdrSources(), ExportProfile.Hd1080p);

        // §6.3: opaklık straight alpha çarpanıdır → format=rgba + colorchannelmixer=aa.
        Assert.Contains("format=rgba,colorchannelmixer=aa=0.25", compiled.FilterGraphScript);
        Assert.Contains("format=rgba,colorchannelmixer=aa=0.5", compiled.FilterGraphScript);
        // Tüm katmanlar RGB'de blend edilir (yuv420 blend YASAK).
        Assert.Contains(":format=rgb[c0]", compiled.FilterGraphScript);
        Assert.Contains(":format=rgb[c1]", compiled.FilterGraphScript);
        Assert.Contains(":format=rgb[c2]", compiled.FilterGraphScript);

        // §2.5: çapa (0,1) merkezde değil → çapayı tuval ortasına getiren şeffaf pad,
        // ardından merkez etrafında rotate = ÇAPA etrafında rotate.
        Assert.Contains("pad=w=iw*2:h=ih*2:x=iw*1:y=ih*0:color=#00000000",
            compiled.FilterGraphScript);
        Assert.Contains("rotate=a=0.523599:c=none:ow=hypot(iw\\,ih):oh=ow",
            compiled.FilterGraphScript);
        // Dönen katmanda overlay telafisi w/2, h/2'ye sadeleşir.
        Assert.Contains("overlay=x=960-0.5*w:y=540-0.5*h:", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_HiddenTrack_KeepsAudio_MutedTrackDoesNot()
    {
        // resolve.ts semantiği: hidden = YALNIZ görsel gizleme; muted = ses yok.
        var compiled = ExportCompiler.Compile(HiddenAndMutedTracks(), SdrSources(), ExportProfile.Hd1080p);

        // 3 track var ama yalnız 2 görsel katman (gizli olan overlay üretmez).
        Assert.Contains("[base][v0]overlay=", compiled.FilterGraphScript);
        Assert.Contains("[c0][v1]overlay=", compiled.FilterGraphScript);
        Assert.DoesNotContain("[v2]", compiled.FilterGraphScript);

        // Ses: alt (normal) + üst (gizli) = 2 giriş; ortadaki muted track ses üretmez.
        Assert.Contains("amix=inputs=2:duration=longest:normalize=0", compiled.FilterGraphScript);

        // Gizli track'in klibi giriş olarak AÇILIR (sesi lazım) ama :v referansı YOKTUR.
        Assert.Equal(3, compiled.Inputs.Count);
        Assert.Contains("[2:a]", compiled.FilterGraphScript);
        Assert.DoesNotContain("[2:v]", compiled.FilterGraphScript);
        // Susturulmuş track'in klibi görsel olarak vardır ama ses zinciri üretmez.
        Assert.Contains("[1:v]", compiled.FilterGraphScript);
        Assert.DoesNotContain("[1:a]", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_FullyInertClip_OpensNoInput()
    {
        // Gizli VE susturulmuş track: ne görüntü ne ses → giriş bile açılmaz (boşuna decode yok).
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(hidden: true, muted: true, clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000, ExportTestDocs.Audio()),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000, ExportTestDocs.Audio()),
            ]),
        ]);
        var compiled = ExportCompiler.Compile(doc, SdrSources(), ExportProfile.Hd1080p);

        Assert.Single(compiled.Inputs);
        Assert.Equal("assets/a.mp4", compiled.Inputs[0].Path);
        // Süre yine de gizli katmanın sonunu kapsar (timeline uzunluğu görünürlükten bağımsız).
        Assert.Equal(2_000_000, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Compile_AudioTrackClip_ProducesNoVideoLayer()
    {
        var compiled = ExportCompiler.Compile(AudioTrackMix(), SdrSources(), ExportProfile.Hd1080p);

        // Ses klibi görsel katman üretmez: tek overlay (video track'in klibi).
        Assert.Contains("[base][v0]overlay=", compiled.FilterGraphScript);
        Assert.DoesNotContain("[v1]", compiled.FilterGraphScript);
        // Ses klibi mikse girer; müzik 4 sn olduğu için toplam süreyi o belirler.
        Assert.Contains("amix=inputs=2:duration=longest:normalize=0", compiled.FilterGraphScript);
        Assert.Contains("volume=0.35", compiled.FilterGraphScript);
        Assert.Equal(4_000_000, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Compile_TracksOverlapAcrossLayers_IsAllowed()
    {
        // Track İÇİNDE overlap yasak; track'ler ARASI overlap kompozisyonun ta kendisidir.
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000)]),
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000)]),
        ]);

        var plan = ExportCompiler.Validate(doc);
        Assert.Equal(2, plan.Tracks.Count);
        Assert.Equal(2, plan.Clips.Count);
        // Render sırası: en alt katman (docIndex 1) önce.
        Assert.Equal(1, plan.Tracks[0].DocIndex);
        Assert.Equal(0, plan.Tracks[1].DocIndex);
    }

    // ---------- Micro-fade (rendering-semantics §8.4) ----------

    [Fact]
    public void Compile_HardCutEdges_GetFiveMsMicroFades()
    {
        // multi-clip-contiguous: aynı asset ama sourceIn(5s) != önceki sourceOut(2s) → seamless
        // DEĞİL; her iki klibin her iki kenarı sert kesimdir → 5 ms micro-fade in+out.
        var compiled = ExportCompiler.Compile(MultiClipContiguous(), SdrSources(), ExportProfile.Hd1080p);

        Assert.Contains("afade=t=in:st=0:d=0.005000:curve=tri", compiled.FilterGraphScript);
        // Klip1 2 sn: out micro-fade st = 1.995; klip2 3 sn: st = 2.995.
        Assert.Contains("afade=t=out:st=1.995000:d=0.005000:curve=tri", compiled.FilterGraphScript);
        Assert.Contains("afade=t=out:st=2.995000:d=0.005000:curve=tri", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_UserFadeOnEdge_SkipsMicroFadeOnThatEdge()
    {
        // audio-fades klip1: kullanıcı fade'i iki kenarda da var → micro-fade ÜRETİLMEZ
        // (kullanıcı fade'i zaten sıfıra iner); klip2 (fade'siz) iki kenarda micro-fade alır.
        var compiled = ExportCompiler.Compile(AudioFades(), SdrSources(), ExportProfile.Hd1080p);
        var audioLines = compiled.FilterGraphScript.Split(";\n")
            .Where(l => l.Contains(":a]")).ToList();

        var clip1 = Assert.Single(audioLines, l => l.StartsWith("[0:a]"));
        Assert.DoesNotContain("d=0.005000", clip1); // kullanıcı fade'leri kenarları kapsıyor
        Assert.Contains("afade=t=in:st=0:d=0.500000:curve=tri", clip1);

        var clip2 = Assert.Single(audioLines, l => l.StartsWith("[1:a]"));
        Assert.Contains("afade=t=in:st=0:d=0.005000:curve=tri", clip2);
        Assert.Contains("afade=t=out:st=1.995000:d=0.005000:curve=tri", clip2);
    }

    [Fact]
    public void Compile_SeamlessSplice_SkipsMicroFadeOnSharedEdge()
    {
        // §8.4 istisnası: split edilmiş klip — bitişik, aynı asset, B.sourceIn == A.sourceOut,
        // rate eşit → ortak kenarda micro-fade YOK (ses çukuru olmasın); dış kenarlar alır.
        var doc = ExportTestDocs.Doc(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 2_000_000, 2_000_000, 5_000_000,
                ExportTestDocs.Audio()),
        ]);
        var compiled = ExportCompiler.Compile(doc, SdrSources(), ExportProfile.Hd1080p);
        var audioLines = compiled.FilterGraphScript.Split(";\n")
            .Where(l => l.Contains(":a]")).ToList();

        var clip1 = Assert.Single(audioLines, l => l.StartsWith("[0:a]"));
        Assert.Contains("afade=t=in:st=0:d=0.005000:curve=tri", clip1);   // dış kenar (timeline başı)
        Assert.DoesNotContain("afade=t=out", clip1);                       // ortak kenar: atlanır

        var clip2 = Assert.Single(audioLines, l => l.StartsWith("[1:a]"));
        Assert.DoesNotContain("afade=t=in", clip2);                        // ortak kenar: atlanır
        Assert.Contains("afade=t=out:st=2.995000:d=0.005000:curve=tri", clip2); // dış kenar
    }

    [Fact]
    public void Compile_SeamlessSplice_IsTrackLocal()
    {
        // Seamless splice AYNI TRACK'teki komşuluk kuralıdır: farklı katmanlarda aynı asset'in
        // bitişik parçaları ortak kenar SAYILMAZ (ikisi de kendi micro-fade'ini alır).
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 2_000_000, 2_000_000, 5_000_000,
                    ExportTestDocs.Audio()),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
            ]),
        ]);
        var compiled = ExportCompiler.Compile(doc, SdrSources(), ExportProfile.Hd1080p);
        var audioLines = compiled.FilterGraphScript.Split(";\n")
            .Where(l => l.Contains(":a]")).ToList();

        Assert.All(audioLines, l => Assert.Contains("afade=t=in:st=0:d=0.005000:curve=tri", l));
        Assert.All(audioLines, l => Assert.Contains("afade=t=out:st=", l));
    }

    [Fact]
    public void IsSeamlessSplice_MatchesGainTsFormula()
    {
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 2_000_000, 2_000_000, 3_000_000);
        Assert.True(ExportCompiler.IsSeamlessSplice(a, b));

        // Kaynakta süreklilik kırık → seamless değil.
        var skipped = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 2_000_000, 2_500_000, 3_500_000);
        Assert.False(ExportCompiler.IsSeamlessSplice(a, skipped));

        // Timeline'da boşluk → seamless değil.
        var gapped = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 3_000_000, 2_000_000, 3_000_000);
        Assert.False(ExportCompiler.IsSeamlessSplice(a, gapped));

        // Farklı asset → seamless değil.
        var otherAsset = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 2_000_000, 3_000_000);
        Assert.False(ExportCompiler.IsSeamlessSplice(a, otherAsset));
    }

    [Fact]
    public void Compile_OutputArgs_Are1080pProfileWithBt709Tags()
    {
        var compiled = ExportCompiler.Compile(SingleClip(), SdrSources(hasAudio: false), ExportProfile.Hd1080p);
        var args = string.Join(' ', compiled.OutputArgs);
        Assert.Contains("-map [vout] -map [aout]", args);
        Assert.Contains("-c:v libx264 -preset veryfast -crf 18 -profile:v high -g 150 -pix_fmt yuv420p", args);
        Assert.Contains("-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv", args);
        Assert.Contains("-c:a aac -b:a 192k -ar 48000", args);
        Assert.Contains("-movflags +faststart", args);
    }

    // ---------- UnsupportedFeature / InvalidTimeline vakaları ----------

    [Fact]
    public void Validate_EmptyExtraTracks_AreIgnored()
    {
        // Editör +V/+A ile içeriksiz track ekler — boş track (tipi ne olursa olsun) export'u
        // 422'ye DÜŞÜRMEZ; tek dolu video track'le derleme normal sürer.
        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        doc.Tracks.Add(new Track { Id = Guid.CreateVersion7(), Type = TrackType.Overlay, Clips = [] });
        doc.Tracks.Add(new Track { Id = Guid.CreateVersion7(), Type = TrackType.Audio, Clips = [] });
        doc = ExportTestDocs.Roundtrip(doc);

        var plan = ExportCompiler.Validate(doc);
        Assert.Single(plan.Clips);
        var track = Assert.Single(plan.Tracks);
        Assert.Equal(TrackType.Video, track.Track.Type);
    }

    [Fact]
    public void Validate_OnlyEmptyTracks_ThrowsInvalidTimeline()
    {
        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        doc.Tracks[0].Clips.Clear();
        Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(doc));
    }

    [Fact]
    public void Validate_Transition_Throws()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.TransitionOut = new Transition { Type = TransitionType.Crossfade, DurationUs = 500_000 };
        var doc = ExportTestDocs.Doc(clips: clip);

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("transition", ex.Feature);
    }

    [Fact]
    public void Validate_Keyframes_Throws()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Keyframes = new KeyframeTracks
        {
            Opacity =
            [
                new Keyframe { TimeUs = 0, Value = 0, Easing = new EasingLinear { Type = "linear" } },
            ],
        };
        var doc = ExportTestDocs.Doc(clips: clip);

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("keyframes", ex.Feature);
    }

    [Fact]
    public void Validate_EnabledEffect_Throws()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Effects =
        [
            new Effect { Id = Guid.CreateVersion7(), Type = EffectType.ColorAdjust, Enabled = true },
        ];
        var doc = ExportTestDocs.Doc(clips: clip);

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("effects", ex.Feature);
    }

    [Fact]
    public void Validate_SpeedRate_Throws()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Speed = new MediaClipSpeed { Rate = 2 };
        clip.TimelineDurationUs = 500_000;
        var doc = ExportTestDocs.Doc(clips: clip);

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("speed", ex.Feature);
    }

    [Fact]
    public void Validate_TextClip_Throws()
    {
        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        doc.Tracks[0].Clips.Add(new TextClip
        {
            Id = Guid.CreateVersion7(),
            Kind = "text",
            TimelineStartUs = 1_000_000,
            TimelineDurationUs = 1_000_000,
            Transform = ExportTestDocs.DefaultTransform(),
            Keyframes = new KeyframeTracks(),
            Effects = [],
            Opacity = 1,
        });

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("text-clip", ex.Feature);
    }

    [Fact]
    public void Validate_ImageClip_Throws()
    {
        // Görsel klipleri M4 dalga 2 kapsamındadır (loop'lu giriş + süre modeli) — tipli hata.
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Kind = MediaClipKind.Image;
        var doc = ExportTestDocs.Doc(clips: clip);

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("image-clip", ex.Feature);
    }

    [Fact]
    public void Validate_NonPositiveScale_ThrowsInvalidTimeline()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 0));
        Assert.Throws<InvalidTimelineException>(
            () => ExportCompiler.Validate(ExportTestDocs.Doc(clips: clip)));
    }

    [Fact]
    public void Validate_ScaleBeyondLayerLimit_Throws()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 25)); // 1920*25 = 48000 px
        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(ExportTestDocs.Doc(clips: clip)));
        Assert.Equal("transform-scale", ex.Feature);
    }

    [Fact]
    public void Validate_RotationAndAnchorPadBlowUpTheIntermediateCanvas_Throws()
    {
        // Denetim #2 (HIGH): tavan YALNIZ scale kutusuna uygulanınca çapa pad'i (2x) ve
        // rotate hypot'u (~1.41x) tavanın üstüne çıkıyordu. Gerçek ffmpeg ölçümü (verbose):
        //   scale 2 + çapa(0,0) + 30° → kutu 3840x2160 (tavanın ALTINDA) ama
        //   'overlay w:8812 h:8812 fmt:rgba' = 310 MB/KARE ara tuval → worker OOM.
        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 2, rotationDeg: 30, anchorX: 0, anchorY: 0)));

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("transform-scale", ex.Feature);
        Assert.Contains("8812x8812", ex.Message);       // reddedilen ara tuval kullanıcıya söylenir
        Assert.Contains("3840x2160", ex.Message);       // kutu da görünür ("ölçek küçük ama neden?")

        // AYNI ölçek, dönme YOK → ara tuval kutunun kendisidir (3840x2160) ve kabul edilir.
        var noRotation = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 2, anchorX: 0, anchorY: 0)));
        var plan = ExportCompiler.Validate(noRotation);
        Assert.Single(plan.Clips);
    }

    [Fact]
    public void Validate_RotationWithCenterAnchor_UsesDiagonalCeiling()
    {
        // Merkez çapada pad yoktur ama rotate yine köşegen kadar tuval açar:
        // scale 3.9 → kutu 7488x4212 (tavanın ALTINDA), Dg = ceil(hypot) = 8592 → REDDEDİLİR.
        var rotated = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 3.9, rotationDeg: 12)));
        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(rotated));
        Assert.Contains("8592x8592", ex.Message);

        // Aynı katman dönmeden geçer (7488x4212 ≤ 8192).
        var flat = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 3.9)));
        Assert.Single(ExportCompiler.Validate(flat).Clips);
    }

    [Fact]
    public void Validate_AbsurdScale_CannotOverflowPastTheCeiling()
    {
        // Tavan karşılaştırması long üstünde yapılır; aşırı ölçekte double→long dönüşümü taşar.
        // .NET Core 3.0'dan beri bu dönüşüm SPEC GEREĞİ doyurur (long.MaxValue) — test bu
        // varsayımı sabitler: runtime davranışı değişirse tavan sessizce atlanmasın.
        foreach (var scale in new[] { 1e16, 1e30, double.MaxValue })
        {
            var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
                ExportTestDocs.AssetA, 0, 0, 1_000_000,
                transform: ExportTestDocs.Transform(scale: scale)));
            var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
            Assert.Equal("transform-scale", ex.Feature);
        }
    }

    [Fact]
    public void Validate_OpacityOutOfRange_ThrowsInvalidTimeline()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000, opacity: 1.5);
        Assert.Throws<InvalidTimelineException>(
            () => ExportCompiler.Validate(ExportTestDocs.Doc(clips: clip)));
    }

    [Fact]
    public void Validate_OverlappingClipsWithinOneTrack_ThrowsInvalidTimeline()
    {
        var doc = ExportTestDocs.Doc(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000),
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_000_000, 0, 1_000_000), // overlap
        ]);

        Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(doc));
    }

    [Fact]
    public void Validate_DurationContractViolation_ThrowsInvalidTimeline()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000);
        clip.TimelineDurationUs = 1_500_000; // != sourceOut - sourceIn (rate=1)
        var doc = ExportTestDocs.Doc(clips: clip);

        Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(doc));
    }

    [Fact]
    public void Validate_WrongSchemaVersion_ThrowsInvalidTimeline()
    {
        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        doc.SchemaVersion = 2;

        Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(doc));
    }

    [Fact]
    public void Validate_EmptyTrack_ThrowsInvalidTimeline()
    {
        var doc = ExportTestDocs.Doc();
        Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(doc));
    }

    // ---------- Yardımcılar ----------

    /// <summary>Snapshot metni: girişler + script + çıktı argümanları + beklenen süre.</summary>
    private static string Render(CompiledExport compiled)
    {
        var sb = new StringBuilder();
        sb.Append("# inputs\n");
        foreach (var input in compiled.Inputs)
        {
            sb.Append(string.Join(' ', input.ToArgs())).Append('\n');
        }

        sb.Append("\n# filter_complex_script\n");
        sb.Append(compiled.FilterGraphScript).Append('\n');
        sb.Append("\n# output\n");
        sb.Append(string.Join(' ', compiled.OutputArgs)).Append('\n');
        sb.Append("\n# expectedDurationUs=")
          .Append(compiled.ExpectedDurationUs.ToString(CultureInfo.InvariantCulture))
          .Append('\n');
        return sb.ToString();
    }
}
