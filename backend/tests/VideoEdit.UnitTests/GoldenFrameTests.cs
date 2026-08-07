using System.Diagnostics;
using VideoEdit.Media;
using VideoEdit.Media.Export;
using VideoEdit.Media.Probing;

namespace VideoEdit.UnitTests;

/// <summary>
/// Golden-frame CI temeli (rendering-semantics §9, tasarım 04 §6.7): sabit fixture doc
/// (lavfi testsrc2 2 sn HAREKETLİ kaynak — her karesi farklı) → compiler → GERÇEK ffmpeg render
/// → çıktıdan frame çıkarımı (-vf select) → repoya commit'li golden PNG ile piksel MSE
/// karşılaştırması. Örnekleme kesim sınırı karelerini (n_cut-1, n_cut) İÇERİR — statik kaynağın
/// göremediği ±1 frame kaymaları burada görünür (§9.2).
/// Golden yoksa üretilir ve test "golden üretildi" olarak geçer — ilk koşuda golden'lar
/// oluşur ve repoya bırakılır (backend/tests/GoldenFrames/). Ara .raw dosyaları _outDir'e
/// yazılır — golden dizini KİRLETİLMEZ (commit'li dizinde yalnız PNG yaşar).
/// Eşik: farklı ffmpeg sürümlerinin encoder/scale farklarını emer ama yanlış frame /
/// yanlış renk / kayma gibi gerçek kırılmaları (MSE yüzler mertebesi) yakalar.
/// </summary>
[Collection("ffmpeg-media")]
public sealed class GoldenFrameTests(FfmpegTestMediaFixture media) : IDisposable
{
    /// <summary>Kanal başına ortalama kare hata eşiği (0-255 ölçeği, rgb24).</summary>
    private const double MseThreshold = 60.0;

    private static readonly string GoldenDir = TestVectorFiles.Resolve("backend/tests/GoldenFrames");

    private readonly FfmpegOptions _options = new();
    private readonly string _outDir = Directory.CreateTempSubdirectory("videoedit-golden-").FullName;

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

    [FfmpegFact]
    public async Task TwoClipsWithGap_RenderedFrames_MatchGoldens()
    {
        // ── 1) Sabit fixture doc: klip1 0-1sn (kaynak 0-1sn), boşluk 1-1.5sn, klip2 1.5-2.5sn
        //      (kaynak 1-2sn, volume 0.5). Tuval 320x240 @30fps → toplam 75 frame / 2.5 sn.
        //      Kesimler: n=30 (klip1→boşluk) ve n=45 (boşluk→klip2).
        var sourcePath = media.Video320x240Moving2sWithAudio();
        var probe = await new FfprobeService(_options).ProbeAsync(sourcePath);
        Assert.True(probe.HasAudio, "golden source must carry audio");

        var doc = ExportTestDocs.Doc(
            width: 320, height: 240,
            clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000,
                    ExportTestDocs.Audio()),
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 1_500_000, 1_000_000, 2_000_000,
                    ExportTestDocs.Audio(volume: 0.5)),
            ]);

        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(sourcePath, probe.HasAudio, probe.ColorTransfer, probe.ColorPrimaries),
        };
        var compiled = ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p);
        Assert.Equal(2_500_000, compiled.ExpectedDurationUs);

        // ── 2) Gerçek render — worker ile aynı yol (graph.txt + FfmpegRunner).
        var scriptPath = Path.Combine(_outDir, "graph.txt");
        await File.WriteAllTextAsync(scriptPath, compiled.FilterGraphScript);
        var outputPath = Path.Combine(_outDir, "out.mp4");
        var result = await new FfmpegRunner(_options).RunAsync(
            compiled.ToFfmpegArgs(scriptPath, outputPath), compiled.ExpectedDurationUs);
        Assert.True(result.Success, $"export render failed: {result.StderrTail}");

        // ── 3) Çıktı doğrulaması (ExportJob'un ffprobe gate'iyle aynı sözleşme) + renk tag'leri:
        //      ffmpeg 7+ CLI tag'lerini filtergraph frame metadata'sıyla ezebildiği için dört
        //      tag ffprobe'dan GERÇEK render üstünde doğrulanır (rendering-semantics §6.1).
        var outProbe = await new FfprobeService(_options).ProbeAsync(outputPath);
        Assert.True(outProbe.HasVideo);
        Assert.True(outProbe.HasAudio);
        Assert.NotNull(outProbe.DurationUs);
        Assert.InRange(outProbe.DurationUs!.Value, 2_300_000, 2_700_000);
        Assert.Equal(320, outProbe.Width);
        Assert.Equal(240, outProbe.Height);
        Assert.Equal("bt709", outProbe.ColorSpace);
        Assert.Equal("bt709", outProbe.ColorPrimaries);
        Assert.Equal("bt709", outProbe.ColorTransfer);
        Assert.Equal("tv", outProbe.ColorRange);

        // ── 4) Frame çıkarımı + golden karşılaştırması (rendering-semantics §9.2): klip
        //      ortaları, boşluk ortası VE her kesimin n_cut-1 / n_cut kareleri (off-by-one
        //      avcısı — kaynak hareketli olduğu için kayma MSE'de patlar).
        Directory.CreateDirectory(GoldenDir);
        var produced = new List<string>();
        foreach (var (frame, name) in new[]
                 {
                     (15, "two-clip-gap-f15"),          // klip1 ortası
                     (29, "two-clip-gap-f29-precut"),   // kesim1 n_cut-1 (klip1 son karesi)
                     (30, "two-clip-gap-f30-gap"),      // kesim1 n_cut (boşluk ilk karesi)
                     (37, "two-clip-gap-f37-gap"),      // boşluk ortası (siyah)
                     (44, "two-clip-gap-f44-gap"),      // kesim2 n_cut-1 (boşluk son karesi)
                     (45, "two-clip-gap-f45-postcut"),  // kesim2 n_cut (klip2 ilk karesi)
                     (60, "two-clip-gap-f60"),          // klip2 ortası
                 })
        {
            var framePath = Path.Combine(_outDir, name + ".png");
            ExtractFrame(outputPath, frame, framePath);

            var goldenPath = Path.Combine(GoldenDir, name + ".png");
            if (!File.Exists(goldenPath))
            {
                File.Copy(framePath, goldenPath);
                produced.Add(name);
                continue; // golden üretildi — sonraki koşular karşılaştırır
            }

            var mse = Mse(DecodeRgb24(framePath), DecodeRgb24(goldenPath));
            Assert.True(mse <= MseThreshold,
                $"frame {frame} ({name}) deviates from golden: MSE {mse:F2} > {MseThreshold}");
        }

        if (produced.Count > 0)
        {
            // Bilgi amaçlı — golden üretim koşusu (commit edilecek dosyalar GoldenDir'de).
            Console.WriteLine($"golden üretildi: {string.Join(", ", produced)}");
        }
    }

    // ───────────────────────── ffmpeg yardımcıları ─────────────────────────

    private void ExtractFrame(string videoPath, int frameIndex, string pngPath) =>
        RunFfmpeg([
            "-y", "-i", videoPath,
            "-vf", $"select=eq(n\\,{frameIndex})",
            "-frames:v", "1",
            pngPath,
        ]);

    private int _rawCounter;

    /// <summary>
    /// PNG'yi ham rgb24 bayt dizisine çözer — piksel MSE'si için ortak zemin. Ara .raw dosyası
    /// DAİMA _outDir'e yazılır (girdi commit'li GoldenFrames dizininde olsa bile) — golden
    /// dizinine yan-ürün sızmaz.
    /// </summary>
    private byte[] DecodeRgb24(string pngPath)
    {
        var rawPath = Path.Combine(
            _outDir, $"{Path.GetFileNameWithoutExtension(pngPath)}-{_rawCounter++}.raw");
        RunFfmpeg(["-y", "-i", pngPath, "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath]);
        return File.ReadAllBytes(rawPath);
    }

    private static double Mse(byte[] a, byte[] b)
    {
        Assert.Equal(a.Length, b.Length); // aynı çözünürlük şart
        double sum = 0;
        for (var i = 0; i < a.Length; i++)
        {
            double diff = a[i] - b[i];
            sum += diff * diff;
        }

        return sum / a.Length;
    }

    private void RunFfmpeg(string[] args)
    {
        var psi = new ProcessStartInfo
        {
            FileName = _options.FfmpegPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start ffmpeg");
        var stderr = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(60_000) || process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"ffmpeg helper failed ({string.Join(' ', args)}): {stderr}");
        }
    }
}
