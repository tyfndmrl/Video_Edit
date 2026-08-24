using System.Diagnostics;
using System.Globalization;
using VideoEdit.Contracts.Timeline;
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
        var compiled = ExportCompiler.Compile(doc, sources, CanvasSpec);
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

    // ───────────────────────── Çok katman kompozisyonu ─────────────────────────

    /// <summary>
    /// Düz renk kaynağın (0x804020) tam hattan geçtikten sonraki ÖLÇÜLMÜŞ rgb24 değeri
    /// (yeni hatta 131,66,29). Kaynak RGB'sinden (128,64,32) birkaç birim sapar: fixture
    /// dosyaları renk tag'siz üretilir ve lavfi onları SD'de bt601 ile kodlar, hat ise
    /// §6.1'in NORMATİF varsayımını uygular ("untagged SDR = BT.709/tv", çözünürlükten
    /// bağımsız — BT.601 tahmini YAPILMAZ). Sapma testin iddialarını etkilemez: iddialar
    /// "içeride bu renk / dışarıda BAŞKA bir şey" ayrımıdır (tolerans ±10).
    /// </summary>
    private static readonly byte[] SolidLayerRgb = [132, 68, 28];

    /// <summary>Düz renk katmanın piksel kimliği için tolerans (kanal başına).</summary>
    private const int SolidTolerance = 10;

    /// <summary>Bir pikselin düz renk katmandan FARKLI olduğunu kanıtlayan asgari kanal farkı.</summary>
    private const int DistinctThreshold = 40;

    /// <summary>Çok katman fixture'larının tuval boyutu — piksel indeksleme bunu kullanır.</summary>
    private const int CanvasWidth = 320;

    private const int CanvasHeight = 240;

    /// <summary>
    /// Fixture tuvali (320x240, 4:3) HIZ icin kucuktur ve hicbir uretim profiline oran-uyumlu
    /// degildir; kutusu tuvale esit bu spec ile olcek asamasi uretilmez ve script, eski
    /// Compile(profile) ciktisiyla bayt bayt aynidir (ExportProfileGoldenTests bunu kosarak
    /// sabitler). Profil-gecisli GERCEK olcek golden kanitlari ExportProfileGoldenTests tedir.
    /// </summary>
    private static readonly ExportOutputSpec CanvasSpec =
        new(ExportProfile.Hd1080p, CanvasWidth, CanvasHeight);

    [FfmpegFact]
    public async Task MultiLayerComposition_TopTrackWins_AndPipLandsOnTheNormativePixels()
    {
        // ── 1) Fixture: 320x240 @30fps, 2 sn, siyah tuval. Üç katman — tracks[0] EN ÜST
        //      (şema sözleşmesi docs/design/01 §1.2), render sırası SONDAN BAŞA.
        //
        //   tracks[0] ÜST   : düz renk, scale 0.25, x=+0.25, y=-0.25, opak
        //                     kutu = (round(320*.25), round(240*.25)) = 80x60
        //                     P    = (160+80, 120-60) = (240, 60) → dikdörtgen x[200,280) y[30,90)
        //   tracks[1] ORTA  : düz renk, scale 0.25, x=-0.25, y=+0.25, OPAKLIK 0.5
        //                     P    = (160-80, 120+60) = (80, 180) → dikdörtgen x[40,120) y[150,210)
        //   tracks[2] ALT   : hareketli testsrc2, scale 0.5 → 160x120, merkezde
        //                     P    = (160, 120) → dikdörtgen x[80,240) y[60,180)
        //
        // ÜST ile ALT x[200,240) y[60,90) bölgesinde ÇAKIŞIR → o pikselin düz renk çıkması
        // katman sırasının doğru olduğunun kanıtıdır (sıra ters olsaydı testsrc2 üste binerdi).
        // ORTA'nın x[40,80) bölümü hiçbir katmanın altında değildir → altı SAF SİYAH tuvaldir,
        // dolayısıyla %50 straight-alpha karışımı sayısal olarak doğrulanabilir (§6.3).
        var movingPath = media.Video320x240Moving2sWithAudio();
        var solidPath = media.VideoSolid320x240NoAudio();
        var movingProbe = await new FfprobeService(_options).ProbeAsync(movingPath);

        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000,
                    transform: ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.25)),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 0, 0, 2_000_000,
                    transform: ExportTestDocs.Transform(x: -0.25, y: 0.25, scale: 0.25),
                    opacity: 0.5),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000,
                    ExportTestDocs.Audio(), ExportTestDocs.Transform(scale: 0.5)),
            ]),
        ], width: CanvasWidth, height: CanvasHeight);

        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(movingPath, movingProbe.HasAudio,
                movingProbe.ColorTransfer, movingProbe.ColorPrimaries),
            [ExportTestDocs.AssetB] = new(solidPath, false, "bt709", "bt709"),
            [ExportTestDocs.AssetC] = new(solidPath, false, "bt709", "bt709"),
        };

        var compiled = ExportCompiler.Compile(doc, sources, CanvasSpec);
        Assert.Equal(2_000_000, compiled.ExpectedDurationUs);

        // Overlay zinciri taban tuvalden başlayıp sondan başa ilerler; ÜST katman EN SON biner.
        Assert.Contains(
            "[base][v0]overlay=x=floor(160-0.5*w):y=floor(120-0.5*h)", compiled.FilterGraphScript);
        Assert.Contains("[c0][v1]overlay=x=floor(80-0.5*w):y=floor(180-0.5*h)", compiled.FilterGraphScript);
        Assert.Contains("[c1][v2]overlay=x=floor(240-0.5*w):y=floor(60-0.5*h)", compiled.FilterGraphScript);
        Assert.Contains("[c2]setparams=", compiled.FilterGraphScript);

        // ── 2) GERÇEK render (worker ile aynı yol).
        var scriptPath = Path.Combine(_outDir, "multilayer-graph.txt");
        await File.WriteAllTextAsync(scriptPath, compiled.FilterGraphScript);
        var outputPath = Path.Combine(_outDir, "multilayer.mp4");
        var result = await new FfmpegRunner(_options).RunAsync(
            compiled.ToFfmpegArgs(scriptPath, outputPath), compiled.ExpectedDurationUs);
        Assert.True(result.Success, $"multi-layer render failed: {result.StderrTail}");

        var outProbe = await new FfprobeService(_options).ProbeAsync(outputPath);
        Assert.Equal(320, outProbe.Width);
        Assert.Equal(240, outProbe.Height);
        Assert.Equal("bt709", outProbe.ColorSpace);
        Assert.Equal("tv", outProbe.ColorRange);

        // ── 3) Frame 30 (t=1 sn) üstünde NOKTA piksel doğrulaması.
        var mid = DecodeFrameRgb24(outputPath, 30, "multi-layer-f30");

        // (a) PiP KONUMU: dikdörtgenin dört kenarının ±3 px iç/dış çifti. İçeride düz renk,
        //     dışarıda BAŞKA bir şey → katman tam beklenen piksellerde duruyor.
        AssertSolidLayer(mid, 240, 60, "PiP merkezi (P)");
        AssertSolidLayer(mid, 203, 75, "PiP sol kenarın 3 px içi");
        AssertSolidLayer(mid, 277, 45, "PiP sağ kenarın 3 px içi");
        AssertSolidLayer(mid, 250, 33, "PiP üst kenarın 3 px içi");
        AssertSolidLayer(mid, 250, 87, "PiP alt kenarın 3 px içi");

        AssertNotSolidLayer(mid, 197, 75, "PiP sol kenarın 3 px dışı (alt katman görünmeli)");
        AssertBackground(mid, 283, 45, "PiP sağ kenarın 3 px dışı (tuval)");
        AssertBackground(mid, 250, 27, "PiP üst kenarın 3 px dışı (tuval)");
        AssertBackground(mid, 250, 93, "PiP alt kenarın 3 px dışı (tuval)");

        // (b) KATMAN SIRASI: ÜST ile ALT'ın çakıştığı bölgede ÜST kazanır. Sıra ters olsaydı
        //     buradaki piksel testsrc2 içeriği olurdu (kenarın hemen dışındaki (197,75) gibi).
        AssertSolidLayer(mid, 220, 75, "ÜST katman ALT katmanın üstünde (sıra kanıtı)");
        AssertNotSolidLayer(mid, 100, 100, "ALT katman kendi bölgesinde görünür");
        AssertNotSolidLayer(mid, 160, 120, "ALT katman merkezi görünür");

        // (c) STRAIGHT ALPHA (§6.3): opaklık 0.5 katman SAF SİYAH tuvalin üstünde →
        //     out.rgb = src.rgb*0.5 + 0*0.5 = src.rgb/2. Kanal başına yarı değer beklenir.
        AssertPixel(mid, 60, 180,
            [(byte)(SolidLayerRgb[0] / 2), (byte)(SolidLayerRgb[1] / 2), (byte)(SolidLayerRgb[2] / 2)],
            tolerance: 8, "opaklık 0.5 katman siyah tuval üstünde = düz rengin YARISI");

        // (d) Hiçbir katmanın olmadığı köşeler taban tuval rengidir (settings.backgroundColor).
        AssertBackground(mid, 10, 10, "sol üst köşe (taban tuval)");
        AssertBackground(mid, 310, 230, "sağ alt köşe (taban tuval)");

        // ── 4) SON frame (59): enable penceresinin yarım frame geri çekilmiş bitişi son kareyi
        //      DÜŞÜRMEMELİ — klasik off-by-one avı (t=59/30=1.9667 < 1.983334).
        var last = DecodeFrameRgb24(outputPath, 59, "multi-layer-f59");
        AssertSolidLayer(last, 240, 60, "son karede PiP hâlâ görünür (enable penceresi kapanmadı)");
        AssertBackground(last, 10, 10, "son karede taban tuval");

        // ── 5) Tam kare golden karşılaştırması (regresyon ağı): ilk/orta/son kare.
        CompareWithGolden(outputPath, 0, "multi-layer-f00");
        CompareWithGolden(outputPath, 30, "multi-layer-f30");
        CompareWithGolden(outputPath, 59, "multi-layer-f59");
    }

    [FfmpegFact]
    public async Task RotatedLayers_AnchorCompensation_LandsOnTheNormativePixels()
    {
        // rendering-semantics §2.5: ffmpeg rotate DAİMA merkez etrafında döner; çapa telafisi
        // şeffaf pad + overlay konumuna taşınır. Bu test o zinciri GERÇEK piksellerde doğrular
        // (filter_complex_script içindeki 'hypot(iw\,ih)' kaçışının ffmpeg tarafından
        // çalıştırılabilir olduğunu da kanıtlar — snapshot testi bunu göremez).
        //
        //   tracks[0]: düz renk, scale 0.25 (80x60), rotation 90°, ÇAPA (0,0) = sol üst köşe,
        //              x=-0.25, y=-0.25 → P = (80, 60).
        //              Çapa etrafında +90° (saat yönü): (u,v) → (-v, u); kutu u∈[0,80] v∈[0,60]
        //              → x' ∈ [-60,0], y' ∈ [0,80] → mutlak x∈[20,80], y∈[60,140].
        //   tracks[1]: düz renk, scale 0.25 (80x60), rotation 90°, çapa MERKEZ, x=0, y=0
        //              → P = (160,120); 90° dönmüş kutu 60x80 olur → x∈[130,190), y∈[80,160).
        var solidPath = media.VideoSolid320x240NoAudio();
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000,
                    transform: ExportTestDocs.Transform(
                        x: -0.25, y: -0.25, scale: 0.25, rotationDeg: 90, anchorX: 0, anchorY: 0)),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 0, 0, 2_000_000,
                    transform: ExportTestDocs.Transform(scale: 0.25, rotationDeg: 90)),
            ]),
        ], width: CanvasWidth, height: CanvasHeight);

        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetB] = new(solidPath, false, "bt709", "bt709"),
            [ExportTestDocs.AssetC] = new(solidPath, false, "bt709", "bt709"),
        };

        var compiled = ExportCompiler.Compile(doc, sources, CanvasSpec);
        // Çapa merkezdeyse pad NO-OP'tur ve üretilmez; çapa köşedeyse simetrik pad üretilir.
        Assert.Contains("pad=w=iw*2:h=ih*2:x=iw*1:y=ih*1:color=#00000000", compiled.FilterGraphScript);
        Assert.Contains(
            "rotate=a=1.570796:c=none:ow=2*ceil(hypot(iw\\,ih)/2):oh=ow",
            compiled.FilterGraphScript);

        var outputPath = await RenderAsync(compiled, "rotated-anchor");
        var frame = DecodeFrameRgb24(outputPath, 30, "rotated-anchor-f30");

        // ── Çapası SOL ÜST olan katman: x∈[20,80], y∈[60,140] — §2.5 telafi formülünün kanıtı.
        //    (Kenarlarda ±6 px pay: 90° radyan olarak tam değil, interpolasyon kenarı yumuşatır.)
        AssertSolidLayer(frame, 50, 100, "çapa(0,0)+90° katmanın içi");
        AssertSolidLayer(frame, 27, 100, "çapa(0,0)+90° sol kenarın içi (x=20)");
        AssertSolidLayer(frame, 73, 100, "çapa(0,0)+90° sağ kenarın içi (x=80)");
        AssertSolidLayer(frame, 50, 67, "çapa(0,0)+90° üst kenarın içi (y=60)");
        AssertSolidLayer(frame, 50, 133, "çapa(0,0)+90° alt kenarın içi (y=140)");
        AssertBackground(frame, 13, 100, "çapa(0,0)+90° sol kenarın dışı");
        AssertBackground(frame, 87, 100, "çapa(0,0)+90° sağ kenarın dışı");
        AssertBackground(frame, 50, 53, "çapa(0,0)+90° üst kenarın dışı");
        AssertBackground(frame, 50, 147, "çapa(0,0)+90° alt kenarın dışı");

        // ── Çapası MERKEZ olan katman: 90° sonrası 60x80 kutu, merkezi P=(160,120).
        AssertSolidLayer(frame, 160, 120, "çapa merkez +90° katmanın merkezi");
        AssertSolidLayer(frame, 137, 120, "çapa merkez +90° sol kenarın içi (x=130)");
        AssertSolidLayer(frame, 183, 120, "çapa merkez +90° sağ kenarın içi (x=190)");
        AssertSolidLayer(frame, 160, 87, "çapa merkez +90° üst kenarın içi (y=80)");
        AssertSolidLayer(frame, 160, 153, "çapa merkez +90° alt kenarın içi (y=160)");
        AssertBackground(frame, 123, 120, "çapa merkez +90° sol kenarın dışı");
        AssertBackground(frame, 197, 120, "çapa merkez +90° sağ kenarın dışı");
        AssertBackground(frame, 160, 73, "çapa merkez +90° üst kenarın dışı");
        AssertBackground(frame, 160, 167, "çapa merkez +90° alt kenarın dışı");

        CompareWithGolden(outputPath, 30, "rotated-anchor-f30");
    }

    // ───────────── Denetim düzeltmeleri: kompozisyon renk modu + geometri ─────────────

    [FfmpegFact]
    public async Task OpaqueLayerOnTop_DoesNotDisturbThePixelsItDoesNotCover()
    {
        // Denetim #1 (HIGH). Sözleşme (rendering-semantics §6.3): kompozisyon renk modu GRAFİK
        // başınadır. Katman başına seçildiğinde alt (alpha'lı) katmanın overlay'i RGB'de blend
        // ediyor, üstteki OPAK katmanın overlay'i ise 4:2:0'a düşüyordu → ffmpeg birikmiş RGB
        // kompozisyonu zincirin ORTASINDA yuv'a çeviriyor ve ALTTAKİ katmanın renkleri kayıyordu.
        //
        // İDDİA (kendi kendini kalibre eder — mutlak renk sabiti YOK):
        //   "Bir katman EKLEMEK, ÖRTMEDİĞİ piksellerde hiçbir şeyi değiştirmez."
        // Aynı yarı saydam SMPTE çubuk katmanı iki kez render edilir (yalnız / üstünde opak PiP
        // varken) ve PiP'in DIŞINDA kalan doygun renkli bölge karşılaştırılır. Kaynağın doygun
        // renkleri + sert dikey kenarları bu sınıf hatanın genliğini en yükseğe çıkarır.
        //
        // ÖLÇÜLDÜ (aynı fixture, gerçek render):
        //   katman başına format → örtülmeyen üst şerit MSE 89.07, doygun çubukta 24 birim sapma
        //   grafik başına rgb    → MSE 0.05, örneklenen kenar piksellerinde sapma 0
        var barsPath = media.VideoBars320x240NoAudio();
        var solidPath = media.VideoSolid320x240NoAudio();
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetB] = new(barsPath, false, "bt709", "bt709"),
            [ExportTestDocs.AssetC] = new(solidPath, false, "bt709", "bt709"),
        };

        // ALT (her iki senaryoda AYNI): yarı saydam (0.75) tam kare SMPTE çubukları.
        static VideoEdit.Contracts.Timeline.Track TranslucentBars() => ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000, opacity: 0.75),
        ]);

        var alone = ExportTestDocs.MultiTrackDoc([TranslucentBars()],
            width: CanvasWidth, height: CanvasHeight);
        var withTop = ExportTestDocs.MultiTrackDoc(
        [
            // ÜST: TAMAMEN OPAK PiP (scale 0.5 → 160x120, merkezde) — x[80,240) y[60,180).
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 0, 0, 2_000_000,
                    transform: ExportTestDocs.Transform(scale: 0.5)),
            ]),
            TranslucentBars(),
        ], width: CanvasWidth, height: CanvasHeight);

        var aloneCompiled = ExportCompiler.Compile(alone, sources, CanvasSpec);
        var withTopCompiled = ExportCompiler.Compile(withTop, sources, CanvasSpec);

        // Opak katmanın overlay'i de RGB'de blend eder — hatanın kaynağı tam olarak buydu.
        Assert.Contains(":format=rgb[c0]", aloneCompiled.FilterGraphScript);
        Assert.Contains(":format=rgb[c1]", withTopCompiled.FilterGraphScript);

        var aloneFrame = DecodeFrameRgb24(
            await RenderAsync(aloneCompiled, "bars-alone"), 30, "bars-alone-f30");
        var withTopFrame = DecodeFrameRgb24(
            await RenderAsync(withTopCompiled, "bars-with-top"), 30, "bars-with-top-f30");

        // (a) PiP'in DIŞINDAKİ iki şerit: encode gürültüsü mertebesinde kalmalı.
        var topStrip = RegionMse(aloneFrame, withTopFrame, 0, 0, CanvasWidth, 56);
        var leftStrip = RegionMse(aloneFrame, withTopFrame, 0, 0, 78, CanvasHeight);
        Assert.True(topStrip <= 2d,
            $"üstteki opak katman, ÖRTMEDİĞİ üst şeridi değiştirdi: MSE {topStrip:F2} > 2 "
            + "(kompozisyon renk modu katman başına seçiliyor — §6.3)");
        Assert.True(leftStrip <= 2d,
            $"üstteki opak katman, ÖRTMEDİĞİ sol şeridi değiştirdi: MSE {leftStrip:F2} > 2");

        // (b) DOYGUN RENKLİ KENARLAR: yedi SMPTE çubuğunun sınırlarının iki yanı, PiP'in
        //     üstündeki örtülmeyen şeritte. Renk sabiti YOK — iki render'ın aynı noktası.
        foreach (var x in new[]
                 {
                     44, 46, 48, 88, 90, 92, 94, 134, 136, 138,
                     180, 182, 184, 226, 228, 230, 272, 274, 276, 300,
                 })
        {
            AssertSamePixel(aloneFrame, withTopFrame, x, 30, tolerance: 4,
                $"doygun çubuk kenarı x={x} (örtülmeyen şerit)");
        }
    }

    [FfmpegFact]
    public async Task SameTransform_LandsOnTheSamePixels_WhateverTheOpacity()
    {
        // Denetim #15 (MEDIUM). ffmpeg overlay, 4:2:0 tuvalde x/y'yi normalize_xy ile chroma
        // adımına (çift piksele) KIRPAR; rgb tuvalde kırpmaz. Katman başına format seçiminde
        // opak katman çift piksele snap oluyor, alpha'lı katman olmuyordu → AYNI transform
        // opaklığa göre 1 px kayıyordu. Ölçülmüş repro (overlay x=201): yuv420 → 200, rgb → 201.
        //
        // Fixture: iki katman, TEK farkları opaklık. overlay_x = 241 - 0.5*80 = 201 (TEK sayı).
        //   ÜST  (opak)      : y=-0.25 → satır [30,90)
        //   ALT  (opaklık .75): y=+0.25 → satır [150,210)
        var solidPath = media.VideoSolid320x240NoAudio();
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000,
                    transform: ExportTestDocs.Transform(x: 0.253125, y: -0.25, scale: 0.25)),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 0, 0, 2_000_000,
                    transform: ExportTestDocs.Transform(x: 0.253125, y: 0.25, scale: 0.25),
                    opacity: 0.75),
            ]),
        ], width: CanvasWidth, height: CanvasHeight);

        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetB] = new(solidPath, false, "bt709", "bt709"),
            [ExportTestDocs.AssetC] = new(solidPath, false, "bt709", "bt709"),
        };

        var compiled = ExportCompiler.Compile(doc, sources, CanvasSpec);
        // İki katmanın overlay ifadesi BİREBİR aynı x'i verir (y farkı kasıtlı).
        Assert.Contains("overlay=x=floor(241-0.5*w):y=floor(180-0.5*h)", compiled.FilterGraphScript);
        Assert.Contains("overlay=x=floor(241-0.5*w):y=floor(60-0.5*h)", compiled.FilterGraphScript);

        var frame = DecodeFrameRgb24(await RenderAsync(compiled, "odd-offset"), 30, "odd-offset-f30");

        // Her iki katmanın SOL KENARI aynı sütunda olmalı — ve tam olarak 201'de (ifadenin
        // değeri). Hatalı modda opak katman 200'e snap olurdu.
        var opaqueEdge = FirstLitColumn(frame, row: 60);
        var translucentEdge = FirstLitColumn(frame, row: 180);
        Assert.Equal(201, opaqueEdge);
        Assert.Equal(201, translucentEdge);
        Assert.Equal(opaqueEdge, translucentEdge);

        // Aynı iddia dikeyde: üst katmanın üst kenarı 30, alttakinin 150 (ikisi de ifadeden).
        Assert.Equal(30, FirstLitRow(frame, column: 220));
        Assert.Equal(150, FirstLitRow(frame, column: 220, fromRow: 100));
    }

    [FfmpegFact]
    public async Task HiddenTrackStillProducesAudio_MutedTrackRendersSilence()
    {
        // rendering-semantics §8 + apps/editor resolve.ts: hidden = YALNIZ görsel gizleme
        // (ses akmaya devam eder), muted = ses yok. İddia GERÇEK render üstünde ölçülür:
        // volumedetect max_volume'u sessizlikle duyulabiliri ayırır.
        var sourcePath = media.Video320x240Moving2sWithAudio();
        var probe = await new FfprobeService(_options).ProbeAsync(sourcePath);
        Assert.True(probe.HasAudio);

        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(sourcePath, true, probe.ColorTransfer, probe.ColorPrimaries),
            [ExportTestDocs.AssetB] = new(sourcePath, true, probe.ColorTransfer, probe.ColorPrimaries),
        };

        // ── Senaryo 1: ÜST track gizli (ses ÜRETİR), ALT track susturulmuş (yalnız görüntü).
        var hiddenPlusMuted = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(hidden: true, clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio())]),
            ExportTestDocs.VideoTrack(muted: true, clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000, ExportTestDocs.Audio())]),
        ], width: CanvasWidth, height: CanvasHeight);

        var audibleCompiled = ExportCompiler.Compile(hiddenPlusMuted, sources, CanvasSpec);
        // Tek ses girişi: gizli track'inki. Susturulmuş track ses zinciri üretmez.
        Assert.Contains("amix=inputs=1:", audibleCompiled.FilterGraphScript);
        Assert.DoesNotContain("anullsrc", audibleCompiled.FilterGraphScript);

        var audiblePath = await RenderAsync(audibleCompiled, "hidden-audio");
        var audibleMax = MaxVolumeDb(audiblePath);
        Assert.True(audibleMax > -30d,
            $"gizli track'in sesi mikse girmeliydi ama çıktı sessiz (max_volume={audibleMax} dB)");

        // ── Senaryo 2: TEK track ve o da susturulmuş → hiç duyulabilir klip yok → anullsrc.
        var mutedOnly = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(muted: true, clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio())]),
        ], width: CanvasWidth, height: CanvasHeight);

        var silentCompiled = ExportCompiler.Compile(mutedOnly, sources, CanvasSpec);
        Assert.Contains("anullsrc=channel_layout=stereo:sample_rate=48000", silentCompiled.FilterGraphScript);

        var silentPath = await RenderAsync(silentCompiled, "muted-silence");
        var silentMax = MaxVolumeDb(silentPath);
        Assert.True(silentMax < -60d,
            $"susturulmuş track ses üretmemeliydi (max_volume={silentMax} dB)");
    }

    [FfmpegFact]
    public async Task AudioTrackWithVideoTrack_MixesThroughRealFfmpeg()
    {
        // Ses track'i klibi GÖRSEL katman üretmez; kaynağı da video stream'i OLMAYAN bir
        // dosyadır (müzik). Zincirde o girişe [N:v] referansı çıkarsa ffmpeg patlar — bu test
        // grafiğin gerçekten çalıştırılabilir olduğunu kanıtlar (snapshot testi göremez).
        var videoPath = media.Video320x240Moving2sWithAudio();
        var musicPath = media.AudioWav();
        var videoProbe = await new FfprobeService(_options).ProbeAsync(videoPath);
        var musicProbe = await new FfprobeService(_options).ProbeAsync(musicPath);
        Assert.False(musicProbe.HasVideo, "müzik varlığında video stream'i olmamalı");

        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
            ]),
            ExportTestDocs.AudioTrack(clips:
            [
                ExportTestDocs.AudioClip(ExportTestDocs.AssetC, 0, 0, 2_000_000,
                    ExportTestDocs.Audio(volume: 0.5, fadeOutUs: 500_000)),
            ]),
        ], width: CanvasWidth, height: CanvasHeight);

        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(videoPath, true, videoProbe.ColorTransfer, videoProbe.ColorPrimaries),
            [ExportTestDocs.AssetC] = new(musicPath, true, musicProbe.ColorTransfer, musicProbe.ColorPrimaries),
        };

        var compiled = ExportCompiler.Compile(doc, sources, CanvasSpec);
        // Girişler RENDER sırasında açılır (sondan başa) → müzik (tracks[1]) giriş 0,
        // video klibi (tracks[0]) giriş 1. Müzik girişine [0:v] referansı ÇIKMAMALI.
        Assert.Equal(musicPath, compiled.Inputs[0].Path);
        Assert.Contains("[0:a]", compiled.FilterGraphScript);
        Assert.DoesNotContain("[0:v]", compiled.FilterGraphScript); // ses klibi görsel katman ÜRETMEZ
        Assert.Contains("amix=inputs=2:duration=longest:normalize=0", compiled.FilterGraphScript);

        var outputPath = await RenderAsync(compiled, "audio-track-mix");
        var outProbe = await new FfprobeService(_options).ProbeAsync(outputPath);
        Assert.True(outProbe.HasVideo);
        Assert.True(outProbe.HasAudio);
        Assert.Equal(320, outProbe.Width);
        Assert.InRange(outProbe.DurationUs!.Value, 1_800_000, 2_200_000);
        Assert.True(MaxVolumeDb(outputPath) > -30d, "miks duyulabilir olmalı");
    }

    // ───── Denetim düzeltmeleri: katman run'ları + görsel (still image) klipler ─────

    /// <summary>Görsel fixture'ının (0x2080C0 PNG) hattan geçtikten sonraki rgb24 değeri.</summary>
    private static readonly byte[] ImageLayerRgb = [32, 128, 192];

    [FfmpegFact]
    public async Task ImageOnlyTimeline_RendersThroughLoopedInput_ForItsWholeDuration()
    {
        // Denetim bulgusu: ürün kullanıcıyı görsel yüklemeye AKTİF olarak yönlendiriyor
        // (fileTypes.ts, worker, timeline) ama compiler görsel klibi 422 ile reddediyordu.
        // Sözleşme: -loop 1 -t <süre> girişi + normal katman zinciri. GERÇEK RENDER şart —
        // "-loop olmadan tek kare sonrası akış biter" sınıfı hata yalnız burada görünür.
        var photoPath = media.ImageSolid320x240Png();
        var doc = ExportTestDocs.Doc(
            width: CanvasWidth, height: CanvasHeight,
            clips: ExportTestDocs.ImageClip(ExportTestDocs.AssetC, 0, 2_000_000));
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetC] = new(photoPath, false, "bt709", "bt709"),
        };

        var compiled = ExportCompiler.Compile(doc, sources, CanvasSpec);
        var input = Assert.Single(compiled.Inputs);
        Assert.True(input.Loop);
        Assert.Equal(["-loop", "1", "-t", "2.033333", "-i", photoPath], input.ToArgs());

        var outputPath = await RenderAsync(compiled, "image-only");
        var outProbe = await new FfprobeService(_options).ProbeAsync(outputPath);
        Assert.True(outProbe.HasVideo);
        Assert.True(outProbe.HasAudio);                       // anullsrc: sessiz ses izi
        Assert.Equal(CanvasWidth, outProbe.Width);
        Assert.InRange(outProbe.DurationUs!.Value, 1_800_000, 2_200_000);
        Assert.Equal("bt709", outProbe.ColorSpace);

        // İLK ve SON kare aynı görseli taşımalı: -loop 1 tüm süre boyunca kare üretmiş demektir
        // (loop olmasaydı ilk kareden sonrası donuk/boş olurdu ve süre kapısı da düşerdi).
        foreach (var frame in new[] { 0, 30, 59 })
        {
            var rgb = DecodeFrameRgb24(outputPath, frame, $"image-only-f{frame}");
            AssertPixel(rgb, 160, 120, ImageLayerRgb, tolerance: 12, $"görsel merkezi (kare {frame})");
            AssertPixel(rgb, 5, 5, ImageLayerRgb, tolerance: 12, $"görsel tuvali kaplıyor (kare {frame})");
        }
    }

    [FfmpegFact]
    public async Task ImageLayerOverVideo_ComposesLikeAnyOtherLayer()
    {
        // Görsel klip ÜST katmanda: taban video + görsel PiP. Konum §2.5 formülünden gelir —
        // kutu 80x60, P = (240, 60) → dikdörtgen x[200,280) y[30,90).
        var photoPath = media.ImageSolid320x240Png();
        var movingPath = media.Video320x240Moving2sWithAudio();
        var movingProbe = await new FfprobeService(_options).ProbeAsync(movingPath);

        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.ImageClip(ExportTestDocs.AssetC, 0, 2_000_000,
                    transform: ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.25)),
            ]),
            // Taban katman scale 0.5 → x[80,240) y[60,180); dışında taban tuval görünür.
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000,
                    ExportTestDocs.Audio(), ExportTestDocs.Transform(scale: 0.5)),
            ]),
        ], width: CanvasWidth, height: CanvasHeight);

        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(movingPath, true, movingProbe.ColorTransfer, movingProbe.ColorPrimaries),
            [ExportTestDocs.AssetC] = new(photoPath, false, "bt709", "bt709"),
        };

        var compiled = ExportCompiler.Compile(doc, sources, CanvasSpec);
        Assert.True(compiled.Inputs[1].Loop);                 // görsel = üst katman, ikinci giriş
        var frame = DecodeFrameRgb24(await RenderAsync(compiled, "image-layer"), 30, "image-layer-f30");

        AssertPixel(frame, 240, 60, ImageLayerRgb, 12, "görsel PiP merkezi");
        AssertPixel(frame, 203, 75, ImageLayerRgb, 12, "görsel PiP sol kenarın 3 px içi");
        AssertPixel(frame, 277, 45, ImageLayerRgb, 12, "görsel PiP sağ kenarın 3 px içi");
        AssertBackground(frame, 283, 45, "PiP'in sağ dışı (tuval)");
        AssertBackground(frame, 250, 27, "PiP'in üst dışı (tuval)");
        // Alt katman (hareketli video) kendi bölgesinde görünür → görsel onu ÖRTMEMİŞ.
        var mid = ((120 * CanvasWidth) + 160) * 3;
        Assert.True(
            Math.Abs(frame[mid] - ImageLayerRgb[0]) + Math.Abs(frame[mid + 1] - ImageLayerRgb[1])
            + Math.Abs(frame[mid + 2] - ImageLayerRgb[2]) > 60,
            "tuval merkezinde alt katman görünmeliydi");
    }

    [FfmpegTheory]
    [InlineData(0.5, 160, 120)]      // ÇİFT kutu — tarihsel koşum (bu testin ilk hali)
    [InlineData(0.503, 161, 121)]    // TEK kutu — 320*0.503=160.96→161, 240*0.503=120.72→121
    public async Task ContiguousLayerClips_ConcatIntoOneOverlay_WithoutMovingASinglePixel(
        double scale, int expectedBoxW, int expectedBoxH)
    {
        // Denetim #1 (HIGH) düzeltmesinin GERÇEK RENDER kanıtı. Run'daki segmentler tek concat'e
        // girer; concat girişlerinin AYNI BOYUTTA olması şarttır, oysa scale
        // force_original_aspect_ratio=decrease kullandığı için gerçek boyut KAYNAĞIN aspect'ine
        // bağlıdır (16:9 kaynak 4:3 kutuda 160x90'a düşer). Segmentler bu yüzden kutuya şeffaf
        // pad'lenir — bu testin iki iddiası var:
        //   (a) FARKLI aspect'li iki kaynak aynı run'da concat edilebiliyor (ffmpeg patlamıyor);
        //   (b) pad geometriyi KAYDIRMIYOR: aynı klip tek başınayken (pad'siz yol) ve run
        //       içindeyken (pad'li yol) katmanın kenarları AYNI piksele oturuyor.
        //
        // TEK KUTU KOŞUMU (0.503) bu testin kaybolan güvencesidir: tek boyutlu kutu eskiden
        // run'ı BÖLDÜRÜYORDU, yani pad yolu hiç sınanmıyordu. Pad hedefi artık kutunun çifte
        // indirilmiş halidir; hedefi ham (TEK) kutuya geri almak (b) iddiasını 1 px kaydırıp
        // KIRAR — negatif kontrol tam olarak burada koşar.
        var widePath = media.Video1280x720NoAudio();          // 16:9 → 4:3 kutuda letterbox
        var solidPath = media.VideoSolid320x240NoAudio();     // 4:3 → kutuyu tam doldurur
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetB] = new(widePath, false, "bt709", "bt709"),
            [ExportTestDocs.AssetC] = new(solidPath, false, "bt709", "bt709"),
        };

        // PiP yerleşimi (her iki dokümanda AYNI), merkezde. Taban katman YOK — kenar ölçümü
        // siyah tuvale karşı yapılır (FirstLitColumn/Row).
        var pip = ExportTestDocs.Transform(scale: scale);
        var alone = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 1_000_000, transform: pip)]),
        ], width: CanvasWidth, height: CanvasHeight);

        var inRun = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 1_000_000, transform: pip),
                // Bitişik + aynı yerleşim → AYNI run; kaynağın aspect'i farklı (4:3).
                ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 1_000_000, 0, 1_000_000, transform: pip),
            ]),
        ], width: CanvasWidth, height: CanvasHeight);

        var aloneCompiled = ExportCompiler.Compile(alone, sources, CanvasSpec);
        var runCompiled = ExportCompiler.Compile(inRun, sources, CanvasSpec);
        Assert.DoesNotContain("concat=", aloneCompiled.FilterGraphScript);
        Assert.Contains("concat=n=2:v=1:a=0[v0]", runCompiled.FilterGraphScript);
        // İki klip TEK overlay'e düşer (klip başına overlay olsaydı iki tane olurdu).
        Assert.Equal(1, runCompiled.FilterGraphScript.Split(";\n").Count(l => l.Contains("]overlay=")));

        var tag = scale.ToString("0.000", CultureInfo.InvariantCulture);
        var aloneFrame = DecodeFrameRgb24(
            await RenderAsync(aloneCompiled, $"run-alone-{tag}"), 15, $"run-alone-{tag}-f15");
        var runOutput = await RenderAsync(runCompiled, $"run-concat-{tag}");
        var runFrame = DecodeFrameRgb24(runOutput, 15, $"run-concat-{tag}-f15");

        // (b) Katmanın sınır kutusu BİREBİR aynı olmalı: pad'li ve pad'siz yol aynı pikselleri
        //     boyar. 16:9 kaynak 160x120 kutuda 160x90'a düşer (letterbox) → pad ofseti yanlış
        //     olsaydı kutu düşeyde kayardı.
        Assert.Equal(LitBoundingBox(aloneFrame), LitBoundingBox(runFrame));

        // Normatif dikdörtgen: kutu 160x120 merkezde, içerik 160x90 → x[80,240) y[75,165).
        var (x0, y0, x1, y1) = LitBoundingBox(runFrame);
        // (Sınırlarda ±2 px pay: kaynağın koyu sütunları eşiğin altında kalabilir, x264
        //  ringing'i sert kenarın bir satır dışına taşabilir. Kayma olsaydı fark 15+ px olurdu.)
        Assert.InRange(x0, 78, 100);
        Assert.InRange(x1, 220, 241);
        Assert.InRange(y0, 73, 85);
        Assert.InRange(y1, 155, 166);
        // Dikdörtgenin dışı taban tuval: kayma olsaydı burası boyanmış olurdu.
        AssertBackground(runFrame, 76, 120, "katmanın 3 px solu");
        AssertBackground(runFrame, 243, 120, "katmanın 3 px sağı");
        AssertBackground(runFrame, 160, 71, "letterbox üst kenarının 3 px üstü");
        AssertBackground(runFrame, 160, 168, "letterbox alt kenarının 3 px altı");

        // (a) Run'ın İKİNCİ segmenti de doğru pencerede görünür (concat sırası korunmuş).
        var second = DecodeFrameRgb24(runOutput, 45, $"run-concat-{tag}-f45");
        AssertSolidLayer(second, 160, 120, "run'ın ikinci segmenti (düz renk) 1-2 sn arasında");
        AssertBackground(second, 5, 5, "ikinci segment kenar dışında tuval");

        // Dize iddiaları EN SONDA: yukarıdaki piksel iddiası kendi başına ayakta durmalı, yoksa
        // düzeltmeyi geri aldığımızda test dizede patlar ve "1 px kaydı" savı KANITLANMAMIŞ olur.
        // Ölçek hedefi HAM kutu, pad hedefi ÇİFTE İNDİRİLMİŞ kutu (tek kutuda ikisi ayrışır).
        Assert.Contains($"scale={expectedBoxW}:{expectedBoxH}:", runCompiled.FilterGraphScript);
        Assert.Contains(
            $"pad={expectedBoxW & ~1}:{expectedBoxH & ~1}:(ow-iw)/2:(oh-ih)/2:",
            runCompiled.FilterGraphScript);
    }

    [FfmpegTheory]
    // aspect, ölçek, x, dönme — TEK KUTU rejimi (ölçek 0.503, x=0): kutu 161x121, P tamsayı.
    [InlineData("16:9", 0.503, 0, 0)]
    [InlineData("4:3", 0.503, 0, 0)]
    [InlineData("kare", 0.503, 0, 0)]
    [InlineData("9:16", 0.503, 0, 0)]
    // KIRPMA rejimi (ölçek > 1 + KESİRLİ x): pad'li yolda overlay hedefi NEGATİFE düşer.
    // Ayrışmanın ULAŞILABİLİR olduğu tek pencere budur; yukarıdaki dört satır onu hiç açmaz.
    [InlineData("16:9", 1.005, 0.0025, 0)]
    [InlineData("4:3", 1.005, 0.0025, 0)]
    [InlineData("kare", 1.005, 0.0025, 0)]
    [InlineData("9:16", 1.005, 0.0025, 0)]
    // DÖNEN YARI — üç turdur HİÇ KOŞMAMIŞTI (satırların hiçbiri rotationDeg yazmıyordu) ve
    // ayrışma tam oradaydı: dönmeyen yolda rotate GİRİŞİ gerçek scale çıktısıdır, pad'li yolda
    // ise kutuya normalize edilmiş halidir; iki farklı giriş iki farklı kare tuval verir
    // (2*ceil(hypot(iw,ih)/2)) ve içerik farklı ızgaraya oturur. Ölçüldü (16:9, s=0.503, a=90):
    // pad'siz (114,39,205,200), pad'li (115,39,204,200).
    // 90/180 interpolasyon ÜRETMEZ (kenarlar kesindir); 30 ise üretir — kural yalnız dik
    // açılarda tutuyorsa yeterli değildir, o yüzden eğik açı da koşar.
    [InlineData("16:9", 0.503, 0, 90)]
    [InlineData("4:3", 0.503, 0, 90)]
    [InlineData("kare", 0.503, 0, 90)]
    [InlineData("9:16", 0.503, 0, 90)]
    [InlineData("16:9", 0.503, 0, 30)]
    [InlineData("9:16", 0.503, 0, 30)]
    [InlineData("16:9", 1.005, 0.0025, 90)]
    [InlineData("9:16", 1.005, 0.0025, 90)]
    public async Task AddingATransition_DoesNotMoveTheLayerByASinglePixel(
        string aspect, double scale, double x, double rotationDeg)
    {
        // BU DÜZELTMENİN ASIL DEĞİŞMEZİ (rendering-semantics §5): bir katmanın geometrisi,
        // kesiminde geçiş olup olmamasından BAĞIMSIZDIR. Geçiş run'ı BÖLDÜRMEZ → kutuya
        // normalize pad ZORUNLU olur; geçişsiz tek klip ise pad'siz yoldan geçer. İki yolun
        // aynı pikselleri boyaması gerekir.
        //
        // İKİ REJİM koşar ve ikisi de gereklidir:
        //  (a) ölçek 0.503, x=0 → kutu 161x121 TEK. Pad hedefi HAM kutu olsaydı katman 1 TAM
        //      piksel yukarı kayardı — pad ofsetinin ((121-ih)/2) ve overlay ifadesinin
        //      (120-0.5*121) tamsayı kırpmaları AYNI YÖNE toplanır. Bu rejimde P tamsayıdır ve
        //      overlay hedefi pozitiftir, yani overlay'in KENDİ kırpması hiç tetiklenmez.
        //  (b) ölçek 1.005, x=0.0025 → P.x = 160.8 ve pad'li yolda hedef 160.8 - 161 = -0.2'ye,
        //      yani NEGATİFE düşer. overlay (int) ile SIFIRA DOĞRU kırptığı için pad'li yol
        //      pad'siz yoldan 1 px ayrışırdı; ifadedeki floor bunu kapatır. Ölçüldü (gerçek
        //      ffmpeg 8.0, bu tuvalde): kare ve 9:16 kaynakta trunc ile dx=1, floor ile dx=0.
        //
        // Dört aspect: 16:9 kaynakta pad yatayda no-op, 4:3 kaynakta tamamen no-op, KARE kaynakta
        // iki eksende birden çalışır, DİKEY kaynakta yatay pay kutunun yarısından büyüktür —
        // (b) rejiminin ayrışması ancak son iki aspect'te GÖRÜNÜR olur (ilk ikisinde katman
        // yatayda tuvali taşar ve iki yol da aynı kenarları verir).
        var (path, assetId) = aspect switch
        {
            "16:9" => (media.Video1280x720NoAudio(), ExportTestDocs.AssetB),
            "4:3" => (media.VideoSolid320x240NoAudio(), ExportTestDocs.AssetC),
            "9:16" => (media.VideoSolid180x320NoAudio(), ExportTestDocs.AssetA),
            _ => (media.VideoSolid240x240NoAudio(), ExportTestDocs.AssetA),
        };
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [assetId] = new(path, false, "bt709", "bt709"),
        };
        var pip = ExportTestDocs.Transform(x: x, scale: scale, rotationDeg: rotationDeg);
        var tag = $"{aspect}-{scale.ToString(CultureInfo.InvariantCulture)}"
                  + $"-r{rotationDeg.ToString(CultureInfo.InvariantCulture)}";

        // Referans: TEK klip, geçiş yok → tek segmentli run → pad ÜRETİLMEZ.
        var alone = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(assetId, 0, 200_000, 1_200_000, transform: pip)]),
        ], width: CanvasWidth, height: CanvasHeight);

        // Aynı klip + bitişik komşu + kesimde geçiş → xfade yolu, pad ZORUNLU.
        var first = ExportTestDocs.VideoClip(assetId, 0, 200_000, 1_200_000, transform: pip);
        var next = ExportTestDocs.VideoClip(assetId, 1_000_000, 200_000, 1_200_000, transform: pip);
        ExportTestDocs.Link(first, next, 200_000);
        var joined = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips: [first, next]),
        ], width: CanvasWidth, height: CanvasHeight);

        var aloneCompiled = ExportCompiler.Compile(alone, sources, CanvasSpec);
        var joinedCompiled = ExportCompiler.Compile(joined, sources, CanvasSpec);
        Assert.Contains("xfade=transition=fade:", joinedCompiled.FilterGraphScript);

        // Frame 15 (t=0.5 sn) geçiş penceresinin (0.9-1.1 sn) DIŞINDADIR → saf ilk klip.
        var aloneFrame = DecodeFrameRgb24(
            await RenderAsync(aloneCompiled, $"tr-alone-{tag}"), 15, $"tr-alone-{tag}-f15");
        var joinedFrame = DecodeFrameRgb24(
            await RenderAsync(joinedCompiled, $"tr-joined-{tag}"), 15, $"tr-joined-{tag}-f15");

        var (ax0, ay0, ax1, ay1) = LitBoundingBox(aloneFrame);
        var (jx0, jy0, jx1, jy1) = LitBoundingBox(joinedFrame);
        Assert.True(
            (ax0, ay0, ax1, ay1) == (jx0, jy0, jx1, jy1),
            $"Geçiş katmanı KAYDIRDI ({tag}): geçişsiz x[{ax0}..{ax1}] y[{ay0}..{ay1}], "
            + $"geçişli x[{jx0}..{jx1}] y[{jy0}..{jy1}]. Fark dy={jy0 - ay0}, dx={jx0 - ax0}.");

        // Dize iddiaları EN SONDA (piksel iddiası kendi başına ayakta dursun): pad hedefi
        // kutunun çifte indirilmiş halidir — ham kutu 161x121 iken hedef 160x120.
        var box = LayerGeometry.ScaleBox(CanvasWidth, CanvasHeight, scale);
        Assert.Contains(
            $"pad={box.Width & ~1L}:{box.Height & ~1L}:(ow-iw)/2:(oh-ih)/2:",
            joinedCompiled.FilterGraphScript);

        // Tek klipte kutuya normalize pad YALNIZ dönen katmanda üretilir: rotate'in kare
        // tuvali GİRİŞİNİN boyutundan doğar, dolayısıyla girişin iki yolda da aynı olması
        // gerekir. Dönmeyen katmanda pad'in geometrik bir işlevi yoktur ve üretilmez —
        // tek katmanlı belgelerin snapshot'ları böylece bayt bayt korunur.
        Assert.Equal(
            (tag, rotationDeg != 0),
            (tag, aloneCompiled.FilterGraphScript.Contains("pad=", StringComparison.Ordinal)));
    }

    [FfmpegFact]
    public void OverlayExpression_TruncatesTowardZero_AndAcceptsFloor()
    {
        // FLOOR'UN DAYANDIĞI DIŞ SÖZLEŞME — kaynak koddan değil GERÇEK ffmpeg'den ölçülür.
        // İki ayrı iddia; ffmpeg sürümü ikisinden birini değiştirirse burası kırmızıya düşer:
        //   (1) overlay'in KENDİ tamsayı çevrimi SIFIRA DOĞRUDUR (floor DEĞİL) — bu yüzden
        //       ifadeye açık floor GEREKİR;
        //   (2) ifade değerlendiricisinde floor VARDIR ve overlay onu kabul eder.
        // 64 px tuval + 20 px katman; katman sola taştığında sol kenar tuvalde görünmez, o yüzden
        // konum SAĞ kenardan türetilir (x = sağ - 20 + 1).
        foreach (var (expression, expected, why) in new (string, int, string)[]
                 {
                     ("-10.1", -10, "kesir 0.1 → sıfıra doğru"),
                     ("-10.5", -10, "yarım → yuvarlama OLSAYDI -11 olurdu"),
                     ("-10.9", -10, "kesir 0.9 → hâlâ -10"),
                     ("-10.999", -10, "sınıra kadar -10"),
                     ("-11", -11, "tam sayıda kırpma yok"),
                     ("10.9", 10, "pozitif tarafta trunc = floor"),
                     ("11", 11, "pozitif tam sayı"),
                 })
        {
            Assert.Equal((expected, $"trunc({expression}) — {why}"),
                (OverlayLeftEdge(expression), $"trunc({expression}) — {why}"));
        }

        foreach (var (expression, expected) in new (string, int)[]
                 {
                     ("floor(-10.1)", -11), ("floor(-10.5)", -11), ("floor(-10.9)", -11),
                     ("floor(-0.2)", -1), ("floor(-11)", -11),
                     ("floor(10.9)", 10), ("floor(11.2)", 11),
                 })
        {
            Assert.Equal((expected, expression), (OverlayLeftEdge(expression), expression));
        }

        // NEGATİF KONTROL: 'floor' gerçekten ÇÖZÜLÜYOR mu, yoksa bilinmeyen bir ad sessizce
        // yutuluyor mu? Uydurma bir fonksiyon adı ffmpeg'i HATAYLA düşürmeli — düşmüyorsa
        // yukarıdaki floor ölçümleri hiçbir şey kanıtlamazdı.
        var failure = Record.Exception(() => OverlayLeftEdge("zzz_not_a_function(1)"));
        Assert.NotNull(failure);
        Assert.Contains("Unknown function", failure.Message, StringComparison.Ordinal);
    }

    [FfmpegFact]
    public void CompositingInRgb_IsWhatKeepsOddOverlayPositionsFromSnapping()
    {
        // §6.3'ün "kompozisyon GRAFİK BAŞINA RGB'de yapılır" kuralının KONUM yarısının dış
        // sözleşmesi — gerçek ffmpeg'den ölçülür. Doküman bugüne kadar bu yarıyı gerekçe
        // olarak SAYIYORDU ama koşan bir ölçümü yoktu.
        //
        // İDDİA: alt örneklemeli tuvalde overlay konumu TEK piksel taşıyamaz; ':format=rgb'
        // bunu kaldırır. Ölçüm zinciri ürünün kendi zinciridir (taban ve katman format=rgba,
        // overlay ':eval=frame' + CompositeFormat) ve iki kol YALNIZ o son parçada ayrışır.
        //
        // BAĞLAYICILIK: 'rgb' kolu ExportCompiler.CompositeFormat'ın KENDİSİYLE kurulur.
        // Sabit boşaltılırsa (kompozisyon RGB'den çıkarılırsa) iki kol AYNILAŞIR ve aşağıdaki
        // ayrışma iddiaları kırmızıya düşer — negatif kontrolün yükü budur.
        //
        // KAPSAM: yalnız KONUM nicelemesi. §6.3'ün RENK yarısı (zincir ortasında renk uzayı
        // değişiminin alt katmanları kaydırması) burada ÖLÇÜLMEZ.
        const string auto = ""; // overlay'in kendi 'format=auto' varsayılanı
        var rgb = ExportCompiler.CompositeFormat;
        Assert.NotEqual(auto, rgb);

        // ÖNCE: format=auto GERÇEKTEN alt örneklemeli bir tuval seçiyor mu? Seçmeseydi
        // aşağıdaki "auto snap'liyor" ölçümü bir şey kanıtlamazdı. Ürünün zincirinde her iki
        // giriş de rgba OLMASINA RAĞMEN pazarlık yuva420p'ye iniyor (ölçüldü) — yani
        // 'format=rgba' tek başına YETMEZ, yükü taşıyan parça overlay'in kendi seçeneğidir.
        Assert.Contains("yuva420p", CompositeNegotiatedFormats(auto), StringComparison.Ordinal);
        Assert.DoesNotContain("yuv", CompositeNegotiatedFormats(rgb), StringComparison.Ordinal);

        // TEK konumlar: auto kolu onları ÇİFTE indiriyor (11→10, −11→−12), rgb kolu indirmiyor.
        // Yön FLOOR'dur, sıfıra doğru DEĞİL: −11 sıfırdan UZAĞA, −12'ye düşüyor.
        Assert.Equal(CompositeLayerBox(auto, 10, 10), CompositeLayerBox(auto, 11, 11));
        Assert.Equal(CompositeLayerBox(auto, -12, -12), CompositeLayerBox(auto, -11, -11));

        // Aynı konumlar rgb kolunda AYRIŞIYOR ve katman TAM istenen sütuna/satıra oturuyor.
        Assert.Equal((11, 11, 11 + LayerWidth - 1, 11 + LayerHeight - 1), CompositeLayerBox(rgb, 11, 11));
        Assert.Equal((10, 10, 10 + LayerWidth - 1, 10 + LayerHeight - 1), CompositeLayerBox(rgb, 10, 10));

        // Negatif tarafta sol/üst kenar tuval dışında kalır → iddia SAĞ/ALT kenardan kurulur.
        Assert.Equal((0, 0, -11 + LayerWidth - 1, -11 + LayerHeight - 1), CompositeLayerBox(rgb, -11, -11));
        Assert.Equal((0, 0, -12 + LayerWidth - 1, -12 + LayerHeight - 1), CompositeLayerBox(rgb, -12, -12));

        // KONTROL GRUBU: ÇİFT konumlarda iki kol AYNI kutuyu veriyor. Bu olmasaydı fark
        // "niceleme" değil genel bir geometri/format farkı olurdu ve iddia çürük kalırdı.
        Assert.Equal(CompositeLayerBox(auto, 10, 10), CompositeLayerBox(rgb, 10, 10));
        Assert.Equal(CompositeLayerBox(auto, -12, -12), CompositeLayerBox(rgb, -12, -12));
    }

    [FfmpegTheory]
    // rotate girişinin boyutu (scale çıkışı DAİMA çifttir, o yüzden her ikisi de çift).
    [InlineData(960, 540)]      // hypot 1101.45 → ham kural 1101 (TEK)
    [InlineData(480, 270)]      // hypot  550.73 → 551 (TEK)
    [InlineData(768, 432)]      // hypot  881.16 → 881 (TEK)
    [InlineData(640, 360)]      // hypot  734.30 → 734 (ÇİFT — kontrol grubu)
    [InlineData(1928, 1084)]    // hypot 2211.84 → 2212 (ÇİFT — kontrol grubu)
    public void RotateCanvas_CentersTheContent_OnlyWhenTheCanvasIsEven(int width, int height)
    {
        // ÇİFT TUVAL KURALININ DAYANDIĞI DIŞ SÖZLEŞME — gerçek ffmpeg'den ölçülür, kaynak koddan
        // değil. `a=0` seçildi: interpolasyon YOK, dolayısıyla içeriğin tuval içindeki yeri
        // KESİN okunur ve ölçüm rotate'in yalnızca TUVAL ARİTMETİĞİNİ sınar.
        var (rawDg, rawBox) = RotateCanvasPlacement(width, height, "hypot(iw\\,ih)");
        var (evenDg, evenBox) = RotateCanvasPlacement(width, height, "2*ceil(hypot(iw\\,ih)/2)");

        // Yeni kural: tuval DAİMA çift ve köşegeni kapsıyor.
        Assert.Equal(0, evenDg % 2);
        Assert.True(evenDg >= Math.Sqrt((double)(width * width) + (height * height)),
            $"çift tuval köşegeni kapsamıyor: {evenDg} < hypot({width},{height})");

        // Ve içerik tuvalin TAM ORTASINDA (süreklilik koordinatında: içerik merkezi = Dg/2).
        Assert.Equal((evenDg / 2d, evenDg / 2d),
            ((evenBox.X0 + evenBox.X1 + 1) / 2d, (evenBox.Y0 + evenBox.Y1 + 1) / 2d));

        // Ham kural TEK tuval ürettiğinde içerik ortaya oturamaz — sapma tam 0.5 px'tir.
        var rawOffset = ((rawBox.X0 + rawBox.X1 + 1) / 2d) - (rawDg / 2d);
        Assert.Equal(rawDg % 2 == 0 ? 0d : 0.5d, Math.Abs(rawOffset));
    }

    [FfmpegTheory]
    // ölçek, x — katman tuvali TAŞIYOR (ölçek > 1) → overlay hedefi NEGATİF; ve kontrol grubu.
    [InlineData(1.1, -0.3996, true)]    // hedef -143.872 → floor -144, trunc -143: AYRIŞIR
    [InlineData(1.1, -0.4004, true)]    // hedef -144.128 → floor -145, trunc -144: AYRIŞIR
    [InlineData(0.5, 0.0026, false)]    // hedef +80.832: iki kural AYNI sonucu verir (kontrol)
    public async Task ZoomedLayer_LandsOnTheFlooredTarget_EvenWhenItIsNegative(
        double scale, double x, bool discriminates)
    {
        // §2.5(b) modeli: "export merkezi = trunc(P), sapma daima orijine doğru". Bu ancak
        // overlay HEDEFİ ≥ 0 iken doğruydu. Katman tuvali taştığı an (her yakınlaştırma) hedef
        // negatifleşir ve (int)'in sıfıra doğru kırpması sapmayı TERS ÇEVİRİRDİ. İfadedeki floor
        // modeli her iki işarette de geçerli kılar; bu test onu GERÇEK piksellerde sabitler.
        //
        // İki negatif satır BİLEREK -144'ün iki yakasındadır: trunc ikisini de bir piksel
        // ORİJİNE DOĞRU (-143 ve -144) yollar, floor ise -144 ve -145 verir — yani negatif
        // tarafta sapmanın İŞARETİ terstir. Farkın gerçekten doğduğunu testin kendi hesabı
        // (flooredRight != truncatedRight) doğrular; üçüncü satır aynı hesapla farkın
        // pozitif tarafta DOĞMADIĞINI sabitler.
        //
        // Katman yatayda tuvali taştığı için SOL kenar görünmez → SAĞ kenar ölçülür. Kaynak DÜZ
        // RENKTİR ve kenar TEK BİR SATIRDA, katman renginin yarısı eşiğiyle aranır: encode
        // (4:2:0 + DCT) sınırın 1 px ötesine zayıf bir sızıntı bırakır (ölçüldü: dış komşu
        // (30,0,0), iç komşu (106,71,54)); tüm karenin sınır kutusu bu sızıntıyı katmanın
        // kendisi sanardı.
        var assetId = ExportTestDocs.AssetC;
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [assetId] = new(media.VideoSolid320x240NoAudio(), false, "bt709", "bt709"),
        };
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(assetId, 0, 0, 1_000_000,
                    transform: ExportTestDocs.Transform(x: x, scale: scale)),
            ]),
        ], width: CanvasWidth, height: CanvasHeight);

        var compiled = ExportCompiler.Compile(doc, sources, CanvasSpec);
        var box = LayerGeometry.ScaleBox(CanvasWidth, CanvasHeight, scale);
        var (outW, _) = ScaleOutputSize(320, 240, (int)box.Width, (int)box.Height);

        // İki kuralın ÖNGÖRÜSÜ (fixture'ın gerçekten ayrım yaptığını testin kendisi doğrular).
        var target = (CanvasWidth / 2d) + (x * CanvasWidth) - (outW / 2d);
        var flooredRight = (int)Math.Floor(target) + outW - 1;
        var truncatedRight = (int)Math.Truncate(target) + outW - 1;
        Assert.Equal(discriminates, flooredRight != truncatedRight);

        var tag = $"zoom-{scale.ToString(CultureInfo.InvariantCulture)}"
                  + $"-{x.ToString(CultureInfo.InvariantCulture)}";
        var frame = DecodeFrameRgb24(await RenderAsync(compiled, tag), 15, tag + "-f15");
        var right = LastSolidColumn(frame, CanvasHeight / 2);

        Assert.True(right < CanvasWidth - 1,
            $"fixture bozuk: sağ kenar da tuvali taşıyor (x1={right}), ölçüm anlamsız");
        Assert.Equal(flooredRight, right);
    }

    [FfmpegFact]
    public async Task RotatedLayer_LandsOnTheSameCenterAsTheUnrotatedOne()
    {
        // G3: dönen katmanın ara tuvali TEK olduğunda katman merkezi dönmeyen halinden 1 px
        // ayrılıyordu — "dönme yalnız görüntüyü çevirir, çapayı KAYDIRMAZ" sözleşmesinin ihlali.
        // Kök neden rotate'in ow=hypot(iw,ih) ifadesini round ile tamsayılaması ve sonucun
        // sıklıkla TEK çıkmasıydı; TEK tuvalde içerik tuvalin ortasına oturamaz ve overlay
        // telafisi 0.5*w yarım tamsayı olur. Tuval artık ÇİFTE sabitlenir (2*ceil(hypot/2)).
        //
        // Fixture ölçek 0.657 seçildi ÇÜNKÜ ayrım TAM ORADA doğar: 4:3 kaynak → scale çıkışı
        // 210x158, hypot 262.80 → eski kural 263 (TEK), yeni kural 264 (ÇİFT). x=y=0.0025 ile
        // P her iki eksende de kesirlidir, yani eski kural katmanı kaydırırdı.
        //
        // 90° seçildi: dönme interpolasyon bulanıklığı ÜRETMEZ (kenar yumuşaması simetriktir),
        // dolayısıyla sınır kutusunun MERKEZİ kesindir. Kenarlar ±1 px yumuşayabilir — iddia
        // bu yüzden kenarlar üstünde değil MERKEZ üstünde kurulur.
        const double x = 0.0025;
        const double y = 0.0025;
        var assetId = ExportTestDocs.AssetC;
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [assetId] = new(media.VideoSolid320x240NoAudio(), false, "bt709", "bt709"),
        };

        TimelineDoc Doc(double rotationDeg) => ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(assetId, 0, 0, 1_000_000,
                    transform: ExportTestDocs.Transform(
                        x: x, y: y, scale: 0.657, rotationDeg: rotationDeg)),
            ]),
        ], width: CanvasWidth, height: CanvasHeight);

        var straightCompiled = ExportCompiler.Compile(Doc(0), sources, CanvasSpec);
        var rotatedCompiled = ExportCompiler.Compile(Doc(90), sources, CanvasSpec);
        Assert.DoesNotContain("rotate=", straightCompiled.FilterGraphScript);

        var straight = DecodeFrameRgb24(
            await RenderAsync(straightCompiled, "rot-parity-straight"), 15, "rot-parity-straight-f15");
        var rotated = DecodeFrameRgb24(
            await RenderAsync(rotatedCompiled, "rot-parity-rotated"), 15, "rot-parity-rotated-f15");

        var (sx0, sy0, sx1, sy1) = LitBoundingBox(straight);
        var (rx0, ry0, rx1, ry1) = LitBoundingBox(rotated);
        var straightCenter = ((sx0 + sx1 + 1) / 2d, (sy0 + sy1 + 1) / 2d);
        var rotatedCenter = ((rx0 + rx1 + 1) / 2d, (ry0 + ry1 + 1) / 2d);

        // Modelin kendisi: merkez = floor(P), her iki eksende ve dönmeden BAĞIMSIZ.
        var expected = (
            Math.Floor((CanvasWidth / 2d) + (x * CanvasWidth)),
            Math.Floor((CanvasHeight / 2d) + (y * CanvasHeight)));

        Assert.Equal(expected, straightCenter);
        Assert.Equal(expected, rotatedCenter);

        // Dönmüş kutu gerçekten 90° dönmüş olmalı (aksi halde "merkez aynı" iddiası boş olurdu:
        // hiç dönmemiş bir katman da testi geçerdi).
        Assert.True(rx1 - rx0 < sx1 - sx0 && ry1 - ry0 > sy1 - sy0,
            $"katman dönmemiş görünüyor: dönmesiz {sx1 - sx0 + 1}x{sy1 - sy0 + 1}, "
            + $"dönmüş {rx1 - rx0 + 1}x{ry1 - ry0 + 1}");

        // Dize iddiası EN SONDA: tuval ifadesi ÇİFTE zorlanıyor.
        Assert.Contains("ow=2*ceil(hypot(iw\\,ih)/2):oh=ow", rotatedCompiled.FilterGraphScript);
    }

    [FfmpegTheory]
    // (kaynak, kutu) — 16:9 / 4:3 / kare kaynak, TEK ve ÇİFT kutular, dejenere olmayan aralık.
    [InlineData(1280, 720, 962, 541)]
    [InlineData(640, 480, 962, 541)]
    [InlineData(512, 512, 962, 541)]
    [InlineData(1280, 720, 963, 541)]
    [InlineData(333, 777, 121, 55)]
    [InlineData(1920, 1080, 3, 3)]
    [InlineData(16, 9, 1919, 1079)]
    public void ScaleOutput_IsAlwaysEven_AndFitsTheEvenBox(int srcW, int srcH, int boxW, int boxH)
    {
        // Düzeltmenin dayandığı DIŞ SÖZLEŞME: pad hedefini kutunun çifte indirilmiş haline
        // çekmek ancak scale çıktısı DAİMA çift ve o hedeften küçük/eşitse güvenlidir.
        // ffmpeg sürümü bu davranışı değiştirirse burası kırmızıya düşmelidir — kaynak koddan
        // değil, GERÇEK koşumdan ölçülür.
        //
        // ÖNKOŞUL (ölçüldü): sözleşme, sığdırılan boyut ≥ 1 px olduğu sürece geçerlidir. Alt-piksele
        // düşen eksende scale 0 üretir ve 0'ı "girdi boyutu" diye yorumlar (ölç.: src 100x8,
        // kutu 6x6 → 6x8). O rejim artık derlemeye HİÇ GİRMEZ: dejenerelik kapısı onu
        // 'degenerate-layer' ile reddeder (bkz. DegenerateLayer_*). Aşağıdaki InlineData'ların
        // hiçbiri dejenere değildir — sözleşme yalnız o kümede iddia edilir.
        Assert.False(LayerGeometry.IsDegenerate(boxW, boxH, srcW, srcH),
            "fixture dejenere: bu vaka kapıdan geçemez, sözleşme onda iddia edilemez");

        var (outW, outH) = ScaleOutputSize(srcW, srcH, boxW, boxH);

        Assert.True(outW % 2 == 0 && outH % 2 == 0,
            $"scale çıktısı TEK boyutlu: {srcW}x{srcH} → kutu {boxW}x{boxH} → {outW}x{outH}");
        Assert.True(outW <= (boxW & ~1) && outH <= (boxH & ~1),
            $"scale çıktısı çifte indirilmiş kutuyu AŞTI: {srcW}x{srcH} → kutu {boxW}x{boxH} → "
            + $"{outW}x{outH} > {boxW & ~1}x{boxH & ~1} — pad kırpardı");
    }

    [FfmpegTheory]
    [MemberData(nameof(LayerGeometryTests.MeasuredScaleOutputs), MemberType = typeof(LayerGeometryTests))]
    public void ScaleOutput_MatchesRealFfmpeg(
        int srcW, int srcH, int boxW, int boxH, int outW, int outH, bool degenerate)
    {
        // LayerGeometry.ScaleOutput ffmpeg'in ff_scale_adjust_dimensions davranışının TAMSAYI
        // MODELİDİR ve dejenerelik kapısı ona dayanır. Model bir REPLİKADIR: ffmpeg sürümü
        // yuvarlamayı değiştirirse kapı sessizce yanlış yere kayar. Bu yüzden model, CANLI
        // ffmpeg'e karşı koşulur — tablodaki beklenen değer değil, GERÇEK ölçüm hakemdir.
        var measured = ScaleOutputSize(srcW, srcH, boxW, boxH);

        Assert.Equal((outW, outH), measured);
        Assert.Equal(measured, LayerGeometry.ScaleOutput(boxW, boxH, srcW, srcH));
        Assert.Equal(degenerate, LayerGeometry.IsDegenerate(boxW, boxH, srcW, srcH));

        // Dejenere vakada ffmpeg o ekseni 0 hesaplar ve KAYNAĞIN boyutunu korur — "çıktı kutuyu
        // aşar" ile aynı şey değildir (sessiz sınıf kutuya sığar; bkz. LayerGeometryTests).
        Assert.Equal(
            degenerate, measured.Width == srcW || measured.Height == srcH);
    }

    /// <summary>
    /// ANİMASYONLU ölçek yolunun kutu aritmetiği: kesirli ifade → tamsayı kutu.
    /// fitW, fitH (kaynak), ifade w, ifade h, beklenen ÇIKIŞ (showinfo).
    /// </summary>
    public static TheoryData<int, int, string, string, int, int> MeasuredTruncatedBoxes() => new()
    {
        // Canlı ölçümde E2E'nin ÖLDÜĞÜ vaka: bbox 223x104, taban 0.015 → 3.345 / 1.56.
        // Kırpma → kutu 3x1 → yükseklik çöker, çıkış KAYNAĞIN yüksekliği (104).
        { 223, 104, "3.345", "1.56", 2, 104 },
        // KIRPMA/YUVARLAMA AYRIMININ TANIK VAKASI: 3.9/2.9 yuvarlansaydı kutu 4x3 → çıkış 4x2.
        { 223, 104, "3.9", "2.9", 2, 2 },
        { 223, 104, "3.0", "2.0", 2, 2 },
        { 223, 104, "4.0", "3.0", 4, 2 },
        // Kapının önerdiği taban (0.020): 4.46 / 2.08 → kutu 4x2 → temiz.
        { 223, 104, "4.46", "2.08", 4, 2 },
        // Varyant 2 (bbox 6x20): 0.25 (eski, statik eşik) → 1.5/5 → kutu 1x5, GENİŞLİK çöker
        // ve çıkış genişliği KAYNAĞIN kendi genişliğine sıçrar (6). Ölçüm: 6x4.
        { 6, 20, "1.5", "5.0", 6, 4 },
        // 0.334 (yeni taban) → 2.004 / 6.68 → kutu 2x6 → temiz.
        { 6, 20, "2.004", "6.68", 2, 6 },
    };

    [FfmpegTheory]
    [MemberData(nameof(MeasuredTruncatedBoxes))]
    public void ScaleBoxTruncated_MatchesRealFfmpeg(
        int fitW, int fitH, string exprW, string exprH, int outW, int outH)
    {
        // ANİMASYONLU ölçekte kutuyu compiler DEĞİL ffmpeg üretir: filtergraph'a ham çarpım
        // ifadesi gider (scale=w='...':eval=frame) ve tamsayıya çeviren ffmpeg'dir. Kapının
        // hangi aritmetiği varsaydığı BELİRLEYİCİDİR — ilk sürümü roundHalfUp varsayıyordu ve
        // kabul ettiği belge ffmpeg'de ölüyordu. Hakem burada da CANLI ölçümdür.
        var w = double.Parse(exprW, CultureInfo.InvariantCulture);
        var h = double.Parse(exprH, CultureInfo.InvariantCulture);
        var box = LayerGeometry.ScaleBoxTruncated(w, h, 1d);

        var measured = ScaleOutputSizeFromExpression(fitW, fitH, exprW, exprH);
        Assert.Equal((outW, outH), measured);

        // Modelin kutusu ffmpeg'in kutusuyla aynı mı: çıkışı kendi kutumuzdan yeniden üret.
        Assert.Equal(measured, ToInt(LayerGeometry.ScaleOutput(box.Width, box.Height, fitW, fitH)));

        // Ve kapının yüklemi ölçülen sonuçla aynı şeyi söylemeli: dejenere ⟺ bir eksen kaynağın.
        var degenerate = measured.Width == fitW || measured.Height == fitH;
        Assert.Equal(degenerate, LayerGeometry.IsDegenerate(box.Width, box.Height, fitW, fitH));

        // KIRPMA vs YUVARLAMA: yuvarlayan bir model bu tabloyu yeniden üretemez.
        Assert.Equal(box, LayerGeometry.ScaleBoxTruncated(w, h, 1d));
    }

    private static (int Width, int Height) ToInt((long Width, long Height) value) =>
        ((int)value.Width, (int)value.Height);

    [FfmpegFact]
    public async Task DegenerateLayer_IsRejectedTyped_WhileTheScaleJustAboveItRendersCorrectly()
    {
        // KAPININ İKİ YARISI TEK TESTTE, GERÇEK RENDER'LA.
        //
        // Kaynak 320x16 (afiş, 20:1), tuval 320x240. Eşik: (ceil(320/16) - 0.5)/320 = 19.5/320
        // = 0.060937 → editör ızgarasında 0.061.
        //   * ölçek 0.060 → kutu 19x14, sığdırılan yükseklik 0.95 px → DEJENERE. Gerçek ffmpeg
        //     bu kutuda 18x16 çizerdi (16.7 KAT yüksek, önizleme 19.2x0.96 çizerken) — kapı
        //     olmasaydı bu ya pad'de -22 ile ölürdü ya da SESSİZCE yanlış çizerdi.
        //   * ölçek 0.061 → kutu 20x15 → çıktı 20x2, temiz ve MERKEZLİ.
        var bannerPath = media.VideoBanner320x16NoAudio();
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            // Boyutlar worker'da ffprobe'tan gelir; kapı yalnız bu defterden beslenir.
            [ExportTestDocs.AssetB] = new(bannerPath, false, "bt709", "bt709", 320, 16),
        };

        static TimelineDoc DocAt(double scale) => ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(
                    ExportTestDocs.AssetB, 0, 0, 1_000_000,
                    transform: ExportTestDocs.Transform(scale: scale)),
            ]),
        ], width: CanvasWidth, height: CanvasHeight);

        // ── (1) Eşiğin ALTI: TİPLİ hata, ffmpeg hiç çağrılmaz.
        var rejected = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Compile(DocAt(0.060), sources, CanvasSpec));
        Assert.Equal("degenerate-layer", rejected.Feature);
        Assert.Contains("320x16", rejected.Message);          // NEDEN: kaynağın oranı
        Assert.Contains("19x14", rejected.Message);           // hangi kutuda
        Assert.Contains("en az 0.061", rejected.Message);     // EYLEM: tek ve kesin bir sayı

        // Reddin gerekçesi GERÇEK: aynı kutu canlı ffmpeg'de kaynağın kendi yüksekliğini korur.
        Assert.Equal((18, 16), ScaleOutputSize(320, 16, 19, 14));

        // ── (2) Eşiğin HEMEN ÜSTÜ: derlenir VE doğru geometriyle render edilir.
        var compiled = ExportCompiler.Compile(DocAt(0.061), sources, CanvasSpec);
        Assert.Contains("scale=20:15:", compiled.FilterGraphScript);

        var frame = DecodeFrameRgb24(await RenderAsync(compiled, "degen-edge"), 15, "degen-edge-f15");
        var (x0, y0, x1, y1) = LitBoundingBox(frame);

        // Beklenen: 20x2 katman, merkezi (160,120) → overlay x = 160-0.5*20 = 150,
        // y = 120-0.5*2 = 119. Önizlemenin çizdiği kutu 19.52x0.976 merkezli; export her kenarda
        // en fazla 1 px farkla ama MERKEZİ BOZMADAN nicelenir (§2.5'in beyan edilen toleransı).
        Assert.Equal((150, 119, 169, 120), (x0, y0, x1, y1));
        Assert.Equal(160d, (x0 + x1 + 1) / 2d);
        Assert.Equal(120d, (y0 + y1 + 1) / 2d);
    }

    /// <summary>
    /// Derleyicinin ölçek filtresinin GERÇEK ffmpeg çıktısı (showinfo'dan okunur). Kutu bir ÜST
    /// SINIRDIR; gerçek boyut kaynağın aspect'inden ve force_divisible_by=2'den doğar.
    /// </summary>
    /// <summary>
    /// <see cref="ScaleOutputSize"/>'ın İFADELİ hali: kutu sabit sayı değil, <c>eval=frame</c>
    /// ile değerlendirilen kesirli bir ifadedir (animasyonlu ölçek yolunun birebir biçimi).
    /// </summary>
    private static (int Width, int Height) ScaleOutputSizeFromExpression(
        int srcW, int srcH, string exprW, string exprH)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "ffmpeg",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
                 {
                     "-hide_banner", "-loglevel", "info", "-y",
                     "-f", "lavfi", "-i",
                     $"color=c=white:s={srcW.ToString(CultureInfo.InvariantCulture)}x"
                     + $"{srcH.ToString(CultureInfo.InvariantCulture)}:d=0.1",
                     "-vf",
                     $"scale=w='{exprW}':h='{exprH}'"
                     + ":force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic"
                     + ":eval=frame,showinfo",
                     "-frames:v", "1", "-f", "null", "-",
                 })
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)!;
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit(30_000);

        var match = System.Text.RegularExpressions.Regex.Match(stderr, @"\ss:(\d+)x(\d+)\s");
        Assert.True(match.Success, $"showinfo çıktısı okunamadı:\n{stderr}");
        return (
            int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture),
            int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture));
    }

    /// <summary>
    /// <c>overlay=x='&lt;expression&gt;'</c>'in GERÇEK ffmpeg'de oturduğu sütun. 64x64 siyah tuval +
    /// 20x20 beyaz katman; konum SAĞ kenardan türetilir (sola taşan katmanın sol kenarı tuvalde
    /// görünmez, sağ kenarı görünür). Ölçüm rgb24 ham kareden yapılır — encode/decode yolu yok.
    /// ffmpeg hata verirse <see cref="InvalidOperationException"/> fırlar (negatif kontrol bunu
    /// kullanır: bilinmeyen fonksiyon adı sessizce yutulmamalıdır).
    /// </summary>
    private static int OverlayLeftEdge(string expression)
    {
        const int canvas = 64;
        const int layer = 20;
        var psi = new ProcessStartInfo
        {
            FileName = "ffmpeg",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
                 {
                     "-hide_banner", "-loglevel", "error", "-y",
                     "-filter_complex",
                     $"color=c=black:s={canvas}x{canvas}:d=1[bg];"
                     + $"color=c=white:s={layer}x{layer}:d=1[fg];"
                     + $"[bg][fg]overlay=x='{expression}':y=0:format=rgb[out]",
                     "-map", "[out]", "-frames:v", "1",
                     "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
                 })
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)!;
        using var stdout = new MemoryStream();
        process.StandardOutput.BaseStream.CopyTo(stdout);
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit(30_000);
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"ffmpeg overlay x='{expression}' ile başarısız oldu: {stderr}");
        }

        var rgb = stdout.ToArray();
        Assert.Equal(canvas * canvas * 3, rgb.Length);
        for (var column = canvas - 1; column >= 0; column--)
        {
            if (rgb[column * 3] > 32)
            {
                return column - layer + 1;
            }
        }

        throw new InvalidOperationException(
            $"overlay x='{expression}': katman tuvalde hiç görünmedi");
    }

    /// <summary>Kompozisyon ölçümünün katman boyutu (tuvalin içine sığar, kenarları kesin).</summary>
    private const int LayerWidth = 64;

    /// <inheritdoc cref="LayerWidth"/>
    private const int LayerHeight = 48;

    /// <summary>
    /// ÜRÜNÜN kompozisyon zinciri, tek karelik küçük ölçeği: taban ve katman <c>format=rgba</c>
    /// ile girer, <c>overlay</c> <paramref name="compositeFormat"/> ile blend eder. Yalnız o son
    /// parça değişkendir — iki kolun farkı başka hiçbir şeyden doğamaz.
    /// </summary>
    private static string CompositeGraph(string compositeFormat, string x, string y) =>
        $"color=c=black:s={CanvasWidth.ToString(CultureInfo.InvariantCulture)}x"
        + $"{CanvasHeight.ToString(CultureInfo.InvariantCulture)}:d=1,"
        + "format=rgba,setsar=1,settb=AVTB[base];"
        + $"color=c=0x{SolidLayerRgb[0]:X2}{SolidLayerRgb[1]:X2}{SolidLayerRgb[2]:X2}"
        + $":s={LayerWidth.ToString(CultureInfo.InvariantCulture)}x"
        + $"{LayerHeight.ToString(CultureInfo.InvariantCulture)}:d=1,"
        + "setsar=1,format=rgba,settb=AVTB[l];"
        + $"[base][l]overlay=x={x}:y={y}:eval=frame{compositeFormat}[out]";

    /// <summary>
    /// <see cref="CompositeGraph"/>'ın verdiği kompozit karede katmanın sınır kutusu (ham rgb24,
    /// encode YOK). Konum tamsayı verilir: ürün overlay hedefini ifadenin içinde zaten
    /// <c>floor</c>'lar, yani bu hatta kesirli bir hedef ULAŞMAZ.
    /// </summary>
    private static (int X0, int Y0, int X1, int Y1) CompositeLayerBox(
        string compositeFormat, int x, int y)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "ffmpeg",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
                 {
                     "-hide_banner", "-loglevel", "error", "-y",
                     "-filter_complex",
                     CompositeGraph(
                         compositeFormat,
                         x.ToString(CultureInfo.InvariantCulture),
                         y.ToString(CultureInfo.InvariantCulture)),
                     "-map", "[out]", "-frames:v", "1",
                     "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
                 })
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)!;
        using var buffer = new MemoryStream();
        process.StandardOutput.BaseStream.CopyTo(buffer);
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit(30_000);
        Assert.True(process.ExitCode == 0,
            $"kompozisyon ölçümü başarısız (format='{compositeFormat}', x={x}, y={y}): {stderr}");

        var rgb = buffer.ToArray();
        Assert.Equal(CanvasWidth * CanvasHeight * 3, rgb.Length);
        return LitBoundingBox(rgb);
    }

    /// <summary>
    /// <c>overlay</c>'in pazarlık SONUCUNDA seçtiği piksel formatlarını (ffmpeg'in kendi verbose
    /// satırı) döndürür. "auto gerçekten alt örneklemeli mi" sorusunu ölçümle yanıtlar —
    /// varsayımla değil.
    /// </summary>
    private static string CompositeNegotiatedFormats(string compositeFormat)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "ffmpeg",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
                 {
                     "-hide_banner", "-loglevel", "verbose", "-y",
                     "-filter_complex", CompositeGraph(compositeFormat, "11", "11"),
                     "-map", "[out]", "-frames:v", "1", "-f", "null", "-",
                 })
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)!;
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit(30_000);
        Assert.True(process.ExitCode == 0, $"format pazarlığı okunamadı: {stderr}");

        var line = stderr.Split('\n')
            .FirstOrDefault(l => l.Contains("Parsed_overlay", StringComparison.Ordinal)
                                 && l.Contains("fmt:", StringComparison.Ordinal));
        Assert.False(string.IsNullOrEmpty(line),
            $"overlay'in seçtiği format satırı bulunamadı:\n{stderr}");
        return line!;
    }

    /// <summary>
    /// <c>rotate=a=0:c=none:ow=&lt;expression&gt;:oh=ow</c>'un ÜRETTİĞİ kare tuvalin kenarı ve
    /// içeriğin o tuvaldeki sınır kutusu. Tuval boyutu ffmpeg'in kendi hesabıdır — ham bayt
    /// sayısından türetilir, biz varsaymayız. <c>a=0</c> olduğu için interpolasyon yoktur ve
    /// sınır kutusu KESİNDİR.
    /// </summary>
    private static (int Dg, (int X0, int Y0, int X1, int Y1) Box) RotateCanvasPlacement(
        int width, int height, string canvasExpression)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "ffmpeg",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
                 {
                     "-hide_banner", "-loglevel", "error", "-y",
                     "-filter_complex",
                     $"color=c=white:s={width.ToString(CultureInfo.InvariantCulture)}x"
                     + $"{height.ToString(CultureInfo.InvariantCulture)}:d=1,format=rgba,"
                     + $"rotate=a=0:c=none:ow={canvasExpression}:oh=ow[out]",
                     "-map", "[out]", "-frames:v", "1",
                     "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
                 })
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)!;
        using var buffer = new MemoryStream();
        process.StandardOutput.BaseStream.CopyTo(buffer);
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit(30_000);
        Assert.True(process.ExitCode == 0, $"rotate ow={canvasExpression} başarısız: {stderr}");

        var rgb = buffer.ToArray();
        var dg = (int)Math.Round(Math.Sqrt(rgb.Length / 3d));
        Assert.Equal(dg * dg * 3, rgb.Length); // kare tuval (oh=ow)

        int x0 = dg, y0 = dg, x1 = -1, y1 = -1;
        for (var y = 0; y < dg; y++)
        {
            for (var x = 0; x < dg; x++)
            {
                var offset = ((y * dg) + x) * 3;
                if (Math.Max(rgb[offset], Math.Max(rgb[offset + 1], rgb[offset + 2])) <= 32)
                {
                    continue;
                }

                x0 = Math.Min(x0, x);
                y0 = Math.Min(y0, y);
                x1 = Math.Max(x1, x);
                y1 = Math.Max(y1, y);
            }
        }

        Assert.True(x1 >= 0, $"rotate ow={canvasExpression}: tuvalde içerik yok");
        return (dg, (x0, y0, x1, y1));
    }

    private static (int Width, int Height) ScaleOutputSize(int srcW, int srcH, int boxW, int boxH)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "ffmpeg",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
                 {
                     "-hide_banner", "-loglevel", "info", "-y",
                     "-f", "lavfi", "-i",
                     $"color=c=white:s={srcW.ToString(CultureInfo.InvariantCulture)}x"
                     + $"{srcH.ToString(CultureInfo.InvariantCulture)}:d=0.1",
                     "-vf",
                     $"scale={boxW.ToString(CultureInfo.InvariantCulture)}:"
                     + $"{boxH.ToString(CultureInfo.InvariantCulture)}"
                     + ":force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,showinfo",
                     "-frames:v", "1", "-f", "null", "-",
                 })
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)!;
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit(30_000);

        var match = System.Text.RegularExpressions.Regex.Match(stderr, @"\ss:(\d+)x(\d+)\s");
        Assert.True(match.Success, $"showinfo çıktısı okunamadı:\n{stderr}");
        return (
            int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture),
            int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture));
    }

    // ───────────────────────── Piksel / render yardımcıları ─────────────────────────

    private async Task<string> RenderAsync(CompiledExport compiled, string name)
    {
        var scriptPath = Path.Combine(_outDir, name + "-graph.txt");
        await File.WriteAllTextAsync(scriptPath, compiled.FilterGraphScript);
        var outputPath = Path.Combine(_outDir, name + ".mp4");
        var result = await new FfmpegRunner(_options).RunAsync(
            compiled.ToFfmpegArgs(scriptPath, outputPath), compiled.ExpectedDurationUs);
        Assert.True(result.Success, $"{name} render failed: {result.StderrTail}");
        return outputPath;
    }

    /// <summary>
    /// Çıktının belirli karesini rgb24 bayt dizisine çözer. Piksel yardımcıları
    /// <see cref="CanvasWidth"/>×<see cref="CanvasHeight"/> tuval varsayar — çözülen kare
    /// boyutu burada doğrulanır ki yanlış tuvalde sessizce yanlış piksel okunmasın.
    /// </summary>
    private byte[] DecodeFrameRgb24(string videoPath, int frameIndex, string name)
    {
        var framePath = Path.Combine(_outDir, name + ".png");
        ExtractFrame(videoPath, frameIndex, framePath);
        var rgb = DecodeRgb24(framePath);
        Assert.Equal(CanvasWidth * CanvasHeight * 3, rgb.Length);
        return rgb;
    }

    private static void AssertPixel(
        byte[] rgb, int x, int y, byte[] expected, int tolerance, string what)
    {
        var offset = ((y * CanvasWidth) + x) * 3;
        var actual = new[] { rgb[offset], rgb[offset + 1], rgb[offset + 2] };
        var ok = Math.Abs(actual[0] - expected[0]) <= tolerance
                 && Math.Abs(actual[1] - expected[1]) <= tolerance
                 && Math.Abs(actual[2] - expected[2]) <= tolerance;
        Assert.True(ok,
            $"({x},{y}) {what}: beklenen ≈({expected[0]},{expected[1]},{expected[2]}) ±{tolerance}, "
            + $"ölçülen ({actual[0]},{actual[1]},{actual[2]})");
    }

    private static void AssertSolidLayer(byte[] rgb, int x, int y, string what) =>
        AssertPixel(rgb, x, y, SolidLayerRgb, SolidTolerance, what);

    private static void AssertBackground(byte[] rgb, int x, int y, string what) =>
        AssertPixel(rgb, x, y, [0, 0, 0], SolidTolerance, what);

    /// <summary>İki render'ın AYNI pikselinin eşitliği — mutlak renk sabiti gerektirmez.</summary>
    private static void AssertSamePixel(byte[] a, byte[] b, int x, int y, int tolerance, string what)
    {
        var offset = ((y * CanvasWidth) + x) * 3;
        var diff = Math.Max(
            Math.Abs(a[offset] - b[offset]),
            Math.Max(Math.Abs(a[offset + 1] - b[offset + 1]), Math.Abs(a[offset + 2] - b[offset + 2])));
        Assert.True(diff <= tolerance,
            $"({x},{y}) {what}: iki render farklı — ({a[offset]},{a[offset + 1]},{a[offset + 2]}) vs "
            + $"({b[offset]},{b[offset + 1]},{b[offset + 2]}), fark {diff} > {tolerance}");
    }

    /// <summary>[x0,x1) × [y0,y1) dikdörtgeninde kanal başına ortalama kare hata.</summary>
    private static double RegionMse(byte[] a, byte[] b, int x0, int y0, int x1, int y1)
    {
        double sum = 0;
        var count = 0;
        for (var y = y0; y < y1; y++)
        {
            for (var x = x0; x < x1; x++)
            {
                var offset = ((y * CanvasWidth) + x) * 3;
                for (var c = 0; c < 3; c++)
                {
                    double diff = a[offset + c] - b[offset + c];
                    sum += diff * diff;
                    count++;
                }
            }
        }

        return sum / count;
    }

    /// <summary>
    /// Satırdaki ilk "aydınlık" sütun — katmanın SOL KENARININ hangi piksele oturduğunun ölçüsü.
    /// Eşik siyah tuval (≈0) ile düz renk katman (≈128 kırmızı, %75 opaklıkta ≈96) arasında
    /// güvenle ayrım yapar; encode ringing'i eşiğin altında kalır.
    /// </summary>
    private static int FirstLitColumn(byte[] rgb, int row)
    {
        for (var x = 0; x < CanvasWidth; x++)
        {
            var offset = ((row * CanvasWidth) + x) * 3;
            if (Math.Max(rgb[offset], Math.Max(rgb[offset + 1], rgb[offset + 2])) > 32)
            {
                return x;
            }
        }

        return -1;
    }

    /// <summary>
    /// "Aydınlık" piksellerin sınır kutusu (x0, y0, x1, y1 — kapsayıcı). Katmanın hangi
    /// piksellere oturduğunun içerikten BAĞIMSIZ ölçüsüdür: iki render'ın kutusu eşitse
    /// geometri birebir aynıdır.
    /// </summary>
    private static (int X0, int Y0, int X1, int Y1) LitBoundingBox(byte[] rgb)
    {
        int x0 = CanvasWidth, y0 = CanvasHeight, x1 = -1, y1 = -1;
        for (var y = 0; y < CanvasHeight; y++)
        {
            for (var x = 0; x < CanvasWidth; x++)
            {
                var offset = ((y * CanvasWidth) + x) * 3;
                if (Math.Max(rgb[offset], Math.Max(rgb[offset + 1], rgb[offset + 2])) <= 32)
                {
                    continue;
                }

                x0 = Math.Min(x0, x);
                y0 = Math.Min(y0, y);
                x1 = Math.Max(x1, x);
                y1 = Math.Max(y1, y);
            }
        }

        return (x0, y0, x1, y1);
    }

    /// <summary>
    /// Verilen SATIRDA düz renk katmanın SON sütunu. Eşik, katman renginin (yaklaşık) YARISIDIR:
    /// encode'un (4:2:0 + DCT) sınırın bir piksel ötesine bıraktığı zayıf sızıntı bu eşiğin
    /// altında kalır, sınırın içindeki (kısmen bulanıklaşmış) gerçek kenar üstünde. Kenarın
    /// MUTLAK piksel konumu iddia edilecekse bu ölçüm kullanılmalıdır — <see cref="LitBoundingBox"/>
    /// tüm kareyi taradığı için herhangi bir satırdaki sızıntıyı kenar sanar.
    /// </summary>
    private static int LastSolidColumn(byte[] rgb, int row)
    {
        var threshold = SolidLayerRgb[0] / 2;
        for (var x = CanvasWidth - 1; x >= 0; x--)
        {
            if (rgb[((row * CanvasWidth) + x) * 3] > threshold)
            {
                return x;
            }
        }

        return -1;
    }

    /// <summary>Sütundaki ilk aydınlık satır (üst kenarın piksel konumu).</summary>
    private static int FirstLitRow(byte[] rgb, int column, int fromRow = 0)
    {
        for (var y = fromRow; y < CanvasHeight; y++)
        {
            var offset = ((y * CanvasWidth) + column) * 3;
            if (Math.Max(rgb[offset], Math.Max(rgb[offset + 1], rgb[offset + 2])) > 32)
            {
                return y;
            }
        }

        return -1;
    }

    /// <summary>Pikselin düz renk katmandan AÇIKÇA farklı olduğunu doğrular (kenar dışı / alt katman).</summary>
    private static void AssertNotSolidLayer(byte[] rgb, int x, int y, string what)
    {
        var offset = ((y * CanvasWidth) + x) * 3;
        var maxDiff = Math.Max(
            Math.Abs(rgb[offset] - SolidLayerRgb[0]),
            Math.Max(
                Math.Abs(rgb[offset + 1] - SolidLayerRgb[1]),
                Math.Abs(rgb[offset + 2] - SolidLayerRgb[2])));
        Assert.True(maxDiff > DistinctThreshold,
            $"({x},{y}) {what}: düz renk katmandan ayırt edilemedi "
            + $"(ölçülen ({rgb[offset]},{rgb[offset + 1]},{rgb[offset + 2]}), fark {maxDiff})");
    }

    /// <summary>Golden PNG karşılaştırması; golden yoksa üretilir (ilk koşu).</summary>
    private void CompareWithGolden(string videoPath, int frameIndex, string name)
    {
        Directory.CreateDirectory(GoldenDir);
        var framePath = Path.Combine(_outDir, name + "-cmp.png");
        ExtractFrame(videoPath, frameIndex, framePath);

        var goldenPath = Path.Combine(GoldenDir, name + ".png");
        if (!File.Exists(goldenPath))
        {
            File.Copy(framePath, goldenPath);
            Console.WriteLine($"golden üretildi: {name}");
            return;
        }

        var mse = Mse(DecodeRgb24(framePath), DecodeRgb24(goldenPath));
        Assert.True(mse <= MseThreshold,
            $"frame {frameIndex} ({name}) deviates from golden: MSE {mse:F2} > {MseThreshold}");
    }

    /// <summary>ffmpeg volumedetect'ten max_volume (dBFS). Sessiz akışta ffmpeg -91.0 döndürür.</summary>
    private double MaxVolumeDb(string mediaPath)
    {
        var stderr = RunFfmpegCapturingStderr([
            "-hide_banner", "-i", mediaPath, "-af", "volumedetect", "-f", "null", "-",
        ]);
        var marker = stderr.LastIndexOf("max_volume:", StringComparison.Ordinal);
        Assert.True(marker >= 0, $"volumedetect çıktısı okunamadı:\n{stderr}");
        var tail = stderr[(marker + "max_volume:".Length)..].TrimStart();
        var token = tail.Split(' ')[0];
        return double.Parse(token, System.Globalization.CultureInfo.InvariantCulture);
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

    private void RunFfmpeg(string[] args) => RunFfmpegCapturingStderr(args);

    private string RunFfmpegCapturingStderr(string[] args)
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

        return stderr;
    }
}
