using System.Diagnostics;
using System.Globalization;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media;
using VideoEdit.Media.Export;
using VideoEdit.Media.Probing;

namespace VideoEdit.UnitTests;

/// <summary>
/// EXPORT PROFİLLERİ (dalga 2): profil, BİTMİŞ tuval kompozisyonunu kendi hedef kutusuna
/// taşır — bu sınıf o taşımanın GERÇEK RENDER kanıtlarıdır.
///
/// İki iddia ailesi ölçülür:
///  1. GEOMETRİ SÖZLEŞMELERİ KORUNUR (rendering-semantics §2.5 + §6.1): çıktı boyutu profil
///     kutusudur (çift boyut), SAR 1:1 kalır, pix_fmt yuv420p ve BT.709/tv tag'leri korunur,
///     içerik yerleşimi TAM oranla ölçeklenir (PiP kutusunun kenarları beklenen piksele düşer)
///     ve renkler referans (ölçeksiz) render ile aynıdır — ölçek geometriyi taşır, rengi
///     DEĞİŞTİRMEZ.
///  2. EN-BOY KAPISI: profil kutusu tuval oranına uymuyorsa Compile TİPLİ hata verir
///     ('export-profile-aspect') — sessiz letterbox/esnetme YOKTUR. (HTTP karşılığı
///     ExportGateInventoryTests'in SyncGate satırında koşturulur.)
///
/// Snapshot testleri neden yetmez: scale satırının VARLIĞI script'te görünür ama SAR'ın
/// gerçekten 1:1 kaldığı, tag'lerin ffmpeg 8'in çıktısında korunduğu ve bicubic'in kenarları
/// beklenen piksele koyduğu ancak koşarak bilinir.
/// </summary>
[Collection("ffmpeg-media")]
public sealed class ExportProfileGoldenTests : IDisposable
{
    private const int CanvasWidth = 1920;
    private const int CanvasHeight = 1080;

    private readonly FfmpegOptions _options = new();
    private readonly string _dir = Directory.CreateTempSubdirectory("videoedit-profiles-").FullName;
    private int _rawCounter;

    public void Dispose()
    {
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch
        {
            // best-effort temp temizliği
        }
    }

    // ───────────────────────── Saf derleme kanıtları (ffmpeg gerekmez) ─────────────────────────

    [Fact]
    public void SameAspectProfiles_EmitExactlyOneOutputScaleStage()
    {
        var (doc, sources) = PipDoc();

        // 1080p: tuval == hedef → ölçek aşaması YOK; script bugünkü davranışla aynı biter.
        var hd = ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p);
        Assert.EndsWith(ExportCompiler.OutputColorParams + "[vout]",
            VideoTail(hd.FilterGraphScript));
        Assert.DoesNotContain(":flags=bicubic,setsar=1," + ExportCompiler.OutputColorParams,
            hd.FilterGraphScript);

        // 720p / 2160p: tek çıktı ölçeği, renk damgasından HEMEN önce ([vout] son söz damga).
        var sd = ExportCompiler.Compile(doc, sources, ExportProfile.Hd720p);
        Assert.Contains("scale=1280:720:flags=bicubic,setsar=1," + ExportCompiler.OutputColorParams
            + "[vout]", sd.FilterGraphScript);

        var uhd = ExportCompiler.Compile(doc, sources, ExportProfile.Uhd2160p);
        Assert.Contains("scale=3840:2160:flags=bicubic,setsar=1," + ExportCompiler.OutputColorParams
            + "[vout]", uhd.FilterGraphScript);
    }

    [Fact]
    public void TheSpecSeam_WithTheProfileBox_IsByteIdenticalToTheProfilePath()
    {
        // Golden testlerin CanvasSpec dikişi "profil yoluyla aynı script" iddiasına dayanır —
        // iddia burada bayt bayt ölçülür.
        var (doc, sources) = PipDoc();
        var viaProfile = ExportCompiler.Compile(doc, sources, ExportProfile.Hd720p);
        var viaSpec = ExportCompiler.Compile(
            doc, sources, new ExportOutputSpec(ExportProfile.Hd720p, 1280, 720));

        Assert.Equal(viaProfile.FilterGraphScript, viaSpec.FilterGraphScript);
        Assert.Equal(viaProfile.OutputArgs, viaSpec.OutputArgs);
    }

    [Fact]
    public void MismatchedAspect_IsRefusedTyped_WithTheCompatibleProfilesInTheSentence()
    {
        var (doc, sources) = PipDoc(); // 1920x1080 (16:9)

        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Compile(doc, sources, ExportProfile.Vertical1080p));
        Assert.Equal("export-profile-aspect", ex.Feature);
        Assert.Contains("1080p, 720p, 2160p", ex.Message);
        Assert.Contains("letterbox", ex.Message);

        // Ters yön: dikey tuval + yatay profil — cümle bu kez 'dikey'i önerir.
        var portrait = PortraitDoc();
        var ex2 = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Compile(portrait.Doc, portrait.Sources, ExportProfile.Hd720p));
        Assert.Equal("export-profile-aspect", ex2.Feature);
        Assert.Contains("dikey", ex2.Message);
    }

    [Fact]
    public void SpecFor_AllowsAnyMatchingCanvasSize_IncludingUpscale()
    {
        // Aynı oran = serbest ölçek: küçük 16:9 tuvalden 4K istemek geçerlidir (büyütme).
        var spec = ExportProfiles.SpecFor(ExportProfile.Uhd2160p, 960, 540);
        Assert.Equal((3840, 2160), (spec.Width, spec.Height));

        // 9:16 tuval yalnız dikey profile uyar.
        Assert.Equal((1080, 1920),
            (ExportProfiles.SpecFor(ExportProfile.Vertical1080p, 540, 960).Width,
             ExportProfiles.SpecFor(ExportProfile.Vertical1080p, 540, 960).Height));

        // 16:9/9:16 DIŞI tuval (ham API'den kurulabilir) hiçbir profile uymaz; cümle tuval
        // önerisini kurar. Davranış değişikliği docs/poc-bilinen-sinirlar.md'de beyanlıdır.
        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportProfiles.SpecFor(ExportProfile.Hd1080p, 320, 240));
        Assert.Equal("export-profile-aspect", ex.Feature);
        Assert.Contains("uyan profil yok", ex.Message);
    }

    // ───────────────────────── Gerçek render kanıtları ─────────────────────────

    [FfmpegFact]
    public async Task DownscaleAndUpscale_PreserveGeometryColourAndTags()
    {
        var (doc, sources) = PipDoc();

        // Referans: 1080p (tuval == hedef, ölçek yok) — renk/yerleşim taban çizgisi.
        var reference = await RenderAsync(
            ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p), "ref-1080p");
        var refFrame = Frame(reference, 15, "ref-f15", CanvasWidth, CanvasHeight);
        var refBase = PixelAt(refFrame, CanvasWidth, 600, 800);
        var refPip = PixelAt(refFrame, CanvasWidth, 1440, 270);

        foreach (var (profile, name, w, h) in new[]
                 {
                     (ExportProfile.Hd720p, "out-720p", 1280, 720),
                     (ExportProfile.Uhd2160p, "out-2160p", 3840, 2160),
                 })
        {
            var output = await RenderAsync(ExportCompiler.Compile(doc, sources, profile), name);

            // Geometri sözleşmesi: boyut profil kutusu, SAR 1:1, yuv420p, BT.709/tv tam takım.
            var probe = await new FfprobeService(_options).ProbeAsync(output);
            Assert.Equal((w, h), (probe.Width, probe.Height));
            Assert.Equal("bt709", probe.ColorPrimaries);
            Assert.Equal("bt709", probe.ColorTransfer);
            Assert.Equal("bt709", probe.ColorSpace);
            Assert.Equal("tv", probe.ColorRange);
            Assert.Equal("1:1", VideoStreamField(output, "sample_aspect_ratio"));
            Assert.Equal("yuv420p", VideoStreamField(output, "pix_fmt"));
            Assert.InRange(probe.DurationUs!.Value, 900_000, 1_100_000); // süre ölçekten etkilenmez

            var frame = Frame(output, 15, name + "-f15", w, h);
            var k = w / (double)CanvasWidth; // 720p: 2/3, 2160p: 2 — h için de aynı oran

            // Renk taşınır: aynı içerik noktası referansla aynı değeri verir (düz bölgede
            // bicubic sabiti korur). Taban ve PiP ayrı kaynak/renk olduğundan ikisi birden
            // "ölçek rengi değiştirmez" iddiasını iki bağımsız noktadan ölçer.
            AssertPixel(frame, w, Scaled(600, k), Scaled(800, k), refBase, 4,
                "taban rengi referansla aynı");
            AssertPixel(frame, w, Scaled(1440, k), Scaled(270, k), refPip, 4,
                "PiP rengi referansla aynı");

            // Yerleşim TAM oranla taşınır (§2.5'in çıktı eşleniği): PiP kutusu tuvalde
            // x[1200,1680) y[135,405) — kenarın 8 px içi PiP, 8 px dışı taban olmalı.
            // 8 px payı bicubic kenar rampasının (≤2 px) çok üstündedir; kenar yanlış
            // piksele kayarsa (ör. oran hatası ya da yarım piksel ofset birikimi) yakalanır.
            AssertPixel(frame, w, Scaled(1200 + 12, k), Scaled(270, k), refPip, 6,
                "PiP sol kenarının içi");
            AssertPixel(frame, w, Scaled(1200 - 12, k), Scaled(270, k), refBase, 6,
                "PiP sol kenarının dışı taban");
            AssertPixel(frame, w, Scaled(1440, k), Scaled(135 + 12, k), refPip, 6,
                "PiP üst kenarının içi");
            AssertPixel(frame, w, Scaled(1440, k), Scaled(135 - 12, k), refBase, 6,
                "PiP üst kenarının dışı taban");
        }
    }

    [FfmpegFact]
    public async Task VerticalProfile_RendersAPortraitCanvasUnscaled()
    {
        var (doc, sources) = PortraitDoc();
        var compiled = ExportCompiler.Compile(doc, sources, ExportProfile.Vertical1080p);

        // Tuval == hedef (1080x1920): ölçek aşaması üretilmez.
        Assert.DoesNotContain(":flags=bicubic,setsar=1," + ExportCompiler.OutputColorParams,
            compiled.FilterGraphScript);

        var output = await RenderAsync(compiled, "out-dikey");
        var probe = await new FfprobeService(_options).ProbeAsync(output);
        Assert.Equal((1080, 1920), (probe.Width, probe.Height));
        Assert.Equal("bt709", probe.ColorSpace);
        Assert.Equal("tv", probe.ColorRange);
        Assert.Equal("1:1", VideoStreamField(output, "sample_aspect_ratio"));
        Assert.Equal("yuv420p", VideoStreamField(output, "pix_fmt"));
    }

    // ───────────────────────── Fixture'lar ─────────────────────────

    /// <summary>
    /// 1920x1080 tuval, 1 sn: tam kare taban (0x804020) + PiP (0x2080C0, scale 0.25,
    /// merkez (0.75, 0.25) normalize → tuvalde kutu x[1200,1680) y[135,405)).
    /// Kaynaklar 16:9 olduğundan fit=contain kutuları TAM doldurur (iç letterbox yok).
    /// </summary>
    private (TimelineDoc Doc, Dictionary<Guid, ExportAssetSource> Sources) PipDoc()
    {
        var baseClip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        var pip = ExportTestDocs.VideoClip(
            ExportTestDocs.AssetB, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.25));
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips: pip),
            ExportTestDocs.VideoTrack(clips: baseClip),
        ], width: CanvasWidth, height: CanvasHeight);
        return (doc, new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(
                MediaFile("base-1080.mp4", "0x804020", "1920x1080"), false, "bt709", "bt709"),
            [ExportTestDocs.AssetB] = new(
                MediaFile("pip-360.mp4", "0x2080C0", "640x360"), false, "bt709", "bt709"),
        });
    }

    /// <summary>1080x1920 (9:16) tuval, tam kare tek klip, 1 sn.</summary>
    private (TimelineDoc Doc, Dictionary<Guid, ExportAssetSource> Sources) PortraitDoc()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        var doc = ExportTestDocs.Doc(width: 1080, height: 1920, clips: clip);
        return (doc, new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(
                MediaFile("portrait.mp4", "0xC02080", "1080x1920"), false, "bt709", "bt709"),
        });
    }

    // ───────────────────────── ffmpeg yardımcıları ─────────────────────────

    private string MediaFile(string name, string color, string size)
    {
        var path = Path.Combine(_dir, name);
        if (File.Exists(path))
        {
            return path;
        }

        RunTool(_options.FfmpegPath,
        [
            "-y", "-f", "lavfi", "-i", $"color=c={color}:size={size}:rate=30:duration=1.5",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", path,
        ]);
        return path;
    }

    private async Task<string> RenderAsync(CompiledExport compiled, string name)
    {
        var scriptPath = Path.Combine(_dir, name + "-graph.txt");
        await File.WriteAllTextAsync(scriptPath, compiled.FilterGraphScript);
        var outputPath = Path.Combine(_dir, name + ".mp4");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(120));
        var result = await new FfmpegRunner(_options).RunAsync(
            compiled.ToFfmpegArgs(scriptPath, outputPath), compiled.ExpectedDurationUs,
            ct: cts.Token);
        Assert.True(result.Success, $"{name} render failed: {result.StderrTail}");
        return outputPath;
    }

    private static int Scaled(int canvasCoord, double k) => (int)Math.Round(canvasCoord * k);

    private byte[] Frame(string videoPath, int frameIndex, string name, int width, int height)
    {
        var rawPath = Path.Combine(
            _dir, $"{name}-{_rawCounter++.ToString(CultureInfo.InvariantCulture)}.raw");
        RunTool(_options.FfmpegPath,
        [
            "-y", "-i", videoPath,
            "-vf", $"select=eq(n\\,{frameIndex.ToString(CultureInfo.InvariantCulture)})",
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath,
        ]);
        var rgb = File.ReadAllBytes(rawPath);
        Assert.Equal(width * height * 3, rgb.Length);
        return rgb;
    }

    /// <summary>Video akışının tek bir ffprobe alanı (SAR/pix_fmt — MediaProbe taşımıyor).</summary>
    private string VideoStreamField(string path, string field)
    {
        var output = RunTool(_options.FfprobePath,
        [
            "-v", "error", "-select_streams", "v:0",
            "-show_entries", $"stream={field}", "-of", "default=nw=1:nk=1", path,
        ]);
        return output.Trim();
    }

    private static byte[] PixelAt(byte[] rgb, int width, int x, int y)
    {
        var offset = ((y * width) + x) * 3;
        return [rgb[offset], rgb[offset + 1], rgb[offset + 2]];
    }

    private static void AssertPixel(
        byte[] rgb, int width, int x, int y, byte[] expected, int tolerance, string what)
    {
        var actual = PixelAt(rgb, width, x, y);
        var diff = Math.Max(Math.Abs(actual[0] - expected[0]),
            Math.Max(Math.Abs(actual[1] - expected[1]), Math.Abs(actual[2] - expected[2])));
        Assert.True(diff <= tolerance,
            $"({x},{y}) {what}: beklenen ≈({expected[0]},{expected[1]},{expected[2]}) "
            + $"±{tolerance}, ölçülen ({actual[0]},{actual[1]},{actual[2]})");
    }

    /// <summary>Script'in [vout] ile biten video satırı (son video hattı).</summary>
    private static string VideoTail(string script)
    {
        var lines = script.Split(";\n");
        return Array.Find(lines, l => l.EndsWith("[vout]", StringComparison.Ordinal))
            ?? throw new InvalidOperationException("script'te [vout] satırı yok");
    }

    private string RunTool(string exe, string[] args)
    {
        var psi = new ProcessStartInfo
        {
            FileName = exe,
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
            ?? throw new InvalidOperationException($"could not start {exe}");
        // İKİ AKIŞ EŞZAMANLI OKUNUR: ffmpeg gevezeliğini stderr'e yazar — önce stdout'u
        // senkron okumak, stderr borusu dolunca süreci yazma tarafında KİLİTLER (ilk
        // koşumda ölçüldü: ffmpeg 1,25 sn CPU'da dakikalarca asılı kaldı).
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(120_000))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch
            {
                // süreç bu arada bitmiş olabilir
            }

            throw new InvalidOperationException(
                $"{Path.GetFileName(exe)} 120 sn'de bitmedi: {string.Join(' ', args)}");
        }

        var stdout = stdoutTask.GetAwaiter().GetResult();
        var stderr = stderrTask.GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0,
            $"{Path.GetFileName(exe)} {string.Join(' ', args)} exit {process.ExitCode}:\n{stderr}");
        return stdout;
    }
}
