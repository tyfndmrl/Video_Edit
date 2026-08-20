using System.Diagnostics;
using System.Text.Json;
using VideoEdit.Media;
using VideoEdit.Media.Probing;
using VideoEdit.Media.Recipes;
using VideoEdit.Media.Waveform;
using VideoEdit.Worker.Jobs;

namespace VideoEdit.UnitTests;

/// <summary>
/// Gerçek ffmpeg/ffprobe ile entegrasyon: sentetik kaynak üret → probe → proxy → çıktıyı
/// ffprobe ile doğrula (GOP≤15, B-frame=0, upscale yasağı), waveform JSON şekli, poster,
/// filmstrip. ffmpeg PATH'te yoksa Skip.
/// </summary>
[Collection("ffmpeg-media")]
public sealed class FfmpegIntegrationTests(FfmpegTestMediaFixture media) : IDisposable
{
    private readonly FfmpegOptions _options = new();
    private readonly string _outDir = Directory.CreateTempSubdirectory("videoedit-ffmpeg-out-").FullName;

    public void Dispose()
    {
        try
        {
            Directory.Delete(_outDir, recursive: true);
        }
        catch
        {
            // best-effort
        }
    }

    private FfprobeService Ffprobe => new(_options);
    private FfmpegRunner Runner => new(_options);

    [FfmpegFact]
    public async Task Probe_ParsesSyntheticVideo()
    {
        var probe = await Ffprobe.ProbeAsync(media.Video320x240WithAudio());

        Assert.True(probe.HasVideo);
        Assert.True(probe.HasAudio);
        Assert.NotNull(probe.DurationUs);
        Assert.InRange(probe.DurationUs!.Value, 2_900_000, 3_300_000);
        Assert.Equal(320, probe.Width);
        Assert.Equal(240, probe.Height);
        Assert.Equal((30, 1), (probe.FpsNum, probe.FpsDen));
        Assert.False(probe.IsVfr);
        Assert.False(probe.IsHdr);
        Assert.Equal(48000, probe.AudioSampleRate);
        Assert.Equal("h264", probe.VideoCodec);
        Assert.Equal("aac", probe.AudioCodec);
    }

    [FfmpegFact]
    public async Task Probe_GarbageFile_ThrowsUnsupportedMedia()
    {
        var garbage = Path.Combine(_outDir, "garbage.mp4");
        await File.WriteAllBytesAsync(garbage, [1, 2, 3, 4, 5, 6, 7, 8]);
        await Assert.ThrowsAsync<UnsupportedMediaException>(() => Ffprobe.ProbeAsync(garbage));
    }

    [FfmpegFact]
    public async Task Proxy_240pSource_NotUpscaled_AndScrubbingContractHolds()
    {
        var source = media.Video320x240WithAudio();
        var probe = await Ffprobe.ProbeAsync(source);
        var proxyPath = Path.Combine(_outDir, "proxy240.mp4");

        var progressSamples = new List<double>();
        var result = await Runner.RunAsync(
            ProxyRecipe.BuildVideoArgs(probe, source, proxyPath),
            probe.DurationUs,
            (fraction, _) =>
            {
                progressSamples.Add(fraction);
                return Task.CompletedTask;
            });
        Assert.True(result.Success, $"proxy transcode failed: {result.StderrTail}");

        // UPSCALE YASAĞI: 240p kaynak 540'a BÜYÜTÜLMEZ — çıktı 320×240 kalır.
        var outProbe = await Ffprobe.ProbeAsync(proxyPath);
        Assert.Equal(320, outProbe.Width);
        Assert.Equal(240, outProbe.Height);
        Assert.Equal("h264", outProbe.VideoCodec);
        Assert.True(outProbe.HasAudio, "proxy should carry the AAC audio track");
        Assert.Equal(48000, outProbe.AudioSampleRate);

        // Scrubbing sözleşmesi (tasarım 02 tuzak #11): ilk 40 frame'de B-frame YOK, GOP ≤ 15.
        using var frames = FfprobeJson.Run(
            "-select_streams", "v:0", "-show_frames", "-read_intervals", "%+#40", proxyPath);
        var frameArray = frames.RootElement.GetProperty("frames").EnumerateArray().ToList();
        Assert.True(frameArray.Count >= 40, $"expected ≥40 frames, got {frameArray.Count}");

        var lastKeyIndex = -1;
        for (var i = 0; i < frameArray.Count; i++)
        {
            var pictType = frameArray[i].GetProperty("pict_type").GetString();
            Assert.NotEqual("B", pictType); // -bf 0
            var isKey = frameArray[i].GetProperty("key_frame").GetInt32() == 1;
            if (i == 0)
            {
                Assert.True(isKey, "first frame must be an IDR keyframe");
            }

            if (isKey)
            {
                if (lastKeyIndex >= 0)
                {
                    Assert.True(i - lastKeyIndex <= 15,
                        $"GOP too long: keyframes at {lastKeyIndex} and {i}");
                }

                lastKeyIndex = i;
            }
        }

        Assert.True(lastKeyIndex >= 15, "expected at least a second keyframe within 40 frames (-g 15)");

        // ffmpeg -progress akışından orantılı ilerleme geldi mi?
        Assert.NotEmpty(progressSamples);
        Assert.All(progressSamples, f => Assert.InRange(f, 0d, 1d));
    }

    [FfmpegFact]
    public async Task Proxy_720pSource_ScaledDownTo540()
    {
        var source = media.Video1280x720NoAudio();
        var probe = await Ffprobe.ProbeAsync(source);
        var proxyPath = Path.Combine(_outDir, "proxy540.mp4");

        var result = await Runner.RunAsync(ProxyRecipe.BuildVideoArgs(probe, source, proxyPath));
        Assert.True(result.Success, $"proxy transcode failed: {result.StderrTail}");

        var outProbe = await Ffprobe.ProbeAsync(proxyPath);
        Assert.Equal(960, outProbe.Width);   // -2:540, 16:9 → 960×540
        Assert.Equal(540, outProbe.Height);
        Assert.False(outProbe.HasAudio);      // sessiz kaynak → ses zinciri hiç yok
    }

    [FfmpegFact]
    public async Task Waveform_MatchesAudiowaveformShape()
    {
        var jsonPath = Path.Combine(_outDir, "peaks.json");
        await new WaveformGenerator(_options).GenerateAsync(media.Video320x240WithAudio(), jsonPath);

        using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(jsonPath));
        var root = doc.RootElement;
        Assert.Equal(2, root.GetProperty("version").GetInt32());
        Assert.Equal(1, root.GetProperty("channels").GetInt32());
        Assert.Equal(8000, root.GetProperty("sample_rate").GetInt32());
        Assert.Equal(160, root.GetProperty("samples_per_pixel").GetInt32());
        Assert.Equal(8, root.GetProperty("bits").GetInt32());

        var length = root.GetProperty("length").GetInt32();
        var data = root.GetProperty("data");
        Assert.Equal(length * 2, data.GetArrayLength());
        Assert.InRange(length, 145, 155); // 3 sn × 50 peak/sn = 150 (±codec priming payı)

        var values = data.EnumerateArray().Select(v => v.GetInt32()).ToList();
        Assert.All(values, v => Assert.InRange(v, -128, 127));
        // Fixture sesi ~0.65 FS sinüs (volume=5) → ölçekli peak ≈ ±83; AAC payıyla > ±40 beklenir.
        Assert.True(values.Max() > 40, $"sine tone should produce visible positive peaks (max={values.Max()})");
        Assert.True(values.Min() < -40, $"sine tone should produce visible negative peaks (min={values.Min()})");
    }

    [FfmpegFact]
    public async Task Waveform_VideoWithoutAudio_ThrowsDeterministicFfmpegError()
    {
        var jsonPath = Path.Combine(_outDir, "no-audio-peaks.json");
        await Assert.ThrowsAsync<FfmpegFailedException>(
            () => new WaveformGenerator(_options).GenerateAsync(media.Video1280x720NoAudio(), jsonPath));
    }

    [FfmpegFact]
    public async Task Poster_KeepsAspect_NoUpscale()
    {
        var source = media.Video320x240WithAudio();
        var probe = await Ffprobe.ProbeAsync(source);
        var posterPath = Path.Combine(_outDir, "poster.jpg");

        var result = await Runner.RunAsync(PosterRecipe.BuildVideoArgs(probe, source, posterPath));
        Assert.True(result.Success, $"poster failed: {result.StderrTail}");

        var bytes = await File.ReadAllBytesAsync(posterPath);
        Assert.True(bytes.Length > 500);
        Assert.Equal(0xFF, bytes[0]); // JPEG SOI
        Assert.Equal(0xD8, bytes[1]);

        using var doc = FfprobeJson.Run("-show_streams", posterPath);
        var stream = doc.RootElement.GetProperty("streams")[0];
        Assert.Equal(320, stream.GetProperty("width").GetInt32());  // 1280 tavanı altında — dokunulmaz
        Assert.Equal(240, stream.GetProperty("height").GetInt32());
    }

    [FfmpegFact]
    public async Task Filmstrip_ProducesSpriteAndAccurateManifest()
    {
        var source = media.Video320x240WithAudio();
        var probe = await Ffprobe.ProbeAsync(source);
        var durationUs = probe.DurationUs!.Value;
        var pattern = Path.Combine(_outDir, "sprite_%d.jpg");

        var result = await Runner.RunAsync(FilmstripRecipe.BuildArgs(probe, durationUs, source, pattern));
        Assert.True(result.Success, $"filmstrip failed: {result.StderrTail}");

        var sprite1 = Path.Combine(_outDir, "sprite_1.jpg");
        Assert.True(File.Exists(sprite1));
        Assert.False(File.Exists(Path.Combine(_outDir, "sprite_2.jpg"))); // 3 kare → tek sprite

        // Sprite boyutu = 30×160 × 10×tileH; 320×240 kaynak → tileH 120 → 4800×1200.
        using var doc = FfprobeJson.Run("-show_streams", sprite1);
        var stream = doc.RootElement.GetProperty("streams")[0];
        Assert.Equal(4800, stream.GetProperty("width").GetInt32());
        Assert.Equal(1200, stream.GetProperty("height").GetInt32());

        var manifest = FilmstripRecipe.BuildManifest(probe, durationUs, ["sprite_1.jpg"]);
        Assert.Equal(1_000_000, manifest.IntervalUs);
        Assert.Equal(120, manifest.TileH);
        Assert.Equal(3, manifest.FrameCount);
    }

    [FfmpegFact]
    public async Task AudioProxy_ProducesAacM4a()
    {
        var source = media.AudioWav();
        var proxyPath = Path.Combine(_outDir, "audio.m4a");

        var result = await Runner.RunAsync(ProxyRecipe.BuildAudioArgs(source, proxyPath));
        Assert.True(result.Success, $"audio proxy failed: {result.StderrTail}");

        var probe = await Ffprobe.ProbeAsync(proxyPath);
        Assert.False(probe.HasVideo);
        Assert.True(probe.HasAudio);
        Assert.Equal("aac", probe.AudioCodec);
        Assert.Equal(48000, probe.AudioSampleRate);
        Assert.Equal(2, probe.AudioChannels);
    }

    // ───────── ÇIKTI SAATİ TAVANI (kaçak süreç: durmadan üretir, asla bitmez) ─────────

    [FfmpegFact]
    public async Task OutputTimeCeiling_KillsAProcessThatKeepsWritingPastTheExpectedDuration()
    {
        // SESSİZLİK BEKÇİSİNİN KÖR NOKTASI. Bekçi ÇIKTI SESSİZLİĞİNİ ölçer; kaçak bir grafik
        // durmadan -progress bastığı için asla sessiz kalmaz ve 120 sn HİÇ dolmaz. Burada o
        // hal birebir kurulur: SINIRSIZ bir üreteç (anullsrc) sonu olmayan bir çıktı yazar.
        // Bekçi 120 sn'de kalsaydı bu test tavana çarpardı; tavan çalışıyorsa saniyeler sürer.
        var outputPath = Path.Combine(_outDir, "runaway.m4a");
        const long ExpectedUs = 2_000_000;

        // TESTİN KENDİ EMNİYETİ: tavan bir gün geri giderse bu koşum ASILIRDI (kaçak süreç
        // sessiz kalmadığı için sessizlik bekçisi de onu kurtarmaz). İptal, süreç ağacını
        // öldürür ve testi ASILMA yerine KIRMIZI yapar.
        using var safety = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var watch = Stopwatch.StartNew();
        FfmpegRunResult result;
        try
        {
            result = await Runner.RunAsync(
                ["-y", "-nostdin", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                 "-c:a", "aac", outputPath],
                ExpectedUs,
                outputTimeCeilingUs: FfmpegRunner.OutputTimeCeilingUs(ExpectedUs),
                ct: safety.Token);
        }
        catch (OperationCanceledException)
        {
            Assert.Fail("çıktı saati tavanı TETİKLENMEDİ: kaçak süreç 30 sn boyunca yaşadı "
                + "ve ancak testin emniyet iptaliyle öldü.");
            throw; // erişilmez
        }

        watch.Stop();

        Assert.True(result.Overran, "kaçak süreç tavana takılmalıydı");
        Assert.False(result.Success);
        // AYRI HALLER AYRI KALMALI: bu bir "hiç çıktı üretmedi" (TimedOut) vakası DEĞİLDİR.
        Assert.False(result.TimedOut);
        Assert.True(watch.Elapsed < FfmpegRunner.DefaultWatchdogTimeout,
            $"tavan sessizlik bekçisinden ÖNCE tetiklenmeliydi ({watch.Elapsed})");
    }

    [FfmpegFact]
    public async Task OutputTimeCeiling_DoesNotKillANormalTranscode()
    {
        // YANLIŞ ÖLDÜRME ÜRETMEME KANITI. Normal bir render'ın bildirdiği EN BÜYÜK out_time
        // beklenen sürenin ALTINDADIR (son karenin damgası); tavan onun çok üstündedir.
        // Bu test tavanı GERÇEK bir transcode'a takar ve süreci bitirir.
        var source = media.Video320x240WithAudio();
        var probe = await Ffprobe.ProbeAsync(source);
        var proxyPath = Path.Combine(_outDir, "ceiling-proxy.mp4");

        var maxFraction = 0d;
        var result = await Runner.RunAsync(
            ProxyRecipe.BuildVideoArgs(probe, source, proxyPath),
            probe.DurationUs,
            (fraction, _) =>
            {
                maxFraction = Math.Max(maxFraction, fraction);
                return Task.CompletedTask;
            },
            outputTimeCeilingUs: FfmpegRunner.OutputTimeCeilingUs(probe.DurationUs!.Value));

        Assert.True(result.Success, $"normal transcode tavana takıldı: {result.StderrTail}");
        Assert.False(result.Overran);
        // Kurulum ölçülür: iş GERÇEKTEN sonuna kadar koştu (aksi hâlde "takılmadı" boş bir iddia).
        Assert.True(maxFraction > 0.9,
            $"transcode sonuna kadar ilerlemeliydi (en büyük oran {maxFraction})");
    }

    [Fact]
    public void OutputTimeCeiling_IsWiderThanTheDurationDeviationTheExportJobAccepts()
    {
        // İKİ EŞİK BİRBİRİYLE TUTARLI OLMAK ZORUNDA: worker çıktı süresini beklenen ±1 sn ile
        // KABUL ediyor. Tavan o payın altına inseydi runner, işin kabul edeceği bir render'ı
        // öldürürdü — kural iki dosyada yaşadığı için bağ ölçülerek sabitlenir.
        foreach (var expectedUs in (long[])[1_000_000, 19_000_000, 4L * 60 * 60 * 1_000_000])
        {
            Assert.True(
                FfmpegRunner.OutputTimeCeilingUs(expectedUs)
                    > expectedUs + ExportJob.OutputDurationToleranceUs,
                $"{expectedUs} us için tavan, işin kabul ettiği sapmadan geniş olmalı");
        }
    }
}
