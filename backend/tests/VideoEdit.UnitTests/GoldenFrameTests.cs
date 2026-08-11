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

    // ───────────────────────── M4 dalga 1: çok katman kompozisyonu ─────────────────────────

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

        var compiled = ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p);
        Assert.Equal(2_000_000, compiled.ExpectedDurationUs);

        // Overlay zinciri taban tuvalden başlayıp sondan başa ilerler; ÜST katman EN SON biner.
        Assert.Contains("[base][v0]overlay=x=160-0.5*w:y=120-0.5*h", compiled.FilterGraphScript);
        Assert.Contains("[c0][v1]overlay=x=80-0.5*w:y=180-0.5*h", compiled.FilterGraphScript);
        Assert.Contains("[c1][v2]overlay=x=240-0.5*w:y=60-0.5*h", compiled.FilterGraphScript);
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

        var compiled = ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p);
        // Çapa merkezdeyse pad NO-OP'tur ve üretilmez; çapa köşedeyse simetrik pad üretilir.
        Assert.Contains("pad=w=iw*2:h=ih*2:x=iw*1:y=ih*1:color=#00000000", compiled.FilterGraphScript);
        Assert.Contains("rotate=a=1.570796:c=none:ow=hypot(iw\\,ih):oh=ow", compiled.FilterGraphScript);

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

    // ───────────── M4 dalga 1 denetim düzeltmeleri: kompozisyon renk modu + geometri ─────────────

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

        var aloneCompiled = ExportCompiler.Compile(alone, sources, ExportProfile.Hd1080p);
        var withTopCompiled = ExportCompiler.Compile(withTop, sources, ExportProfile.Hd1080p);

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

        var compiled = ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p);
        // İki katmanın overlay ifadesi BİREBİR aynı x'i verir (y farkı kasıtlı).
        Assert.Contains("overlay=x=241-0.5*w:y=180-0.5*h", compiled.FilterGraphScript);
        Assert.Contains("overlay=x=241-0.5*w:y=60-0.5*h", compiled.FilterGraphScript);

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

        var audibleCompiled = ExportCompiler.Compile(hiddenPlusMuted, sources, ExportProfile.Hd1080p);
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

        var silentCompiled = ExportCompiler.Compile(mutedOnly, sources, ExportProfile.Hd1080p);
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

        var compiled = ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p);
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
