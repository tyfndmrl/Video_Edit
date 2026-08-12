using System.Diagnostics;
using System.Globalization;
using System.Text;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media;
using VideoEdit.Media.Export;
using VideoEdit.Media.Probing;
using MediaEasing = VideoEdit.Media.Easing;
using MediaKeyframe = VideoEdit.Media.Keyframe;

namespace VideoEdit.UnitTests;

/// <summary>
/// M5'in GERÇEK RENDER kanıtları (rendering-semantics §9 golden-frame protokolü): HIZ,
/// RENK DÜZELTME (§4.1), LUT (§4.2) ve KEYFRAME animasyonları (§3) sabit fixture'lardan
/// derlenip GERÇEK ffmpeg ile render edilir, sonra çıktı karelerinden piksel/süre okunur.
/// Snapshot testi bu sınıf hataları GÖREMEZ:
///  - <c>setpts=PTS/k</c>'nin ardından ikinci <c>fps</c> ızgarası olmasa da script geçerli
///    görünür, ama çıktı süresi/kare sayısı kayar;
///  - <c>sendcmd</c>'in komutu HANGİ kareye uyguladığı ancak koşturarak bilinir (komut
///    katman zincirine takılsaydı framesync tamponu kadar kayardı);
///  - <c>lutrgb</c>/<c>colorchannelmixer</c> ifadelerinin ffmpeg eval'de ayrıştırılıp
///    ayrıştırılmadığı ve sonucun §4.1 formülünü verip vermediği;
///  - <c>scale eval=frame</c> ile kare kare değişen katman boyutunun overlay/rotate
///    zincirini yeniden yapılandırıp yapılandıramadığı.
/// </summary>
[Collection("ffmpeg-media")]
public sealed class ExportM5GoldenTests : IDisposable
{
    private const int CanvasWidth = 320;
    private const int CanvasHeight = 240;

    /// <summary>Merdiven kaynağının 8 basamağı — 0.5 sn'de bir renk değişir (4 sn toplam).</summary>
    private static readonly string[] StaircaseColors =
        ["0x804020", "0x2080C0", "0xC02080", "0x20C080", "0x8040C0", "0xC08020", "0x2040C0", "0x40C020"];

    private readonly FfmpegOptions _options = new();
    private readonly string _dir = Directory.CreateTempSubdirectory("videoedit-m5-").FullName;
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

    // ───────────────────────── HIZ (tasarım 04 §2.4) ─────────────────────────

    [FfmpegFact]
    public async Task Speed_ProducesTheContractDuration_FrameCount_AndTheRightSourceFrame()
    {
        // Süre sözleşmesi §1.3: timelineDurationUs = roundHalfUp((out-in)/rate).
        // İDDİA KENDİ KENDİNİ KALİBRE EDER: aynı kaynak önce rate=1 ile render edilir
        // (referans), sonra hızlı/yavaş sürümlerin her karesi referansın BEKLENEN karesiyle
        // karşılaştırılır. Renk sabiti yoktur — sadece "hangi kaynak karesi hangi çıktı
        // karesinde" sorusu ölçülür, ki hızın TANIMI budur.
        var source = StaircaseSource();
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(source, true, "bt709", "bt709"),
        };

        // Referans: rate = 1, kaynak [0,4) → 4 sn, 120 kare.
        var reference = await RenderAsync(
            ExportCompiler.Compile(
                SpeedDoc(0, 4_000_000, 1), sources, ExportProfile.Hd1080p), "speed-ref");
        await AssertStreamAsync(reference, 4_000_000, 120);

        // 2x: kaynak [0,4) → 2 sn, 60 kare. Çıktı karesi n = referansın 2n. karesi.
        var fast = await RenderAsync(
            ExportCompiler.Compile(
                SpeedDoc(0, 4_000_000, 2), sources, ExportProfile.Hd1080p), "speed-2x");
        await AssertStreamAsync(fast, 2_000_000, 60);
        foreach (var n in (int[])[4, 10, 20, 40, 55])
        {
            AssertSameFrame(fast, n, reference, 2 * n, "2x");
        }

        // 0.5x: kaynak [0,1) → 2 sn, 60 kare. Çıktı karesi n = referansın floor(n/2). karesi.
        var half = await RenderAsync(
            ExportCompiler.Compile(
                SpeedDoc(0, 1_000_000, 0.5), sources, ExportProfile.Hd1080p), "speed-05x");
        await AssertStreamAsync(half, 2_000_000, 60);
        foreach (var n in (int[])[6, 20, 36, 50])
        {
            AssertSameFrame(half, n, reference, n / 2, "0.5x");
        }

        // 0.25x: kaynak [0,1) → 4 sn, 120 kare. atempo KATLAMASI (0.5 × 0.5) burada koşar.
        var quarter = await RenderAsync(
            ExportCompiler.Compile(
                SpeedDoc(0, 1_000_000, 0.25), sources, ExportProfile.Hd1080p), "speed-025x");
        await AssertStreamAsync(quarter, 4_000_000, 120);
        foreach (var n in (int[])[8, 40, 80, 100])
        {
            AssertSameFrame(quarter, n, reference, n / 4, "0.25x");
        }
    }

    [FfmpegFact]
    public async Task Speed_KeepsAudioAudible_ThroughTheAtempoChain()
    {
        // atempo katlaması (0.25 → 0.5,0.5) sesi SUSTURMAMALI ve süre videoyla aynı kalmalı.
        var source = StaircaseSource();
        var compiled = ExportCompiler.Compile(
            SpeedDoc(0, 1_000_000, 0.25),
            new Dictionary<Guid, ExportAssetSource>
            {
                [ExportTestDocs.AssetA] = new(source, true, "bt709", "bt709"),
            },
            ExportProfile.Hd1080p);
        Assert.Contains("atempo=0.5,atempo=0.5", compiled.FilterGraphScript);

        var output = await RenderAsync(compiled, "speed-audio");
        var probe = await new FfprobeService(_options).ProbeAsync(output);
        Assert.True(probe.HasAudio);
        foreach (var at in (double[])[0.2, 1.5, 3.0])
        {
            Assert.True(MaxVolumeDb(output, at, 0.2) > -25d,
                $"{at.ToString(CultureInfo.InvariantCulture)} sn'de ses duyulmalı (atempo zinciri çukur açtı)");
        }
    }

    [FfmpegFact]
    public async Task Speed_PutsAudioOnTheTimeline_MeasuredStreamLengthAndBurstPositions()
    {
        // GERÇEK ÖLÇÜM (görev sözleşmesi): kapılanmış BURST kaynağı + patlama konumu tespiti.
        // İki AYRI iddia ölçülür ve İKİSİ DE daha önce ölçülmüyordu:
        //  (a) SES AKIŞININ uzunluğu (ffprobe -select_streams a:0) sözleşme süresine eşit mi —
        //      kapsayıcı süresi VİDEODAN gelir ve ses akışının kısalığını GİZLER;
        //  (b) her patlamanın çıktı zamanı beklenen yerde mi — atempo (WSOLA) akışın başından
        //      sabit bir pay yutuyor ve sesi timeline'da ERKENE kaydırıyordu.
        // Ölçüm enerji-ağırlıklı patlama MERKEZİdir: eşik tabanlı onset tespiti WSOLA'nın atak
        // yaymasından etkilenir ve gerçekte olduğundan BÜYÜK sapma raporlar, merkez etkilenmez.
        var source = BurstAudioSource();
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(source, true, "bt709", "bt709"),
        };

        // Sözleşmenin sapma tavanı: BİR ÇIKIŞ KARESİ (30 fps → 33.33 ms).
        const double FrameSec = 1 / 30d;

        (double Rate, long SourceOutUs)[] cases =
            [(2d, 4_000_000), (4d, 4_000_000), (0.5d, 2_000_000), (0.25d, 1_000_000)];
        foreach (var (rate, sourceOutUs) in cases)
        {
            var name = "burst-" + rate.ToString("0.##", CultureInfo.InvariantCulture);
            var compiled = ExportCompiler.Compile(
                SpeedDoc(0, sourceOutUs, rate), sources, ExportProfile.Hd1080p);
            var output = await RenderAsync(compiled, name);
            var expectedSec = compiled.ExpectedDurationUs / 1_000_000d;

            // (a) apad + atrim=end kilidi olmadan atempo zinciri burada rate 0.25'te 160 ms
            //     (≈5 kare) EKSİK ses akışı üretiyordu.
            var audioSec = AudioStreamDurationSec(output);
            Assert.True(Math.Abs(audioSec - expectedSec) <= FrameSec,
                $"rate {rate.ToString(CultureInfo.InvariantCulture)}: ses AKIŞI "
                + $"{audioSec.ToString("0.####", CultureInfo.InvariantCulture)} sn, sözleşme "
                + $"{expectedSec.ToString("0.####", CultureInfo.InvariantCulture)} sn "
                + "(fark bir çıkış karesini aşıyor)");

            // (b) Patlama konumları: kaynakta 0.5 sn'de bir, merkezleri 0.25 + 0.5k.
            var pcm = DecodeMonoPcm(output, name);
            for (var k = 0; (0.25 + (0.5 * k)) < sourceOutUs / 1_000_000d; k++)
            {
                var sourceCentre = 0.25 + (0.5 * k);
                var expected = sourceCentre / rate;
                var measured = BurstCentreSec(pcm, expected, 0.20 / rate);
                Assert.True(Math.Abs(measured - expected) <= FrameSec,
                    $"rate {rate.ToString(CultureInfo.InvariantCulture)}: kaynağın "
                    + $"{sourceCentre.ToString("0.###", CultureInfo.InvariantCulture)} sn'deki patlaması "
                    + $"{expected.ToString("0.####", CultureInfo.InvariantCulture)} sn'de olmalı, "
                    + $"{measured.ToString("0.####", CultureInfo.InvariantCulture)} sn ölçüldü "
                    + $"({((measured - expected) * 1000).ToString("+0.0;-0.0", CultureInfo.InvariantCulture)} ms)");
            }
        }
    }

    // ───────────────────── SES SEVİYESİ KEYFRAME'İ (§8.1 + §3.4) ─────────────────────

    [FfmpegFact]
    public async Task VolumeKeyframes_DriveTheRenderedGainCurve_AtTheRightTimes()
    {
        // §8.1: volume LİNEER genlik çarpanıdır ve §3.4 kuralıyla proje fps'inde örneklenir.
        // İDDİA KENDİ KENDİNİ KALİBRE EDER: aynı doküman önce SABİT volume ile render edilir
        // (taban), sonra keyframe'li sürümün aynı zaman penceresindeki tepe genliği tabana
        // ORANLANIR — kaynak genliği, AAC kodlaması ve alimiter denklemin dışında kalır.
        var source = ToneSource();
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(source, true, "bt709", "bt709"),
        };

        var flat = DecodeMonoPcm(
            await RenderAsync(
                ExportCompiler.Compile(VolumeDoc(null), sources, ExportProfile.Hd1080p), "vol-flat"),
            "vol-flat");

        // "V" eğrisi: 1 → 0 (2 sn) → 1 (4 sn). Tam ortadaki SIFIR, komutun DOĞRU ZAMANA
        // düştüğünün en sert kanıtıdır — eksen kaysaydı dip de kayardı.
        var compiled = ExportCompiler.Compile(
            VolumeDoc(
            [
                ExportTestDocs.Kf(0, 1),
                ExportTestDocs.Kf(2_000_000, 0),
                ExportTestDocs.Kf(4_000_000, 1),
            ]), sources, ExportProfile.Hd1080p);
        // Ses zincirinde komut filtresi ASENDCMD'dir: 'sendcmd' (video tipi) grafiği
        // "Media type mismatch" ile kurulmadan düşürürdü.
        Assert.Contains("asendcmd=c='", compiled.FilterGraphScript);
        Assert.Contains("volume@v0s0=1", compiled.FilterGraphScript);
        var curved = DecodeMonoPcm(await RenderAsync(compiled, "vol-curve"), "vol-curve");

        // Tolerans BEYANI: ffmpeg ses zincirinde komutlar SES KARESİ sınırında (1024 örnek =
        // 21.3 ms @48 kHz) uygulanır, §3.4 örneği ise proje karesindedir (33.3 ms). İkisinin
        // birleşimi eğriyi ZAMANDA en fazla ~50 ms geciktirir; bu eğimde (0.5/sn) 0.025'lik
        // gain payına karşılık gelir. AAC payıyla birlikte tavan 0.04 alınmıştır.
        foreach (var at in (double[])[0.5, 1.0, 1.5, 2.5, 3.0, 3.5])
        {
            var expected = at <= 2 ? (2 - at) / 2 : (at - 2) / 2;
            var reference = WindowRms(flat, at, 0.005);
            Assert.True(reference > 0.05, "taban render'da bu pencerede ses yok — fixture bozuk");
            var ratio = WindowRms(curved, at, 0.005) / reference;
            Assert.True(Math.Abs(ratio - expected) <= 0.04,
                $"{at.ToString(CultureInfo.InvariantCulture)} sn: §3.3 lineer interpolasyon "
                + $"{expected.ToString("0.###", CultureInfo.InvariantCulture)} diyor, "
                + $"ölçülen oran {ratio.ToString("0.###", CultureInfo.InvariantCulture)}");
        }

        // Eğrinin dibi: 2.000 sn'de gain 0 → pencere pratikte SESSİZ olmalı.
        Assert.True(WindowRms(curved, 2.0, 0.005) / WindowRms(flat, 2.0, 0.005) < 0.04,
            "2 sn'deki sıfır keyframe'i sesi kısmadı (komut yanlış zamana düştü)");
    }

    // ───────────────────────── RENK DÜZELTME (§4.1) ─────────────────────────

    [FfmpegFact]
    public async Task ColorAdjust_MatchesTheNormativeStageFormulas_PerChannel()
    {
        // §4.1'in MATEMATİK sütunu (= GLSL sütunu = önizleme shader'ı) referanstır.
        // İddia kendi kendini kalibre eder: aynı klip önce EFEKTSİZ render edilir, ölçülen
        // taban piksele referans hattı UYGULANIR, sonra efektli render'ın aynı pikseliyle
        // karşılaştırılır. Böylece kaynak/kodek/renk-etiketi hattı denklemin dışında kalır ve
        // yalnız EFEKT AŞAMALARI ölçülür.
        var solid = SolidSource("ca-src.mp4", "0x60A0C0");
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(solid, false, "bt709", "bt709"),
        };

        var plain = await RenderRawAsync(
            ExportCompiler.Compile(EffectDoc(null), sources, ExportProfile.Hd1080p), "ca-plain");
        var baseline = PixelAt(RawFrame(plain, 15), 160, 120);

        (string Name, Effect Effect, ColorAdjustRef Params)[] cases =
        [
            ("exposure", ExportTestDocs.ColorAdjust(exposure: 0.5), new(Exposure: 0.5)),
            ("exposure-", ExportTestDocs.ColorAdjust(exposure: -0.5), new(Exposure: -0.5)),
            ("temperature", ExportTestDocs.ColorAdjust(temperature: 0.5), new(Temperature: 0.5)),
            ("tint", ExportTestDocs.ColorAdjust(tint: -0.4), new(Tint: -0.4)),
            ("contrast", ExportTestDocs.ColorAdjust(contrast: 0.5, brightness: 0.05),
                new(Contrast: 0.5, Brightness: 0.05)),
            ("saturation", ExportTestDocs.ColorAdjust(saturation: 0.6), new(Saturation: 0.6)),
            ("desaturate", ExportTestDocs.ColorAdjust(saturation: -1), new(Saturation: -1)),
            ("full", ExportTestDocs.ColorAdjust(
                    exposure: 0.3, temperature: 0.4, tint: -0.2,
                    contrast: 0.25, brightness: 0.05, saturation: 0.4),
                new(0.3, 0.4, -0.2, 0.25, 0.05, 0.4)),
        ];

        foreach (var (name, effect, parameters) in cases)
        {
            var output = await RenderRawAsync(
                ExportCompiler.Compile(EffectDoc(effect), sources, ExportProfile.Hd1080p),
                "ca-" + name);
            var actual = PixelAt(RawFrame(output, 15), 160, 120);
            var expected = parameters.Apply(baseline);
            // Tolerans 2/255: kayıpsız hatta kalan tek pay lutrgb'nin 8-bit tablo yuvarlaması
            // ve exposure'ın float→8-bit dönüşüdür (§4.1 lutrgb için ±1/255 payı verir).
            Assert.True(MaxDiff(actual, expected) <= 2,
                $"colorAdjust '{name}': §4.1 formülü {Describe(expected)} diyor, "
                + $"render {Describe(actual)} verdi (taban {Describe(baseline)})");
        }
    }

    [FfmpegFact]
    public async Task ColorAdjust_Contrast_IsCloserToTheNormativeMathThanTheEqMappingWouldBe()
    {
        // SÖZLEŞME DEFEKTİ KANITI (bkz. ColorPipeline sınıf yorumu). §4.1 tablosunun "ffmpeg
        // formülü" hücresi contrast+brightness için `eq` diyor ve gerekçe olarak "luma-afin
        // dönüşüm RGB'de aynı afin dönüşüme denktir" yazıyor. `eq` contrast'ı YALNIZ luma
        // düzlemine uygular; iki eşleme ancak R=G=B iken çakışır. Bu test ikisini AYNI kare
        // üstünde ölçer ve uygulamanın §4.1 MATEMATİK sütununa (= önizleme shader'ına) yakın
        // olduğunu, `eq` eşlemesinin ise §9.3 eşiklerini kat kat aşacağını sabitler.
        var solid = SolidSource("eq-src.mp4", "0xE0C080");
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(solid, false, "bt709", "bt709"),
        };

        var plain = await RenderRawAsync(
            ExportCompiler.Compile(EffectDoc(null), sources, ExportProfile.Hd1080p), "eq-plain");
        var baseline = PixelAt(RawFrame(plain, 15), 160, 120);
        var reference = new ColorAdjustRef(Contrast: 0.5, Brightness: 0.05).Apply(baseline);

        var compiled = ExportCompiler.Compile(
            EffectDoc(ExportTestDocs.ColorAdjust(contrast: 0.5, brightness: 0.05)),
            sources, ExportProfile.Hd1080p);
        Assert.Contains("lutrgb=r='clip((val-127.5)*1.5+127.5+12.75,0,255)'",
            compiled.FilterGraphScript);
        Assert.DoesNotContain("eq=", compiled.FilterGraphScript);
        var ours = PixelAt(RawFrame(await RenderRawAsync(compiled, "eq-ours"), 15), 160, 120);

        // §4.1'in ffmpeg sütununun BİREBİR karşılığı, aynı taban kare üstünde ölçülür.
        var eqPath = Path.Combine(_dir, "eq-doc.rgb");
        RunFfmpeg([
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-video_size", $"{CanvasWidth}x{CanvasHeight}", "-framerate", "30", "-i", plain,
            "-vf", "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv,"
                   + "format=rgba,eq=contrast=1.5:brightness=0.05,format=rgb24",
            "-f", "rawvideo", "-pix_fmt", "rgb24", eqPath,
        ]);
        var docMapping = PixelAt(RawFrame(eqPath, 15), 160, 120);

        var oursError = MaxDiff(ours, reference);
        var docError = MaxDiff(docMapping, reference);
        Assert.True(oursError <= 4,
            $"RGB eşlemesi §4.1 matematiğini vermeli: beklenen {Describe(reference)}, "
            + $"ölçülen {Describe(ours)}");
        Assert.True(docError > 15,
            "§4.1'in `eq` eşlemesi bu kareyle ÇAKIŞIYOR — sözleşme defekti raporu güncellenmeli "
            + $"(beklenen {Describe(reference)}, eq {Describe(docMapping)})");
    }

    // ───────────────────────── LUT (§4.2) ─────────────────────────

    [FfmpegFact]
    public async Task Lut3d_AppliesTheCubeFile_AndBlendsByIntensity()
    {
        // .cube dosyası R ve B kanallarını TAKAS eder → tam güçte sonuç bariz, %50'de tam
        // ortalama olmalıdır (§4.2: out = mix(orig, LUT(orig), intensity)).
        var solid = SolidSource("lut-src.mp4", "0x60A0C0");
        var cube = SwapRedBlueCube();
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(solid, false, "bt709", "bt709"),
            [LutAsset] = new(cube, false, null, null),
        };

        var plain = await RenderRawAsync(
            ExportCompiler.Compile(EffectDoc(null), sources, ExportProfile.Hd1080p), "lut-plain");
        var baseline = PixelAt(RawFrame(plain, 15), 160, 120);

        var fullCompiled = ExportCompiler.Compile(
            EffectDoc(ExportTestDocs.Lut(LutAsset)), sources, ExportProfile.Hd1080p);
        Assert.Contains("lut3d=file=", fullCompiled.FilterGraphScript);
        Assert.Contains("interp=trilinear", fullCompiled.FilterGraphScript);
        Assert.DoesNotContain("split", fullCompiled.FilterGraphScript); // intensity=1 → düz lut3d
        var full = PixelAt(RawFrame(await RenderRawAsync(fullCompiled, "lut-full"), 15), 160, 120);
        byte[] swapped = [baseline[2], baseline[1], baseline[0]];
        Assert.True(MaxDiff(full, swapped) <= 2,
            $"tam güçte LUT R/B takası vermeli: beklenen {Describe(swapped)}, ölçülen {Describe(full)}");

        var halfCompiled = ExportCompiler.Compile(
            EffectDoc(ExportTestDocs.Lut(LutAsset, 0.5)), sources, ExportProfile.Hd1080p);
        Assert.Contains("split", halfCompiled.FilterGraphScript);
        Assert.Contains("blend=all_expr='A*(1-0.5)+B*0.5'", halfCompiled.FilterGraphScript);
        var half = PixelAt(RawFrame(await RenderRawAsync(halfCompiled, "lut-half"), 15), 160, 120);
        byte[] mixed =
        [
            (byte)((baseline[0] + swapped[0]) / 2),
            (byte)((baseline[1] + swapped[1]) / 2),
            (byte)((baseline[2] + swapped[2]) / 2),
        ];
        Assert.True(MaxDiff(half, mixed) <= 2,
            $"intensity=0.5 tam ortalama olmalı: beklenen {Describe(mixed)}, ölçülen {Describe(half)}");

        // NEGATİF KONTROL — §6.1 beyanının efekt zincirinde de geçerli olduğunun kanıtı:
        // KİMLİK LUT'u efekt zincirini (format=rgba + lut3d) TAMAMEN çalıştırır ama pikseli
        // değiştirmemelidir. Efekt dönüşümü ölçekten ÖNCE yapılsaydı ffmpeg'in örtük
        // dönüştürücüsü §6.1'in BT.709 beyanını yok sayar ve bu kare tabandan ~6 kod değeri
        // sapardı (ölçüldü) — yani bu iddia, aşama sırasının regresyon bekçisidir.
        sources[LutAsset] = new ExportAssetSource(IdentityCube(), false, null, null);
        var identity = PixelAt(
            RawFrame(await RenderRawAsync(
                ExportCompiler.Compile(EffectDoc(ExportTestDocs.Lut(LutAsset)), sources,
                    ExportProfile.Hd1080p), "lut-identity"), 15), 160, 120);
        Assert.True(MaxDiff(identity, baseline) <= 2,
            $"kimlik LUT pikseli değiştirmemeli: taban {Describe(baseline)}, "
            + $"ölçülen {Describe(identity)}");
    }

    // ───────────────────────── KEYFRAME (§3, tasarım 04 §2.5) ─────────────────────────

    [FfmpegFact]
    public async Task LinearPositionKeyframes_PutTheLayerOnTheExpectedPixel_AtStartMiddleEnd()
    {
        // İfade yolu (piecewise-linear 'if' zinciri). Katman 80x60 kutuda, x normalize
        // -0.25 → +0.25 arası 2 sn'de lineer gider: P.x = 160 + x*320 → 80 → 240,
        // overlay_x = P.x - 0.5*w = P.x - 40.
        // Klip timeline'da 0.5 sn'de BAŞLAR: keyframe zamanı klip-göreli, overlay ifadesi ise
        // KOMPOZİT eksendedir (§1.4: t_composite = timelineStartUs + kf.timeUs). Klibi 0'dan
        // başlatmak bu dönüşümü ölçemezdi — kayma tam olarak timelineStart kadar olurdu.
        var top = SolidSource("kf-top.mp4", "0x20C080");
        var bottom = SolidSource("kf-base.mp4", "0x804020");
        var animated = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 500_000, 0, 2_000_000,
            transform: ExportTestDocs.Transform(scale: 0.25));
        animated.Keyframes = new KeyframeTracks
        {
            X = [ExportTestDocs.Kf(0, -0.25), ExportTestDocs.Kf(2_000_000, 0.25)],
        };
        var compiled = ExportCompiler.Compile(
            LayeredDoc(animated, bottomDurationUs: 2_500_000),
            new Dictionary<Guid, ExportAssetSource>
            {
                [ExportTestDocs.AssetA] = new(bottom, false, "bt709", "bt709"),
                [ExportTestDocs.AssetB] = new(top, false, "bt709", "bt709"),
            },
            ExportProfile.Hd1080p);
        Assert.DoesNotContain("sendcmd", compiled.FilterGraphScript);

        var output = await RenderAsync(compiled, "kf-linear");
        foreach (var frame in (int[])[15, 30, 45, 60, 74])
        {
            // §3.3 lineer interpolasyon + §2.5 adım 4: overlay_x = (160 + x(t)*320) - 0.5*80.
            var clipTimeUs = Timecode.FromFrameNumber(frame, 30, 1).Micros - 500_000;
            var x = -0.25 + (0.5 * clipTimeUs / 2_000_000d);
            var expectedLeft = (int)Math.Round(160 + (x * 320) - 40);

            var box = LayerBox(Frame(output, frame, $"kfl-f{frame}"));
            Assert.True(Math.Abs(box.X0 - expectedLeft) <= 2,
                $"frame {frame}: katmanın sol kenarı ≈{expectedLeft} olmalı, ölçülen {box}");
            Assert.True(Math.Abs(box.X1 - box.X0 - 79) <= 3,
                $"frame {frame}: katman genişliği 80 px kalmalı, ölçülen {box}");
        }

        // Klip başlamadan ÖNCE katman görünmez (enable penceresi) — animasyon ifadesi
        // pencereyi genişletmez.
        var before = LayerBox(Frame(output, 5, "kfl-f5"));
        Assert.True(before.X1 < 0, $"klip başlamadan katman görünmemeli, ölçülen {before}");
    }

    [FfmpegFact]
    public async Task EasedPositionKeyframes_FollowTheBezierCurve_FrameByFrame()
    {
        // §3.4 frame örneklemesi (karar ağacı ifadesi). Aynı iki uç, tek fark easeInOut.
        // Uçlar LİNEERLE AYNI olmalı, ORTA BÖLGE ise ölçülebilir biçimde farklı — ve fark,
        // C# Easing referansının (32 iterasyon bisection, §3.2) verdiği yerde olmalı.
        var top = SolidSource("kfe-top.mp4", "0x20C080");
        var bottom = SolidSource("kfe-base.mp4", "0x804020");
        var animated = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000,
            transform: ExportTestDocs.Transform(scale: 0.25));
        animated.Keyframes = new KeyframeTracks
        {
            X = [ExportTestDocs.Kf(0, -0.25, ExportTestDocs.EaseInOut()),
                 ExportTestDocs.Kf(2_000_000, 0.25)],
        };
        var compiled = ExportCompiler.Compile(
            LayeredDoc(animated, bottomDurationUs: 2_000_000),
            new Dictionary<Guid, ExportAssetSource>
            {
                [ExportTestDocs.AssetA] = new(bottom, false, "bt709", "bt709"),
                [ExportTestDocs.AssetB] = new(top, false, "bt709", "bt709"),
            },
            ExportProfile.Hd1080p);
        Assert.DoesNotContain("sendcmd", compiled.FilterGraphScript);
        Assert.Contains("overlay=x='if(lt(t,", compiled.FilterGraphScript);

        var output = await RenderAsync(compiled, "kf-eased");
        foreach (var frame in (int[])[0, 15, 30, 45, 59])
        {
            // §3.2/§3.3'ün C# referansı — önizleme ile AYNI fonksiyon ailesi.
            var timeUs = Timecode.FromFrameNumber(frame, 30, 1).Micros;
            var eased = MediaEasing.SampleKeyframes(
            [
                new MediaKeyframe(0, -0.25, EasingValue.EaseInOut),
                new MediaKeyframe(2_000_000, 0.25, EasingValue.Linear),
            ], timeUs);
            var expectedLeft = (int)Math.Round(160 + (eased * 320) - 40);

            var box = LayerBox(Frame(output, frame, $"kfe-f{frame}"));
            Assert.True(Math.Abs(box.X0 - expectedLeft) <= 2,
                $"frame {frame}: easeInOut eğrisi sol kenarı ≈{expectedLeft} demeli, ölçülen {box}");
        }

        // Negatif kontrol: aynı frame'de LİNEER konum belirgin şekilde FARKLIDIR — yani test
        // "hep aynı yere koy" hatasını da yakalar (frame 15'te lineer 128, easeInOut ≈ 88).
        var quarterBox = LayerBox(Frame(output, 15, "kfe-f15"));
        Assert.True(Math.Abs(quarterBox.X0 - 128) > 20,
            $"frame 15 lineer konuma (128) düştü — easing uygulanmamış olabilir ({quarterBox})");
    }

    [FfmpegFact]
    public async Task OpacityKeyframes_MapZeroToOneOntoTheFadeFilter()
    {
        // tasarım 04 §2.5 madde 1. 0→1 lineer opaklık = fade=t=in:alpha=1. Ölçüm: alt katman
        // TAM KAPLAYAN düz renk, üst katman düz renk → ara karede tam ortalama beklenir.
        var top = SolidSource("op-top.mp4", "0x20C080");
        var bottom = SolidSource("op-base.mp4", "0x804020");
        var animated = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5));
        animated.Keyframes = new KeyframeTracks
        {
            Opacity = [ExportTestDocs.Kf(0, 0), ExportTestDocs.Kf(2_000_000, 1)],
        };
        var compiled = ExportCompiler.Compile(
            LayeredDoc(animated, bottomDurationUs: 2_000_000),
            new Dictionary<Guid, ExportAssetSource>
            {
                [ExportTestDocs.AssetA] = new(bottom, false, "bt709", "bt709"),
                [ExportTestDocs.AssetB] = new(top, false, "bt709", "bt709"),
            },
            ExportProfile.Hd1080p);
        Assert.Contains("fade=t=in:st=0.000000:d=2.000000:alpha=1", compiled.FilterGraphScript);
        Assert.DoesNotContain("sendcmd", compiled.FilterGraphScript);

        var output = await RenderAsync(compiled, "kf-opacity");
        var baseColor = PixelAt(Frame(output, 1, "op-f1"), 160, 120);
        var mid = PixelAt(Frame(output, 30, "op-f30"), 160, 120);
        var end = PixelAt(Frame(output, 59, "op-f59"), 160, 120);
        var corner = PixelAt(Frame(output, 59, "op-f59"), 10, 10); // katman dışı = alt katman

        // t≈0: katman görünmez (merkez bile alt katmanın rengi).
        Assert.True(MaxDiff(baseColor, corner) <= 12,
            $"başlangıçta katman şeffaf olmalı: merkez {Describe(baseColor)}, köşe {Describe(corner)}");
        // t=1 sn (yarı yol): merkez alt ve üst rengin ~yarısı.
        byte[] halfway =
        [
            (byte)((corner[0] + end[0]) / 2),
            (byte)((corner[1] + end[1]) / 2),
            (byte)((corner[2] + end[2]) / 2),
        ];
        Assert.True(MaxDiff(mid, halfway) <= 14,
            $"yarı yolda %50 karışım beklenir: {Describe(halfway)}, ölçülen {Describe(mid)}");
        Assert.True(MaxDiff(end, corner) > 30, "sonda katman OPAK olmalı (alt katmandan farklı)");
    }

    [FfmpegFact]
    public async Task AnimatedScale_GrowsTheLayerFrameByFrame()
    {
        // scale eval=frame katman boyutunu KARE KARE değiştirir; overlay'in w/h değişkenleri
        // de kare kare yeniden okunmalıdır (eval=frame). Script'e bakarak bunun çalışıp
        // çalışmadığı BİLİNEMEZ — ffmpeg boyut değişiminde filtre bağlantısını yeniden
        // yapılandırmak zorundadır; kanıt yalnız gerçek render'dır.
        var top = SolidSource("sc-top.mp4", "0x20C080");
        var bottom = SolidSource("sc-base.mp4", "0x804020");
        var animated = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000,
            transform: ExportTestDocs.Transform(scale: 0.25));
        animated.Keyframes = new KeyframeTracks
        {
            Scale = [ExportTestDocs.Kf(0, 0.25), ExportTestDocs.Kf(2_000_000, 0.75)],
        };
        var compiled = ExportCompiler.Compile(
            LayeredDoc(animated, bottomDurationUs: 2_000_000),
            new Dictionary<Guid, ExportAssetSource>
            {
                [ExportTestDocs.AssetA] = new(bottom, false, "bt709", "bt709"),
                [ExportTestDocs.AssetB] = new(top, false, "bt709", "bt709"),
            },
            ExportProfile.Hd1080p);
        Assert.Contains(":eval=frame", compiled.FilterGraphScript);

        var output = await RenderAsync(compiled, "kf-scale");
        await AssertStreamAsync(output, 2_000_000, 60);

        // Kutu 320*scale(t) genişliğinde ve MERKEZDE kalır (x/y animasyonu yok).
        foreach (var frame in (int[])[0, 30, 59])
        {
            var timeUs = Timecode.FromFrameNumber(frame, 30, 1).Micros;
            var scale = 0.25 + (0.5 * timeUs / 2_000_000d);
            var expectedWidth = (int)Math.Round(320 * scale);

            var box = LayerBox(Frame(output, frame, $"sc-f{frame}"));
            var width = box.X1 - box.X0 + 1;
            Assert.True(Math.Abs(width - expectedWidth) <= 4,
                $"frame {frame}: katman genişliği ≈{expectedWidth} olmalı, ölçülen {width} ({box})");
            Assert.True(Math.Abs(((box.X0 + box.X1) / 2) - 160) <= 2,
                $"frame {frame}: katman merkezde kalmalı, ölçülen {box}");
        }
    }

    [FfmpegFact]
    public async Task AnimatedRotation_TurnsTheLayer_WithoutMovingItsCentre()
    {
        // Dönme animasyonu ölçek SABİTKEN güvenlidir: giriş boyutu değişmediği için rotate'in
        // ow=hypot(iw,ih) tuvali de sabittir. 45°'de 160x120 kutunun sınır kutusu
        // 160*cos45 + 120*sin45 ≈ 198 px'e açılır.
        var top = SolidSource("ro-top.mp4", "0x20C080");
        var bottom = SolidSource("ro-base.mp4", "0x804020");
        var animated = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5));
        animated.Keyframes = new KeyframeTracks
        {
            RotationDeg = [ExportTestDocs.Kf(0, 0), ExportTestDocs.Kf(2_000_000, 45)],
        };
        var compiled = ExportCompiler.Compile(
            LayeredDoc(animated, bottomDurationUs: 2_000_000),
            new Dictionary<Guid, ExportAssetSource>
            {
                [ExportTestDocs.AssetA] = new(bottom, false, "bt709", "bt709"),
                [ExportTestDocs.AssetB] = new(top, false, "bt709", "bt709"),
            },
            ExportProfile.Hd1080p);
        Assert.Contains("rotate=a='if(lt(t,", compiled.FilterGraphScript);

        var output = await RenderAsync(compiled, "kf-rotate");
        AssertRotation(output, "ro-lin", linear: true);

        // Dönme ÇAPA (merkez) etrafındadır: kutu merkezi hiç kaymaz.
        var last = LayerBox(Frame(output, 59, "ro-lin-f59"));
        Assert.True(Math.Abs(((last.X0 + last.X1) / 2) - 160) <= 3
                    && Math.Abs(((last.Y0 + last.Y1) / 2) - 120) <= 3,
            $"dönme katmanı kaydırdı: {last}");

        // EĞRİLİ dönme aynı filtreye KARAR AĞACI ifadesi olarak girer (§3.4 frame örneklemesi);
        // beklenen açı §3.2'nin C# referansından (32 iterasyon bisection) gelir.
        animated.Keyframes = new KeyframeTracks
        {
            RotationDeg = [ExportTestDocs.Kf(0, 0, ExportTestDocs.EaseInOut()),
                           ExportTestDocs.Kf(2_000_000, 45)],
        };
        var easedCompiled = ExportCompiler.Compile(
            LayeredDoc(animated, bottomDurationUs: 2_000_000),
            new Dictionary<Guid, ExportAssetSource>
            {
                [ExportTestDocs.AssetA] = new(bottom, false, "bt709", "bt709"),
                [ExportTestDocs.AssetB] = new(top, false, "bt709", "bt709"),
            },
            ExportProfile.Hd1080p);
        Assert.Contains("rotate=a='if(lt(t,", easedCompiled.FilterGraphScript);
        AssertRotation(await RenderAsync(easedCompiled, "kf-rotate-eased"), "ro-eas", linear: false);
    }

    /// <summary>
    /// 160x120 kutunun θ açısındaki sınır kutusu genişliği <c>160·cosθ + 120·sinθ</c>'dır.
    /// Açı, lineer interpolasyondan ya da §3.2'nin C# easing referansından hesaplanır — yani
    /// iddia "büyüdü mü" değil, "TAM OLARAK bu açıda mı" sorusunu ölçer.
    /// </summary>
    private void AssertRotation(string output, string name, bool linear)
    {
        foreach (var frame in (int[])[0, 15, 30, 59])
        {
            var timeUs = Timecode.FromFrameNumber(frame, 30, 1).Micros;
            var degrees = linear
                ? 45d * timeUs / 2_000_000d
                : MediaEasing.SampleKeyframes(
                [
                    new MediaKeyframe(0, 0, EasingValue.EaseInOut),
                    new MediaKeyframe(2_000_000, 45, EasingValue.Linear),
                ], timeUs);
            var radians = degrees * Math.PI / 180d;
            var expected = (160 * Math.Cos(radians)) + (120 * Math.Sin(radians));

            var box = LayerBox(Frame(output, frame, $"{name}-f{frame}"));
            var width = box.X1 - box.X0 + 1;
            Assert.True(Math.Abs(width - expected) <= 4,
                $"{name} frame {frame}: {degrees:0.##}° için sınır kutusu ≈{expected:0.#} px "
                + $"olmalı, ölçülen {width} ({box})");
        }
    }

    [FfmpegFact]
    public void AnimatedScaleWithRotation_IsRejectedWithATypedError()
    {
        // NEGATİF KONTROL (M5 ölçümü): rotate ÇIKIŞ TUVALİNİ config anında bir kez kurar ve
        // giriş büyüdüğünde yeniden yapılandırmaz — ölçek animasyonuyla birlikte katmanı
        // SESSİZCE KIRPARDI (ölçüldü: 240x180 içerik 100x100 tuvalde kalıyor, ow/oh'yi sabit
        // sayı vermek de düzeltmiyor). Sessiz kırpma yerine tipli hata.
        var animated = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000,
            transform: ExportTestDocs.Transform(scale: 0.25, rotationDeg: 20));
        animated.Keyframes = new KeyframeTracks
        {
            Scale = [ExportTestDocs.Kf(0, 0.25), ExportTestDocs.Kf(2_000_000, 0.75)],
        };

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(
            LayeredDoc(animated, bottomDurationUs: 2_000_000)));
        Assert.Equal("scale-keyframes-with-rotation", ex.Feature);
    }

    // ───────────────────────── Fixture / render yardımcıları ─────────────────────────

    private static readonly Guid LutAsset = Guid.Parse("00000000-0000-0000-0000-0000000000d4");

    /// <summary>Tek klipli, hız değiştirilmiş doküman (tuval 320x240, 30 fps).</summary>
    private static TimelineDoc SpeedDoc(long sourceInUs, long sourceOutUs, double rate) =>
        ExportTestDocs.Doc(
            width: CanvasWidth, height: CanvasHeight,
            clips: ExportTestDocs.SpeedClip(
                ExportTestDocs.AssetA, 0, sourceInUs, sourceOutUs, rate, ExportTestDocs.Audio()));

    /// <summary>
    /// Efekt ölçüm dokümanı: efektli klip ÜST katmandır, altında ikinci bir track vardır.
    /// Gerekçe: tek katmanlı hızlı yol tüm zinciri yuv420p'de tutar, efektli yol ise RGB'ye
    /// çıkar — taban ölçümü hızlı yoldan alınsaydı iki render FARKLI renk dönüşümlerinden
    /// geçer ve ölçüm efekt yerine dönüşüm farkını görürdü (ölçüldü: exposure ×1.414 için
    /// 8 kod değeri sapma). İki track kompozisyon yolunu (§6.3 grafik başına RGB) her iki
    /// render'da da zorlar → karşılaştırma YALNIZ efekt aşamalarını ölçer.
    /// </summary>
    private static TimelineDoc EffectDoc(Effect? effect)
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000);
        clip.Effects = effect is null ? [] : [effect];
        return ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips: [clip]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000),
            ]),
        ], width: CanvasWidth, height: CanvasHeight);
    }

    /// <summary>Üstte animasyonlu katman, altta tam kaplayan taban video.</summary>
    private static TimelineDoc LayeredDoc(MediaClip top, long bottomDurationUs) =>
        ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips: [top]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, bottomDurationUs),
            ]),
        ], width: CanvasWidth, height: CanvasHeight);

    /// <summary>
    /// 4 sn, 30 fps MERDİVEN kaynak: 0.5 sn'de bir renk değişir (8 basamak) + 440 Hz sinüs.
    /// Hız testinin "hangi kaynak karesi hangi çıktı karesinde" sorusunu piksel düzeyinde
    /// yanıtlayabilmesi için kare içeriği ZAMANA göre AYRIŞMALIDIR.
    /// </summary>
    private string StaircaseSource()
    {
        var path = Path.Combine(_dir, "staircase.mp4");
        if (File.Exists(path))
        {
            return path;
        }

        var args = new List<string> { "-y" };
        foreach (var color in StaircaseColors)
        {
            args.AddRange(["-f", "lavfi", "-i", $"color=c={color}:size={CanvasWidth}x{CanvasHeight}:rate=30:duration=0.5"]);
        }

        args.AddRange(["-f", "lavfi", "-i", "sine=frequency=440:duration=4"]);
        var concat = new StringBuilder();
        for (var i = 0; i < StaircaseColors.Length; i++)
        {
            concat.Append(CultureInfo.InvariantCulture, $"[{i}:v]");
        }

        concat.Append(CultureInfo.InvariantCulture, $"concat=n={StaircaseColors.Length}:v=1:a=0[v]");
        args.AddRange([
            "-filter_complex", concat.ToString(),
            "-map", "[v]", "-map", $"{StaircaseColors.Length}:a",
            "-af", "volume=5",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "10",
            "-c:a", "aac", "-ar", "48000", "-shortest", path,
        ]);
        RunFfmpeg([.. args]);
        return path;
    }

    /// <summary>
    /// Tek klipli SES SEVİYESİ dokümanı: 2 sn video + gömülü ses. <paramref name="keyframes"/>
    /// null ise sabit volume (taban render), doluysa §8.1 keyframe eğrisi.
    /// </summary>
    private static TimelineDoc VolumeDoc(
        IReadOnlyList<VideoEdit.Contracts.Timeline.Keyframe>? keyframes)
    {
        var clip = ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 4_000_000, ExportTestDocs.Audio());
        if (keyframes is not null)
        {
            clip.Keyframes = new KeyframeTracks { Volume = [.. keyframes] };
        }

        return ExportTestDocs.MultiTrackDoc(
            [ExportTestDocs.VideoTrack(clips: [clip])],
            width: CanvasWidth, height: CanvasHeight);
    }

    /// <summary>
    /// 4 sn, 30 fps video + KAPILANMIŞ BURST sesi: 0.5 sn'de bir 100 ms'lik 1 kHz patlama,
    /// merkezleri 0.25 + 0.5k. Aradaki mutlak sessizlik sayesinde her patlamanın enerji
    /// merkezi tek başına ölçülebilir → "ses timeline'da nereye düştü" sorusu doğrudan
    /// yanıtlanır (sürekli sinüs bu soruyu SORAMAZ, eski test bu yüzden defekti göremedi).
    /// </summary>
    private string BurstAudioSource()
    {
        var path = Path.Combine(_dir, "bursts.mp4");
        if (File.Exists(path))
        {
            return path;
        }

        RunFfmpeg([
            "-y",
            "-f", "lavfi", "-i", $"testsrc2=duration=4:size={CanvasWidth}x{CanvasHeight}:rate=30",
            "-f", "lavfi",
            "-i", "aevalsrc=exprs='0.8*sin(2*PI*1000*t)*between(mod(t\\,0.5)\\,0.2\\,0.3)'"
                  + ":d=4:s=48000:c=stereo",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            "-c:a", "aac", "-ar", "48000", "-shortest", path,
        ]);
        return path;
    }

    /// <summary>4 sn, 30 fps video + SABİT genlikli 1 kHz ton (ses seviyesi eğrisi ölçümü).</summary>
    private string ToneSource()
    {
        var path = Path.Combine(_dir, "tone.mp4");
        if (File.Exists(path))
        {
            return path;
        }

        RunFfmpeg([
            "-y",
            "-f", "lavfi", "-i", $"testsrc2=duration=4:size={CanvasWidth}x{CanvasHeight}:rate=30",
            // Genlik 0.5: alimiter=0.98 tavanına DEĞMEZ, yani ölçülen oran yalnız volume'dur.
            "-f", "lavfi", "-i", "aevalsrc=exprs='0.5*sin(2*PI*1000*t)':d=4:s=48000:c=stereo",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            "-c:a", "aac", "-ar", "48000", "-shortest", path,
        ]);
        return path;
    }

    // ───────────────────────── Ses ölçüm yardımcıları ─────────────────────────

    /// <summary>SES AKIŞININ kendi süresi (saniye) — kapsayıcı/video süresi DEĞİL.</summary>
    private static double AudioStreamDurationSec(string mediaPath)
    {
        using var json = FfprobeJson.Run(
            "-select_streams", "a:0", "-show_entries", "stream=duration", mediaPath);
        var streams = json.RootElement.GetProperty("streams");
        Assert.True(streams.GetArrayLength() > 0, $"{mediaPath}: ses akışı yok");
        return double.Parse(
            streams[0].GetProperty("duration").GetString()!, CultureInfo.InvariantCulture);
    }

    /// <summary>Çıktının sol kanalı, 48 kHz float örnekler (-1..1) — edit list uygulanmış.</summary>
    private float[] DecodeMonoPcm(string mediaPath, string name)
    {
        var rawPath = Path.Combine(_dir, name + "-audio.raw");
        RunFfmpeg([
            "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-i", mediaPath, "-map", "0:a:0",
            "-f", "s16le", "-ac", "1", "-ar", "48000", rawPath,
        ]);
        var bytes = File.ReadAllBytes(rawPath);
        var samples = new float[bytes.Length / 2];
        for (var i = 0; i < samples.Length; i++)
        {
            samples[i] = BitConverter.ToInt16(bytes, i * 2) / 32768f;
        }

        return samples;
    }

    private const int AudioRate = 48000;

    /// <summary>
    /// <paramref name="centreSec"/> ± <paramref name="halfSec"/> penceresindeki ENERJİ
    /// MERKEZİ (saniye). Patlama tek başına olduğu için bu, patlamanın konumudur.
    /// </summary>
    private static double BurstCentreSec(float[] pcm, double centreSec, double halfSec)
    {
        var lo = Math.Max(0, (int)((centreSec - halfSec) * AudioRate));
        var hi = Math.Min(pcm.Length, (int)((centreSec + halfSec) * AudioRate));
        double weighted = 0, energy = 0;
        for (var i = lo; i < hi; i++)
        {
            var e = (double)pcm[i] * pcm[i];
            weighted += e * i;
            energy += e;
        }

        Assert.True(energy > 1e-6,
            $"{centreSec.ToString("0.###", CultureInfo.InvariantCulture)} sn civarında patlama "
            + "bulunamadı (ses hiç yok ya da bir pencere ötede)");
        return weighted / energy / AudioRate;
    }

    /// <summary>
    /// Pencere içindeki RMS genlik. Tepe DEĞİL: gain merdiveni pencere içinde bir basamak
    /// atlarsa tepe DAİMA yüksek basamağı seçer (yanlı), RMS ortalar. Pencere ±5 ms = 1 kHz
    /// tonun 10 çevrimidir → AAC'nin spektral gürültüsü de ortalanır.
    /// </summary>
    private static double WindowRms(float[] pcm, double centreSec, double halfSec)
    {
        var lo = Math.Max(0, (int)((centreSec - halfSec) * AudioRate));
        var hi = Math.Min(pcm.Length, (int)((centreSec + halfSec) * AudioRate));
        Assert.True(hi > lo, "ölçüm penceresi ses akışının dışında");
        double sum = 0;
        for (var i = lo; i < hi; i++)
        {
            sum += (double)pcm[i] * pcm[i];
        }

        return Math.Sqrt(sum / (hi - lo));
    }

    /// <summary>2 sn, 30 fps DÜZ RENK H.264 (sessiz).</summary>
    private string SolidSource(string name, string color)
    {
        var path = Path.Combine(_dir, name);
        if (File.Exists(path))
        {
            return path;
        }

        RunFfmpeg([
            "-y", "-f", "lavfi",
            "-i", $"color=c={color}:size={CanvasWidth}x{CanvasHeight}:rate=30:duration=2",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "10", path,
        ]);
        return path;
    }

    /// <summary>KİMLİK 2³ .cube — efekt zincirini çalıştırır ama pikseli değiştirmez.</summary>
    private string IdentityCube() => Cube("identity.cube", (r, g, b) => (r, g, b));

    /// <summary>R ve B kanallarını takas eden 2³ .cube dosyası (§4.2 formatı).</summary>
    private string SwapRedBlueCube() => Cube("swap-rb.cube", (r, g, b) => (b, g, r));

    private string Cube(string name, Func<int, int, int, (int R, int G, int B)> map)
    {
        var path = Path.Combine(_dir, name);
        if (File.Exists(path))
        {
            return path;
        }

        // .cube veri satırları R'si EN HIZLI değişecek şekilde sıralanır (format sözleşmesi).
        var text = new StringBuilder();
        text.AppendLine(CultureInfo.InvariantCulture, $"TITLE \"{Path.GetFileNameWithoutExtension(name)}\"");
        text.AppendLine("LUT_3D_SIZE 2");
        text.AppendLine("DOMAIN_MIN 0.0 0.0 0.0");
        text.AppendLine("DOMAIN_MAX 1.0 1.0 1.0");
        for (var b = 0; b < 2; b++)
        {
            for (var g = 0; g < 2; g++)
            {
                for (var r = 0; r < 2; r++)
                {
                    var (outR, outG, outB) = map(r, g, b);
                    text.AppendLine(CultureInfo.InvariantCulture,
                        $"{outR:0.000000} {outG:0.000000} {outB:0.000000}");
                }
            }
        }

        File.WriteAllText(path, text.ToString());
        return path;
    }

    /// <summary>
    /// Aynı DERLENMİŞ filtergraph'ı KAYIPSIZ ham RGB'ye yazar (profil encode'u yerine
    /// <c>-f rawvideo -pix_fmt rgb24</c>). Renk ölçümlerinde şart: h264/yuv420p çıkış aşaması
    /// piksel değerlerini kaydırır (ölçüldü: aynı düz renk grafiğin İÇİNDE 95, encode/decode
    /// sonrası 88) ve "efekt formülü doğru mu" sorusunu kirletir. Test edilen şey filtergraph
    /// olduğu için encode'u devre dışı bırakmak kapsamı DARALTMAZ — kodlayıcı ayarları
    /// ExportProfiles'ın kendi testlerinde sabitlenir.
    /// </summary>
    private async Task<string> RenderRawAsync(CompiledExport compiled, string name)
    {
        var scriptPath = Path.Combine(_dir, name + "-graph.txt");
        await File.WriteAllTextAsync(scriptPath, compiled.FilterGraphScript);
        var rawPath = Path.Combine(_dir, name + ".rgb");
        var args = new List<string> { "-y", "-nostdin", "-hide_banner", "-loglevel", "error" };
        foreach (var input in compiled.Inputs)
        {
            args.AddRange(input.ToArgs());
        }

        args.AddRange([
            "-filter_complex_script", scriptPath, "-map", "[vout]",
            "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath,
            // Grafik DAİMA bir [aout] tanımlar (ses yoksa anullsrc); bağlanmayan çıkış
            // ffmpeg'i "output unconnected" ile düşürür.
            "-map", "[aout]", "-f", "null", "-",
        ]);
        RunFfmpeg([.. args]);
        return rawPath;
    }

    /// <summary>Ham RGB dökümünden tek kare.</summary>
    private static byte[] RawFrame(string rawPath, int frameIndex)
    {
        var frameSize = CanvasWidth * CanvasHeight * 3;
        var data = File.ReadAllBytes(rawPath);
        Assert.True(data.Length >= (frameIndex + 1) * frameSize,
            $"ham dökümde {frameIndex}. kare yok ({data.Length / frameSize} kare var)");
        return data[(frameIndex * frameSize)..((frameIndex + 1) * frameSize)];
    }

    private async Task<string> RenderAsync(CompiledExport compiled, string name)
    {
        var scriptPath = Path.Combine(_dir, name + "-graph.txt");
        await File.WriteAllTextAsync(scriptPath, compiled.FilterGraphScript);
        var outputPath = Path.Combine(_dir, name + ".mp4");
        var result = await new FfmpegRunner(_options).RunAsync(
            compiled.ToFfmpegArgs(scriptPath, outputPath), compiled.ExpectedDurationUs);
        Assert.True(result.Success, $"{name} render failed: {result.StderrTail}");
        return outputPath;
    }

    /// <summary>Çıktının süresi ve KARE SAYISI (frame defterinin uçtan uca kanıtı).</summary>
    private async Task AssertStreamAsync(string path, long expectedDurationUs, int expectedFrames)
    {
        var probe = await new FfprobeService(_options).ProbeAsync(path);
        Assert.InRange(probe.DurationUs!.Value, expectedDurationUs - 40_000, expectedDurationUs + 40_000);

        using var json = FfprobeJson.Run("-select_streams", "v:0", "-count_frames",
            "-show_entries", "stream=nb_read_frames", path);
        var frames = int.Parse(
            json.RootElement.GetProperty("streams")[0].GetProperty("nb_read_frames").GetString()!,
            CultureInfo.InvariantCulture);
        Assert.Equal(expectedFrames, frames);
    }

    private void AssertSameFrame(
        string actualPath, int actualFrame, string referencePath, int referenceFrame, string what)
    {
        var actual = PixelAt(Frame(actualPath, actualFrame, $"{what}-a{actualFrame}"), 160, 120);
        var expected = PixelAt(
            Frame(referencePath, referenceFrame, $"{what}-r{referenceFrame}"), 160, 120);
        Assert.True(MaxDiff(actual, expected) <= 6,
            $"{what}: çıktı karesi {actualFrame}, kaynağın {referenceFrame}. karesi olmalıydı "
            + $"(beklenen {Describe(expected)}, ölçülen {Describe(actual)})");
    }

    // ───────────────────────── Piksel yardımcıları ─────────────────────────

    private byte[] Frame(string videoPath, int frameIndex, string name)
    {
        var pngPath = Path.Combine(_dir, name + ".png");
        RunFfmpeg([
            "-y", "-i", videoPath,
            "-vf", $"select=eq(n\\,{frameIndex.ToString(CultureInfo.InvariantCulture)})",
            "-frames:v", "1", pngPath,
        ]);
        return ReadRgb(pngPath, name);
    }

    private byte[] ReadRgb(string pngPath, string name)
    {
        var rawPath = Path.Combine(
            _dir, $"{name}-{_rawCounter++.ToString(CultureInfo.InvariantCulture)}.raw");
        RunFfmpeg(["-y", "-i", pngPath, "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath]);
        var rgb = File.ReadAllBytes(rawPath);
        Assert.Equal(CanvasWidth * CanvasHeight * 3, rgb.Length);
        return rgb;
    }

    private static byte[] PixelAt(byte[] rgb, int x, int y)
    {
        var offset = ((y * CanvasWidth) + x) * 3;
        return [rgb[offset], rgb[offset + 1], rgb[offset + 2]];
    }

    private static int MaxDiff(byte[] a, byte[] b) => Math.Max(
        Math.Abs(a[0] - b[0]), Math.Max(Math.Abs(a[1] - b[1]), Math.Abs(a[2] - b[2])));

    private static string Describe(byte[] rgb) =>
        $"({rgb[0].ToString(CultureInfo.InvariantCulture)},"
        + $"{rgb[1].ToString(CultureInfo.InvariantCulture)},"
        + $"{rgb[2].ToString(CultureInfo.InvariantCulture)})";

    /// <summary>
    /// Üst katmanın (yeşilimsi 0x20C080) sınır kutusu: taban katman kırmızımsıdır
    /// (0x804020), ayrım YEŞİL kanalın baskınlığından okunur — parlaklık eşiği iki düz rengi
    /// ayırmaya yetmez.
    /// </summary>
    private static (int X0, int Y0, int X1, int Y1) LayerBox(byte[] rgb)
    {
        int x0 = CanvasWidth, y0 = CanvasHeight, x1 = -1, y1 = -1;
        for (var y = 0; y < CanvasHeight; y++)
        {
            for (var x = 0; x < CanvasWidth; x++)
            {
                var offset = ((y * CanvasWidth) + x) * 3;
                if (rgb[offset + 1] <= rgb[offset] + 40)
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

    /// <summary>Belirli bir zaman penceresinin max_volume'u (dBFS) — ffmpeg volumedetect.</summary>
    private double MaxVolumeDb(string mediaPath, double startSec, double durationSec)
    {
        var stderr = RunFfmpeg([
            "-hide_banner",
            "-ss", startSec.ToString("0.###", CultureInfo.InvariantCulture),
            "-t", durationSec.ToString("0.###", CultureInfo.InvariantCulture),
            "-i", mediaPath, "-af", "volumedetect", "-f", "null", "-",
        ]);
        var marker = stderr.LastIndexOf("max_volume:", StringComparison.Ordinal);
        Assert.True(marker >= 0, $"volumedetect çıktısı okunamadı:\n{stderr}");
        var token = stderr[(marker + "max_volume:".Length)..].TrimStart().Split(' ')[0];
        return double.Parse(token, CultureInfo.InvariantCulture);
    }

    private string RunFfmpeg(string[] args)
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
        if (!process.WaitForExit(180_000) || process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"ffmpeg helper failed ({string.Join(' ', args)}): {stderr}");
        }

        return stderr;
    }

    /// <summary>
    /// §4.1 hattının TEST-İÇİ referans implementasyonu — apps/editor/.../core/colorAdjustRef.ts
    /// ile satır satır aynıdır (aşama sırası + aşama başına clamp). Compiler'ın ÜRETTİĞİ
    /// filtreleri değil, DOKÜMANIN matematiğini temsil eder: ikisi ayrışırsa test kırılır.
    /// </summary>
    private readonly record struct ColorAdjustRef(
        double Exposure = 0, double Temperature = 0, double Tint = 0,
        double Contrast = 0, double Brightness = 0, double Saturation = 0)
    {
        public byte[] Apply(byte[] rgb)
        {
            var r = rgb[0] / 255d;
            var g = rgb[1] / 255d;
            var b = rgb[2] / 255d;

            var gain = Math.Pow(2, Exposure);
            (r, g, b) = (Clamp(r * gain), Clamp(g * gain), Clamp(b * gain));

            (r, b) = (Clamp(r + (ColorPipeline.KTemp * Temperature)),
                Clamp(b - (ColorPipeline.KTemp * Temperature)));
            g = Clamp(g - (ColorPipeline.KTint * Tint));

            var c = 1 + Contrast;
            (r, g, b) = (Affine(r, c), Affine(g, c), Affine(b, c));

            var luma = (ColorPipeline.LumaR * r) + (ColorPipeline.LumaG * g) + (ColorPipeline.LumaB * b);
            var k = 1 + Saturation;
            (r, g, b) = (Clamp(luma + ((r - luma) * k)),
                Clamp(luma + ((g - luma) * k)),
                Clamp(luma + ((b - luma) * k)));

            return [Byte(r), Byte(g), Byte(b)];
        }

        private double Affine(double x, double c) => Clamp(((x - 0.5) * c) + 0.5 + Brightness);

        private static double Clamp(double x) => Math.Min(1, Math.Max(0, x));

        private static byte Byte(double x) => (byte)Math.Round(x * 255, MidpointRounding.AwayFromZero);
    }
}
