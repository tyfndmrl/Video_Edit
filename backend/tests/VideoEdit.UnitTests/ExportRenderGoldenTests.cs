using System.Diagnostics;
using System.Globalization;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media;
using VideoEdit.Media.Export;
using VideoEdit.Media.Probing;

namespace VideoEdit.UnitTests;

/// <summary>
/// M4 dalga 2'nin GERÇEK RENDER kanıtları (rendering-semantics §9 golden-frame protokolü):
/// geçişler (xfade/acrossfade) ve overlay varlıkları (metin/şekil rasteri + çıkartma) sabit
/// fixture dokümanlarından derlenip GERÇEK ffmpeg ile render edilir, sonra çıktı karelerinden
/// piksel okunur. Snapshot testi bu sınıf hataları GÖREMEZ:
///  - "xfade birleşik akışın kendi zamanında offset alır" yanlış anlaşılsa script yine üretilir,
///    ama geçiş yanlış anda olur;
///  - rgba akışta xfade'in çalışıp çalışmadığı ancak ffmpeg koşarak bilinir;
///  - metin rasterinin fit=contain ile tuvale ŞİŞİRİLMESİ script'te "geçerli" görünür.
/// Kaynaklar DÜZ RENKtir: karışım oranı piksel değerinden ARİTMETİK olarak doğrulanabilsin.
/// </summary>
[Collection("ffmpeg-media")]
public sealed class ExportRenderGoldenTests(FfmpegTestMediaFixture media) : IDisposable
{
    private const int CanvasWidth = 320;
    private const int CanvasHeight = 240;

    /// <summary>Kaynak A'nın (0x804020) hattan geçtikten sonraki ölçülmüş rgb24 değeri.</summary>
    private static readonly byte[] SolidA = [132, 68, 28];

    /// <summary>Kaynak B'nin (0x2080C0) hattan geçtikten sonraki ölçülmüş rgb24 değeri.</summary>
    private static readonly byte[] SolidB = [28, 128, 194];

    /// <summary>
    /// Kaynak C'nin (0xC02080) hattan geçtikten sonraki ölçülmüş rgb24 değeri. Kaynak
    /// RGB'sinden sapar: fixture'lar renk tag'siz üretilir ve lavfi onları SD'de bt601 ile
    /// kodlar, hat ise §6.1'in NORMATİF varsayımını (untagged SDR = BT.709/tv) uygular.
    /// </summary>
    private static readonly byte[] SolidC = [202, 52, 128];

    /// <summary>Overlay rasterinin (0x20C080) hattan geçtikten sonraki ölçülmüş rgb24 değeri.</summary>
    private static readonly byte[] RasterRgb = [32, 192, 128];

    private readonly FfmpegOptions _options = new();
    private readonly string _dir = Directory.CreateTempSubdirectory("videoedit-m4w2-").FullName;
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

    // ───────────────────────── Geçişler (rendering-semantics §5) ─────────────────────────

    [FfmpegFact]
    public async Task Crossfade_BlendsBothSourcesAtTheMidpointOfTheCut()
    {
        // GÖREV 2'nin çekirdek kanıtı. Fixture: iki DÜZ RENK kaynak, timeline'da BİTİŞİK
        // (0-1.5 sn ve 1.5-3 sn), D = 400 ms (12 frame). §5.3'e göre geçiş penceresi kesimin
        // D/2 = 200 ms ÖNCESİNDE başlar, D/2 sonra biter → [1.3, 1.7] sn = frame 39..51.
        // Tam ortası (frame 45, t = 1.5 sn) %50/%50 karışımdır ve bu ARİTMETİK olarak
        // doğrulanabilir: out = (A + B) / 2.
        var (doc, sources) = TwoSolidsWithTransition(TransitionType.Crossfade);
        var compiled = ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p);

        Assert.Contains("xfade=transition=fade:duration=0.400000:offset=1.300000",
            compiled.FilterGraphScript);
        Assert.Equal(3_000_000, compiled.ExpectedDurationUs);

        var output = await RenderAsync(compiled, "crossfade");

        // Süre sözleşmesi: geçiş timeline'ı KISALTMAZ (klipler bitişik kalır, §5.1).
        var probe = await new FfprobeService(_options).ProbeAsync(output);
        Assert.InRange(probe.DurationUs!.Value, 2_900_000, 3_100_000);

        // (a) Pencere DIŞI: saf kaynaklar.
        AssertPixel(Frame(output, 15, "xf-f15"), 160, 120, SolidA, 12, "geçiş öncesi = kaynak A");
        AssertPixel(Frame(output, 75, "xf-f75"), 160, 120, SolidB, 12, "geçiş sonrası = kaynak B");

        // (b) Pencerenin TAM ORTASI: iki kaynağın yarı yarıya karışımı — hem A'dan hem B'den
        //     AÇIKÇA farklı, ve ikisinin ortalamasına YAKIN. Sadece "farklı" demek yetmez:
        //     yanlış offset de farklı bir kare verirdi; ortalamaya yakınlık karışımı kanıtlar.
        var mid = Frame(output, 45, "xf-f45");
        byte[] expectedMix =
        [
            (byte)((SolidA[0] + SolidB[0]) / 2),
            (byte)((SolidA[1] + SolidB[1]) / 2),
            (byte)((SolidA[2] + SolidB[2]) / 2),
        ];
        AssertPixel(mid, 160, 120, expectedMix, 14, "geçişin ORTASI = A ile B'nin %50 karışımı");
        AssertPixel(mid, 20, 20, expectedMix, 14, "karışım TÜM kareye uygulanır (sol üst)");
        AssertDistinct(mid, 160, 120, SolidA, "geçişin ortası kaynak A DEĞİL");
        AssertDistinct(mid, 160, 120, SolidB, "geçişin ortası kaynak B DEĞİL");

        // (c) Pencerenin KENARLARI: hemen dışı hâlâ saf kaynak (offset doğru yerde).
        AssertPixel(Frame(output, 37, "xf-f37"), 160, 120, SolidA, 14, "pencere başlamadan A saf");
        AssertPixel(Frame(output, 53, "xf-f53"), 160, 120, SolidB, 14, "pencere bittikten sonra B saf");
    }

    [FfmpegFact]
    public async Task FadeToBlack_GoesThroughBlackAtTheMidpoint()
    {
        // §5.3 tip eşlemesi: fadeToBlack → ffmpeg 'fadeblack'. Crossfade'den AYRIŞTIĞININ
        // kanıtı: ortada karışım değil SİYAH vardır (aynı fixture, tek fark tip).
        var (doc, sources) = TwoSolidsWithTransition(TransitionType.FadeToBlack);
        var compiled = ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p);
        Assert.Contains("xfade=transition=fadeblack:", compiled.FilterGraphScript);

        var mid = Frame(await RenderAsync(compiled, "fadeblack"), 45, "fb-f45");
        var pixel = PixelAt(mid, 160, 120);
        var brightness = pixel[0] + pixel[1] + pixel[2];
        // ffmpeg fadeblack, siyaha inişi smoothstep ile yumuşatır → orta kare TAM siyah değil
        // ama HER İKİ kaynaktan da çok daha karanlıktır. Crossfade'in aynı karesi ~289 parlaklık
        // verir (ölçüldü); eşik ikisini kesin ayırır.
        Assert.True(brightness <= 120,
            $"fadeToBlack'in ortası karanlık olmalı, ölçülen {Describe(pixel)} (parlaklık {brightness})");
        AssertDistinct(mid, 160, 120, SolidA, "fadeToBlack ortası kaynak A DEĞİL");
        AssertDistinct(mid, 160, 120, SolidB, "fadeToBlack ortası kaynak B DEĞİL");
    }

    [FfmpegFact]
    public async Task WipeLeft_SplitsTheFrameSpatially_UnlikeCrossfade()
    {
        // wipeLeft geçişi ZAMANDA değil MEKÂNDA ayırır: ortada karenin bir yanı A, öteki yanı
        // B'dir. Bu, tip eşlemesinin gerçekten ffmpeg'e ulaştığının (ve sabit bir 'fade'e
        // düşmediğinin) piksel kanıtıdır.
        var (doc, sources) = TwoSolidsWithTransition(TransitionType.WipeLeft);
        var mid = Frame(
            await RenderAsync(ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p), "wipeleft"),
            45, "wl-f45");

        var left = PixelAt(mid, 20, 120);
        var right = PixelAt(mid, 300, 120);
        Assert.True(MaxDiff(left, right) > 40,
            $"wipeLeft ortasında karenin iki yanı AYNI çıktı ({Describe(left)} / {Describe(right)}) — "
            + "geçiş tipi ffmpeg'e ulaşmamış olabilir");
        // Her iki yan da saf kaynaktır (karışım değil): wipe blend etmez, keser.
        Assert.True(MaxDiff(left, SolidA) <= 14 || MaxDiff(left, SolidB) <= 14,
            $"wipe'ın sol yanı saf kaynak olmalı, ölçülen {Describe(left)}");
        Assert.True(MaxDiff(right, SolidA) <= 14 || MaxDiff(right, SolidB) <= 14,
            $"wipe'ın sağ yanı saf kaynak olmalı, ölçülen {Describe(right)}");
    }

    [FfmpegFact]
    public async Task TransitionChain_KeepsEveryClipOnItsTimelinePosition()
    {
        // §5.3 kümülatif offset'in zincirdeki kanıtı: 3 klip (her biri 1.5 sn), 2 geçiş.
        // Toplam süre Σd = 4.5 sn KALIR ve her klibin ORTASI kendi saf rengindedir — offset
        // birikimi yanlış olsaydı ikinci geçiş kayar ve C'nin ortası kirlenirdi.
        var a = MediaFile("chain-a.mp4", "0x804020");
        var b = MediaFile("chain-b.mp4", "0x2080C0");
        var c = MediaFile("chain-c.mp4", "0xC02080");
        var clipA = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 500_000, 2_000_000);
        var clipB = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_500_000, 500_000, 2_000_000);
        var clipC = ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 3_000_000, 500_000, 2_000_000);
        ExportTestDocs.Link(clipA, clipB, 400_000);
        ExportTestDocs.Link(clipB, clipC, 200_000, TransitionType.Dissolve);
        var doc = ExportTestDocs.Doc(
            width: CanvasWidth, height: CanvasHeight, clips: [clipA, clipB, clipC]);

        var compiled = ExportCompiler.Compile(doc, new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(a, false, "bt709", "bt709"),
            [ExportTestDocs.AssetB] = new(b, false, "bt709", "bt709"),
            [ExportTestDocs.AssetC] = new(c, false, "bt709", "bt709"),
        }, ExportProfile.Hd1080p);
        Assert.Equal(4_500_000, compiled.ExpectedDurationUs);

        var output = await RenderAsync(compiled, "chain");
        var probe = await new FfprobeService(_options).ProbeAsync(output);
        Assert.InRange(probe.DurationUs!.Value, 4_400_000, 4_600_000);

        // Klip ortaları (frame 22 / 67 / 112 = t 0.73 / 2.23 / 3.73 sn) saf renklerdir.
        AssertPixel(Frame(output, 22, "ch-f22"), 160, 120, SolidA, 12, "A'nın ortası saf");
        AssertPixel(Frame(output, 67, "ch-f67"), 160, 120, SolidB, 12, "B'nin ortası saf");
        AssertPixel(Frame(output, 112, "ch-f112"), 160, 120, SolidC, 14, "C'nin ortası saf");

        // İkinci geçişin ortası: kesim 3.0 sn = frame 90, D = 200 ms → pencere [2.9, 3.1].
        var second = Frame(output, 90, "ch-f90");
        AssertDistinct(second, 160, 120, SolidB, "ikinci geçişin ortası B DEĞİL");
        AssertDistinct(second, 160, 120, SolidC, "ikinci geçişin ortası C DEĞİL");
    }

    [FfmpegFact]
    public async Task TransitionUnderAPipLayer_RendersThroughTheRgbaCompositionPath()
    {
        // Geçişli track ÖNCE kendi içinde birleşik akışa derlenir, SONRA üst katman
        // kompozisyonuna girer (tasarım 04 §2.3). Kompozisyon yolunda katmanlar rgba'dır —
        // "xfade rgba akışta çalışır mı" sorusunun cevabı ancak GERÇEK render'da bilinir
        // (snapshot testi göremez; ffmpeg format uyuşmazlığında patlar).
        var a = MediaFile("pip-a.mp4", "0x804020");
        var b = MediaFile("pip-b.mp4", "0x2080C0");
        var top = MediaFile("pip-top.mp4", "0xC02080");
        var clipA = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 500_000, 2_000_000);
        var clipB = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_500_000, 500_000, 2_000_000);
        ExportTestDocs.Link(clipA, clipB, 400_000);

        var doc = ExportTestDocs.MultiTrackDoc(
        [
            // ÜST: PiP, scale 0.25 → 80x60 kutu, P = (160+80, 120-60) = (240, 60).
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 0, 0, 3_000_000,
                    transform: ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.25)),
            ]),
            ExportTestDocs.VideoTrack(clips: [clipA, clipB]),
        ], width: CanvasWidth, height: CanvasHeight);

        var compiled = ExportCompiler.Compile(doc, new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(a, false, "bt709", "bt709"),
            [ExportTestDocs.AssetB] = new(b, false, "bt709", "bt709"),
            [ExportTestDocs.AssetC] = new(top, false, "bt709", "bt709"),
        }, ExportProfile.Hd1080p);

        // Kompozisyon yolu: rgba katmanlar + rgb blend + xfade (hızlı yol DEĞİL).
        Assert.Contains("format=rgba,pad=320:240:(ow-iw)/2:(oh-ih)/2:color=#00000000",
            compiled.FilterGraphScript);
        Assert.Contains("xfade=transition=fade:duration=0.400000:offset=1.300000",
            compiled.FilterGraphScript);
        Assert.Contains("[base][v0]overlay=", compiled.FilterGraphScript);

        var output = await RenderAsync(compiled, "transition-pip");
        var mid = Frame(output, 45, "tp-f45");

        // (a) PiP'in DIŞINDA alt track'in geçişi görünür: %50 karışım.
        byte[] expectedMix =
        [
            (byte)((SolidA[0] + SolidB[0]) / 2),
            (byte)((SolidA[1] + SolidB[1]) / 2),
            (byte)((SolidA[2] + SolidB[2]) / 2),
        ];
        AssertPixel(mid, 60, 180, expectedMix, 14, "PiP dışında alt katmanın geçiş karışımı");

        // (b) PiP'in İÇİ üst katmandır ve geçişten ETKİLENMEZ (kendi track'i geçişsiz).
        //     İddia KENDİ KENDİNİ KALİBRE EDER: mutlak renk sabiti yok, geçişin ortasındaki PiP
        //     pikseli geçişten ÖNCEKİ aynı pikselle karşılaştırılır.
        var before = Frame(output, 15, "tp-f15");
        Assert.True(MaxDiff(PixelAt(mid, 240, 60), PixelAt(before, 240, 60)) <= 12,
            $"PiP geçişten etkilendi: {Describe(PixelAt(before, 240, 60))} → "
            + $"{Describe(PixelAt(mid, 240, 60))}");
        AssertDistinct(mid, 240, 60, expectedMix, "PiP alt katmanın karışımını GÖSTERMEZ");
    }

    [FfmpegFact]
    public async Task TransitionAudio_CrossfadesAndKeepsTheTotalDuration()
    {
        // §5.4: acrossfade video xfade'iyle AYNI D/2 payını alır → toplam ses süresi Σd kalır
        // ve A/V senkron bozulmaz. Ses gerçekten AKIYOR mu, karışım sırasında çukura düşüyor mu:
        // pencere ortasında RMS ölçülür (iki 440 Hz sinüs lineer karışımı sessizlik ÜRETMEZ).
        var a = MediaFile("aud-a.mp4", "0x804020", withAudio: true);
        var b = MediaFile("aud-b.mp4", "0x2080C0", withAudio: true);
        var clipA = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 500_000, 2_000_000,
            ExportTestDocs.Audio());
        var clipB = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_500_000, 500_000, 2_000_000,
            ExportTestDocs.Audio());
        ExportTestDocs.Link(clipA, clipB, 400_000);
        var doc = ExportTestDocs.Doc(width: CanvasWidth, height: CanvasHeight, clips: [clipA, clipB]);

        var compiled = ExportCompiler.Compile(doc, new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(a, true, "bt709", "bt709"),
            [ExportTestDocs.AssetB] = new(b, true, "bt709", "bt709"),
        }, ExportProfile.Hd1080p);
        Assert.Contains("acrossfade=d=0.400000:c1=tri:c2=tri", compiled.FilterGraphScript);

        var output = await RenderAsync(compiled, "transition-audio");
        var probe = await new FfprobeService(_options).ProbeAsync(output);
        Assert.True(probe.HasAudio);
        // Ses süresi de Σd olmalı: acrossfade bindirmeyi YUTAR (3.4 sn değil 3.0 sn).
        Assert.InRange(probe.DurationUs!.Value, 2_900_000, 3_100_000);

        // Geçiş penceresinin ortasında (1.4-1.6 sn) ses DUYULABİLİR olmalı — acrossfade
        // yerine iki bağımsız fade olsaydı burada çukur oluşurdu.
        Assert.True(MaxVolumeDb(output, 1.4, 0.2) > -25d,
            "geçiş ortasında ses çukura düştü — acrossfade penceresi yanlış hizalanmış olabilir");
        Assert.True(MaxVolumeDb(output, 0.2, 0.2) > -25d, "geçiş öncesi ses duyulmalı");
        Assert.True(MaxVolumeDb(output, 2.6, 0.2) > -25d, "geçiş sonrası ses duyulmalı");
    }

    // ───────── ÇOK GİRİŞLİ MİKS: kuyruğun ffmpeg'i asmadığı ve tam boyda bittiği ─────────

    /// <summary>
    /// Bu testin kolladığı kusurun temiz koşumda ölçülen süresi ~1 sn'dir (320×240, 19 sn'lik
    /// çizelge, üç koşum). Tavan onun ~20 katıdır: yavaş bir makinede bile yanlış KIRMIZI
    /// üretmez, ama KUSURLU şekil SONSUZA KADAR koştuğu için tavana MUTLAKA çarpar.
    /// </summary>
    private static readonly TimeSpan MixRenderCeiling = TimeSpan.FromSeconds(20);

    [FfmpegFact]
    public async Task AudioMix_WithTwoAudibleGroups_FinishesAndSpansTheWholeTimeline()
    {
        // ASILAN ŞEKLİN KOŞAN KARŞILIĞI. Miks kuyruğu bir dönem
        // '…,alimiter=limit=0.98,apad,atrim=end=T' idi; 'apad' argümansız SINIRSIZ üreteçtir ve
        // atrim onu bu rejimde durdurmuyordu. ÖLÇÜLDÜ (ffmpeg 8.0): aynı belge 8/10 asıldı,
        // ürün düzeyinde iş %90/render'da kalıp tek export kanalını kilitledi.
        //
        // REJİM ÜÇ KOŞULUN KESİŞİMİDİR — biri düşerse test kusuru GÖREMEZ, o yüzden üçü de
        // aşağıda AYRICA ölçülür:
        //   (1) ÇOK GİRİŞLİ miks (amix=inputs>=2). Tek girişli miks aynı kuyrukla 5/5 temiz
        //       bitiyor; deponun miks uzunluk testi kendini 'amix=inputs=1:' ile sabitlediği
        //       için kusuru göremiyordu — bu test o sabitlemenin ÇOK GİRİŞLİ eşidir.
        //   (2) TAM A/V GRAFİĞİ. Aynı ses zinciri tek başına ([aout] tek çıkış) 'apad,atrim'
        //       ile de bitiyor; kusur ancak [vout] da haritalandığında doğuyor.
        //   (3) KLİP ARALIĞI KAYNAK DOSYASININ SONUNA DAYANIYOR. Pencere dosyanın İÇİNDE
        //       bitince (12 sn'lik kaynağın ilk 10 sn'si) aynı graf 5/5 temiz bitiyor.
        // Belge: A kaynak[0,10) → çizelge [0,10); B kaynak[1,10) (BAŞTAN KIRPILMIŞ) → çizelge
        // [10,19). Ardışık, geçişsiz → iki AYRI ses grubu → amix=inputs=2, toplam 19 sn.
        var a = media.Video320x240Tone330_10sWithAudio();
        var b = media.Video320x240Tone660_10sWithAudio();
        var doc = ExportTestDocs.Doc(width: CanvasWidth, height: CanvasHeight, clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 10_000_000,
                ExportTestDocs.Audio()),
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 10_000_000, 1_000_000, 10_000_000,
                ExportTestDocs.Audio()),
        ]);

        var compiled = ExportCompiler.Compile(doc, new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(a, true, "bt709", "bt709"),
            [ExportTestDocs.AssetB] = new(b, true, "bt709", "bt709"),
        }, ExportProfile.Hd1080p);

        // (1) Kurulumun kendisi ölçülür — rejim gerçekten kurulmuş mu?
        Assert.Equal(19_000_000, compiled.ExpectedDurationUs);
        Assert.Contains("amix=inputs=2:", compiled.FilterGraphScript);
        Assert.Contains("adelay=10000|10000", compiled.FilterGraphScript);   // ikinci grup gecikmeli
        // (2) Tam A/V grafiği: iki çıkış da haritalanıyor.
        Assert.Contains("[vout]", compiled.OutputArgs);
        Assert.Contains("[aout]", compiled.OutputArgs);
        // (3) İkinci klip BAŞTAN KIRPILMIŞ ve iki giriş de dosya SONUNA dayanıyor.
        Assert.Equal(["-ss", "1.000000", "-t", "9.000000", "-i", b], compiled.Inputs[1].ToArgs());

        // KUSUR YARIŞSALDIR: tek koşum yeşil kalabilir (ölçülen asılma oranı 8/10). Üç koşumun
        // hepsinin kaçırma olasılığı bu orana göre ~%0,8'dir.
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            var name = $"mix-tail-{attempt.ToString(CultureInfo.InvariantCulture)}";
            string output;
            try
            {
                output = await RenderAsync(compiled, name, MixRenderCeiling);
            }
            catch (OperationCanceledException)
            {
                // TAVANA ÇARPMAK YAVAŞLIK DEĞİL BAŞARISIZLIKTIR. Tavan olmasaydı asılma "yavaş
                // test" gibi görünür, koşum süresiz uzar ve arkada CPU yakan kaçak bir ffmpeg
                // kalırdı; bu yol süreç ağacını da öldürür.
                Assert.Fail(
                    $"{name}: render {MixRenderCeiling.TotalSeconds.ToString(CultureInfo.InvariantCulture)}"
                    + " sn TAVANINA çarptı — miks kuyruğu ASILIYOR (temiz koşum ~1 sn sürer). "
                    + "Bu bir yavaşlık değil, sonsuz döngüdür: kuyruktaki dolgu filtresi kendi "
                    + "durma noktasını taşımıyor.");
                throw; // erişilmez — Assert.Fail fırlatır; derleyicinin kesin atama analizi için
            }

            // ÇIKTI SÜRESİ AKIŞTAN OKUNUR: kapsayıcı süresi VİDEODAN gelir ve ses akışının
            // kısalığını GİZLER (S2'nin kazanımı budur, düzeltme onu bozmamalı).
            var audioSec = AudioStreamDurationSec(output);
            Assert.True(Math.Abs(audioSec - 19d) <= 1 / 30d,
                $"{name}: ses AKIŞI 19 sn olmalı, "
                + $"{audioSec.ToString("0.####", CultureInfo.InvariantCulture)} sn ölçüldü "
                + "(fark bir çıkış karesini aşıyor)");

            var probe = await new FfprobeService(_options).ProbeAsync(output);
            Assert.True(probe.HasVideo && probe.HasAudio);
            Assert.InRange(probe.DurationUs!.Value, 18_900_000, 19_100_000);
        }
    }

    /// <summary>Çıktının SES AKIŞI süresi (kapsayıcı/format süresi DEĞİL — o videodan gelir).</summary>
    private static double AudioStreamDurationSec(string mediaPath)
    {
        using var json = FfprobeJson.Run(
            "-select_streams", "a:0", "-show_entries", "stream=duration", mediaPath);
        var streams = json.RootElement.GetProperty("streams");
        Assert.True(streams.GetArrayLength() > 0, $"{mediaPath}: ses akışı yok");
        return double.Parse(
            streams[0].GetProperty("duration").GetString()!, CultureInfo.InvariantCulture);
    }

    // ─────────────── Overlay varlıkları: metin/şekil rasteri + çıkartma ───────────────

    [FfmpegFact]
    public async Task TextRasterLayer_LandsOnItsOwnBboxPixels_NotStretchedToTheCanvas()
    {
        // GÖREV 1'in çekirdek kanıtı (rendering-semantics §7). Raster 160x80 PNG'dir ve @2x
        // kuralı gereği doğal boyutu 80x40'tır. scale=1'de katman 80x40 piksel kaplamalıdır.
        //   HATA MODU: medya kliplerindeki fit=contain uygulansaydı kutu 320x240 olurdu ve
        //   metin TÜM KAREYİ kaplardı — aşağıdaki "köşe = tuval" iddiası bunu yakalar.
        // PNG'nin dış çerçevesi ŞEFFAFTIR: straight-alpha kompozisyonu da böylece kanıtlanır.
        var video = MediaFile("text-base.mp4", "0x804020", withAudio: true);
        var raster = RasterFile("text-raster.png", 160, 80, 120, 60, "0x20C080");

        var text = ExportTestDocs.TextClip(0, 2_000_000);
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.OverlayTrack(clips: [text]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
            ]),
        ], width: CanvasWidth, height: CanvasHeight);
        var textId = ((TextClip)doc.Tracks[0].Clips[0]).Id;

        var compiled = ExportCompiler.Compile(
            doc,
            new Dictionary<Guid, ExportAssetSource>
            {
                [ExportTestDocs.AssetA] = new(video, true, "bt709", "bt709"),
            },
            ExportProfile.Hd1080p,
            new Dictionary<Guid, ExportRasterSource> { [textId] = new(raster, 80, 40) });

        Assert.True(compiled.Inputs[1].Loop);                       // raster: -loop 1 -t
        Assert.Contains("scale=80:40:force_original_aspect_ratio=decrease", compiled.FilterGraphScript);
        Assert.DoesNotContain("[1:a]", compiled.FilterGraphScript); // metin ses ÜRETMEZ

        var output = await RenderAsync(compiled, "text-layer");
        var outProbe = await new FfprobeService(_options).ProbeAsync(output);
        Assert.True(outProbe.HasAudio);                             // ses yalnız video klibinden
        var frame = Frame(output, 30, "tx-f30");

        // Katman kutusu: 80x40, P = (160,120) → x[120,200), y[100,140).
        // Opak bölge rasterin iç 120x60'ıdır → ölçekte 60x30 → x[130,190), y[105,135).
        AssertPixel(frame, 160, 120, RasterRgb, 14, "raster merkezi");
        AssertPixel(frame, 133, 120, RasterRgb, 14, "opak bölgenin sol içi");
        AssertPixel(frame, 187, 120, RasterRgb, 14, "opak bölgenin sağ içi");
        AssertPixel(frame, 160, 108, RasterRgb, 14, "opak bölgenin üst içi");
        AssertPixel(frame, 160, 132, RasterRgb, 14, "opak bölgenin alt içi");

        // Şeffaf çerçeve: altındaki VİDEO görünür (straight alpha — §6.3).
        AssertPixel(frame, 123, 120, SolidA, 14, "rasterin şeffaf sol çerçevesi altındaki video");
        AssertPixel(frame, 197, 120, SolidA, 14, "rasterin şeffaf sağ çerçevesi altındaki video");

        // FIT=CONTAIN HATA MODU: kutu tuvale şişseydi burası raster rengi olurdu.
        AssertPixel(frame, 10, 10, SolidA, 14, "kare köşesi ALTTAKİ VİDEO (metin şişmemiş)");
        AssertPixel(frame, 310, 230, SolidA, 14, "kare köşesi ALTTAKİ VİDEO (metin şişmemiş)");
    }

    [FfmpegFact]
    public async Task TextRasterLayer_ScalesAboutItsOwnBox()
    {
        // scale=2 metni İKİ KATINA çıkarır (80x40 → 160x80), tuvale sığdırmaz. Kenarlar
        // ölçülür: aynı raster, tek fark transform.scale.
        var raster = RasterFile("scale-raster.png", 160, 80, 160, 80, "0x20C080"); // tam opak
        var text = ExportTestDocs.TextClip(0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 2));
        var doc = ExportTestDocs.MultiTrackDoc(
            [ExportTestDocs.OverlayTrack(clips: [text])], width: CanvasWidth, height: CanvasHeight);
        var textId = ((TextClip)doc.Tracks[0].Clips[0]).Id;

        var compiled = ExportCompiler.Compile(
            doc, new Dictionary<Guid, ExportAssetSource>(), ExportProfile.Hd1080p,
            new Dictionary<Guid, ExportRasterSource> { [textId] = new(raster, 80, 40) });
        Assert.Contains("scale=160:80:force_original_aspect_ratio=decrease", compiled.FilterGraphScript);

        var frame = Frame(await RenderAsync(compiled, "text-scale"), 15, "ts-f15");
        // Doğal 80x40 × scale 2 = 160x80 kutu, merkezde → x[80,240), y[80,160).
        // (±2 px pay: x264 ringing'i sert kenarın bir satır dışına taşabilir; yanlış fit
        //  kuralı olsaydı kutu 320x240'a şişer ve fark 80+ px olurdu.)
        var box = LitBoundingBox(frame);
        Assert.True(
            box.X0 is >= 78 and <= 82 && box.Y0 is >= 78 and <= 82
            && box.X1 is >= 237 and <= 241 && box.Y1 is >= 157 and <= 161,
            $"katman kutusu {box} — beklenen x[80,240) y[80,160) (scale=2 kendi kutusu üstünde)");
    }

    [FfmpegFact]
    public async Task ShapeAndStickerLayers_ComposeOverVideo_AndProduceNoAudio()
    {
        // Şekil klibinin şemada içsel boyutu YOKTUR → rasteri proje tuvalidir; scale 0.5
        // tam olarak medya klibindeki gibi 160x120 kutu verir. Çıkartma rasterlenmez:
        // kendi PNG asset'i GÖRSEL klip semantiğiyle (fit=contain × scale) girer.
        var video = MediaFile("shape-base.mp4", "0x804020", withAudio: true);
        var shapeRaster = RasterFile("shape-raster.png", 320, 240, 320, 240, "0x20C080");
        var stickerAsset = RasterFile("sticker.png", 320, 240, 240, 180, "0xC02080");

        var shape = ExportTestDocs.ShapeClip(0, 2_000_000,
            transform: ExportTestDocs.Transform(x: -0.25, scale: 0.5));
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.OverlayTrack(clips:
            [
                ExportTestDocs.StickerClip(ExportTestDocs.AssetC, 0, 2_000_000,
                    transform: ExportTestDocs.Transform(x: 0.25, scale: 0.25)),
            ]),
            ExportTestDocs.OverlayTrack(clips: [shape]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
            ]),
        ], width: CanvasWidth, height: CanvasHeight);
        var shapeId = ((ShapeClip)doc.Tracks[1].Clips[0]).Id;

        var compiled = ExportCompiler.Compile(
            doc,
            new Dictionary<Guid, ExportAssetSource>
            {
                [ExportTestDocs.AssetA] = new(video, true, "bt709", "bt709"),
                [ExportTestDocs.AssetC] = new(stickerAsset, false, "bt709", "bt709"),
            },
            ExportProfile.Hd1080p,
            new Dictionary<Guid, ExportRasterSource>
            {
                [shapeId] = new(shapeRaster, CanvasWidth, CanvasHeight),
            });

        Assert.Contains("scale=160:120:force_original_aspect_ratio=decrease", compiled.FilterGraphScript);
        Assert.Contains("scale=80:60:force_original_aspect_ratio=decrease", compiled.FilterGraphScript);
        Assert.Contains("amix=inputs=1:", compiled.FilterGraphScript); // yalnız videonun sesi

        var frame = Frame(await RenderAsync(compiled, "shape-sticker"), 30, "ss-f30");

        // Şekil: 160x120 kutu, P = (160-80, 120) = (80, 120) → x[0,160), y[60,180).
        AssertPixel(frame, 80, 120, RasterRgb, 14, "şekil merkezi");
        AssertPixel(frame, 155, 120, RasterRgb, 14, "şeklin sağ içi");
        AssertPixel(frame, 80, 55, SolidA, 14, "şeklin üst dışı = video");

        // Çıkartma: 80x60 kutu, P = (240, 120) → x[200,280), y[90,150). Asset'in dış çerçevesi
        // şeffaftır (240x180 opak / 320x240) → ölçekte 60x45 opak, x[210,270), y[97,142).
        // Çıkartma bir PNG asset'idir (renk tag'i dönüşümüne girmez) → kaynak RGB'sine yakın.
        AssertPixel(frame, 240, 120, [192, 32, 128], 10, "çıkartma merkezi");
        AssertPixel(frame, 203, 120, SolidA, 14, "çıkartmanın şeffaf çerçevesi altındaki video");
        AssertPixel(frame, 300, 120, SolidA, 14, "çıkartmanın dışı = video");
    }

    [FfmpegFact]
    public async Task TransitionRun_WithAnOffCenterAnchor_DoesNotShiftTheLayerByASinglePixel()
    {
        // Geçişte run BÖLÜNEMEZ → segmentler kutuya şeffaf pad ile normalize EDİLMEK ZORUNDA.
        // Bu pad'in ofseti ÇAPA ORANINDADIR; simetrik (ow-iw)/2 kullanılsaydı merkez dışı çapalı
        // katman letterbox payı kadar kayardı. İddia kendi kendini kalibre eder: AYNI klip
        // (a) tek başına (pad'siz yol) ve (b) geçişli run içinde (pad'li yol) render edilir,
        // katmanın sınır kutusu BİREBİR aynı çıkmalıdır.
        // Kaynak 16:9, kutu 4:3 → pad payı sıfır DEĞİL (hata görünür olsun).
        var wide = MediaFile("anchor-wide.mp4", "0x804020", size: "640x360");
        var other = MediaFile("anchor-other.mp4", "0x2080C0", size: "640x360");
        var sources = new Dictionary<Guid, ExportAssetSource>
        {
            [ExportTestDocs.AssetA] = new(wide, false, "bt709", "bt709"),
            [ExportTestDocs.AssetB] = new(other, false, "bt709", "bt709"),
        };
        var placement = ExportTestDocs.Transform(scale: 0.5, anchorX: 0.25, anchorY: 0.25);

        var aloneClip = ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 500_000, 2_000_000, transform: placement);
        var alone = ExportTestDocs.Doc(
            width: CanvasWidth, height: CanvasHeight, clips: aloneClip);

        var first = ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 500_000, 2_000_000, transform: placement);
        var second = ExportTestDocs.VideoClip(
            ExportTestDocs.AssetB, 1_500_000, 500_000, 2_000_000, transform: placement);
        ExportTestDocs.Link(first, second, 400_000);
        var inRun = ExportTestDocs.Doc(
            width: CanvasWidth, height: CanvasHeight, clips: [first, second]);

        var aloneCompiled = ExportCompiler.Compile(alone, sources, ExportProfile.Hd1080p);
        var runCompiled = ExportCompiler.Compile(inRun, sources, ExportProfile.Hd1080p);
        Assert.DoesNotContain("pad=160:120", aloneCompiled.FilterGraphScript);   // tek segment: pad YOK
        Assert.Contains("pad=160:120:(ow-iw)*0.25:(oh-ih)*0.25:color=#00000000",
            runCompiled.FilterGraphScript);                                      // çapa ORANLI pad

        var aloneFrame = Frame(await RenderAsync(aloneCompiled, "anchor-alone"), 15, "aa-f15");
        var runFrame = Frame(await RenderAsync(runCompiled, "anchor-run"), 15, "ar-f15");
        Assert.Equal(LitBoundingBox(aloneFrame), LitBoundingBox(runFrame));
    }

    // ───────────────────────── Fixture / render yardımcıları ─────────────────────────

    /// <summary>
    /// İki düz renk kaynak, timeline'da BİTİŞİK (0-1.5 ve 1.5-3 sn), aralarında D = 400 ms
    /// geçiş. Kaynaklar 3 sn, klipler 0.5-2.0 sn aralığını okur → her iki tarafta D/2 = 200 ms
    /// pay VAR (§5.2 handle invariant'ı sağlanır).
    /// </summary>
    private (TimelineDoc Doc, Dictionary<Guid, ExportAssetSource> Sources) TwoSolidsWithTransition(
        TransitionType type)
    {
        var a = MediaFile($"solid-a-{type}.mp4", "0x804020");
        var b = MediaFile($"solid-b-{type}.mp4", "0x2080C0");
        var clipA = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 500_000, 2_000_000);
        var clipB = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_500_000, 500_000, 2_000_000);
        ExportTestDocs.Link(clipA, clipB, 400_000, type);
        return (
            ExportTestDocs.Doc(width: CanvasWidth, height: CanvasHeight, clips: [clipA, clipB]),
            new Dictionary<Guid, ExportAssetSource>
            {
                [ExportTestDocs.AssetA] = new(a, false, "bt709", "bt709"),
                [ExportTestDocs.AssetB] = new(b, false, "bt709", "bt709"),
            });
    }

    /// <summary>3 sn, @30fps DÜZ RENK H.264 (istenirse 440 Hz sinüs AAC ile).</summary>
    private string MediaFile(string name, string color, bool withAudio = false, string size = "320x240")
    {
        var path = Path.Combine(_dir, name);
        if (File.Exists(path))
        {
            return path;
        }

        var args = new List<string>
        {
            "-y", "-f", "lavfi", "-i", $"color=c={color}:size={size}:rate=30:duration=3",
        };
        if (withAudio)
        {
            args.AddRange(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-af", "volume=5"]);
        }

        args.AddRange(["-c:v", "libx264", "-pix_fmt", "yuv420p"]);
        if (withAudio)
        {
            args.AddRange(["-c:a", "aac", "-ar", "48000", "-shortest"]);
        }

        args.Add(path);
        RunFfmpeg([.. args]);
        return path;
    }

    /// <summary>
    /// Overlay rasteri taklidi: <paramref name="width"/>×<paramref name="height"/> ŞEFFAF PNG'nin
    /// ortasında <paramref name="innerWidth"/>×<paramref name="innerHeight"/> opak dikdörtgen.
    /// Şeffaf çerçeve straight-alpha kompozisyonunun (§6.3/§6.4) piksel kanıtını sağlar.
    /// </summary>
    private string RasterFile(
        string name, int width, int height, int innerWidth, int innerHeight, string color)
    {
        var path = Path.Combine(_dir, name);
        if (File.Exists(path))
        {
            return path;
        }

        var w = width.ToString(CultureInfo.InvariantCulture);
        var h = height.ToString(CultureInfo.InvariantCulture);
        RunFfmpeg([
            "-y", "-f", "lavfi",
            "-i", $"color=c={color}:size={innerWidth}x{innerHeight}",
            "-vf", $"format=rgba,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=#00000000",
            "-frames:v", "1", path,
        ]);
        return path;
    }

    /// <param name="ceiling">
    /// Verilirse render bu SÜRE TAVANIYLA koşar: tavana çarpınca ffmpeg SÜREÇ AĞACI öldürülür
    /// (FfmpegRunner iptalde <c>Kill(entireProcessTree)</c> yapar) ve
    /// <see cref="OperationCanceledException"/> fırlar. Tavansız bir "asılabilir" testin iki
    /// ayrı zararı vardır: koşum süresiz uzar ve arkada CPU yakan KAÇAK bir ffmpeg kalır.
    /// </param>
    private async Task<string> RenderAsync(
        CompiledExport compiled, string name, TimeSpan? ceiling = null)
    {
        var scriptPath = Path.Combine(_dir, name + "-graph.txt");
        await File.WriteAllTextAsync(scriptPath, compiled.FilterGraphScript);
        var outputPath = Path.Combine(_dir, name + ".mp4");
        using var cts = ceiling is { } limit ? new CancellationTokenSource(limit) : new CancellationTokenSource();
        var result = await new FfmpegRunner(_options).RunAsync(
            compiled.ToFfmpegArgs(scriptPath, outputPath), compiled.ExpectedDurationUs,
            ct: cts.Token);
        Assert.True(result.Success, $"{name} render failed: {result.StderrTail}");
        return outputPath;
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

    private static void AssertPixel(
        byte[] rgb, int x, int y, byte[] expected, int tolerance, string what)
    {
        var actual = PixelAt(rgb, x, y);
        Assert.True(MaxDiff(actual, expected) <= tolerance,
            $"({x},{y}) {what}: beklenen ≈{Describe(expected)} ±{tolerance}, ölçülen {Describe(actual)}");
    }

    private static void AssertDistinct(byte[] rgb, int x, int y, byte[] other, string what)
    {
        var actual = PixelAt(rgb, x, y);
        Assert.True(MaxDiff(actual, other) > 20,
            $"({x},{y}) {what}: {Describe(other)} değerinden ayırt edilemedi (ölçülen {Describe(actual)})");
    }

    /// <summary>"Aydınlık" piksellerin sınır kutusu (x0, y0, x1, y1 — kapsayıcı).</summary>
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
        if (!process.WaitForExit(120_000) || process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"ffmpeg helper failed ({string.Join(' ', args)}): {stderr}");
        }

        return stderr;
    }
}
