using System.Globalization;
using System.Text;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Export;

namespace VideoEdit.UnitTests;

/// <summary>
/// FilterGraph Compiler v1 snapshot testleri: sabit fixture dokümanları → üretilen
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
            // İlk klip 1 sn'de başlar → baştaki boşluk da color source ile doldurulur.
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
            // frame defteri + trim=end_frame olmadan color source ±1 frame üretebilir (denetim
            // reprosu). Klip2: frame 32'de başlar (1067733 µs — grid'de), 60 frame sürer.
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_001_000,
                ExportTestDocs.Audio()),
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_067_733, 2_000_000, 4_002_000,
                ExportTestDocs.Audio(volume: 0.5)),
        ]);

    private static Dictionary<Guid, ExportAssetSource> SdrSources(bool hasAudio = true) => new()
    {
        [ExportTestDocs.AssetA] = new ExportAssetSource("assets/a.mp4", hasAudio, "bt709", "bt709"),
        [ExportTestDocs.AssetB] = new ExportAssetSource("assets/b.mp4", hasAudio, "bt709", "bt709"),
    };

    private static Dictionary<Guid, ExportAssetSource> HdrSources() => new()
    {
        [ExportTestDocs.AssetA] = new ExportAssetSource("assets/hdr.mov", true, "smpte2084", "bt2020"),
    };

    public static TheoryData<string> FixtureNames() =>
    [
        "single-clip", "multi-clip-contiguous", "with-gaps",
        "muted-audio", "audio-fades", "hdr-source", "ntsc-fps", "ntsc-gap",
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
        var first = Render(ExportCompiler.Compile(AudioFades(), SdrSources(), ExportProfile.Hd1080p));
        var second = Render(ExportCompiler.Compile(AudioFades(), SdrSources(), ExportProfile.Hd1080p));
        Assert.Equal(first, second);
    }

    [Fact]
    public void Compile_UnderTurkishCulture_ProducesIdenticalOutput()
    {
        // TR locale ondalık ayracı virgüldür — script'e "0,5" sızarsa ffmpeg patlar (tuzak #1).
        var invariant = Render(ExportCompiler.Compile(AudioFades(), SdrSources(), ExportProfile.Hd1080p));

        var culture = CultureInfo.CurrentCulture;
        var uiCulture = CultureInfo.CurrentUICulture;
        try
        {
            CultureInfo.CurrentCulture = new CultureInfo("tr-TR");
            CultureInfo.CurrentUICulture = new CultureInfo("tr-TR");
            var turkish = Render(ExportCompiler.Compile(AudioFades(), SdrSources(), ExportProfile.Hd1080p));
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
    public void Compile_Gaps_ProduceColorSourceSegments_PinnedToFrameLedger()
    {
        var compiled = ExportCompiler.Compile(WithGaps(), SdrSources(hasAudio: false), ExportProfile.Hd1080p);

        // 2 klip + 2 boşluk (baştaki + aradaki) = 4 segmentli concat; concat SONRASI setparams
        // çıktı frame'lerini BT.709/tv işaretler (ffmpeg 7+ CLI tag ezme düzeltmesi).
        Assert.Contains(
            "concat=n=4:v=1:a=0,"
            + "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[vout]",
            compiled.FilterGraphScript);

        // Boşluk 30 frame: color d= bir frame cömert (31 frame), trim=end_frame=30 kesinleştirir.
        Assert.Contains("color=c=0x000000:s=1920x1080:r=30/1:d=1.033333,trim=end_frame=30",
            compiled.FilterGraphScript);

        // Klipler de frame defterine sabitlenir (2 sn @30fps = 60 frame).
        Assert.Contains("fps=30/1,trim=end_frame=60,scale=", compiled.FilterGraphScript);
        Assert.Equal(6_000_000, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Compile_NtscGap_FrameLedgerProducesExactFrameCounts()
    {
        // Denetim reprosu: 30000/1001'de 2 frame'lik boşluğun µs-farkı (66733 µs) color source'a
        // süre olarak verilirse ffmpeg 3 frame üretebilir → tüm sonraki klipler +1 frame kayar.
        // Frame defteri: boşluk trim=end_frame=2 ile TAM 2 frame'e sabitlenir.
        var compiled = ExportCompiler.Compile(NtscGap(), SdrSources(), ExportProfile.Hd1080p);

        Assert.Contains(",trim=end_frame=2,", compiled.FilterGraphScript);      // boşluk: 2 frame
        Assert.Contains("fps=30000/1001,trim=end_frame=30,", compiled.FilterGraphScript); // klip1
        Assert.Contains("fps=30000/1001,trim=end_frame=60,", compiled.FilterGraphScript); // klip2
        // adelay frame defterinden: klip2 frame 32 → 1067733 µs → 1068 ms (half-up).
        Assert.Contains("adelay=1068|1068", compiled.FilterGraphScript);
        // Toplam süre frame defteriyle tutarlı: 92 frame = 3069733 µs.
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
    public void Validate_MultiplePopulatedTracks_Throws()
    {
        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        doc.Tracks.Add(new Track
        {
            Id = Guid.CreateVersion7(),
            Type = TrackType.Overlay,
            Clips = [ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 1_000_000)],
        });

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("multiple-tracks", ex.Feature);
        // Mesaj kullanıcıya ProblemDetails detail'inde gösterilir — Türkçe ve yönlendirici.
        Assert.Contains("track", ex.Message);
        Assert.Contains("M4", ex.Message);
    }

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
        Assert.Equal(TrackType.Video, plan.VideoTrack.Type);
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
    public void Validate_NonDefaultTransform_Throws()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Transform.Scale = 0.5;
        var doc = ExportTestDocs.Doc(clips: clip);

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("transform", ex.Feature);
    }

    [Fact]
    public void Validate_OverlappingClips_ThrowsInvalidTimeline()
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
