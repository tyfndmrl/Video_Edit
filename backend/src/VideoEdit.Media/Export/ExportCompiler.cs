using System.Globalization;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Recipes;
using VideoEdit.Media.Text;

namespace VideoEdit.Media.Export;

/// <summary>
/// Tek track'in normalize planı. <see cref="DocIndex"/> dokümandaki sırasıdır
/// (0 = EN ÜST katman — docs/design/01 §1.2); <see cref="ExportPlan.Tracks"/> ise
/// RENDER sırasındadır (sondan başa: en alt katman önce).
/// </summary>
public sealed record ExportTrackPlan(Track Track, int DocIndex, IReadOnlyList<ExportClipPlan> Clips);

/// <summary>
/// Doğrulama çıktısı: normalize plan. API ön-doğrulaması yalnız <see cref="ExportCompiler.Validate"/>
/// çağırır (asset yolu ve raster gerekmez); worker aynı planla kaynakları indirip, metin/şekil
/// rasterlerini üretip Compile'a geçer.
/// TotalDurationUs TÜM track'lerin en geç klip bitişinin proje fps grid'ine snap edilmiş halidir.
/// <para>
/// <see cref="Clips"/> = worker'ın KAYNAK-ARALIĞI KAPISININ defteridir (render sırasında
/// düzleştirilmiş) ve GEÇİŞ PAYLARI UYGULANMIŞ aralıkları taşır: geçişli bir klip kaynağından
/// D/2 fazla okur, kapının gördüğü sourceOut da o yüzden uzatılmıştır (aksi halde kapı yeterli
/// kuyruk payı olmayan bir geçişi kaçırır ve ffmpeg sessizce donmuş kare üretirdi). Bu defterdeki
/// klip nesneleri KLONDUR — süre sözleşmesini (out-in == timelineDuration) bilerek ihlal ederler.
/// İki sınıf klip bilerek DIŞARIDA bırakılır:
///  - ZAMAN EKSENİ OLMAYAN klipler (görsel + metin/şekil/çıkartma rasterleri): sourceIn/sourceOut'ları
///    dosyada bir zaman aralığına karşılık GELMEZ — kapıya sokulurlarsa "reads source range beyond
///    asset duration" ile export düşerdi;
///  - ATIL klipler (gizli track + şema gereği ses üretemeyen klip): hiçbir ffmpeg girişi
///    açmazlar, dolayısıyla hiçbir kaynak aralığı OKUMAZLAR — render edilmeyen bir klibin
///    TÜM export'u düşürmesi (M4 dalga 1 denetimi) böylece imkânsızlaşır.
/// <see cref="AssetIds"/> ise atıl klipleri ve metin/şekil kliplerini (asset'i yoktur) dışlar ama
/// GÖRSEL ve ÇIKARTMA dosyalarını İÇERİR — dosya indirilmeden render edilemez.
/// <see cref="RasterClips"/> worker'ın SkiaSharp raster hattına vereceği kliplerdir (metin/şekil);
/// atıl olanlar burada da yoktur (görünmeyen metin için boşuna PNG üretilmez).
/// </para>
/// </summary>
public sealed record ExportPlan(
    TimelineDoc Doc,
    IReadOnlyList<ExportTrackPlan> Tracks,
    IReadOnlyList<MediaClip> Clips,
    IReadOnlyList<Guid> AssetIds,
    IReadOnlyList<ExportClipPlan> RasterClips,
    long TotalDurationUs,
    int FpsNum,
    int FpsDen,
    int Width,
    int Height,
    IReadOnlyList<Guid> LutAssetIds)
{
    /// <summary>
    /// LUT (.cube) VARLIKLARI — <see cref="AssetIds"/>'ten AYRI tutulur (M5). Gerekçe:
    /// AssetIds defteri worker'da ffprobe'dan geçer ve video stream'i şart koşulur;
    /// .cube bir MEDYA DOSYASI DEĞİLDİR (probe'u anlamsızdır, "no video stream" ile tüm
    /// export'u düşürürdü) ve kaynak-aralığı kapısına da girmez. Worker bu defteri de
    /// indirip <c>sources</c> sözlüğüne YOL olarak koymalıdır (probe ETMEDEN).
    /// </summary>
    public IReadOnlyList<Guid> LutAssetIds { get; init; } = LutAssetIds;

    /// <summary>
    /// KULLANIM DEFTERİ: hangi klip hangi varlıktan NEYİ okuyor (<see cref="ExportAssetUse"/>).
    /// <see cref="AssetIds"/> "hangi dosyalar inecek" sorusunu yanıtlar, bu defter "inen dosyada
    /// ne bulunmalı" sorusunu. İkisi ayrıdır çünkü aynı dosya iki farklı klipte iki farklı
    /// biçimde okunabilir (ör. aynı varlık hem ses klibinde hem video klibinde).
    /// <para>
    /// Defter yalnız GERÇEKTEN okunan kullanımları taşır: atıl klip (gizli + sessiz) hiç girmez,
    /// gizli track'teki video klibi girmez (görüntüsü çizilmez, sesi varsa OPSİYONELDİR),
    /// susturulmuş track'teki ses klibi girmez. Kapıların yanlış ret üretmemesi buna bağlıdır.
    /// </para>
    /// </summary>
    public IReadOnlyList<ExportAssetUse> AssetUses { get; init; } = [];

    /// <summary>
    /// ÖLÇÜLEMEYEN metin klipleri: <see cref="ExportCompiler.Validate"/>'e bir ölçer VERİLDİĞİ HALDE bbox'ı
    /// alınamayan (Skia/font kökü/manifest arızası) klipler. Boş liste = ölçüm sorunu YOK.
    /// <para>
    /// Neden planın parçası: bu bir DOKÜMAN hatası DEĞİL, KURULUM hatasıdır — derleyici onu
    /// 422'ye çeviremez (yanlış ret olurdu), ama sessizce yutması da kabul edilemez: ölçüm
    /// yolu kapalıyken metin katmanı kapıları (tavan + taban) yalnız alt sınırdan sorulabilir
    /// ve METİN EXPORT'U ZATEN ÇALIŞAMAZ (worker rasterlemek için aynı Skia/font köküne
    /// muhtaçtır). Kararı HTTP katmanı verir (ExportEndpoints: 503 + typed kod), çünkü
    /// "istek şimdi karşılanamıyor" bir taşıma katmanı cevabıdır.
    /// </para>
    /// </summary>
    public IReadOnlyList<Guid> UnmeasuredTextClipIds { get; init; } = [];
}

/// <summary>
/// FilterGraph Compiler v4 (M5 = HIZ + RENK DÜZELTME/LUT + transform/opaklık/SES SEVİYESİ
/// KEYFRAME'leri; hız rampası ve minterpolate hâlâ tipli hata).
/// TimelineDoc → deterministik CompiledExport. Kurallar:
///  - HIZ (tasarım 04 §2.4): video <c>fps → setpts=PTS/k → fps → trim</c> (ikinci fps çıktı
///    ızgarasıdır), ses <c>atempo</c> katlaması; süre §1.3'ün tek formülünden gelir ve geçiş
///    payı KAYNAK ekseninde <c>roundHalfUp((D/2)*rate)</c> ile ölçeklenir (§5.2);
///  - EFEKTLER (§4): colorAdjust → lut, ÖLÇEKTEN SONRA kompozisyondan ÖNCE (yer ve gerekçe
///    <c>EmitSegmentChain</c>'de ölçümüyle birlikte); LUT dosyası ayrı bir varlık defterindedir
///    (<see cref="ExportPlan.LutAssetIds"/>) çünkü .cube probe edilemez;
///  - KEYFRAME (§3, tasarım 04 §2.5): x/y overlay ifadesinde, scale/rotate kendi filtrelerinin
///    ifadesinde, opaklık ya <c>fade</c> ya da AYNI LİNEER ZİNCİRDEKİ sendcmd ile sürülür.
///    Lineer kanal keyframe'ler üstünde kapalı forma, eğrili kanal §3.4'ün frame örneklemesiyle
///    dengeli karar ağacına derlenir (sendcmd overlay'i güvenilir SÜREMEZ — ölçüm
///    <c>KeyframeCompiler.StepExpression</c>'da). Keyframe'li klip KENDİ run'ındadır;
///  - trim INPUT seviyesinde -ss/-t (tasarım 04 §2.1; -to ASLA); aynı asset'ten N klip = N giriş;
///    ZAMAN EKSENİ OLMAYAN klipte (görsel + metin/şekil/çıkartma rasteri) seek anlamsızdır →
///    -loop 1 -t &lt;süre&gt; (ExportInput.Loop);
///  - segment defteri FRAME SAYISIYLA tutulur: her klip proje fps grid'inde tam frame sayısına
///    çözülür ve zincire trim=[start_frame=S:]end_frame=N eklenir — µs-farkı aritmetiğinin
///    NTSC'de ürettiği ±1 frame kaymaları biter (rendering-semantics §1.4);
///  - KATMAN RUN'LARI (M4 dalga 1 denetimi, performans regresyonu): aynı track'te ARDIŞIK
///    (frame-bitişik) ve AYNI yerleşime sahip klipler TEK concat zincirinde birleşir ve tuvale
///    TEK overlay ile biner. Klip başına overlay yalnız GERÇEK katmanlaşmada (farklı track,
///    zaman boşluğu ya da farklı yerleşim) üretilir. GERÇEK ÖLÇÜM (1080p, 12 klip, 12 sn, tek
///    track, ffmpeg 8.0, 3 koşumun en iyisi): klip başına overlay → run concat'i; filtre-only
///    3727 → 1519 ms (2.5x), uçtan uca (libx264 veryfast crf18) 4273 → 2001 ms (2.1x);
///  - GEÇİŞLER (rendering-semantics §5 + tasarım 04 §2.3): klipler timeline'da BİTİŞİK kalır,
///    geçiş kesime iliştirilmiş metadata'dır. Compiler D süresi için A'nın sourceOut'unu D/2
///    ileri, B'nin sourceIn'ini D/2 geri uzatır (handle) ve iki segmenti xfade ile birleştirir;
///    kümülatif offset §2.3 formülüdür. Birleşik akışın toplam süresi Σd'dir → SONRAKİ kliplerin
///    timeline pozisyonları KAYMAZ. Geçişli track önce kendi içinde tek akışa derlenir, sonra
///    üst katman kompozisyonuna girer. Ses tarafında karşılığı acrossfade=d=D'dir (aynı D);
///  - TEK KATMANLI HIZLI YOL: grafikte TEK run var, timeline'ı BAŞTAN SONA kaplıyor, yerleşim
///    birim (scale=1, merkez çapa, dönmesiz) ve opaklık 1 ise taban tuval + overlay TAMAMEN
///    atlanır: segmentler proje tuvaline letterbox pad'lenip doğrudan concat/xfade edilir (M3 hattı).
///    Kompozisyon yoksa blend de yoktur — RGB tuval maliyeti ödenmez. Bu yol aynı zamanda
///    RENK KAYBINI da kaldırır: tuval yolu yuv→rgba→kompozisyon→yuv420p gidiş-dönüşü yapıyordu
///    ve DOKUNULMAMIŞ tam-kare bir klipte bile kayıp ölçülebilirdi (kayıpsız ffv1 karşılaştırma,
///    aynı renk etiketleriyle: tuval yolu PSNR 35.87 dB — Y 38.6 / V 31.1; hızlı yol PSNR ∞,
///    yani kaynakla BİT BİT AYNI);
///  - KOMPOZİSYON (tasarım 04 §2.2 + rendering-semantics §2.2): hızlı yol dışında taban DAİMA
///    proje çözünürlüğünde settings.backgroundColor tuvalidir; her run bu tuvale overlay edilir.
///    Boşluklar (klipsiz aralıklar) ayrı segment gerektirmez — taban tuval görünür.
///    Render sırası tracks dizisinde SONDAN BAŞA'dır (tracks[0] en üst katman, şema §1.2);
///  - OVERLAY VARLIKLARI (M4 dalga 2, tasarım 04 §3): metin/şekil klibi worker'da SkiaSharp ile
///    TEK şeffaf PNG'ye rasterlenir ve normal katman zincirinden geçer; çıkartma kendi asset
///    dosyasıyla girer. Hiçbiri SES ÜRETMEZ. Metin/şekil rasterinin ölçek kutusu TUVAL DEĞİL
///    kendi doğal boyutudur (rendering-semantics §7 @2x kuralı) — fit=contain uygulansaydı
///    fontSizePx anlamsızlaşırdı;
///  - her video zinciri fps=&lt;projeFps&gt;,trim=…,scale(fit=contain × transform.scale),
///    setsar=1,format,…,settb=AVTB,setpts=PTS-STARTPTS+&lt;start&gt;/TB ile normalize edilir;
///    overlay x/y rendering-semantics §2.5 formülüdür, enable=between(t,…) görünürlük
///    penceresini yarım frame geri çekilmiş bitişle sınırlar (tasarım 04 §8 tuzak 9);
///  - KOMPOZİSYON RENK MODU GRAFİK BAŞINADIR ve DAİMA RGB'dir (rendering-semantics §6.3):
///    her katman format=rgba ile girer, her overlay :format=rgb ile blend eder. Katman başına
///    seçim YASAK — alpha'lı katmanın üstüne opak katman gelince zincir ortasında RGB↔YUV
///    dönüşümü oluşur ve ALTTAKİ katmanların renkleri kayar (M4 denetim #1; gerçek render:
///    üstteki katmanın ÖRTMEDİĞİ bölgede MSE 89.07 — grafik başına modda 0.05);
///    4:2:0 kompozisyon ayrıca tek piksellik konumu TEMSİL EDEMEZ (ffmpeg overlay normalize_xy
///    x/y'yi chroma adımına kırpar) — opak katman çift piksele snap olurken alpha'lı katman
///    olmazdı; alt örneklemesiz tuval bu farkı kökten kaldırır (denetim #15);
///  - her katman zincirinin BAŞINDA setparams=bt709/tv vardır: §6.1 "untagged SDR = BT.709/tv"
///    varsayımı RGB dönüşümünden ÖNCE beyan edilmezse swscale kendi varsayılanını (SD'de BT.601)
///    kullanır ve kompozisyon renkleri kaydırır (ölçülen maxAbsDiff 68);
///  - HDR kaynakta ColorChain.ForSource (rendering-semantics §6.2 normatif sabiti) zincirin başındadır;
///  - kompozisyon SONRASI setparams frame'leri BT.709/tv olarak işaretler — ffmpeg 7+ çıktı CLI
///    tag'lerini filtergraph frame metadata'sıyla ezdiği için CLI bayrakları tek başına yetmez
///    (CLI bayrakları emniyet kemeri olarak kalır);
///  - ses: TÜM track'lerin klipleri mikslenir. hidden track SES ÜRETMEYE DEVAM EDER
///    (hidden = yalnız görsel gizleme — apps/editor resolve.ts semantiği), muted track ve
///    muted klip ses üretmez. Zincir: [atempo] → [atrim] → asetpts → [adelay = atempo WSOLA
///    telafisi, AtempoCompensationMs] → aformat(48k fltp stereo) → apad + atrim=end (UZUNLUK
///    KİLİDİ: akış sözleşme penceresine sabitlenir) → volume (sabit ya da §8.1 keyframe eğrisi
///    asendcmd ile) → afade in/out (curve=tri, §8.2) → 5 ms micro-fade (§8.4)
///    → [acrossfade zinciri] → adelay(timeline ofseti);
///    miks amix=normalize=0 + alimiter=limit=0.98 (§8.3); hiç ses yoksa anullsrc;
///  - tüm sayısal literal'ler InvariantCulture (TimeFormat) — TR locale'de virgül SIZAMAZ.
/// </summary>
public static class ExportCompiler
{
    /// <summary>§8.4: sert kesim sınırındaki micro-fade süresi — 5 ms (= 240 sample @48 kHz).</summary>
    public const long MicroFadeUs = 5_000;

    /// <summary>Çıktı frame'lerine damgalanan renk parametreleri (rendering-semantics §6.1).</summary>
    public const string OutputColorParams =
        "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";

    /// <summary>
    /// Kaynak frame'lerine damgalanan renk parametreleri (rendering-semantics §6.1: "untagged
    /// SDR kaynak BT.709/tv VARSAYILIR"). Zincirin BAŞINDA, ilk format dönüşümünden ÖNCE
    /// uygulanır — aksi halde RGB'ye geçişi swscale kendi varsayılanıyla (SD'de BT.601) yapar
    /// ve varsayım pikselleri etkilemez, yalnız etikette kalır.
    /// </summary>
    public const string SourceColorParams = OutputColorParams;

    /// <summary>
    /// Kompozisyon renk modu (rendering-semantics §6.3): TÜM overlay'ler RGB'de blend eder.
    /// Grafik başına tek moddur — katman başına seçim zincir ortasında RGB↔YUV dönüşümü
    /// yaratır (denetim #1) ve 4:2:0 tuval overlay konumunu çift piksele kırpar (denetim #15).
    /// </summary>
    public const string CompositeFormat = ":format=rgb";

    /// <summary>
    /// Şeffaf pad rengi — katman zincirlerinde kullanılan tek "boşluk" rengi (rgba tuval).
    /// </summary>
    public const string TransparentPad = "#00000000";

    /// <summary>
    /// Şema geçiş tipi → ffmpeg xfade geçiş adı (rendering-semantics §5.3 NORMATİF tablosu).
    /// </summary>
    public static string XfadeName(TransitionType type) => type switch
    {
        TransitionType.Crossfade => "fade",
        TransitionType.FadeToBlack => "fadeblack",
        TransitionType.WipeLeft => "wipeleft",
        TransitionType.WipeRight => "wiperight",
        TransitionType.SlideUp => "slideup",
        TransitionType.Dissolve => "dissolve",
        _ => throw new UnsupportedFeatureException("transition-type",
            $"'{type}' geçiş tipi dışa aktarıcıda tanımlı değil."),
    };

    /// <summary>
    /// Dokümanın atıfta bulunduğu TÜM asset id'leri (medya, çıkartma VE LUT) — DOĞRULAMADAN
    /// ÖNCE, ham dokümandan okunur. API asset defterini (<see cref="ExportAssetFacts"/>) tek
    /// sorguda bununla doldurur: <see cref="Validate"/>'i önce id'ler, sonra olgularla ikinci
    /// kez koşmak METİN ÖLÇÜMÜNÜ (Skia) iki kez yapardı.
    /// <para>
    /// LUT id'leri de BURADADIR (eskiden dışarıdaydı): .cube'ün geometrisi yoktur ama VARLIĞI
    /// ve DOSYA TÜRÜ senkron kapının sorularıdır. Defterde geometrisi olmayan fazladan bir
    /// satırın bulunması zararsızdır — geometri kapısı yalnız <c>clip.AssetId</c>'yi arar.
    /// </para>
    /// Geçersiz/eksik doküman burada hata ÜRETMEZ (ayrıştırılamayan bir LUT assetId'si sessizce
    /// atlanır); sözleşme ihlallerini <see cref="Validate"/> kendi diliyle raporlar.
    /// </summary>
    public static IReadOnlyList<Guid> ReferencedAssetIds(TimelineDoc doc)
    {
        ArgumentNullException.ThrowIfNull(doc);

        var ids = new List<Guid>();
        foreach (var track in doc.Tracks ?? [])
        {
            foreach (var clip in track.Clips ?? [])
            {
                var assetId = clip switch
                {
                    MediaClip media => media.AssetId,
                    StickerClip sticker => sticker.AssetId,
                    _ => (Guid?)null,
                };
                Add(assetId);

                foreach (var lutId in ColorPipeline.RawLutAssetIds(EffectsOf(clip)))
                {
                    Add(lutId);
                }
            }
        }

        return ids;

        void Add(Guid? candidate)
        {
            if (candidate is { } id && id != Guid.Empty && !ids.Contains(id))
            {
                ids.Add(id);
            }
        }
    }

    /// <summary>
    /// M4 dalga 2 kapsam + sözleşme doğrulaması. İhlalde ExportCompileException türevi fırlatır.
    /// <para>
    /// <paramref name="overlayMeasurer"/> METİN kliplerinin bbox'ını ÖLÇMEK içindir (yalnız
    /// <see cref="ITextRasterService.Measure"/> çağrılır — dosya yazılmaz). Verilirse metin
    /// katmanı tavanı GERÇEK bbox'la, verilmezse fontlardan BAĞIMSIZ KESİN ALT SINIRLA
    /// doğrulanır (bkz. <see cref="TextBoxLowerBound"/>): ölçüm yokluğu yanlış 422 üretmez,
    /// yalnız kapının yakalayabildiği vaka kümesini daraltır. Şekil klibinde ölçüm GEREKMEZ —
    /// bbox sözleşme gereği proje karesidir (<see cref="Media.Text.ShapeGeometry"/>).
    /// </para>
    /// <para>
    /// <paramref name="assets"/> = assetId → DB'den okunan olgular defteri
    /// (<see cref="ExportAssetFacts"/>). Beş kapı bu TEK defterden beslenir: dejenerelik
    /// (Width/Height), kaynak aralığı (DurationMicros), LUT dosya türü (FileName), varlık
    /// mevcudiyeti (satırın KENDİSİ) ve ses keyframe bütçesi (HasAudio). Defter null ise
    /// (worker yolu) asset kapılarının tamamı atlanır ve worker'ın ffprobe yarısı emniyet
    /// kemeri kalır. Defter YALNIZ kapıya girer, üretilen filtergraph'a ASLA.
    /// </para>
    /// </summary>
    public static ExportPlan Validate(
        TimelineDoc doc,
        ITextRasterService? overlayMeasurer = null,
        IReadOnlyDictionary<Guid, ExportAssetFacts>? assets = null)
    {
        ArgumentNullException.ThrowIfNull(doc);

        if (doc.SchemaVersion != 1)
        {
            throw new InvalidTimelineException(
                $"unsupported schemaVersion {doc.SchemaVersion.ToString(CultureInfo.InvariantCulture)} (expected 1).");
        }

        var settings = doc.Settings
            ?? throw new InvalidTimelineException("timeline has no settings.");
        if (settings.Fps is not { Num: > 0, Den: > 0 }
            || settings.Fps.Num > int.MaxValue || settings.Fps.Den > int.MaxValue)
        {
            throw new InvalidTimelineException("settings.fps must be a positive rational.");
        }

        if (settings.Width <= 0 || settings.Height <= 0
            || settings.Width > int.MaxValue || settings.Height > int.MaxValue)
        {
            throw new InvalidTimelineException("settings.width/height must be positive.");
        }

        if (settings.Width % 2 != 0 || settings.Height % 2 != 0)
        {
            // yuv420p/libx264 çift boyut ister — tek kaynak kural: proje çözünürlüğü çift olmalı.
            throw new InvalidTimelineException(
                $"output resolution {settings.Width}x{settings.Height} must have even dimensions.");
        }

        var tracks = doc.Tracks ?? [];
        if (tracks.Count == 0)
        {
            throw new InvalidTimelineException("timeline has no tracks — nothing to export.");
        }

        var fpsNum = (int)settings.Fps.Num;
        var fpsDen = (int)settings.Fps.Den;
        var width = (int)settings.Width;
        var height = (int)settings.Height;

        // Track'ler RENDER sırasında (sondan başa: en alt katman önce) planlanır — şema
        // sözleşmesi tracks[0]'ı EN ÜST katman sayar (docs/design/01 §1.2). BOŞ track'ler
        // (clips.length == 0, tipi ne olursa olsun) yok sayılır: editör +V/+A ile içeriksiz
        // track ekler — bunlar export kapsamını değiştirmez, 422'ye düşürmez.
        var geometry = new GeometryContext(settings, width, height, overlayMeasurer, assets, []);
        var trackPlans = new List<ExportTrackPlan>();
        var sourceRangeClips = new List<MediaClip>();
        var rasterClips = new List<ExportClipPlan>();
        var assetIds = new List<Guid>();
        var assetUses = new List<ExportAssetUse>();
        var lutAssetIds = new List<Guid>();
        long totalDurationUs = 0;
        for (var i = tracks.Count - 1; i >= 0; i--)
        {
            var track = tracks[i];
            if (track.Clips is not { Count: > 0 })
            {
                continue;
            }

            var clips = new List<ExportClipPlan>(track.Clips.Count);
            foreach (var clip in track.Clips)
            {
                var planned = ValidateClip(clip, geometry);

                // Frame-grid güvenlik ağı (rendering-semantics §1.4): frame defteri klibi İKİ KENARLA
                // tutar (aşağıda startFrame/endFrame → trim=start_frame:end_frame), uzunlukla DEĞİL.
                // Kapı da bu yüzden kenarlardadır: grid tamsayı olmayan fps'te toplama altında KAPALI
                // DEĞİLDİR (30 fps: frame1=33_333, frame2=66_667; 33_333+33_333=66_666 ızgarada yok),
                // dolayısıyla "start ızgarada VE süre ızgarada" isteği bitişik klip zinciri için —
                // yani her bölme ve her geçiş için — çelişkilidir. Kenarlar ızgaradaysa defter
                // birebir tutar; ±1 frame kayma da imkânsız olur.
                var plannedEndUs = planned.TimelineStartUs + planned.TimelineDurationUs;
                if (SnapUs(planned.TimelineStartUs, fpsNum, fpsDen) != planned.TimelineStartUs
                    || SnapUs(plannedEndUs, fpsNum, fpsDen) != plannedEndUs)
                {
                    throw new InvalidTimelineException(
                        $"clip '{planned.Id}' edges are not on the project frame grid "
                        + $"({fpsNum.ToString(CultureInfo.InvariantCulture)}/{fpsDen.ToString(CultureInfo.InvariantCulture)} fps): "
                        + $"timelineStartUs={planned.TimelineStartUs}, "
                        + $"timelineEndUs={plannedEndUs} (timelineDurationUs={planned.TimelineDurationUs}).");
                }

                clips.Add(planned);
            }

            // Sıralama + bitişiklik invariant'ı (schema.ts Track.clips yorumu): TRACK İÇİNDE
            // timelineStartUs artan, overlap YOK. Boşluk serbesttir — taban tuval görünür.
            // Track'ler ARASI çakışma normaldir; kompozisyonun bütün amacı odur.
            for (var c = 1; c < clips.Count; c++)
            {
                var prevEnd = clips[c - 1].TimelineEndUs;
                if (clips[c].TimelineStartUs < prevEnd)
                {
                    throw new InvalidTimelineException(
                        $"clips '{clips[c - 1].Id}' and '{clips[c].Id}' overlap or are out of order "
                        + $"(previous ends at {prevEnd} us, next starts at {clips[c].TimelineStartUs} us).");
                }
            }

            // Geçiş sözleşmesi (§5.2): simetri + bitişiklik + çift-frame D + üst sınır + handle
            // + GÖRÜNEN kesimde yerleşim eşitliği/çapa kuralı. Doğrulanan her kesim iki klibe
            // D/2 payı yazar; ihlal TİPLİ Türkçe hatadır.
            ResolveTransitions(clips, fpsNum, fpsDen, track, width, height);

            var last = clips[^1];
            totalDurationUs = Math.Max(
                totalDurationUs, SnapUs(last.TimelineEndUs, fpsNum, fpsDen));
            trackPlans.Add(new ExportTrackPlan(track, i, clips));

            // Defterler (ExportPlan yorumuna bakınız): atıl klip hiçbir giriş açmaz →
            // ne indirilir ne rasterlenir ne kaynak-aralığı kapısına girer; zaman ekseni
            // olmayan klip (görsel/raster) indirilir/rasterlenir ama kaynak aralığı OKUMAZ.
            foreach (var clip in clips)
            {
                if (IsInert(clip, track))
                {
                    continue;
                }

                // LUT dosyası GÖRSEL bir katman değildir: yalnız GÖRÜNEN klipte indirilir
                // (atıl klip yukarıda elenmiştir), ama raster/medya defterlerinden bağımsızdır.
                if (clip.Effects.Lut is { } lut && !track.Hidden && clip.Kind != ExportClipKind.Audio)
                {
                    lutAssetIds.Add(lut.AssetId);
                }

                if (clip.NeedsServerRaster)
                {
                    // RASTER SÖZLEŞMESİ BURADA sorulur, ValidateClip'te DEĞİL: kural yalnız
                    // GERÇEKTEN rasterlenecek klipler için geçerlidir. Gizli track'in metni
                    // hiçbir PNG üretmez (OverlayRasterPlanner.Collect onu atlar) — orada
                    // sorulsaydı görünmeyen bir klip yüzünden geçerli belge reddedilirdi.
                    EnsureRasterContract(clip);
                    rasterClips.Add(clip);
                    continue;
                }

                assetIds.Add(clip.AssetId!.Value);
                if (NeedOf(clip, track) is { } need)
                {
                    assetUses.Add(new ExportAssetUse(
                        clip.Id, clip.KindTr, clip.AssetId!.Value, need));
                }

                if (!clip.IsStillInput)
                {
                    sourceRangeClips.Add(EffectiveRangeClip(clip));
                }
            }
        }

        // Raster dosya adı klip id'sinden türer ({id:N}.png). Aynı id iki kez rasterlenecek
        // olursa hangi PNG'nin hangi klibe ait olduğu belirsizleşir; worker bunu tipli hatayla
        // reddeder (OverlayRasterPlanner.RenderAllAsync). Kural SAF DOKÜMAN aritmetiğidir —
        // karar için ne dosya ne asset gerekir, dolayısıyla senkron kapıda yaşamalıdır.
        var rasterIds = new HashSet<Guid>();
        foreach (var clip in rasterClips)
        {
            if (!rasterIds.Add(clip.Id))
            {
                throw new UnsupportedFeatureException("overlay-unsupported-clip",
                    $"Timeline'da yinelenen klip kimliği var: {clip.Id} — bu kimlikten iki "
                    + "overlay rasteri doğar ve hangisinin çizileceği belirsiz kalır.");
            }
        }

        if (trackPlans.Count == 0)
        {
            throw new InvalidTimelineException("timeline has no clips — nothing to export.");
        }

        if (totalDurationUs <= 0)
        {
            throw new InvalidTimelineException("timeline duration is shorter than one output frame.");
        }

        var plan = new ExportPlan(
            doc, trackPlans, sourceRangeClips, assetIds.Distinct().ToList(), rasterClips,
            totalDurationUs, fpsNum, fpsDen, width, height, lutAssetIds.Distinct().ToList())
        {
            UnmeasuredTextClipIds = geometry.Unmeasured,
            AssetUses = assetUses,
        };

        // Plan HAZIR olduktan sonra sorulabilen iki kapı. İkisi de plana bakar (defterler
        // atıl/gizli klipleri zaten elemiştir) ve ikisi de Compile'da bir KEZ DAHA koşar —
        // orada olgular ffprobe'dan gelir, burada DB'den. Aynı hesabın iki kez yazılması
        // DEĞİL, aynı fonksiyonun iki farklı veri kaynağıyla çağrılmasıdır.
        EnsureAssetFacts(plan, assets);
        EnsureSampleBudget(plan, assets);
        return plan;
    }

    /// <summary>
    /// Derleme: plan + asset kaynak yolları + metin/şekil rasterleri + profil → deterministik
    /// CompiledExport. sources her plan.AssetIds öğesi, rasters her plan.RasterClips öğesi için
    /// dolu olmalıdır (worker garanti eder).
    /// </summary>
    public static CompiledExport Compile(
        TimelineDoc doc,
        IReadOnlyDictionary<Guid, ExportAssetSource> sources,
        ExportProfile profile,
        IReadOnlyDictionary<Guid, ExportRasterSource>? rasters = null)
    {
        var plan = Validate(doc);
        foreach (var assetId in plan.AssetIds)
        {
            if (!sources.ContainsKey(assetId))
            {
                throw new ArgumentException(
                    $"no source provided for asset {assetId}.", nameof(sources));
            }
        }

        foreach (var rasterClip in plan.RasterClips)
        {
            if (rasters is null || !rasters.ContainsKey(rasterClip.Id))
            {
                throw new ArgumentException(
                    $"no raster provided for {rasterClip.Kind} clip {rasterClip.Id}.", nameof(rasters));
            }
        }

        // LUT dosyaları (§4.2): worker plan.LutAssetIds'i indirip AYNI sources defterine yol
        // olarak koyar. Eksikse bu KULLANICI hatasıdır (silinmiş/başkasına ait .cube) —
        // ArgumentException değil TİPLİ hata, çünkü 422/failed mesajı kullanıcıya gider.
        foreach (var lutAssetId in plan.LutAssetIds)
        {
            if (!sources.ContainsKey(lutAssetId))
            {
                throw new UnsupportedFeatureException("lut-asset",
                    $"Timeline'da kullanılan LUT dosyası (asset {lutAssetId}) bulunamadı — "
                    + "LUT varlığı silinmiş olabilir. Efekti kaldırın ya da LUT'u yeniden yükleyin.");
            }
        }

        var fpsArg = TimeFormat.Fps(plan.FpsNum, plan.FpsDen);
        var background = FfmpegColor(plan.Doc.Settings.BackgroundColor);
        var inputs = new List<ExportInput>();
        var videoLines = new List<string>();
        var audioLines = new List<string>();
        var runs = new List<LayerRun>();
        var audioGroups = new List<AudioGroup>();
        var totalFrames = FrameOf(plan.TotalDurationUs, plan.FpsNum, plan.FpsDen);

        // ── 1) Girişleri aç + görsel klipleri KATMAN RUN'LARINA, sesleri GEÇİŞ GRUPLARINA topla.
        //      Giriş sırası render sırasıdır (plan.Tracks sondan başa: en alt katman önce).
        foreach (var trackPlan in plan.Tracks)
        {
            LayerRun? open = null;
            AudioGroup? openAudio = null;
            for (var i = 0; i < trackPlan.Clips.Count; i++)
            {
                var clip = trackPlan.Clips[i];

                // Atıl klip (gizli track + şema gereği sessiz): giriş bile açılmaz, asset'i
                // plan.AssetIds'te de yoktur — sources[] araması YAPILMAZ.
                if (IsInert(clip, trackPlan.Track))
                {
                    open = null;
                    openAudio = null;
                    continue;
                }

                var asset = clip.NeedsServerRaster ? null : sources[clip.AssetId!.Value];
                var raster = clip.NeedsServerRaster ? rasters![clip.Id] : null;
                var path = raster?.Path ?? asset!.Path;

                // hidden = YALNIZ görsel gizleme (resolve.ts semantiği): ses üretilmeye devam eder.
                var isVisual = !trackPlan.Track.Hidden && clip.Kind != ExportClipKind.Audio;
                var audio = AudibleAudioOf(clip, trackPlan.Track, asset);
                if (!isVisual && audio is null)
                {
                    open = null;
                    openAudio = null;
                    continue; // ne görüntü ne ses — giriş bile açılmaz
                }

                var startFrame = FrameOf(clip.TimelineStartUs, plan.FpsNum, plan.FpsDen);
                var endFrame = FrameOf(clip.TimelineEndUs, plan.FpsNum, plan.FpsDen);
                var startUs = UsOf(startFrame, plan.FpsNum, plan.FpsDen);
                var clipFrames = endFrame - startFrame;

                // Giriş, geçiş paylarıyla birlikte açılır (§5.2 handle); hangi ORTAMIN payı
                // gerçekten kullanacağı aşağıda belli olur, kullanmayan ortam geri kırpılır.
                var inputFrames = clip.HeadInFrames + clipFrames + clip.HeadOutFrames;
                var inputIndex = inputs.Count;
                inputs.Add(InputFor(clip, path, inputFrames, plan));

                var previous = i > 0 ? trackPlan.Clips[i - 1] : null;

                if (isVisual)
                {
                    var placement = PlacementOf(clip, asset, raster, plan);

                    // Geçiş kesimi VİDEODA onurlandırılır mı? Ancak önceki klip de görselse ve
                    // run'ın son segmentiyse — aksi halde kesim sıradan bir kesimdir.
                    var joined = clip.TransitionIn is not null
                                 && open is { } o
                                 && o.EndFrame == startFrame
                                 && o.Segments[^1].Clip.Id == previous?.Id;

                    if (joined && open!.Placement != placement)
                    {
                        // xfade iki girişin AYNI boyutta olmasını şart koşar; farklı yerleşim
                        // sessizce kaydırmak yerine görünür sözleşme ihlalidir.
                        // SİGORTA: aynı soru artık Validate'te de sorulur
                        // (EnsureTransitionPlacement) — API 422'si oradan gelir, bu dal
                        // yalnız Compile'a doğrudan giren yolları (birim testleri) korur.
                        throw TransitionPlacementMismatch(previous!.Id, clip.Id);
                    }

                    if (joined && !CanNormalizeToBox(placement))
                    {
                        // Geçişte run BÖLÜNEMEZ, dolayısıyla kutuya normalize pad ZORUNLUDUR.
                        // Bu pad, çapayı DÖNDÜRÜLEN katmanda koruyamaz: §2.5'in çapa telafisi
                        // pad'i gerçek görüntü boyutuna (iw/ih) göre ölçeklenir, normalize
                        // sonrası iw kutu boyutudur → çapa, içeriğin letterbox payı kadar kayar.
                        // Sessizce kaydırmak yerine görünür hata (M4 dalga 1 denetiminin
                        // "1 px sessiz kayma" kararının aynısı).
                        //
                        // GERİYE KALAN TEK GEREKÇE BUDUR: kutu paritesi artık kapı değil (pad
                        // hedefi NormalizeBox* ile çifte indirildi), o yüzden buraya düşen klipte
                        // rotationDeg≠0 VE çapa≠merkez olduğu KESİNDİR.
                        // SİGORTA: aynı soru artık Validate'te de sorulur (EnsureTransitionPlacement).
                        throw TransitionRotatedAnchor(clip.Id);
                    }

                    // KEYFRAME'li klip KENDİ run'ında yaşar (M5): run tuvale TEK overlay ile
                    // biner ve o overlay'in konum/ölçek ifadesi RUN BAŞINA tektir — animasyonlu
                    // bir klip komşularıyla aynı akışa katılırsa animasyon komşuya da sızardı.
                    // Ayrıca animasyonlu ölçekte segment boyutu kare kare değişir, concat ise
                    // sabit boyut ister.
                    var animated = clip.Animation.Any;
                    if (joined)
                    {
                        open!.EndFrame = endFrame;
                    }
                    else if (animated || open is null || open.EndFrame != startFrame
                             || open.Placement != placement || !CanConcatRun(placement))
                    {
                        open = new LayerRun(placement, startFrame) { EndFrame = endFrame };
                        runs.Add(open);
                    }
                    else
                    {
                        open.EndFrame = endFrame;
                    }

                    // Videonun kullandığı baş payı: yalnız onurlandırılan kesimde. Kullanılmayan
                    // pay girişte AÇILDIĞI için zincirde trim=start_frame ile atlanır.
                    var videoHeadIn = joined ? clip.HeadInFrames : 0;
                    if (joined)
                    {
                        // Kesimin ÖTEKİ yanı: önceki segment kendi kuyruk payını şimdi kazanır
                        // (aynı D/2 — simetri invariant'ı bunu garanti eder).
                        open!.Segments[^1].Frames += clip.HeadInFrames;
                    }

                    open!.Segments.Add(new LayerSegment
                    {
                        InputIndex = inputIndex,
                        Clip = clip,
                        Asset = asset,
                        Raster = raster,
                        StartFrame = clip.HeadInFrames - videoHeadIn,
                        Frames = videoHeadIn + clipFrames,
                        EnteringTransition = joined ? clip.TransitionIn : null,
                        LutPath = clip.Effects.Lut is { } lutEffect
                            ? sources[lutEffect.AssetId].Path
                            : null,
                    });

                    if (animated)
                    {
                        open = null; // sonraki klip bu run'a KATILAMAZ
                    }
                }
                else
                {
                    open = null; // görsel süreklilik kırıldı (ses klibi / gizli track)
                }

                if (audio is not null)
                {
                    // Geçiş kesimi SESTE onurlandırılır mı? Ancak önceki klip de DUYULABİLİRSE.
                    var joinedAudio = clip.TransitionIn is not null
                                      && openAudio is { } g
                                      && g.Segments[^1].Clip.Id == previous?.Id;
                    if (!joinedAudio)
                    {
                        openAudio = new AudioGroup(startUs);
                        audioGroups.Add(openAudio);
                    }

                    var audioHeadIn = joinedAudio ? clip.HeadInUs : 0;
                    if (joinedAudio)
                    {
                        openAudio!.Segments[^1].HeadOutUs = clip.HeadInUs;
                    }

                    openAudio!.Segments.Add(new AudioSegment
                    {
                        InputIndex = inputIndex,
                        Clip = clip,
                        Audio = audio,
                        PrevClip = previous?.Media,
                        NextClip = i + 1 < trackPlan.Clips.Count ? trackPlan.Clips[i + 1].Media : null,
                        HeadInUs = audioHeadIn,
                        EnteringTransition = joinedAudio ? clip.TransitionIn : null,
                    });
                }
                else
                {
                    openAudio = null;
                }
            }
        }

        // Örnekleme tavanı DERLEME GENELİNDEDİR (görsel + ses keyframe'leri aynı bütçeyi paylaşır)
        // — ses zinciri de §3.4'ün frame örneklemesini kullanır (volume keyframe'i, §8.1).
        // Bütçe nesnesi TAZEDİR: Validate aynı hesabı kendi nesnesiyle ZATEN yaptı (senkron
        // kapı). Buradaki koşum sigortadır — Compile'a doğrudan giren yollar (birim testleri,
        // worker'ın defter olmadan çağırdığı Validate sonrası derleme) için.
        var sampleBudget = new SampleBudget();
        foreach (var group in audioGroups)
        {
            audioLines.Add(EmitAudioGroup(group, audioLines.Count, plan, sampleBudget));
        }

        // ── 1b) Animasyon defterleri (§3.4). EĞRİLİ (non-linear easing) kanallar frame başına
        //      örneklenip sendcmd komutlarına çevrilir; TAMAMI LİNEER kanallar ifadeyle çözülür
        //      ve buradan hiç komut çıkmaz.
        for (var n = 0; n < runs.Count; n++)
        {
            BuildAnimationCommands(runs[n], n, plan, sampleBudget);
        }

        // ── 2) Video grafiği. Tek katmanlı hızlı yol: TEK run timeline'ı baştan sona kaplıyor,
        //      yerleşim birim, opaklık 1 → kompozisyon YOK, dolayısıyla taban tuval ve overlay
        //      de yok (M3 hattı: scale + letterbox pad + concat/xfade).
        //      ANİMASYON hızlı yolu KAPATIR: yerleşim kare kare değişiyorsa "tuvali baştan sona
        //      kaplıyor" varsayımı düşer, opaklık animasyonu ise alfa taşıyan bir kompozisyon
        //      ister (hızlı yol yuv420p'dir, alfa yoktur).
        var singleCover = runs.Count == 1
            && runs[0].StartFrame == 0
            && runs[0].EndFrame == totalFrames
            && CoversCanvas(runs[0].Placement, plan.Width, plan.Height)
            && runs[0].Segments.All(s => s.Clip.Opacity >= 1d && !s.Clip.Animation.Any);

        string composite;
        if (singleCover)
        {
            composite = EmitRun(videoLines, runs[0], plan, fpsArg, background, opaque: true, 0);
        }
        else
        {
            // ── Taban tuval: proje çözünürlüğünde, TAM toplam frame sayısı kadar (frame defteri).
            //    color d= bir frame CÖMERT verilir; trim=end_frame kesin sayıyı garanti eder
            //    (d'nin µs yuvarlaması kaynak frame sayısını belirleyemez).
            var canvasHeadroomUs = UsOf(totalFrames + 1, plan.FpsNum, plan.FpsDen);
            //    Tuval RGB'dir: kompozisyon RGB'de yapılır (§6.3) ve settings.backgroundColor zaten
            //    RGB hex'tir — araya yuv420p sokmak arka plan rengini gereksizce yuvarlardı.
            videoLines.Add(
                $"color=c={background}:s={plan.Width}x{plan.Height}:r={fpsArg}:d={TimeFormat.Sec(canvasHeadroomUs)},"
                + $"trim=end_frame={totalFrames.ToString(CultureInfo.InvariantCulture)},"
                + "format=rgba,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[base]");

            // enable penceresinin bitişi yarım frame geri çekilir: bitişik iki run'da aynı t
            // değeri iki overlay'i birden tetiklemesin (tasarım 04 §8 tuzak 9).
            var halfFrameUs = UsOf(1, plan.FpsNum, plan.FpsDen) / 2;

            composite = "base";
            for (var n = 0; n < runs.Count; n++)
            {
                var run = runs[n];
                var label = EmitRun(videoLines, run, plan, fpsArg, background, opaque: false, n);
                var next = $"c{n.ToString(CultureInfo.InvariantCulture)}";
                var startUs = UsOf(run.StartFrame, plan.FpsNum, plan.FpsDen);
                var endEnableUs = UsOf(run.EndFrame, plan.FpsNum, plan.FpsDen) - halfFrameUs;

                // Konum animasyonu overlay'e İFADE olarak girer, sendcmd ile DEĞİL: overlay iki
                // girişli bir filtredir ve framesync ile tamponlar — komut, tuval karesi
                // sendcmd'den geçtiği anda gönderilse bile o kare overlay'e gecikmeli girer ve
                // konum kayar (ölçüm: 60 karenin 22-39'u yanlış konumda; ayrıntı
                // KeyframeCompiler.StepExpression yorumunda).
                videoLines.Add(
                    $"[{composite}][{label}]overlay="
                    + $"x={OverlayCoordinateFor(run, horizontal: true)}"
                    + $":y={OverlayCoordinateFor(run, horizontal: false)}"
                    + $":enable='between(t,{TimeFormat.Sec(startUs)},{TimeFormat.Sec(endEnableUs)})'"
                    + ":eval=frame"
                    // §6.3: kompozisyon DAİMA RGB'de — grafik başına tek mod (denetim #1/#15).
                    + CompositeFormat
                    + $"[{next}]");
                composite = next;
            }
        }

        // Kompozisyon SONRASI setparams frame'leri BT.709/tv işaretler — ffmpeg 7+/8 çıktı renk
        // tag'lerini filtergraph frame metadata'sından alır; CLI -color_* bayrakları tek başına
        // EZİLİR (bayraklar emniyet kemeri olarak profilde durmaya devam eder).
        videoLines.Add($"[{composite}]" + OutputColorParams + "[vout]");

        var lines = new List<string>(videoLines.Count + audioLines.Count + 1);
        lines.AddRange(videoLines);
        lines.AddRange(audioLines);

        // Ses: parçalar amix=normalize=0 + alimiter (rendering-semantics §8.3); hiç ses yoksa
        // toplam süre kadar sessizlik (anullsrc sonsuzdur — atrim şart).
        if (audioLines.Count > 0)
        {
            lines.Add(
                string.Concat(Enumerable.Range(0, audioLines.Count).Select(i => $"[a{i}]"))
                + $"amix=inputs={audioLines.Count.ToString(CultureInfo.InvariantCulture)}"
                + ":duration=longest:normalize=0,alimiter=limit=0.98[aout]");
        }
        else
        {
            lines.Add(
                "anullsrc=channel_layout=stereo:sample_rate=48000,"
                + $"atrim=duration={TimeFormat.Sec(plan.TotalDurationUs)}[aout]");
        }

        return new CompiledExport(
            inputs,
            string.Join(";\n", lines),
            ExportProfiles.BuildOutputArgs(profile, plan.FpsNum, plan.FpsDen),
            plan.TotalDurationUs);
    }

    // ───────────────────────── Katman run'ları ─────────────────────────

    /// <summary>
    /// Run içindeki tek klip: hangi giriş, hangi kaynak, GENİŞLETİLMİŞ girişin hangi frame
    /// aralığı. <see cref="EnteringTransition"/> doluysa bu segment bir öncekine xfade ile
    /// bağlanır (concat değil).
    /// </summary>
    private sealed class LayerSegment
    {
        public required int InputIndex { get; init; }

        public required ExportClipPlan Clip { get; init; }

        public required ExportAssetSource? Asset { get; init; }

        public required ExportRasterSource? Raster { get; init; }

        /// <summary>Genişletilmiş girişte videonun BAŞLADIĞI frame (kullanılmayan baş payı atlanır).</summary>
        public required long StartFrame { get; init; }

        /// <summary>Video frame sayısı — kuyruk payı sonraki segment katıldığında EKLENİR.</summary>
        public required long Frames { get; set; }

        public Transition? EnteringTransition { get; init; }

        /// <summary>LUT (.cube) dosyasının worker'daki yerel yolu; efekt yoksa null (§4.2).</summary>
        public string? LutPath { get; init; }
    }

    /// <summary>
    /// Aynı track'te ARDIŞIK (frame-bitişik) ve AYNI yerleşimli kliplerin oluşturduğu tek katman
    /// akışı. Segmentler tek concat zincirinde birleşir (geçiş varsa xfade ile) → tuvale TEK
    /// overlay biner. Klip başına overlay yalnız gerçek katmanlaşmada üretilir (M4 dalga 1
    /// denetimi: performans regresyonu).
    /// </summary>
    private sealed record LayerRun(LayerPlacement Placement, long StartFrame)
    {
        public long EndFrame { get; set; }

        public List<LayerSegment> Segments { get; } = [];

        /// <summary>Animasyon defteri — animasyonsuz run'da <see cref="RunAnimation.None"/>.</summary>
        public RunAnimation Animation { get; set; } = RunAnimation.None;

        /// <summary>Animasyonlu run TEK segmentlidir (Compile bunu garanti eder).</summary>
        public ExportClipPlan? AnimatedClip =>
            Segments.Count == 1 && Segments[0].Clip.Animation.Any ? Segments[0].Clip : null;
    }

    /// <summary>
    /// Bir run'ın DERLENMİŞ animasyonu: parametre başına hazır ffmpeg ifadesi (null = statik)
    /// + opaklık için sendcmd komutları.
    /// </summary>
    private sealed record RunAnimation
    {
        public static readonly RunAnimation None = new();

        /// <summary>overlay x/y — KOMPOZİT eksende <c>t</c> ifadesi (tırnaklı, virgül içerir).</summary>
        public string? OverlayX { get; init; }

        public string? OverlayY { get; init; }

        /// <summary>scale w/h ve rotate a — KLİP ekseninde <c>t</c> ifadesi.</summary>
        public string? ScaleWidth { get; init; }

        public string? ScaleHeight { get; init; }

        public string? Rotation { get; init; }

        /// <summary>
        /// Opaklık: <c>colorchannelmixer</c> ZAMAN İFADESİ ALMAZ (tasarım 04 §2.5 "opaklık
        /// ffmpeg'in zayıf noktası") → tek yol sendcmd'dir. Komut AYNI LİNEER ZİNCİRDEKİ
        /// filtreye gider, o yüzden kare-kesindir (bkz. KeyframeCompiler.StepExpression yorumu).
        /// </summary>
        public IReadOnlyList<string> OpacityCommands { get; init; } = [];

        public string OpacityTag { get; init; } = "";

        public double OpacityInitial { get; init; } = 1d;
    }

    // ───────────────── Asset olgularına dayanan kapılar (senkron) ─────────────────

    /// <summary>
    /// Kaynak-aralığı kuralının TEK tanımı: klip <paramref name="assetId"/>'nin süresinin
    /// ötesini okuyamaz (+1 çıktı frame'i toleransı). Aşan klip ffmpeg'de sessiz kısa segment /
    /// donmuş kare üretir. Defter (<see cref="ExportPlan.Clips"/>) geçiş paylarını ZATEN
    /// içerir — geçişli klip kaynağından D/2 fazla okur.
    /// <para>
    /// İki çağıran vardır ve aynı fonksiyonu FARKLI veri kaynağıyla çağırırlar:
    /// API senkron kapıda <c>Asset.DurationMicros</c> ile, worker indirdiği dosyanın ffprobe
    /// süresiyle. İki sayı YAPISI GEREĞİ aynıdır (ikisi de aynı orijinalin
    /// <c>MediaProbe.DurationUs</c>'u), o yüzden kapılar çelişemez.
    /// </para>
    /// </summary>
    /// <returns>İhlal eden ilk klip; ihlal yoksa (ya da süre bilinmiyorsa) null.</returns>
    public static MediaClip? FindSourceOutOfRange(
        IReadOnlyList<MediaClip> clips, Guid assetId, long? probeDurationUs, int fpsNum, int fpsDen)
    {
        ArgumentNullException.ThrowIfNull(clips);
        if (probeDurationUs is not { } durationUs)
        {
            return null; // süre ölçülemedi — gate atlanır
        }

        var toleranceUs = Timecode.FromFrameNumber(1, fpsNum, fpsDen).Micros; // 1 çıktı frame'i
        return clips.FirstOrDefault(c => c.AssetId == assetId && c.SourceOutUs > durationUs + toleranceUs);
    }

    /// <summary>
    /// LUT varlığının dosya adı gerçekten bir <c>.cube</c> mi? Domain'de LUT diye bir
    /// <c>AssetKind</c> YOKTUR (yükleme whitelist'i .cube'ü bir medya
    /// content-type'ıyla kabul eder), o yüzden tek ayırt edici uzantıdır.
    /// </summary>
    private static bool IsCubeFile(string? fileName) =>
        fileName is not null
        && fileName.EndsWith(".cube", StringComparison.OrdinalIgnoreCase);

    /// <summary>Varlık türünün kullanıcıya gösterilecek Türkçe adı (422 mesajları).</summary>
    private static string MediaKindTr(ExportAssetMediaKind kind) => kind switch
    {
        ExportAssetMediaKind.Video => "video",
        ExportAssetMediaKind.Audio => "ses",
        ExportAssetMediaKind.Image => "görsel",
        _ => "bilinmeyen tür",
    };

    /// <summary>Dosya adı biliniyorsa mesaja iliştirilecek ek (bilinmiyorsa boş).</summary>
    private static string FileNameNote(string? fileName) =>
        string.IsNullOrWhiteSpace(fileName) ? "" : $" — '{fileName}'";

    /// <summary>
    /// SENKRON YARI: kullanımın istediği akış, DB satırının BEYAN ettiği türle çelişiyor mu?
    /// Worker yarısı aynı soruyu ffprobe olgularıyla sorar (<see cref="ExportAssetUse.UnmetBy"/>).
    /// </summary>
    private static bool IsTypeMismatch(ExportSourceNeed need, ExportAssetFacts facts) => need switch
    {
        // Aralık okuyan görüntü girişi ancak zaman eksenli bir görüntü kaynağından gelir.
        ExportSourceNeed.Motion => facts.MediaKind != ExportAssetMediaKind.Video,

        // -loop 1 girişi durağan bir görselden gelir; video/ses dosyası ffmpeg'i düşürür.
        ExportSourceNeed.Still => facts.MediaKind != ExportAssetMediaKind.Image,

        // Ses akışı: ses varlığında GARANTİDİR (GateByKind), görselde YOKTUR, videoda ise
        // ancak PROBE EDİLMİŞ (Ready) satırda kesin bilinir.
        ExportSourceNeed.Audio => facts.MediaKind == ExportAssetMediaKind.Image
            || (facts.MediaKind == ExportAssetMediaKind.Video
                && facts is { Readiness: ExportAssetReadiness.Ready, HasAudio: false }),

        _ => false,
    };

    /// <summary>Uyuşmazlığın NEDEN uyuşmazlık olduğunu söyleyen cümle.</summary>
    private static string NeedNoteTr(ExportSourceNeed need, ExportAssetFacts facts) => need switch
    {
        ExportSourceNeed.Motion =>
            "video klibi kaynaktan bir zaman aralığı okur, bunun için dosyanın zaman eksenli "
            + "bir görüntü akışı olması gerekir.",
        ExportSourceNeed.Still =>
            "görsel/çıkartma klibi dosyayı tek kare olarak açar, bunun için dosyanın durağan "
            + "bir görsel olması gerekir.",
        _ => facts.MediaKind == ExportAssetMediaKind.Video
            ? "ses klibi yalnız ses akışını kullanır, ama bu videonun ses akışı yok."
            : "ses klibi yalnız ses akışını kullanır, bu dosyada ses akışı yok.",
    };

    /// <summary>
    /// ASSET OLGULARINA dayanan senkron kapılar. HEPSİ eskiden YALNIZ worker'daydı
    /// (<c>ExportJob.Run</c> adım 2/4) — yani belge 202 alıyor, iş kuyruğa giriyor ve dakikalar
    /// sonra "başarısız" oluyordu; LUT tür kontrolü ise HİÇ yoktu (lut3d bir .mp4 yolu alıyor,
    /// ffmpeg <c>-22</c> ile ölüyordu: tipli hata bile üretilmiyordu). Hepsi SAF DB
    /// ARİTMETİĞİDİR ve API o satırları ZATEN sorguluyor.
    /// <para>
    /// Defter null (worker yolu) ise hiçbiri koşmaz: worker'ın kendi yarısı (satır+Ready
    /// kontrolü, ffprobe süresi/akışları) yerinde durur.
    /// </para>
    /// </summary>
    private static void EnsureAssetFacts(
        ExportPlan plan, IReadOnlyDictionary<Guid, ExportAssetFacts>? assets)
    {
        if (assets is null)
        {
            return;
        }

        // ── 1) VARLIK MEVCUDİYETİ. Defterde olmayan id = kullanıcının kütüphanesinde böyle bir
        //      satır yok (silinmiş / başkasının / hiç var olmamış). Bu KALICI bir durumdur:
        //      asset satırı yüklemenin İLK adımında yaratılır, soft-delete geri alınmaz →
        //      "birazdan görünür" diye bir ihtimal yoktur, senkron ret güvenlidir.
        //      (asset-not-ready BİLEREK burada DEĞİLDİR: işlenmekte olan bir asset worker'a
        //      gelene kadar Ready olabilir; senkron reddi YANLIŞ RET olurdu.)
        var missing = plan.AssetIds.Concat(plan.LutAssetIds)
            .Distinct()
            .Where(id => !assets.ContainsKey(id))
            .ToList();
        if (missing.Count > 0)
        {
            throw new UnsupportedFeatureException("asset-missing",
                "Timeline artık var olmayan bir dosyayı kullanıyor (asset "
                + string.Join(", ", missing) + "): varlık silinmiş ya da bu hesaba ait değil. "
                + "İlgili klipleri timeline'dan kaldırın ya da dosyayı yeniden yükleyin.");
        }

        // ── 2) TERMİNAL BAŞARISIZLIK. 'asset-not-ready' worker'da kalır ama DÖRT durumdan
        //      yalnız ÜÇÜ oraya AİTTİR: Uploading/Uploaded/Processing GEÇİCİDİR (iş kuyruktan
        //      alınana kadar Ready olabilirler, senkron ret yanlış ret olurdu). Failed ise
        //      TERMİNALDİR — domain'in durum makinesinde Failed'dan Ready'ye doğrudan geçiş
        //      yoktur; yeniden deneme ancak kullanıcının başlattığı Failed → Processing
        //      geçişiyle olur. Ölçüldü: böyle bir belge 202 alıyor ve iş dakikalar sonra
        //      'asset-not-ready: ... (Failed)' ile ölüyordu (M6 denetimi, N2).
        foreach (var assetId in plan.AssetIds.Concat(plan.LutAssetIds).Distinct())
        {
            if (assets[assetId].Readiness != ExportAssetReadiness.Failed)
            {
                continue;
            }

            throw new UnsupportedFeatureException("asset-failed",
                $"Timeline, işlenemeyen bir dosyayı kullanıyor (asset {assetId}"
                + $"{FileNameNote(assets[assetId].FileName)}): dosyanın yüklenmesi ya da "
                + "işlenmesi kalıcı olarak başarısız oldu, bu haliyle dışa aktarılamaz. "
                + "İlgili klipleri timeline'dan kaldırın ya da dosyayı yeniden yükleyin.");
        }

        // ── 3) LUT DOSYA TÜRÜ. lut3d yalnız .cube okur; başka bir dosya verildiğinde ffmpeg
        //      grafiği kurarken -22 ile ölür ve kullanıcı TİPLİ hata bile görmez (ölçüldü).
        foreach (var lutAssetId in plan.LutAssetIds)
        {
            if (IsCubeFile(assets[lutAssetId].FileName))
            {
                continue;
            }

            var owner = plan.Tracks
                .SelectMany(t => t.Clips)
                .FirstOrDefault(c => c.Effects.Lut?.AssetId == lutAssetId);
            throw new UnsupportedFeatureException("lut-asset-type",
                $"'{owner?.Id.ToString() ?? lutAssetId.ToString()}' klibindeki LUT efekti "
                + $".cube olmayan bir dosyayı gösteriyor ('{assets[lutAssetId].FileName}'). "
                + "LUT bir renk arama tablosudur (.cube); dışa aktarıcı başka bir dosyayı "
                + "renk tablosu olarak okuyamaz. Efekti kaldırın ya da bir .cube dosyası "
                + "yükleyip onu seçin.");
        }

        // ── 4) KLİP TÜRÜ ↔ VARLIK TÜRÜ. Sınıfı LUT kapısıyla BİREBİR aynıdır (dosya türü ile
        //      onu kullanan klibin beklentisi çelişiyor) ve o kural zaten senkrondur.
        //      Ölçüldü (M6 denetimi): (a) ses klibi bir SES varlığını gösterdiğinde export
        //      'unsupported-media: ... has no video stream' ile ölüyordu — worker klip türüne
        //      BAKMADAN her varlıkta görüntü akışı arıyordu, yani müzik eklemek export'u
        //      imkânsız kılıyordu (N1); (b) çıkartma klibi bir VİDEO varlığını gösterdiğinde
        //      ffmpeg 'exited with code -1414549496' veriyordu — kullanıcıya tipli hata bile
        //      gitmiyordu (N3).
        //
        //      TÜR BEYANI GEÇİCİ DURUMDA DA SORULABİLİR ve bu yanlış ret ÜRETMEZ: beyan
        //      yükleme anında yapılır, worker işleme sonunda beyanı ffprobe ile karşılaştırır
        //      (ProcessAssetJob.GateByKind) ve tutmuyorsa asset Ready OLAMAZ. Yani beyanla
        //      çelişen bir belgenin başarıya giden yolu yoktur. TEK İSTİSNA ses akışıdır:
        //      "video varlığının sesi var mı" olgusu ancak probe'dan sonra yazılır, o yüzden
        //      yalnız Ready satırda sorulur.
        foreach (var use in plan.AssetUses)
        {
            var facts = assets[use.AssetId];
            if (facts.MediaKind == ExportAssetMediaKind.Unknown || !IsTypeMismatch(use.Need, facts))
            {
                continue;
            }

            throw new UnsupportedFeatureException("asset-clip-type",
                $"'{use.ClipId}' klibi bir {use.ClipKindTr} klibi ama gösterdiği dosya "
                + $"{MediaKindTr(facts.MediaKind)} türünde{FileNameNote(facts.FileName)}: "
                + NeedNoteTr(use.Need, facts)
                + " Klibi timeline'dan kaldırın ya da türüne uygun bir dosya seçin.");
        }

        // ── 5) KAYNAK ARALIĞI. Defter (plan.Clips) geçiş paylarını uygulanmış halde taşır.
        foreach (var assetId in plan.AssetIds)
        {
            if (FindSourceOutOfRange(
                    plan.Clips, assetId, assets[assetId].DurationMicros,
                    plan.FpsNum, plan.FpsDen) is not { } outOfRange)
            {
                continue;
            }

            // Geçiş payı, kullanıcının timeline'da GÖRMEDİĞİ bir uzatmadır — mesaj bunu
            // söylemezse "klibim kaynağın içinde duruyor, neden reddedildi" sorusu doğar.
            var handleUs = plan.Tracks.SelectMany(t => t.Clips)
                .FirstOrDefault(c => c.Id == outOfRange.Id)?.HeadOutSourceUs ?? 0;
            var handleNote = handleUs > 0
                ? $" (bu klibin sonundaki geçiş, kaynaktan {handleUs.ToString(CultureInfo.InvariantCulture)}"
                  + " us FAZLA okunmasını gerektiriyor)"
                : "";

            throw new UnsupportedFeatureException("source-out-of-range",
                $"'{outOfRange.Id}' klibi kaynağın sonunun ötesini okuyor: "
                + $"{outOfRange.SourceOutUs.ToString(CultureInfo.InvariantCulture)} us'e kadar "
                + $"isteniyor ama varlık {assetId} yalnız "
                + $"{assets[assetId].DurationMicros!.Value.ToString(CultureInfo.InvariantCulture)} "
                + $"us uzunluğunda{handleNote}. Klibi sağ kenarından kısaltın"
                + (handleUs > 0 ? " ya da kesimdeki geçişi kaldırın/kısaltın." : "."));
        }
    }

    // ───────────────── Keyframe örnekleme bütçesi (§3.4, PAYLAŞILAN) ─────────────────

    /// <summary>
    /// Derleme genelindeki örnekleme bütçesinin TEK muhasebecisi. Sayaç bir <c>int</c> yerine
    /// nesne olmasının sebebi mesajdır: aşımı bildiren cümle "önümde kaç klip ne kadar harcadı"
    /// bilgisini taşımak ZORUNDADIR (aksi halde kullanıcıya, ölçülerek görüldüğü gibi, 60 000'in
    /// yanında hiçbir şey olan 600 örneklik masum bir klip suçlanır ve o klibi kısaltmak sorunu
    /// çözmez). Aynı nesne <see cref="Validate"/> kapısında ve <see cref="Compile"/> yayınında
    /// kullanılır — iki yol aynı sırayla harcar, aynı cümleyi üretir.
    /// </summary>
    private sealed class SampleBudget
    {
        private readonly HashSet<Guid> _chargedClips = [];
        private int _spent;

        /// <summary>
        /// Kanalın örneklerini bütçeden düşer; sığmıyorsa tipli hata fırlatır.
        /// Eşik ORİJİNAL biçimin birebir aynısıdır: <c>samples &gt; kalan</c>.
        /// </summary>
        public void Charge(Guid clipId, int samples, string channelTr, string action)
        {
            if (_spent + samples > KeyframeCompiler.MaxSamples)
            {
                throw SampleBudgetExceeded(
                    clipId, samples, _spent, _chargedClips.Count, channelTr, action);
            }

            _spent += samples;
            _chargedClips.Add(clipId);
        }
    }

    /// <summary>Görsel (x/y/scale/rotation/opacity) kanalların mesajdaki adı.</summary>
    private const string VisualChannelTr = "keyframe animasyonu";

    /// <summary>Ses seviyesi kanalının mesajdaki adı.</summary>
    private const string VolumeChannelTr = "ses seviyesi (volume) animasyonu";

    /// <summary>
    /// GÖRSEL kanalın İŞE YARAYAN eylemi. Ölçülebilir gerekçe: tamamı lineer bir kanal
    /// <see cref="KeyframeCompiler.LinearExpression"/> ile KAPALI FORMA derlenir ve
    /// bütçeden SIFIR harcar (bkz. <c>Expression</c> içindeki <c>AllLinear</c> dalı) —
    /// yani easing'i lineere çevirmek klibin katkısını tamamen SİLER.
    /// </summary>
    private const string VisualBudgetAction =
        "İŞE YARAYAN EYLEM: eğrili (easing'li) keyframe'leri LİNEER yapın — lineer kanal "
        + "kapalı forma derlenir ve bütçeden HİÇ harcamaz. Yalnız bu klibi kısaltmak, "
        + "harcamanın çoğu BAŞKA kliplerdeyse yetmez.";

    /// <summary>
    /// SES kanalının İŞE YARAYAN eylemi — görselinkinden FARKLIDIR ve bu bilerek böyledir:
    /// ses zincirinde kapalı-form yol YOKTUR (<c>volume</c> ifade almaz, asendcmd ile sürülür),
    /// dolayısıyla "easing'i lineere çevirin" ses tarafında bütçeyi DÜŞÜRMEZ. Eskiden mesaj
    /// "keyframe sayısını azaltın" diyordu; örnekleme KARE başınadır, keyframe başına değil —
    /// o öneri de ölçülebilir biçimde işe yaramıyordu.
    /// </summary>
    private const string VolumeBudgetAction =
        "İŞE YARAYAN EYLEM: ses seviyesi keyframe'lerini daha AZ klipte kullanın (sabit "
        + "audio.volume bütçeden hiç harcamaz) ya da animasyonlu aralığı kısaltın. Bu kanalda "
        + "easing'i lineere çevirmek bütçeyi DÜŞÜRMEZ — ses zincirinde kapalı-form yol yoktur.";

    private static UnsupportedFeatureException SampleBudgetExceeded(
        Guid clipId, int samples, int spent, int chargedClips, string channelTr, string action)
    {
        var max = KeyframeCompiler.MaxSamples.ToString(CultureInfo.InvariantCulture);
        var wanted = samples.ToString(CultureInfo.InvariantCulture);

        // Bütçe henüz HİÇ harcanmamışsa "başka klipler tüketti" demek yalan olurdu.
        var reason = spent == 0
            ? $"tek başına {max} örneklik tavanı aşıyor ({wanted} örnek istiyor)."
            : $"ORTAK örnekleme bütçesini aşıyor: bu kanal {wanted} örnek istiyor ama "
              + $"{max} örneklik bütçenin {spent.ToString(CultureInfo.InvariantCulture)} "
              + $"kadarı ÖNCEKİ {chargedClips.ToString(CultureInfo.InvariantCulture)} klip "
              + "tarafından zaten harcanmıştı.";

        return new UnsupportedFeatureException("keyframe-sample-budget",
            $"'{clipId}' klibinin {channelTr} {reason} "
            + "Eğrili (easing'li) kanallar ve ses seviyesi kanalı KARE KARE örneklenir; bütçe "
            + "TEK BİR KLİBE DEĞİL, derlemedeki TÜM kliplere ve kanallara aittir. "
            + action);
    }

    /// <summary>
    /// Bir kanalın üreteceği örnek sayısı — <see cref="Compile"/>'ın çağırdığı
    /// <see cref="KeyframeCompiler.Samples"/>'ın AYNISI, yalnız sonucu atılır.
    /// <para>
    /// Frame aralığı olarak KLİBİN kendi aralığı verilir ve bu Compile'daki run aralığıyla
    /// ÖZDEŞTİR: animasyonlu klip DAİMA kendi run'ındadır (komşusu ona katılamaz) ve geçişli
    /// bir kesimde animasyon zaten yasaktır (<c>transition-keyframes</c>), yani run'ın
    /// başlangıç/bitiş frame'i klibinkinden farklı OLAMAZ. Ses tarafında zaten klip aralığı
    /// kullanılır. <c>offsetUs</c> yalnız komut zamanını kaydırır, SAYIYI değiştirmez → 0.
    /// </para>
    /// </summary>
    private static int SampleCount(AnimationTrack track, ExportClipPlan clip, ExportPlan plan) =>
        KeyframeCompiler.Samples(
            track, clip.TimelineStartUs,
            FrameOf(clip.TimelineStartUs, plan.FpsNum, plan.FpsDen),
            FrameOf(clip.TimelineEndUs, plan.FpsNum, plan.FpsDen),
            plan.FpsNum, plan.FpsDen, 0).Count;

    /// <summary>
    /// ÖRNEKLEME BÜTÇESİNİN SENKRON KAPISI. Kural eskiden yalnız <see cref="Compile"/>'daydı
    /// (<c>BuildAnimationCommands</c> + <c>BuildAudioChain</c>), API'nin ön kapısı onu
    /// görmüyordu ve böyle bir belge 202 alıp worker'da düşüyordu (ham API ile ölçüldü).
    /// Hesap SAF DOKÜMAN ARİTMETİĞİDİR: örnek sayısı yalnız keyframe'lere, klibin frame
    /// aralığına ve proje fps'ine bağlıdır.
    /// <para>
    /// TEK İSTİSNA ve onun EMNİYETLİ yönü: bir klibin <c>volume</c> zinciri ancak KAYNAKTA
    /// ses stream'i varsa kurulur; bu olgu dokümanda yoktur, defterden gelir. Defter yoksa ya
    /// da <c>HasAudio</c> false ise bu kapı o kanalı HİÇ SAYMAZ — eksik saymak kapıyı
    /// zayıflatır (Compile'daki sigorta yakalar), fazla saymak YANLIŞ RET üretirdi.
    /// </para>
    /// <para>
    /// Harcama SIRASI Compile'ınkiyle birebir aynıdır (önce ses grupları, sonra katman
    /// run'ları; her ikisi de track/klip sırasında) — aksi halde iki yol aynı belgede FARKLI
    /// klibi suçlardı.
    /// </para>
    /// </summary>
    private static void EnsureSampleBudget(
        ExportPlan plan, IReadOnlyDictionary<Guid, ExportAssetFacts>? assets)
    {
        var budget = new SampleBudget();

        // ── 1) SES: Compile audioGroups'u katman run'larından ÖNCE yayınlar.
        foreach (var trackPlan in plan.Tracks)
        {
            foreach (var clip in trackPlan.Clips)
            {
                if (clip.Animation.Volume is not { } volume
                    || DeclaredAudioOf(clip, trackPlan.Track) is null
                    || clip.AssetId is not { } assetId
                    || assets is null
                    || !assets.TryGetValue(assetId, out var facts)
                    || !facts.HasAudio)
                {
                    continue;
                }

                budget.Charge(
                    clip.Id, SampleCount(volume, clip, plan), VolumeChannelTr, VolumeBudgetAction);
            }
        }

        // ── 2) GÖRSEL: gizli track görsel katman üretmez, ses klibi de üretmez.
        foreach (var trackPlan in plan.Tracks)
        {
            foreach (var clip in trackPlan.Clips)
            {
                if (trackPlan.Track.Hidden || clip.Kind == ExportClipKind.Audio
                    || !clip.Animation.Any)
                {
                    continue;
                }

                ChargeVisualChannels(clip, plan, budget);
            }
        }
    }

    /// <summary>
    /// Bir animasyonlu klibin görsel kanallarını bütçeden düşer —
    /// <see cref="BuildAnimationCommands"/>'in ÖRNEKLEME KARARLARININ birebir aynası:
    /// TAMAMI LİNEER kanal kapalı forma gider (0 örnek), eğrili kanal kare kare örneklenir,
    /// opaklık ise <c>fade</c> hızlı yoluna düşmediği SÜRECE lineer olsa bile örneklenir
    /// (colorchannelmixer zaman ifadesi almaz).
    /// <para>
    /// <c>scale</c> İKİ KEZ sayılır ve bu bir hata değil, derleyicinin gerçeğidir:
    /// <c>ScaleWidth</c> ve <c>ScaleHeight</c> aynı kanalı ayrı ayrı örnekler. Kapı Compile'ın
    /// GERÇEK harcamasını taklit etmek zorundadır; "daha akıllı" sayan bir kapı, Compile'ın
    /// düşeceği bir belgeyi kabul ederdi.
    /// </para>
    /// </summary>
    private static void ChargeVisualChannels(
        ExportClipPlan clip, ExportPlan plan, SampleBudget budget)
    {
        var animation = clip.Animation;
        ChargeCurved(animation.X);
        ChargeCurved(animation.Y);
        ChargeCurved(animation.Scale); // ScaleWidth
        ChargeCurved(animation.Scale); // ScaleHeight
        ChargeCurved(animation.Rotation);

        if (animation.Opacity is { } opacity && OpacityFadeFilter(clip, 0) is null)
        {
            budget.Charge(
                clip.Id, SampleCount(opacity, clip, plan), VisualChannelTr, VisualBudgetAction);
        }

        void ChargeCurved(AnimationTrack? track)
        {
            if (track is { AllLinear: false })
            {
                budget.Charge(
                    clip.Id, SampleCount(track, clip, plan), VisualChannelTr, VisualBudgetAction);
            }
        }
    }

    /// <summary>
    /// Animasyonlu run'ın ifade/komut defterini kurar (rendering-semantics §3 + tasarım 04 §2.5).
    /// Kanal başına karar:
    ///  - TAMAMI LİNEER → keyframe'ler üstünde piecewise-linear <c>if</c> zinciri (tasarım 04
    ///    §2.5'in NORMATİF biçimi; iç içe geçme keyframe sayısı kadardır);
    ///  - EĞRİLİ (easing) → §3.2'nin sabit 32-iterasyon bisection'ıyla FRAME BAŞINA örneklenmiş
    ///    DEĞERLER, dengeli ikili karar ağacı ifadesine gömülür (§3.4'ün örnekleme kuralı;
    ///    sendcmd yerine ifade kullanma gerekçesi StepExpression yorumundadır).
    /// Opaklık ikisinden de ayrıdır: 0→1 / 1→0 lineer eğri <c>fade</c>'e map'lenir, diğer her
    /// şey aynı frame örneklemesiyle sendcmd komutlarına yazılır.
    /// </summary>
    private static void BuildAnimationCommands(
        LayerRun run, int index, ExportPlan plan, SampleBudget budget)
    {
        if (run.AnimatedClip is not { } clip)
        {
            return;
        }

        var animation = clip.Animation;
        var placement = run.Placement;
        var halfFrameUs = UsOf(1, plan.FpsNum, plan.FpsDen) / 2;

        run.Animation = new RunAnimation
        {
            // overlay x/y KOMPOZİT eksendedir (overlay'in t'si tuval karesinin zamanıdır).
            OverlayX = Coordinate(animation.X, plan.Width,
                placement.OverlayAnchorFactorX, "w"),
            OverlayY = Coordinate(animation.Y, plan.Height,
                placement.OverlayAnchorFactorY, "h"),
            // scale/rotate KLİP eksenindedir (zincirin başındaki setpts=PTS-STARTPTS sayesinde).
            ScaleWidth = Expression(animation.Scale, clipRelative: true,
                v => ScaleBoxWidth(run, plan) * v),
            ScaleHeight = Expression(animation.Scale, clipRelative: true,
                v => ScaleBoxHeight(run, plan) * v),
            Rotation = Expression(animation.Rotation, clipRelative: true,
                v => v * Math.PI / 180d),
        };

        if (animation.Opacity is { } opacity && OpacityFadeFilter(clip, 0) is null)
        {
            var tag = $"@k{index.ToString(CultureInfo.InvariantCulture)}";
            var samples = Sample(opacity, clipRelative: true);
            run.Animation = run.Animation with
            {
                OpacityTag = tag,
                OpacityInitial = opacity.Keys[0].Value,
                OpacityCommands =
                [
                    .. samples.Select(s => KeyframeCompiler.Command(
                        s.TimeUs, $"colorchannelmixer{tag}", "aa", Num(s.Value))),
                ],
            };
        }

        return;

        string? Coordinate(AnimationTrack? track, int size, double anchorFactor, string dimension)
        {
            // §2.5 adım 4: overlay_x = floor(P.x - anchor*w). P.x = W/2 + x*W.
            // floor STATİK yoldakiyle AYNI nedenle burada da zorunludur (bkz. FloorOverlay):
            // animasyon P'yi kare kare sürer, dolayısıyla hedefin işaret değiştirdiği pencereden
            // TEK BİR belgede geçilebilir — kırpma kuralı kare başına değişmemelidir.
            var expression = Expression(track, clipRelative: false, v => (size / 2d) + (v * size));
            if (expression is null)
            {
                return null;
            }

            return FloorOverlay(anchorFactor == 0
                ? expression
                : $"{expression}-{Num(anchorFactor)}*{dimension}");
        }

        string? Expression(AnimationTrack? track, bool clipRelative, Func<double, double> map)
        {
            if (track is null)
            {
                return null;
            }

            // Tamamı lineer: keyframe'ler üstünde kapalı biçim — kare başına maliyet yok.
            if (track.AllLinear)
            {
                return KeyframeCompiler.LinearExpression(
                    track, clipRelative ? 0 : clip.TimelineStartUs, map);
            }

            return KeyframeCompiler.StepExpression(Sample(track, clipRelative), halfFrameUs, map);
        }

        IReadOnlyList<(long TimeUs, double Value)> Sample(AnimationTrack track, bool clipRelative)
        {
            var samples = KeyframeCompiler.Samples(
                track, clip.TimelineStartUs, run.StartFrame, run.EndFrame,
                plan.FpsNum, plan.FpsDen, clipRelative ? -clip.TimelineStartUs : 0);
            budget.Charge(clip.Id, samples.Count, VisualChannelTr, VisualBudgetAction);
            return samples;
        }
    }

    /// <summary>
    /// Animasyonlu ölçek kutusunun TABANI (<c>scale = 1</c> boyutu): medya/görsel/çıkartma
    /// klibinde proje tuvali, metin/şekil rasterinde kendi bbox'ı (§7). Kutu bunun
    /// <c>scale(t)</c> katıdır — statik yoldaki <c>roundHalfUp</c> yerine HAM ÇARPIM yazılır.
    /// <para>
    /// TAMSAYIYA ÇEVİREN ffmpeg'DİR VE YUVARLAMAZ, KIRPAR (ölçüldü:
    /// <c>GoldenFrameTests.ScaleBoxTruncated_MatchesRealFfmpeg</c> — kaynak 223x104'te
    /// <c>w='3.9' h='2.9'</c> çıkışı 2x2, yani kutu 3x2). Bu yüzden animasyonlu yolun kutu
    /// modeli <see cref="LayerGeometry.ScaleBoxTruncated"/>'dır ve TABAN kapısı
    /// (<see cref="EnsureLayerFloor"/>) o modeli kullanmak ZORUNDADIR. Eskiden bu satırın
    /// yorumu "yuvarlamayı force_divisible_by=2 devralır" diyordu; kapı da roundHalfUp
    /// varsaydığı için kabul ettiği bir belge ffmpeg'de ölüyordu (5. tur, BLOCKER 1).
    /// </para>
    /// </summary>
    private static double ScaleBoxWidth(LayerRun run, ExportPlan plan) =>
        run.Segments[0].Raster?.NaturalWidthPx ?? plan.Width;

    private static double ScaleBoxHeight(LayerRun run, ExportPlan plan) =>
        run.Segments[0].Raster?.NaturalHeightPx ?? plan.Height;

    /// <summary>
    /// Run'ın overlay x/y argümanı. Statik yerleşimde tarihsel biçim AYNEN korunur
    /// (snapshot'lar); animasyonlu kanalda ifade TIRNAK içine alınır — <c>if(...)</c> virgül
    /// taşır ve tırnaksız yazılırsa filtergraph ayracı sanılır.
    /// </summary>
    private static string OverlayCoordinateFor(LayerRun run, bool horizontal)
    {
        var placement = run.Placement;
        var expression = horizontal ? run.Animation.OverlayX : run.Animation.OverlayY;
        if (expression is not null)
        {
            return $"'{expression}'";
        }

        return horizontal
            ? OverlayCoordinate(placement.AnchorTargetX, placement.OverlayAnchorFactorX, "w")
            : OverlayCoordinate(placement.AnchorTargetY, placement.OverlayAnchorFactorY, "h");
    }

    /// <summary>
    /// Bir yerleşim concat'lenebilir mi? Run'daki segmentler concat için AYNI BOYUTTA olmalıdır;
    /// scale <c>force_original_aspect_ratio=decrease</c> kullandığı için gerçek boyut KAYNAĞIN
    /// aspect'ine bağlıdır (compiler kaynak boyutunu bilmez) → segmentler yerleşim kutusuna
    /// simetrik şeffaf pad ile normalize edilir. Bu pad'in geometriyi KAYDIRMAMASI iki şart ister:
    ///  - çapa MERKEZDE (overlay telafi çarpanı 0.5): simetrik pad merkezi korur, çapa
    ///    merkezdeyse §2.5'in <c>P - 0.5*w</c> formülü pad'li ve pad'siz halde AYNI pikseli verir;
    ///    merkez dışı çapada pad, çapayı görüntü içindeki oranından kaydırırdı.
    /// Kutunun PARİTESİ şart DEĞİLDİR: pad hedefi kutunun çifte indirilmiş hali olduğu için
    /// (<see cref="LayerPlacement.NormalizeBoxWidth"/>) ofset <c>(ow-iw)/2</c> daima TAM bölünür.
    /// Şart sağlanmazsa run tek segmentte kalır ve bugünkü klip-başına overlay yolu kullanılır.
    /// GEÇİŞ bu kararı EZER (kesim bölünemez): orada pad çapa-duyarlı yazılır, bkz. NormalizePad.
    /// </summary>
    private static bool CanConcatRun(LayerPlacement placement) =>
        placement.OverlayAnchorFactorX == 0.5d
        && placement.OverlayAnchorFactorY == 0.5d
        && CanNormalizeToBox(placement);

    /// <summary>
    /// Kutuya normalize eden şeffaf pad geometriyi KORUYABİLİR mi?
    ///  - pad ofseti çapa oranındadır (<see cref="NormalizePadOffset"/>) → çapa, kutunun
    ///    içinde doğru orana oturur ve §2.5'in <c>P - anchor*w</c> formülü aynı pikseli verir;
    ///  - ama katman DÖNÜYOR ve çapası merkezde DEĞİLSE (<c>NeedsAnchorPad</c>) §2.5'in çapa
    ///    telafisi pad'i gerçek görüntü boyutuna göre ölçeklenir; normalize sonrası iw kutu
    ///    boyutu olduğu için telafi yanlış tabana oturur.
    /// Kutunun PARİTESİ artık şart değildir: pad TEK kutuyu değil, kutunun çifte indirilmiş
    /// halini hedefler (<see cref="LayerPlacement.NormalizeBoxWidth"/>) → ofset tam bölünür ve
    /// geometri, kesimde geçiş olup olmamasından BAĞIMSIZ kalır (rendering-semantics §5).
    /// Geçişsiz run bu durumda bölünür (optimizasyondan vazgeçilir); geçişli run BÖLÜNEMEZ →
    /// tipli hata verilir.
    /// </summary>
    private static bool CanNormalizeToBox(LayerPlacement placement) =>
        !placement.NeedsAnchorPad;

    /// <summary>
    /// Yerleşim proje tuvalinin TAMAMINI birim dönüşümle kaplıyor mu (scale=1, merkez çapa,
    /// dönme yok, kaydırma yok)? Böyle bir katman için <c>overlay x = W/2 - 0.5*w</c> ile
    /// <c>pad=W:H:(ow-iw)/2</c> AYNI pikseli verir (W ve w çift) — tuval + overlay yerine
    /// letterbox pad kullanılabilir.
    /// </summary>
    private static bool CoversCanvas(LayerPlacement placement, int width, int height) =>
        !placement.Rotates
        && placement.BoxWidth == width
        && placement.BoxHeight == height
        && placement.OverlayAnchorFactorX == 0.5d
        && placement.OverlayAnchorFactorY == 0.5d
        && placement.AnchorTargetX == width / 2d
        && placement.AnchorTargetY == height / 2d;

    /// <summary>
    /// Run'ı grafiğe yazar ve akış etiketini döndürür.
    /// Tek segmentli run = bugünkü klip zinciri (bayt bayt aynı çıktı). Çok segmentli run:
    /// her segment kendi zincirini kurar (kutuya normalize pad ile), sonra
    ///  - geçişsiz komşular TEK n-li concat'te birleşir,
    ///  - geçişli kesimler bu parçaları xfade ile katlar (§5.3 kümülatif offset).
    /// <paramref name="opaque"/> = tek katmanlı hızlı yol: kompozisyon yoktur, segmentler proje
    /// tuvaline arka plan rengiyle letterbox pad'lenip yuv420p'de birleşir (M3 hattı).
    /// </summary>
    private static string EmitRun(
        List<string> lines, LayerRun run, ExportPlan plan, string fpsArg,
        string background, bool opaque, int labelIndex)
    {
        var label = $"v{labelIndex.ToString(CultureInfo.InvariantCulture)}";
        var startUs = UsOf(run.StartFrame, plan.FpsNum, plan.FpsDen);
        var single = run.Segments.Count == 1;
        var index = labelIndex.ToString(CultureInfo.InvariantCulture);

        // Tek segmentli run'da segment zincirinin sonuna timeline ofseti doğrudan eklenir;
        // çok segmentlide ofset BİRLEŞTİRME SONRASINA taşınır (segmentler 0'dan başlamalı —
        // hem concat hem xfade girişlerinin PTS'i 0'dan başlar).
        var segmentLabels = new List<string>(run.Segments.Count);
        for (var i = 0; i < run.Segments.Count; i++)
        {
            var segment = run.Segments[i];
            var outLabel = single
                ? label
                : $"s{index}_{i.ToString(CultureInfo.InvariantCulture)}";
            segmentLabels.Add(outLabel);

            // Kuyruk: timeline ofseti + (varsa) opaklık fade'i. fade'in st'si KOMPOZİT
            // zamandadır, o yüzden setpts'ten SONRA gelir. Alfa çarpanı geometrik dönüşümle
            // yer değiştirebilir (lineer resample × sabit çarpan) — sıra güvenlidir.
            var tail = SetPtsFilter(single ? startUs : 0);
            if (single && OpacityFadeFilter(segment.Clip, startUs) is { } fade)
            {
                tail += "," + fade;
            }

            EmitSegmentChain(lines, run, segment, plan, fpsArg, background,
                opaque, normalizeToBox: !single, index, i, tail, outLabel);
        }

        if (single)
        {
            return label;
        }

        // Geçişsiz run: bugünkü tek n-li concat (snapshot'lar bayt bayt korunur).
        if (run.Segments.All(s => s.EnteringTransition is null))
        {
            var offset = startUs > 0 ? "," + SetPtsFilter(startUs) : "";
            lines.Add(
                string.Concat(segmentLabels.Select(l => $"[{l}]"))
                + $"concat=n={run.Segments.Count.ToString(CultureInfo.InvariantCulture)}:v=1:a=0"
                + offset + $"[{label}]");
            return label;
        }

        // Geçişli run: önce geçişsiz komşuları concat parçalarına topla, sonra xfade ile katla.
        var chunks = new List<(string Label, long Frames, Transition? Entering)>();
        var chunkStart = 0;
        for (var i = 1; i <= run.Segments.Count; i++)
        {
            if (i < run.Segments.Count && run.Segments[i].EnteringTransition is null)
            {
                continue;
            }

            var count = i - chunkStart;
            var frames = 0L;
            for (var k = chunkStart; k < i; k++)
            {
                frames += run.Segments[k].Frames;
            }

            string chunkLabel;
            if (count == 1)
            {
                chunkLabel = segmentLabels[chunkStart];
            }
            else
            {
                chunkLabel = $"k{index}_{chunks.Count.ToString(CultureInfo.InvariantCulture)}";
                lines.Add(
                    string.Concat(segmentLabels.GetRange(chunkStart, count).Select(l => $"[{l}]"))
                    + $"concat=n={count.ToString(CultureInfo.InvariantCulture)}:v=1:a=0[{chunkLabel}]");
            }

            chunks.Add((chunkLabel, frames, run.Segments[chunkStart].EnteringTransition));
            chunkStart = i;
        }

        // §5.3: offset_i = acc_{i-1} - D_i (birleşik akışın KENDİ zamanında), acc += e_i - D_i.
        // Kapalı form: offset = (Σ_{j<=i} d_j) - D/2 → geçiş kesimin D/2 ÖNCESİNDE başlar.
        var acc = chunks[0].Label;
        var accFrames = chunks[0].Frames;
        for (var j = 1; j < chunks.Count; j++)
        {
            var transition = chunks[j].Entering!;
            var dFrames = FrameOf(transition.DurationUs, plan.FpsNum, plan.FpsDen);
            var offsetUs = UsOf(accFrames - dFrames, plan.FpsNum, plan.FpsDen);
            var last = j == chunks.Count - 1;
            var outLabel = last && startUs == 0
                ? label
                : $"x{index}_{j.ToString(CultureInfo.InvariantCulture)}";
            lines.Add(
                $"[{acc}][{chunks[j].Label}]xfade=transition={XfadeName(transition.Type)}"
                + $":duration={TimeFormat.Sec(UsOf(dFrames, plan.FpsNum, plan.FpsDen))}"
                + $":offset={TimeFormat.Sec(offsetUs)}[{outLabel}]");
            acc = outLabel;
            accFrames += chunks[j].Frames - dFrames;
        }

        if (startUs > 0)
        {
            lines.Add($"[{acc}]{SetPtsFilter(startUs)}[{label}]");
        }

        return label;
    }

    /// <summary>
    /// Klibi timeline'daki yerine kaydıran setpts (tasarım 04 §2.2): setpts olmadan overlay
    /// ilk frame'den itibaren gösterir. enable ile BİRLİKTE kullanılır.
    /// </summary>
    private static string SetPtsFilter(long startUs) => startUs > 0
        ? $"setpts=PTS-STARTPTS+{TimeFormat.Sec(startUs)}/TB"
        : "setpts=PTS-STARTPTS";

    // ───────────────────────── Video katman zinciri ─────────────────────────

    /// <summary>
    /// Segmenti grafiğe yazar. Normal durumda BİR satır üretir (tarihsel biçim bayt bayt
    /// korunur); yalnız <c>intensity &lt; 1</c> olan LUT efektinde §4.2'nin split/blend deseni
    /// için üç ek satır gerekir (lineer bir zincir "orijinal + LUT'lanmış"ı aynı anda taşıyamaz).
    /// </summary>
    private static void EmitSegmentChain(
        List<string> lines, LayerRun run, LayerSegment segment, ExportPlan plan,
        string fpsArg, string background, bool opaque, bool normalizeToBox,
        string runIndex, int segmentIndex, string tail, string outLabel)
    {
        // Kaynak zinciri ölçeğe KADAR (ölçek dahil), sonra EFEKTLER, sonra yerleşimin geri kalanı.
        var source = new List<string>();
        BuildSourceChain(source, run, segment, plan, fpsArg);
        if (segment.Clip.Effects.Any)
        {
            // §4 zinciri RGB'de çalışır. Dönüşüm ÖLÇEKTEN SONRA yapılır — bunun bir performans
            // değil DOĞRULUK kararı olduğu ölçüldü: ffmpeg'in ÖRTÜK olarak eklediği dönüştürücü
            // (auto_scale) zincirin başındaki setparams beyanını GÖRMEZ ve §6.1'in normatif
            // "untagged SDR = BT.709/tv" varsayımı yerine SD varsayılanını (BT.601) kullanır.
            // Gerçek ölçüm (input-level -ss/-t ile açılmış klip, düz renk 0x60A0C0):
            //   setparams,fps,trim,format=rgba        -> (96,158,192)  ← beyan YOK SAYILDI
            //   setparams,fps,trim,scale,format=rgba  -> (90,153,194)  ← beyan uygulandı
            // Aradaki 6 kod değeri tam olarak §6.1'in engellemek için yazıldığı hatadır.
            // Ayrıca bu sıra ÖNİZLEMEYE de daha yakındır: WebGL shader'ı efekti ÖRNEKLENMİŞ
            // (yani ölçeklenmiş) texel'e uygular, kaynak pikseline değil.
            source.Add("format=rgba");
            if (segment.Clip.Effects.Color is { } color)
            {
                source.AddRange(ColorPipeline.ColorAdjustFilters(color));
            }
        }

        var placementChain = new List<string>();
        BuildPlacementChain(placementChain, run, segment, plan, background, opaque, normalizeToBox);
        placementChain.Add(tail);

        var input = $"[{segment.InputIndex.ToString(CultureInfo.InvariantCulture)}:v]";
        var lut = segment.Clip.Effects.Lut;
        if (lut is null)
        {
            lines.Add(input + string.Join(',', source) + "," + string.Join(',', placementChain)
                      + $"[{outLabel}]");
            return;
        }

        var lut3d = ColorPipeline.Lut3dFilter(segment.LutPath!);
        if (lut.Intensity >= 1d)
        {
            // §4.2: intensity = 1 → split/blend ATLANIR, düz lut3d uygulanır.
            lines.Add(input + string.Join(',', source) + "," + lut3d + ","
                      + string.Join(',', placementChain) + $"[{outLabel}]");
            return;
        }

        var tag = $"e{runIndex}_{segmentIndex.ToString(CultureInfo.InvariantCulture)}";
        lines.Add(input + string.Join(',', source) + $"[{tag}]");
        lines.Add($"[{tag}]split[{tag}a][{tag}b]");
        lines.Add($"[{tag}b]{lut3d}[{tag}l]");
        lines.Add($"[{tag}a][{tag}l]{ColorPipeline.LutBlendFilter(lut.Intensity)},"
                  + string.Join(',', placementChain) + $"[{outLabel}]");
    }

    /// <summary>
    /// KAYNAK zinciri (rendering-semantics §2.3 + §6 + tasarım 04 §2.4):
    /// [HDR tonemap] → setparams(BT.709/tv, §6.1) → fps → [setpts=PTS/k → fps (HIZ)] →
    /// trim=[start_frame:]end_frame → [setpts=PTS-STARTPTS (klip-göreli t)] →
    /// scale(fit=contain × scale).
    /// <para>
    /// Efektler (§4) bu zincirin HEMEN ARDINDAN, kompozisyondan ÖNCE gelir — gerekçesi ve
    /// ölçümü <c>EmitSegmentChain</c>'dedir.
    /// </para>
    /// </summary>
    private static void BuildSourceChain(
        List<string> chain, LayerRun run, LayerSegment segment, ExportPlan plan, string fpsArg)
    {
        var clip = segment.Clip;
        if (segment.Asset is { IsHdr: true } hdr)
        {
            chain.Add(ColorChain.ForSource(hdr.ColorTransfer));
        }

        // §6.1: kaynak renk varsayımı RGB'ye geçişten ÖNCE beyan edilir — sonra beyan etmek
        // dönüşümü etkilemez, yalnız etiketi düzeltir (ve renkler kayar).
        chain.Add(SourceColorParams);
        chain.Add($"fps={fpsArg}");

        // HIZ (tasarım 04 §2.4): fps normalize SONRASI setpts=PTS/k, ardından TEKRAR çıktı fps
        // ızgarası — ikinci fps olmadan akış k katı yoğunlukta/seyrek kare taşır ve trim'in
        // frame defteri (§1.4) anlamsızlaşır. Zaman ekseni olmayan girişte (görsel/raster)
        // hız kavramı yoktur: -loop 1 -t zaten TIMELINE süresi kadar kare üretir.
        if (clip.Rate != 1d && !clip.IsStillInput)
        {
            chain.Add($"setpts=PTS/{Num(clip.Rate)}");
            chain.Add($"fps={fpsArg}");
        }

        chain.Add(segment.StartFrame > 0
            ? $"trim=start_frame={segment.StartFrame.ToString(CultureInfo.InvariantCulture)}"
              + $":end_frame={(segment.StartFrame + segment.Frames).ToString(CultureInfo.InvariantCulture)}"
            : $"trim=end_frame={segment.Frames.ToString(CultureInfo.InvariantCulture)}");

        // Katman zincirindeki animasyon (scale/rotate ifadesi + sendcmd) KLİP-GÖRELİ t ister.
        // trim PTS'i sıfırlamaz; -ss ile açılmış giriş çoğu kaynakta 0'dan başlar ama bu bir
        // GARANTİ DEĞİLDİR (edit list / B-frame ofseti) — açık setpts tüm belirsizliği kaldırır.
        if (NeedsClipRelativeTime(run, clip))
        {
            chain.Add("setpts=PTS-STARTPTS");
        }

        // fit=contain (§2.2) ve transform.scale (§2.3 adım 1-2) TEK ölçekte birleşir: hedef
        // kutu katmanın doğal boyutunun scale katıdır (medya/görsel/çıkartmada doğal boyut =
        // proje tuvali; metin/şekilde rasterin kendi bbox'ı — §7),
        // force_original_aspect_ratio=decrease aspect'i korur. Tek resample = tek yumuşama.
        chain.Add(ScaleFilter(run, segment, plan));
    }

    /// <summary>
    /// YERLEŞİM zinciri (rendering-semantics §2.3 sırası + §6), ölçekten SONRASI:
    /// setsar=1 → format=rgba → [kutuya normalize pad] →
    /// [colorchannelmixer=aa (opaklık, §6.3)] → [çapa pad'i] → [rotate c=none] → settb=AVTB.
    /// Timeline ofseti (setpts) çağıran tarafta eklenir — run'da birleştirme SONRASINA taşınır.
    /// <paramref name="opaque"/>: tek katmanlı hızlı yol — RGB kompozisyon yoktur, katman proje
    /// tuvaline ARKA PLAN rengiyle letterbox pad'lenir ve yuv420p'de kalır (M3 hattı; alpha
    /// taşımadığı için concat/encode zinciri hiç RGB'ye çıkmaz).
    /// </summary>
    private static void BuildPlacementChain(
        List<string> chain, LayerRun run, LayerSegment segment, ExportPlan plan,
        string background, bool opaque, bool normalizeToBox)
    {
        var clip = segment.Clip;
        var placement = run.Placement;

        if (opaque)
        {
            // Hızlı yol = M3 hattı: taban tuval yerine letterbox pad. Kutu proje tuvalidir ve
            // çapa merkezdedir (CoversCanvas), dolayısıyla ortalanmış pad, taban tuvale
            // yapılan overlay ile BİREBİR aynı pikselleri verir. Bu pad aynı zamanda concat'in
            // (ve xfade'in) istediği boyut normalizasyonudur — normalizeToBox'a gerek yoktur.
            chain.Add($"pad={plan.Width.ToString(CultureInfo.InvariantCulture)}"
                      + $":{plan.Height.ToString(CultureInfo.InvariantCulture)}"
                      + $":(ow-iw)/2:(oh-ih)/2:color={background}");
            chain.Add("setsar=1");
            chain.Add("format=yuv420p");
            chain.Add("settb=AVTB");
            return;
        }

        chain.Add("setsar=1");

        // §6.3: kompozisyon RGB'de yapılır → HER katman rgba ile girer (overlay'in alpha'lı
        // giriş formatı zaten rgba'dır; opak katmanı yuv420p bırakmak overlay'e sessiz bir
        // dönüşüm sokar ve ölçekleme chroma'yı gereksizce alt örneklerdi).
        chain.Add("format=rgba");

        // İKİ SEBEPTEN BİRİ yeterlidir:
        //  (1) run BÖLÜNDÜ (concat/xfade girişleri aynı boyutta olmalı);
        //  (2) katman DÖNÜYOR — çapası merkezdeyse. Dönen katmanda rotate'in KARE TUVALİ
        //      GİRİŞİNDEN doğar (ow=2*ceil(hypot(iw,ih)/2)); giriş pad'li yolda kutu, pad'siz
        //      yolda gerçek scale çıktısı olduğu sürece iki yol FARKLI tuval kurar ve katman
        //      farklı ızgaraya oturur. Ölçüldü (gerçek ffmpeg 8.0, 320x240 tuval, 16:9 kaynak,
        //      s=0.503, a=90): pad'siz sınır kutusu (114,39,205,200), pad'li (115,39,204,200).
        //      Bu yüzden dönen katmanda pad KESİM DURUMUNDAN BAĞIMSIZ olarak üretilir: geçiş
        //      eklemek katmanı oynatmaz (rendering-semantics §5).
        //
        // İKİ ADAY DA ÖLÇÜLDÜ ve İKİSİ DE piksel eşitliğini sağladı (16 satırlık
        // AddingATransition_DoesNotMoveTheLayerByASinglePixel, gerçek ffmpeg): (a) normalize
        // pad'ini rotate'ten SONRAYA alıp kare tuvali ortak bir kenara pad'lemek, (b) burada
        // seçilen — rotate GİRİŞİNİ eşitlemek. (b) SEÇİLDİ çünkü:
        //  - nedeni kaldırır (giriş eşitlenir), sonucu telafi etmez; zincirde TEK sıra kalır
        //    (normalize daima format=rgba'dan hemen sonra), dönen/dönmeyen için iki ayrı
        //    sıralama akılda tutulmaz;
        //  - (a) pad'i çapa pad'inden SONRAYA taşıdığı için CanNormalizeToBox'ın (ve ona
        //    dayanan 'transition-rotated-anchor' kapısının) YAZILI GEREKÇESİNİ geçersiz kılar;
        //    o kapıyı da kaldırmak bu turun kapsamı dışındadır ve gerekçesiz bir kapı bırakmak
        //    kabul edilemez;
        //  - (a) yeni bir türev büyüklük ister (kare kenarı = CeilEven(hypot(nb))) ve onun
        //    "gerçek rotate çıktısını asla kırpmaz" güvencesi fazladan bir monotonluk adımına
        //    dayanır; (b) zaten ispatlanmış olan "scale çıktısı ≤ nb" güvencesini kullanır.
        // BEDELİ ölçüldü: tek bir snapshot değişir (keyframe-eased) ve tek klipli dönen
        // katmanlar bir pad filtresi kazanır.
        //
        // ÇAPASI MERKEZDE OLMAYAN dönen katman DIŞARIDADIR (NeedsAnchorPad): §2.5'in çapa
        // telafisi pad'i GERÇEK görüntü boyutuna göre ölçeklenir (iw*2*mx), normalize sonrası
        // iw kutu boyutu olurdu ve çapa görüntü içindeki oranından kayardı. Aynı gerekçeyle
        // o katman zaten bölünemez (CanNormalizeToBox) — yani karşılaştırılacak bir pad'li
        // yolu da yoktur.
        if (normalizeToBox || (placement.Rotates && !placement.NeedsAnchorPad))
        {
            // Gerçek ölçek çıktısı kaynağın aspect'ine bağlıdır (compiler kaynağı bilmez) →
            // şeffaf pad ile kutuya sabitlenir. Ofset ÇAPA ORANINDADIR: merkez çapada
            // (ow-iw)/2 ile birebir aynıdır, merkez dışı çapada ise §2.5'in "çapa görüntünün
            // kendi kutusundaki oranındadır" kuralını korur (geçişli kesimde run bölünemediği
            // için bu genel biçim şarttır).
            // HEDEF ham kutu DEĞİL, kutunun ÇİFTE İNDİRİLMİŞ hali (§2.5): scale çıktısı daima
            // çift olduğu için bu hedef kırpmaz, ve çift/çift oranı (ow-iw)/2'yi TAM böler —
            // ham TEK kutu, ofseti ve overlay'i AYNI YÖNE kırpıp katmanı 1 px kaydırırdı.
            chain.Add($"pad={placement.NormalizeBoxWidth.ToString(CultureInfo.InvariantCulture)}"
                      + $":{placement.NormalizeBoxHeight.ToString(CultureInfo.InvariantCulture)}"
                      + $":{NormalizePadOffset("ow", "iw", placement.OverlayAnchorFactorX)}"
                      + $":{NormalizePadOffset("oh", "ih", placement.OverlayAnchorFactorY)}"
                      + $":color={TransparentPad}");
        }

        // §6.3: src.a *= opacity (straight alpha). Keyframe'li opaklıkta değer sendcmd ile
        // kare kare yazılır (colorchannelmixer ZAMAN İFADESİ ALMAZ) — filtre örneği o yüzden
        // adlandırılır. 0→1 / 1→0 lineer eğri ise burada değil, kuyrukta 'fade' ile çözülür.
        // sendcmd, hedefinin HEMEN ÖNÜNE konur: ikisi arasında iki girişli bir filtre
        // (LUT'un split/blend'i gibi) kalırsa komut framesync tamponu yüzünden yanlış kareye
        // düşerdi — aynı lineer zincirde kare eşzamanlı iletilir (ölçüldü: 60/60 doğru).
        if (run.Animation.OpacityTag.Length > 0)
        {
            chain.Add(KeyframeCompiler.SendCmdFilter(run.Animation.OpacityCommands));
            chain.Add($"colorchannelmixer{run.Animation.OpacityTag}"
                      + $"=aa={Num(run.Animation.OpacityInitial)}");
        }
        else if (clip.Animation.Opacity is null && clip.Opacity < 1)
        {
            chain.Add($"colorchannelmixer=aa={Num(clip.Opacity)}");
        }

        if (placement.Rotates)
        {
            if (placement.NeedsAnchorPad)
            {
                // Çapayı tuval merkezine getiren şeffaf pad — rotate merkez etrafında döndüğü
                // için bu, ÇAPA etrafında dönmenin birebir karşılığıdır (§2.5 telafi formülü).
                chain.Add($"pad=w=iw*{Num(placement.PadWidthFactor)}:h=ih*{Num(placement.PadHeightFactor)}"
                          + $":x=iw*{Num(placement.PadXFactor)}:y=ih*{Num(placement.PadYFactor)}"
                          + $":color={TransparentPad}");
            }

            // Kare ara tuval: kenarı "köşegeni kapsayan en küçük ÇİFT tamsayı"dır, yani dönen
            // kutuyu her açıda kapsar; c=none şeffaf arka plan.
            //
            // BU İFADE ffmpeg'in GERÇEK iw/ih'siyle değerlendirilir; LayerPlacement.Intermediate*
            // ise aynı fonksiyonu KUTUDAN hesaplar. Defter bir ÜST SINIRDIR: scale çıktısı
            // kutuyu aşamadığı ve dönüşüm monoton olduğu için çizilen ≤ defter. Bellek tavanı
            // bilerek DEFTERDEN doğrulanır (güvenli taraf, denetim #2); konum aritmetiği ise
            // daima ÇİZİLEN tuvale, yani overlay ifadesindeki w/h'ye aittir.
            //
            // GİRİŞ ARTIK NORMALİZE (çapası merkezde olan dönen katmanda): yukarıdaki pad
            // sayesinde iw/ih kaynağın aspect'ine değil KUTUYA bağlıdır, dolayısıyla bu tuval
            // de kaynaktan bağımsızdır — geçiş eklemek (run'ı bölmek) tuvali değiştirmez.
            // Ölçüldü (gerçek ffmpeg 8.0, kutu 1066x599): normalize EDİLMEMİŞ 16:9 girişi
            // 1064x598 → tuval 1222; normalize edilmiş 1066x598 girişi → tuval 1224.
            // İki farklı tuval, iki farklı ızgara demekti; kaynak bu ayrışmaydı.
            //
            // TUVAL ÇİFTTİR (2*ceil(hypot/2)), ham hypot DEĞİL. GEREKÇE (gerçek ffmpeg 8.0,
            // GoldenFrameTests.RotatedLayer_LandsOnTheSameCenterAsTheUnrotatedOne canlı ffmpeg'e
            // yeniden sorar): rotate ifadeyi round-half-up ile tamsayıya çevirir ve sonuç SIKLIKLA
            // TEKTİR (ölç.: 960x540→1101, 962x540→1103, 100x100→141, 480x270→551). TEK tuvalde
            // içerik tuvalin ORTASINA oturamaz — ölçüldü (a=0, interpolasyon yok): 1101'de içerik
            // merkezi tuval merkezinin 0.5 px sağında; 1102'de TAM ORTADA. Üstelik overlay
            // telafisi 0.5*w de yarım tamsayı olurdu. İki yarım piksel a=90'da eksenlere ZIT
            // işaretle düşüyordu (ölç.: x −0.5, y +0.5 — "sapma daima tek yönlü" iddiasını
            // yalanlar). Çift tuvalde ikisi de 0.000 ve merkez tam olarak floor(P)'ye oturur,
            // yani dönen katman dönmeyenle AYNI modele uyar.
            // Filtergraph içinde argüman virgülü KAÇIRILMALIDIR (\,) — aksi halde filtre ayracı sanılır.
            chain.Add(
                $"rotate=a={RotationArgument(run)}:c=none:ow=2*ceil(hypot(iw\\,ih)/2):oh=ow");
        }

        chain.Add("settb=AVTB");
    }

    /// <summary>
    /// Ölçek filtresi. Statik ölçekte tarihsel biçim AYNEN korunur; animasyonlu ölçekte kutu
    /// kare kare değişir (<c>eval=frame</c>) — TAMAMI LİNEER kanalda ifadeyle, eğrili kanalda
    /// sendcmd ile sürülür. force_original_aspect_ratio/force_divisible_by kuralları her karede
    /// yeniden uygulanır (ffmpeg scale_eval_dimensions eval=frame modunda kare başına çalışır),
    /// yani çift boyut garantisi animasyonlu yolda da geçerlidir.
    /// </summary>
    private static string ScaleFilter(LayerRun run, LayerSegment segment, ExportPlan plan)
    {
        var placement = run.Placement;
        const string options =
            "force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic";
        if (run.Animation.ScaleWidth is not { } width || run.Animation.ScaleHeight is not { } height)
        {
            return $"scale={placement.BoxWidth.ToString(CultureInfo.InvariantCulture)}"
                   + $":{placement.BoxHeight.ToString(CultureInfo.InvariantCulture)}:{options}";
        }

        // İfade virgül taşır → tırnaklanır. eval=frame olmadan ifade yalnız config anında
        // değerlendirilir ve animasyon sabite düşerdi.
        return $"scale=w='{width}':h='{height}':{options}:eval=frame";
    }

    /// <summary>
    /// rotate açısı (radyan). Statikte sabit; animasyonlu kanalda <c>t</c> ifadesi (virgül
    /// içerdiği için tırnaklanır). rotate ifadeyi KARE BAŞINA değerlendirir — ayrı bir eval
    /// seçeneği yoktur.
    /// </summary>
    private static string RotationArgument(LayerRun run) =>
        run.Animation.Rotation is { } expression
            ? $"'{expression}'"
            : Num(run.Placement.RotationRad);

    /// <summary>
    /// Katman zinciri KLİP-GÖRELİ <c>t</c> istiyor mu? scale/rotate ifadeleri ve opaklık
    /// sendcmd'i klip ekseninde çalışır; overlay x/y KOMPOZİT eksendedir ve bu bayrağı
    /// gerektirmez.
    /// </summary>
    private static bool NeedsClipRelativeTime(LayerRun run, ExportClipPlan clip) =>
        clip.Animation.AnimatesLayerChain || run.Animation.OpacityTag.Length > 0;

    /// <summary>
    /// Opaklık keyframe'lerinin <c>fade</c> HIZLI YOLU (tasarım 04 §2.5 madde 1 —
    /// "kullanımın %95'i"): tam iki keyframe, LİNEER easing ve değerler 0→1 (fade-in) ya da
    /// 1→0 (fade-out) ise <c>fade=alpha=1</c> birebir aynı eğriyi verir ve kare başına komut
    /// göndermeye gerek kalmaz. fade, st'den önce 0 (in) / 1 (out) tutar — §3.3'ün "ilk
    /// keyframe'den önce ilk değer, son keyframe'den sonra son değer" kuralıyla ÖZDEŞTİR.
    /// Diğer her eğri (0.2→0.8, çok keyframe'li, easing'li) sendcmd yoluna gider.
    /// <paramref name="startUs"/> klibin KOMPOZİT başlangıcıdır — fade zinciri timeline
    /// ofsetinden (setpts) SONRA çalışır.
    /// </summary>
    private static string? OpacityFadeFilter(ExportClipPlan clip, long startUs)
    {
        if (clip.Animation.Opacity is not { } track || track.Keys.Count != 2 || !track.AllLinear)
        {
            return null;
        }

        var (first, second) = (track.Keys[0], track.Keys[1]);
        var type = (first.Value, second.Value) switch
        {
            (0d, 1d) => "in",
            (1d, 0d) => "out",
            _ => null,
        };

        return type is null
            ? null
            : $"fade=t={type}:st={TimeFormat.Sec(startUs + first.TimeUs)}"
              + $":d={TimeFormat.Sec(second.TimeUs - first.TimeUs)}:alpha=1";
    }

    /// <summary>
    /// Kutuya normalize eden pad'in ofseti. Merkez çapada tarihsel <c>(ow-iw)/2</c> biçimi
    /// AYNEN korunur (snapshot'lar); merkez dışı çapada oransal biçim yazılır.
    /// </summary>
    private static string NormalizePadOffset(string outer, string inner, double anchorFactor) =>
        anchorFactor == 0.5d
            ? $"({outer}-{inner})/2"
            : anchorFactor == 0d ? "0" : $"({outer}-{inner})*{Num(anchorFactor)}";

    /// <summary>
    /// Klibin ffmpeg girişi. Zaman eksenli klip (video/ses): input-level trim (-ss/-t, §2.1),
    /// geçiş payları (§5.2) aralığa DAHİL edilir. ZAMAN EKSENİ OLMAYAN klip (görsel + metin/
    /// şekil/çıkartma rasteri): <c>-loop 1 -t</c>; -t bir frame CÖMERT verilir (görsel
    /// demuxer'ının kendi fps'i proje fps'inden farklı olabilir), kesin kare sayısını zincirdeki
    /// <c>trim</c> sabitler — taban tuvaldeki <c>d=</c> + trim deseninin aynısı.
    /// </summary>
    private static ExportInput InputFor(
        ExportClipPlan clip, string path, long inputFrames, ExportPlan plan) =>
        clip.IsStillInput
            ? new ExportInput(path, 0, UsOf(inputFrames + 1, plan.FpsNum, plan.FpsDen), Loop: true)
            : new ExportInput(path,
                clip.SourceInUs - clip.HeadInSourceUs,
                (clip.SourceOutUs + clip.HeadOutSourceUs)
                - (clip.SourceInUs - clip.HeadInSourceUs));

    /// <summary>
    /// overlay_x = <c>floor</c>(P.x - anchorFactor * &lt;w|h&gt;) (§2.5 adım 4); çarpan 0 ise
    /// hedefin kendisi. <see cref="FloorOverlay"/> neden ZORUNLU olduğunu anlatır.
    /// </summary>
    private static string OverlayCoordinate(double target, double anchorFactor, string dimension) =>
        FloorOverlay(anchorFactor == 0
            ? Num(target)
            : $"{Num(target)}-{Num(anchorFactor)}*{dimension}");

    /// <summary>
    /// overlay hedefini ifadenin İÇİNDE tamsayıya indirir (§2.5 "konum kırpması").
    /// <para>
    /// GEREKÇE (gerçek ffmpeg 8.0 ölçümü; <c>GoldenFrameTests.OverlayExpression_</c>
    /// <c>TruncatesTowardZero_AndAcceptsFloor</c> canlı ffmpeg'e yeniden sorar):
    /// overlay ifadeyi <c>(int)</c> ile, yani SIFIRA DOĞRU çevirir —
    /// <c>floor</c> ile DEĞİL. 64 px tuval + 20 px katman: <c>x=-10.1 / -10.5 / -10.9 / -10.999</c>
    /// → hepsi sol kenar <c>-10</c>; <c>x=-11</c> → <c>-11</c>. Pozitif tarafta ikisi aynıdır.
    /// Bu yüzden hedef negatifken kırpma YÖN DEĞİŞTİRİR ve iki bağımsız sözleşme kırılır:
    /// </para>
    /// <para>
    /// (1) <b>Pad'li ve pad'siz yol ayrışır</b> (rendering-semantics §5.2 invaryantı). Pad'li
    /// yolda katmanın sol kenarı <c>trunc(P - nb/2) + (nb - w)/2</c>, pad'siz yolda
    /// <c>trunc(P - w/2)</c>'dir. <c>(nb - w)/2</c> TAM SAYI olduğu için <c>floor</c> altında iki
    /// ifade ÖZDEŞTİR (<c>floor(a) + k = floor(a + k)</c>); <c>trunc</c> altında değildir ve
    /// <c>0 &lt; P - nb/2 + 1</c> penceresinde 1 px ayrışır. Ölçüldü (1080p, ölçek 1.005,
    /// x=0.0025, kutu 1930x1085): 16:9 / 4:3 / kare / 9:16 / 3:4 kaynakların BEŞİ DE 1 px ayrıştı;
    /// <c>floor</c> ile beşi de eşitlendi (21:9 kaynakta ayrışma zaten yoktu).
    /// </para>
    /// <para>
    /// (2) <b>Ölçek &gt; 1'de sapma İŞARET DEĞİŞTİRİR.</b> §2.5(b) "export merkezi = trunc(P),
    /// sapma daima orijine doğru" der; bu ancak overlay hedefi ≥ 0 iken doğrudur. Katman tuvali
    /// taştığı an (her yakınlaştırma) hedef negatifleşir. Ölçüldü (1080p, 16:9, ölçek 1.2,
    /// x=-0.1026, hedef -388.992): <c>trunc</c> ile merkez P'nin <b>+0.992 px</b> SAĞINA,
    /// <c>floor</c> ile -0.008 px soluna düştü. <c>floor</c> altında sapma her ölçekte ve her
    /// işarette <c>(-1, 0]</c> aralığındadır — dokümanın zaten iddia ettiği model.
    /// </para>
    /// <para>
    /// <c>floor</c> ffmpeg ifade değerlendiricisinde VARDIR ve overlay onu kabul eder (aynı testte
    /// negatif kontrol: uydurma bir fonksiyon adı <c>Unknown function</c> ile reddediliyor, yani
    /// <c>floor</c> sessizce yutulmuyor). Sonuç tamsayı olduğu için overlay'in kendi
    /// <c>(int)</c>'i no-op'a düşer.
    /// </para>
    /// </summary>
    private static string FloorOverlay(string expression) => $"floor({expression})";

    /// <summary>
    /// Katmanın yerleşimi. Medya/görsel/ÇIKARTMA klibinde ölçek kutusunun tabanı proje
    /// tuvalidir (fit=contain, §2.2); METİN/ŞEKİL rasterinde kendi doğal boyutudur (§7 @2x).
    /// Raster kliplerinin bellek tavanı BURADA doğrulanır — Validate raster boyutunu bilmez.
    /// </summary>
    private static LayerPlacement PlacementOf(
        ExportClipPlan clip, ExportAssetSource? asset, ExportRasterSource? raster, ExportPlan plan)
    {
        if (raster is null)
        {
            var media = LayerGeometry.Compute(PlacementTransform(clip), plan.Width, plan.Height);

            // Taban kapısının Compile yarısı: boyut ffprobe'tan gelir ve worker'da DAİMA
            // bilinir (API'nin DB yarısı asset hâlâ işleniyorken boş olabilir). Burada tipli hata
            // üretmek, ffmpeg'in -22'sinden ya da SESSİZ yanlış geometriden her hâlükârda iyidir.
            EnsureLayerFloor(
                clip.Id, clip.KindTr, clip, plan.Width, plan.Height,
                asset?.SourceWidth ?? 0, asset?.SourceHeight ?? 0);
            return media;
        }

        if (!double.IsFinite(raster.NaturalWidthPx) || !double.IsFinite(raster.NaturalHeightPx)
            || raster.NaturalWidthPx <= 0 || raster.NaturalHeightPx <= 0)
        {
            throw new InvalidTimelineException(
                $"'{clip.Id}' {clip.KindTr} klibinin rasteri boş (doğal boyut "
                + $"{Num(raster.NaturalWidthPx)}x{Num(raster.NaturalHeightPx)}).");
        }

        var placement = LayerGeometry.Compute(
            PlacementTransform(clip), plan.Width, plan.Height,
            raster.NaturalWidthPx, raster.NaturalHeightPx);
        EnsureLayerCeiling(clip.Id, clip.KindTr, placement);

        // Metin/şekil rasterinde kutu ≥ 2 sağlandığı sürece dejenerelik eşitsizliği sağlanmaz
        // (fit kutusu rasterin KENDİ bbox'ı olduğu için kaynak aspect'i ≈ kutu aspect'i —
        // SweptRasterBboxes_AreNotDegenerate_WhenTheScaleFloorHolds bunu tarar). Ama KUTU ≥ 2
        // ULAŞILABİLİR biçimde ihlal edilir: ölçek animasyonunun tabanı kutuyu 2x1'e ya da
        // 0x0'a indirebilir (5. tur BLOCKER 1, canlı ölçüm). Kapı bu yüzden burada da KOŞAR
        // ve PNG'nin gerçek boyutuyla tam modeli sorar.
        EnsureLayerFloor(
            clip.Id, clip.KindTr, clip, raster.NaturalWidthPx, raster.NaturalHeightPx,
            raster.SourceWidth ?? 0, raster.SourceHeight ?? 0);
        return placement;
    }

    // ───────────────────────── Geçişler (rendering-semantics §5) ─────────────────────────

    /// <summary>
    /// Track içindeki geçiş kesimlerini doğrular ve D/2 paylarını kliplere yazar (liste
    /// YERİNDE güncellenir). Kurallar §5.2'dir: bitişiklik, simetri (iki taraf derin-eşit),
    /// D proje frame grid'inde ve ÇİFT frame (D/2 tam frame olsun), D*2 ≤ kısa komşunun
    /// süresi, kaynak payı (handle) ve GÖRÜNEN kesimde YERLEŞİM kuralları. İhlaller sessizce
    /// düzeltilMEZ — editör bu dokümanı üretmemeliydi.
    /// <para>
    /// Yerleşim kuralları (eşitlik + dönmüş/merkez-dışı çapa yasağı) eskiden YALNIZ
    /// <see cref="Compile"/>'ın run kurma dalındaydı; API'nin ön kapısı yalnız
    /// <see cref="Validate"/> çağırdığı için onları GÖRMÜYORDU ve böyle bir belge 202 alıp
    /// worker'da düşüyordu (ham API ile ölçüldü). İkisi de SAF DOKÜMAN ARİTMETİĞİDİR —
    /// <see cref="LayerGeometry.Compute(Transform, int, int)"/> yalnız transform + proje tuvali
    /// ister, kaynak dosyasına DOKUNMAZ — dolayısıyla buraya aittirler. Compile'daki dal KALDIRILMADI
    /// (aynı fonksiyon, aynı sonuç; kaynak bilgisi oraya sonradan girdiği için ucuz sigorta).
    /// </para>
    /// </summary>
    /// <param name="clips">Track'in derlenmiş klip planları — YERİNDE güncellenir (kaynak payı, atrim).</param>
    /// <param name="fpsNum">Proje fps pay'ı; geçiş süresi bu grid'e (çift frame'e) oturtulur.</param>
    /// <param name="fpsDen">Proje fps payda'sı.</param>
    /// <param name="width">Proje tuval genişliği — yerleşim kuralı yalnız bunu ve transform'u okur.</param>
    /// <param name="height">Proje tuval yüksekliği.</param>
    /// <param name="track">
    /// Kesimin görünürlük bağlamı. Geçiş VİDEODA yalnız iki taraf da GÖRSEL katman ürettiğinde
    /// onurlandırılır (Compile'daki <c>joined</c> koşulu): gizli track'te ya da ses klibinde
    /// kesim sıradan bir kesimdir, xfade hiç kurulmaz ve yerleşim de rol oynamaz. Kapı bu
    /// yüzden aynı koşula bağlıdır — aksi halde gizli bir track'teki geçiş yanlışlıkla
    /// reddedilirdi.
    /// </param>
    private static void ResolveTransitions(
        List<ExportClipPlan> clips, int fpsNum, int fpsDen, Track track, int width, int height)
    {
        if (!clips.Any(c => c.Media is { } m && (m.TransitionIn is not null || m.TransitionOut is not null)))
        {
            return;
        }

        var inTransition = new Transition?[clips.Count];
        var outTransition = new Transition?[clips.Count];
        var halfFrames = new long[clips.Count + 1];

        for (var i = 0; i < clips.Count; i++)
        {
            if (clips[i].Media?.TransitionOut is not { } transition)
            {
                continue;
            }

            var current = clips[i];
            var next = i + 1 < clips.Count ? clips[i + 1] : null;
            if (next?.Media is null || current.TimelineEndUs != next.TimelineStartUs)
            {
                throw new InvalidTimelineException(
                    $"'{current.Id}' klibinin çıkış geçişi için hemen ardından BİTİŞİK bir medya "
                    + "klibi gerekir (boşluk/çakışma olamaz, metin-şekil-çıkartma klibine geçiş "
                    + "yapılamaz). Geçişi kaldırın ya da klipleri bitiştirin.");
            }

            var counterpart = next.Media.TransitionIn;
            if (counterpart is null)
            {
                throw new InvalidTimelineException(
                    $"geçiş simetrisi ihlali: '{current.Id}' klibinde transitionOut var ama "
                    + $"'{next.Id}' klibinde eşleşen transitionIn yok. Geçiş kesimin İKİ tarafına "
                    + "da yazılmalıdır.");
            }

            if (counterpart.Type != transition.Type || counterpart.DurationUs != transition.DurationUs)
            {
                throw new InvalidTimelineException(
                    $"geçiş simetrisi ihlali: '{current.Id}' → '{next.Id}' kesiminin iki tarafı "
                    + $"derin-eşit olmalı ({transition.Type}/{transition.DurationUs}us ile "
                    + $"{counterpart.Type}/{counterpart.DurationUs}us farklı).");
            }

            // §5.2: D proje frame grid'inde ve ÇİFT frame sayısı (>= 2) olmalı ki D/2 tam frame olsun.
            var dFrames = FrameOf(transition.DurationUs, fpsNum, fpsDen);
            if (UsOf(dFrames, fpsNum, fpsDen) != transition.DurationUs)
            {
                throw new InvalidTimelineException(
                    $"'{current.Id}' → '{next.Id}' geçişinin süresi ({transition.DurationUs}us) proje "
                    + "fps frame grid'inde değil; en yakın frame karşılığı "
                    + $"{UsOf(dFrames, fpsNum, fpsDen)}us.");
            }

            if (dFrames < 2 || dFrames % 2 != 0)
            {
                throw new InvalidTimelineException(
                    $"'{current.Id}' → '{next.Id}' geçişinin süresi ÇİFT frame sayısı ve en az 2 frame "
                    + $"olmalı (gelen değer {dFrames} frame) — D/2 tam frame olmadan geçiş penceresi "
                    + "kesime simetrik oturamaz.");
            }

            // §5.2 üst sınır (timeline-domain): geçiş, kısa komşunun süresinin yarısını aşamaz —
            // aksi halde bir klibin iki kenarındaki pencereler üst üste biner.
            var shorter = Math.Min(current.TimelineDurationUs, next.TimelineDurationUs);
            if (transition.DurationUs * 2 > shorter)
            {
                throw new InvalidTimelineException(
                    $"'{current.Id}' → '{next.Id}' geçişi çok uzun: süresi ({transition.DurationUs}us) "
                    + $"kısa komşunun ({shorter}us) yarısını aşamaz.");
            }

            // Geçiş + keyframe: geçişli kesimde run BÖLÜNEMEZ (iki klip TEK xfade akışına
            // girer), dolayısıyla katmanın yerleşimi kesim boyunca SABİT olmalıdır — animasyon
            // xfade'in "iki giriş aynı boyutta" şartını da kırardı. Sessiz yok sayma yerine
            // tipli hata (M4'teki "geçişli kliplerin yerleşimi aynı olmalı" kuralının kardeşi).
            foreach (var side in (ExportClipPlan[])[current, next])
            {
                if (side.Animation.Any)
                {
                    throw new UnsupportedFeatureException("transition-keyframes",
                        $"'{side.Id}' klibinde hem geçiş hem keyframe animasyonu var — geçişli "
                        + "kesimde iki klip tek akışa katlandığı için katmanın yerleşimi sabit "
                        + "olmalıdır. Geçişi kaldırın ya da animasyonu başka bir klibe taşıyın.");
                }
            }

            var half = dFrames / 2;
            var halfUs = UsOf(half, fpsNum, fpsDen);

            // §5.2/§5.5 handle: B kaynağının BAŞ payı yetmiyorsa geçiş kurulamaz. Sessiz
            // kısaltma YOK. A'nın KUYRUK payı burada bilinemez (asset süresi compiler'da yok) —
            // uzatılmış aralık kaynak-aralığı defterine yazılır, worker'ın kapısı orada yakalar.
            // Zaman ekseni olmayan kaynakta (görsel) pay kavramı yoktur: -loop 1 istediği kadar
            // kare üretir.
            // §5.2 pay KAYNAK-DOMAIN'dedir ve HIZLA ölçeklenir: sourceIn' = sourceIn -
            // roundHalfUp((D/2) * rate). rate=1'de iki eksen çakışır (tarihsel davranış).
            var halfSourceUs = SourceHandleUs(halfUs, next.Rate);
            if (!next.IsStillInput && next.SourceInUs < halfSourceUs)
            {
                throw new UnsupportedFeatureException("transition-handle",
                    $"'{next.Id}' klibinin başında geçiş payı yok: {halfSourceUs}us (D/2, kaynak "
                    + $"ekseninde) gerekiyor ama kaynak {next.SourceInUs}us'ten başlıyor. Geçişi "
                    + "kısaltın ya da klibi kaynakta biraz ileriden başlatın.");
            }

            EnsureTransitionPlacement(current, next, track, width, height);

            outTransition[i] = transition;
            inTransition[i + 1] = transition;
            halfFrames[i + 1] = half;
        }

        for (var i = 0; i < clips.Count; i++)
        {
            if (clips[i].Media?.TransitionIn is not null && inTransition[i] is null)
            {
                throw new InvalidTimelineException(
                    $"geçiş simetrisi ihlali: '{clips[i].Id}' klibinde transitionIn var ama kesimin "
                    + "öteki tarafında (hemen önceki BİTİŞİK medya klibinde) eşleşen transitionOut yok.");
            }
        }

        for (var i = 0; i < clips.Count; i++)
        {
            var headInFrames = halfFrames[i];
            var headOutFrames = halfFrames[i + 1];
            if (headInFrames == 0 && headOutFrames == 0)
            {
                continue;
            }

            var headInUs = UsOf(headInFrames, fpsNum, fpsDen);
            var headOutUs = UsOf(headOutFrames, fpsNum, fpsDen);
            clips[i] = clips[i] with
            {
                TransitionIn = inTransition[i],
                TransitionOut = outTransition[i],
                HeadInFrames = headInFrames,
                HeadOutFrames = headOutFrames,
                HeadInUs = headInUs,
                HeadOutUs = headOutUs,
                HeadInSourceUs = SourceHandleUs(headInUs, clips[i].Rate),
                HeadOutSourceUs = SourceHandleUs(headOutUs, clips[i].Rate),
            };
        }
    }

    /// <summary>
    /// GÖRÜNEN geçiş kesiminin YERLEŞİM kuralları — <see cref="Validate"/> ve
    /// <see cref="Compile"/> AYNI iki soruyu sorar, farkları yalnız NE ZAMAN sorduklarıdır.
    /// <list type="number">
    ///   <item>iki tarafın yerleşimi EŞİT olmalı: <c>xfade</c> girişlerin aynı boyutta
    ///     olmasını şart koşar, farklı yerleşim katmanı geçiş boyunca sessizce kaydırırdı;</item>
    ///   <item>katman DÖNMÜŞ + çapası merkez dışı olamaz: geçişte run bölünemez, kutuya
    ///     normalize pad zorunludur ve o pad §2.5'in çapa telafisini yanlış tabana oturtur.</item>
    /// </list>
    /// KAYNAK DOSYASINA DOKUNMAZ: <see cref="LayerGeometry.Compute(Transform, int, int)"/>'un medya dalı yalnız
    /// transform + proje tuvali okur. Geçişin iki tarafı ŞEMA GEREĞİ medya klibidir (yukarıda
    /// <c>next.Media is null</c> ile reddedilir), dolayısıyla raster bbox'ı hiç gerekmez.
    /// </summary>
    private static void EnsureTransitionPlacement(
        ExportClipPlan a, ExportClipPlan b, Track track, int width, int height)
    {
        // Compile'daki `joined` koşulunun DOKÜMAN yarısı: kesim ancak İKİ TARAF DA GÖRSEL
        // katman ürettiğinde xfade'e çevrilir. Gizli track'te (yalnız ses kalır) ya da ses
        // klibinde kesim sıradan bir kesimdir — yerleşimin hiçbir rolü yoktur ve kapıyı
        // oraya da uygulamak YANLIŞ RET olurdu (acrossfade yerleşim bilmez).
        if (track.Hidden || a.Kind == ExportClipKind.Audio || b.Kind == ExportClipKind.Audio)
        {
            return;
        }

        var placementA = LayerGeometry.Compute(PlacementTransform(a), width, height);
        var placementB = LayerGeometry.Compute(PlacementTransform(b), width, height);
        if (placementA != placementB)
        {
            throw TransitionPlacementMismatch(a.Id, b.Id);
        }

        if (!CanNormalizeToBox(placementB))
        {
            throw TransitionRotatedAnchor(b.Id);
        }
    }

    /// <summary>
    /// Geçişli kesimde yerleşim farkı. Mesaj TEK yerde yaşar: Validate (senkron 422) ve
    /// Compile (worker sigortası) kullanıcıya AYNI cümleyi göstermek ZORUNDADIR.
    /// </summary>
    private static InvalidTimelineException TransitionPlacementMismatch(Guid previousId, Guid clipId) =>
        // Tip adı AÇIKÇA yazılır (hedef-tipli `new(...)` değil): ExportGateInventoryTests
        // fırlatma noktalarını KAYNAK TARAYARAK sayar, gizlenen bir tip adı defterin
        // tamlığını sessizce delerdi.
        new InvalidTimelineException(
            $"'{previousId}' ve '{clipId}' klipleri arasında geçiş var ama iki klibin "
            + "yerleşimi (konum/ölçek/dönme/çapa) farklı — geçişli kliplerin yerleşimi "
            + "aynı olmalıdır. Geçişi kaldırın ya da iki klibe de aynı dönüşümü verin.");

    /// <summary>
    /// Geçişli kesimde dönmüş + merkez dışı çapa. Editör çapayı hiç yazmadığı (daima 0.5)
    /// için bu yol ARAYÜZDEN ULAŞILAMAZ; mesaj bu yüzden yalnız kullanıcının GERÇEKTEN
    /// yapabileceği iki eylemi söyler.
    /// </summary>
    private static UnsupportedFeatureException TransitionRotatedAnchor(Guid clipId) =>
        new UnsupportedFeatureException("transition-rotated-anchor",
            $"'{clipId}' klibinde geçiş var ve katman DÖNDÜRÜLMÜŞ; bu klibin dönme "
            + "merkezi (çapası) karesinin ortasında olmadığı için geçiş katmanı "
            + "kaydırırdı. Klibin dönmesini 0 yapın ya da kesimdeki geçişi kaldırın.");

    /// <summary>
    /// §5.2: timeline-domain D/2 payının kaynak-domain karşılığı —
    /// <c>roundHalfUp((D/2) * rate)</c>. rate = 1'de kimliktir (tarihsel snapshot'lar korunur).
    /// </summary>
    private static long SourceHandleUs(long halfUs, double rate) =>
        rate == 1d ? halfUs : (long)Math.Floor((halfUs * rate) + 0.5);

    /// <summary>
    /// Kaynak-aralığı defterine giren klip: geçiş payları UYGULANMIŞ aralık. Pay yoksa
    /// dokümandaki nesnenin kendisi döner (tahsis yok); varsa KLON üretilir — klon süre
    /// sözleşmesini (out-in == timelineDuration) bilerek ihlal eder, çünkü bu defter yalnız
    /// "worker kaynaktan nereye kadar okuyacak" sorusunu yanıtlar.
    /// </summary>
    private static MediaClip EffectiveRangeClip(ExportClipPlan clip)
    {
        var media = clip.Media!;
        if (clip.HeadInSourceUs == 0 && clip.HeadOutSourceUs == 0)
        {
            return media;
        }

        return new MediaClip
        {
            Id = media.Id,
            Kind = media.Kind,
            AssetId = media.AssetId,
            TimelineStartUs = media.TimelineStartUs,
            TimelineDurationUs = media.TimelineDurationUs,
            SourceInUs = media.SourceInUs - clip.HeadInSourceUs,
            SourceOutUs = media.SourceOutUs + clip.HeadOutSourceUs,
            Speed = media.Speed,
            Transform = media.Transform,
            Keyframes = media.Keyframes,
            Effects = media.Effects,
            Opacity = media.Opacity,
            Audio = media.Audio,
        };
    }

    // ───────────────────────── Klip doğrulaması ─────────────────────────

    /// <summary>
    /// Geometri kapısının ihtiyaç duyduğu bağlam: proje tuvali + (varsa) metin ölçüm yolu.
    /// Ayrı bir kayıt, çünkü <see cref="ValidateClip"/> zincirinde dört parametre daha
    /// taşımak imza gürültüsünden başka bir şey üretmezdi.
    /// </summary>
    /// <param name="Settings">Proje ayarları (fps, örnekleme oranı) — klip doğrulamasının zaman tarafı.</param>
    /// <param name="Width">Proje tuval genişliği; ölçek kutusunun ve <c>P</c>'nin tabanı (§2.3).</param>
    /// <param name="Height">Proje tuval yüksekliği.</param>
    /// <param name="Measurer">
    /// Metin bbox ölçeri. <c>null</c> = kurulumda ölçer YOK → eski hoşgörülü davranış korunur
    /// (kapı zayıflar, yanlış ret üretilmez). Kayıtlı olup ölçüm BAŞARISIZ olursa durum farklıdır:
    /// klip <paramref name="Unmeasured"/>'a yazılır ve HTTP katmanı 503 döndürür.
    /// </param>
    /// <param name="Assets">
    /// Referans verilen asset satırlarının olgu defteri (<see cref="ExportAssetFacts"/>).
    /// <c>null</c> = defter geçirilmemiş (worker yolu) → asset olgusuna dayanan kapılar atlanır.
    /// </param>
    /// <param name="Unmeasured">
    /// Ölçer VERİLDİĞİ HALDE bbox'ı alınamayan metin klipleri — YERİNDE doldurulur ve plana
    /// taşınır (<see cref="ExportPlan.UnmeasuredTextClipIds"/>). Sayaç değil liste: HTTP
    /// katmanı hangi kliplerin etkilendiğini mesajda söyleyebilmelidir.
    /// </param>
    private readonly record struct GeometryContext(
        ProjectSettings Settings, int Width, int Height, ITextRasterService? Measurer,
        IReadOnlyDictionary<Guid, ExportAssetFacts>? Assets, List<Guid> Unmeasured);

    private static ExportClipPlan ValidateClip(Clip clip, GeometryContext geometry)
    {
        var planned = clip switch
        {
            MediaClip media => new ExportClipPlan
            {
                Source = media,
                Kind = media.Kind switch
                {
                    MediaClipKind.Video => ExportClipKind.Video,
                    MediaClipKind.Audio => ExportClipKind.Audio,
                    _ => ExportClipKind.Image,
                },
                Id = media.Id,
                TimelineStartUs = media.TimelineStartUs,
                TimelineDurationUs = media.TimelineDurationUs,
                Transform = media.Transform,
                Opacity = media.Opacity,
                AssetId = media.AssetId,
                Media = media,
                SourceInUs = media.SourceInUs,
                SourceOutUs = media.SourceOutUs,
            },
            TextClip text => new ExportClipPlan
            {
                Source = text,
                Kind = ExportClipKind.Text,
                Id = text.Id,
                TimelineStartUs = text.TimelineStartUs,
                TimelineDurationUs = text.TimelineDurationUs,
                Transform = text.Transform,
                Opacity = text.Opacity,
            },
            ShapeClip shape => new ExportClipPlan
            {
                Source = shape,
                Kind = ExportClipKind.Shape,
                Id = shape.Id,
                TimelineStartUs = shape.TimelineStartUs,
                TimelineDurationUs = shape.TimelineDurationUs,
                Transform = shape.Transform,
                Opacity = shape.Opacity,
            },
            StickerClip sticker => new ExportClipPlan
            {
                Source = sticker,
                Kind = ExportClipKind.Sticker,
                Id = sticker.Id,
                TimelineStartUs = sticker.TimelineStartUs,
                TimelineDurationUs = sticker.TimelineDurationUs,
                Transform = sticker.Transform,
                Opacity = sticker.Opacity,
                AssetId = sticker.AssetId,
            },
            _ => throw new UnsupportedFeatureException("unknown-clip",
                $"Timeline'da tanınmayan bir klip türü var ({clip.GetType().Name}) — "
                + "dışa aktarıcı bu klibi işleyemiyor."),
        };

        // ── M5: efektler (§4) ve keyframe'ler (§3) artık DERLENİR; doğrulama tipli hatalar üretir.
        planned = planned with
        {
            Effects = ColorPipeline.Parse(planned.Id, EffectsOf(clip)),
            Animation = KeyframeCompiler.Parse(planned.Id, KeyframesOf(clip)),
        };

        // Ses klibi görsel katman üretmez → transform/opaklık keyframe'inin karşılığı yoktur.
        // Sessizce yok saymak "animasyonum çalışmıyor" bug'ı üretirdi.
        if (planned.Kind == ExportClipKind.Audio && planned.Animation.Any)
        {
            throw new UnsupportedFeatureException("keyframes-audio-clip",
                $"'{planned.Id}' ses klibinde görsel keyframe animasyonu var — ses klibi "
                + "görüntü üretmez, bu animasyonun karşılığı yoktur.");
        }

        if (planned.Kind == ExportClipKind.Audio && planned.Effects.Any)
        {
            throw new UnsupportedFeatureException("effects-audio-clip",
                $"'{planned.Id}' ses klibinde renk efekti var — ses klibi görüntü üretmez.");
        }

        if (planned.TimelineDurationUs <= 0)
        {
            throw new InvalidTimelineException(
                $"'{planned.Id}' klibinin süresi pozitif olmalı (gelen değer "
                + $"{planned.TimelineDurationUs.ToString(CultureInfo.InvariantCulture)} us).");
        }

        if (planned.Kind == ExportClipKind.Sticker && planned.AssetId == Guid.Empty)
        {
            throw new InvalidTimelineException(
                $"'{planned.Id}' çıkartma klibinin assetId'si yok — çıkartma bir varlık dosyasıdır.");
        }

        ValidateGeometry(planned, geometry);

        if (planned.Media is not { } media2)
        {
            return planned;
        }

        // ── Yalnız medya kliplerine ait sözleşmeler (hız, kaynak aralığı, süre formülü, ses).
        // M5: sabit hız DESTEKLENİR (tasarım 04 §2.4). Hız RAMPASI (keyframe'li hız) şemada
        // yoktur ve kapsam dışıdır; şema rate'i [0.1..10] ile sınırlar — compiler aynı kapıyı
        // ikinci kez kurar (doküman doğrudan API'ye de gelebilir).
        var rate = media2.Speed?.Rate ?? 1d;
        if (!double.IsFinite(rate) || rate is < 0.1 or > 10)
        {
            throw new InvalidTimelineException(
                $"'{media2.Id}' klibinin hızı [0.1..10] aralığında olmalı (gelen değer "
                + $"{rate.ToString("0.######", CultureInfo.InvariantCulture)}).");
        }

        planned = planned with { Rate = rate };

        if (media2.SourceInUs < 0 || media2.SourceOutUs <= media2.SourceInUs)
        {
            throw new InvalidTimelineException(
                $"clip '{media2.Id}' has an invalid source range "
                + $"[{media2.SourceInUs}..{media2.SourceOutUs}] us.");
        }

        // Süre formülü (rendering-semantics §1.3): timelineDurationUs = roundHalfUp((out-in)/rate).
        // Şema ile BİREBİR aynı formül (packages/timeline-schema time.ts clipTimelineDurationUs).
        var expectedDurationUs = Timecode.ClipTimelineDurationUs(
            media2.SourceInUs, media2.SourceOutUs, rate);
        if (media2.TimelineDurationUs != expectedDurationUs)
        {
            throw new InvalidTimelineException(
                $"clip '{media2.Id}' violates the duration contract: timelineDurationUs="
                + $"{media2.TimelineDurationUs} but (sourceOutUs - sourceInUs)/rate={expectedDurationUs}.");
        }

        if (media2.Audio is { } audio)
        {
            if (audio.Volume is < 0 or > 2)
            {
                throw new InvalidTimelineException(
                    $"clip '{media2.Id}' audio.volume must be within [0..2].");
            }

            if (audio.FadeInUs < 0 || audio.FadeOutUs < 0
                || audio.FadeInUs + audio.FadeOutUs > media2.TimelineDurationUs)
            {
                throw new InvalidTimelineException(
                    $"clip '{media2.Id}' audio fades ({audio.FadeInUs}+{audio.FadeOutUs} us) "
                    + $"exceed the clip duration ({media2.TimelineDurationUs} us).");
            }
        }

        return planned;
    }

    private static KeyframeTracks? KeyframesOf(Clip clip) => clip switch
    {
        MediaClip m => m.Keyframes,
        TextClip t => t.Keyframes,
        ShapeClip s => s.Keyframes,
        StickerClip s => s.Keyframes,
        _ => null,
    };

    private static IReadOnlyList<Effect>? EffectsOf(Clip clip) => clip switch
    {
        MediaClip m => m.Effects,
        TextClip t => t.Effects,
        ShapeClip s => s.Effects,
        StickerClip s => s.Effects,
        _ => null,
    };

    /// <summary>
    /// Transform/opaklık sözleşmesi (rendering-semantics §2 + şema sınırları). Ses klibi
    /// görsel katman üretmediği için geometri doğrulaması ATLANIR.
    /// <para>
    /// METİN/ŞEKİL kliplerinde ölçek kutusu tuvalden değil rasterin KENDİ bbox'ından türer
    /// (§7). Bu yüzden tavan eskiden yalnız Compile'da (PlacementOf) doğrulanıyordu ve
    /// API'nin 422 ön kapısı onu GÖRMÜYORDU: iş kuyruğa giriyor, dakikalar sonra worker'da
    /// düşüyordu (3. tur denetim, blocker 2 — canlı ölçümle doğrulandı). Kural artık BURADA:
    /// <see cref="EnsureRasterFits"/> bbox'ı bildiği kadarıyla (şekilde kesin, metinde ölçüm
    /// varsa kesin, yoksa KESİN ALT SINIR) doğrular. Compile'daki tavan KALDIRILMADI — orada
    /// bbox her zaman gerçektir, yani alt sınırın kaçırdığı vaka orada hâlâ yakalanır.
    /// </para>
    /// </summary>
    private static void ValidateGeometry(ExportClipPlan clip, GeometryContext geometry)
    {
        var width = geometry.Width;
        var height = geometry.Height;

        // Bu mesajlar 422 ProblemDetails.Detail olarak KULLANICIYA görünür (ExportEndpoints) —
        // kardeş UnsupportedFeature mesajlarıyla aynı dilde olmalıdır (M4 dalga 1 denetimi).
        if (clip.Opacity is < 0 or > 1 || double.IsNaN(clip.Opacity))
        {
            throw new InvalidTimelineException(
                $"'{clip.Id}' klibinin opaklığı [0..1] aralığında olmalı "
                + $"(gelen değer {clip.Opacity.ToString(CultureInfo.InvariantCulture)}).");
        }

        if (clip.Kind == ExportClipKind.Audio)
        {
            return;
        }

        var transform = clip.Transform
            ?? throw new InvalidTimelineException($"'{clip.Id}' klibinde transform bilgisi yok.");

        if (!double.IsFinite(transform.X) || !double.IsFinite(transform.Y)
            || !double.IsFinite(transform.Scale) || !double.IsFinite(transform.RotationDeg)
            || !double.IsFinite(transform.AnchorX) || !double.IsFinite(transform.AnchorY))
        {
            throw new InvalidTimelineException(
                $"'{clip.Id}' klibinin transform değerlerinden biri sonlu bir sayı değil.");
        }

        if (transform.AnchorX is < 0 or > 1 || transform.AnchorY is < 0 or > 1)
        {
            throw new InvalidTimelineException(
                $"'{clip.Id}' klibinin çapa (anchor) noktası [0..1] aralığında olmalı.");
        }

        if (transform.Scale <= 0)
        {
            throw new InvalidTimelineException(
                $"'{clip.Id}' klibinin ölçeği pozitif olmalı "
                + $"(gelen değer {transform.Scale.ToString(CultureInfo.InvariantCulture)}).");
        }

        // ÖLÇEK ANİMASYONU + DÖNME birlikte kullanılamaz (M5 ölçümü). scale eval=frame katman
        // boyutunu kare kare değiştirir; rotate ise ÇIKIŞ TUVALİNİ config anında bir kez kurar
        // ve giriş büyüdüğünde YENİDEN YAPILANDIRMAZ — fazlalığı sessizce KIRPAR. Gerçek render:
        // ölçek 0.25 → 0.75 animasyonunda katman 80x60'ta kurulan 100x100 tuvalde kalıyor, son
        // karede 240x180'lik içeriğin yalnız ortası görünüyor (ow/oh'yi sabit sayı vermek de
        // düzeltmiyor). Sessiz kırpma yerine tipli hata.
        if (clip.Animation.Scale is not null
            && (transform.RotationDeg % 360d != 0 || clip.Animation.Rotation is not null))
        {
            throw new UnsupportedFeatureException("scale-keyframes-with-rotation",
                $"'{clip.Id}' klibinde hem ölçek animasyonu hem dönme var — bu bileşimde "
                + "dışa aktarıcı katmanı kırpardı. Ölçek animasyonunu ya da dönmeyi kaldırın.");
        }

        if (clip.NeedsServerRaster)
        {
            EnsureRasterFits(clip, geometry);
            return;
        }

        // TAVAN ve TABAN aynı transform'un ZIT uçlarından sorulur (bkz. PlacementTransform):
        // tavan animasyonun en büyük karesinde, taban en küçük karesinde ihlal edilir. Bunları
        // tek bir yerleşimden sormak 5. tur denetiminin BLOCKER 1'iydi — tavan MAKSİMUMDAN
        // kurulmuş yerleşime bakarken taban da o yerleşimden soruluyordu, yani animasyonun
        // tabanı hiç görülmüyordu ve belge 202 alıp worker'da ölüyordu.
        var placement = LayerGeometry.Compute(PlacementTransform(clip), width, height);
        EnsureLayerCeiling(clip.Id, clip.KindTr, placement);

        // Kaynak boyutu DB defterinden geldiyse taban SORUSU tam modelle sorulur (senkron 422,
        // iş kuyruğa HİÇ girmez); gelmediyse yalnız kaynaktan bağımsız yarısı sorulur ve
        // Compile'daki ffprobe yarısı emniyet kemeri kalır.
        var source = clip.AssetId is { } assetId
                     && geometry.Assets is { } assets
                     && assets.TryGetValue(assetId, out var facts)
                     && facts is { Width: { } w, Height: { } h }
            ? ((long)w, (long)h)
            : (0L, 0L);
        EnsureLayerFloor(
            clip.Id, clip.KindTr, clip, width, height, source.Item1, source.Item2);
    }

    /// <summary>
    /// Taban kapısının baktığı EN KÜÇÜK ölçek: statikte <c>transform.scale</c>, ölçek
    /// animasyonunda KEYFRAME MİNİMUMU.
    /// <para>
    /// Animasyonlu dalda statik alan HESABA KATILMAZ çünkü üretilen filtergraph onu hiç
    /// okumaz: ifade yalnız keyframe'lerden örneklenir ve ilk/son keyframe'in dışında
    /// uçlara sabitlenir (bkz. <see cref="ScaleFilter"/>). Statik alanı da hesaba katmak
    /// kapıyı derlenmeyecek bir değerden ötürü ret verebilir hale getirirdi.
    /// (TAVAN kuralı simetrik değildir ve bilerek öyledir: <see cref="PlacementTransform"/>
    /// bellek tavanını <c>max(statik, keyframe max)</c> ile kurar — orada fazladan güvenlik
    /// payı yanlış ret değil, yalnız daha erken bir ret üretir.)
    /// </para>
    /// <para>
    /// KAPSAM NOTU: "keyframe minimumu" örneklenen eğrinin minimumu DEĞİLDİR — undershoot'lu
    /// bir <c>cubicBezier</c> (y1 ya da y2 &lt; 0) ara değerleri keyframe tabanının altına
    /// indirebilir. Editör böyle bir eğri YAZAMAZ (<c>keyframeModel</c> yalnız hazır easing
    /// tiplerini sunar, serbest bezier'i dışarıda bırakır); ham API'den yazılan bir belgede
    /// ise kapı Compile aşamasında ffprobe/PNG boyutuyla yeniden koşar.
    /// </para>
    /// </summary>
    private static double MinScaleOf(ExportClipPlan clip) =>
        clip.Animation.Scale is { } animated ? animated.MinValue : clip.Transform?.Scale ?? 1d;

    /// <summary>
    /// Rasterlenecek klibin, ÇİZİM BAŞLAMADAN karar verilebilen sözleşmesi: renk alanları
    /// ayrıştırılabiliyor mu ve şekil klibinin <c>shape</c> gövdesi var mı.
    /// <para>
    /// NEDEN BURADA: bu kuralların tamamı SAF DOKÜMAN aritmetiğidir — ne dosya, ne asset, ne
    /// font gerekir. Kural yalnız raster hattında yaşadığı sürece belge 202 alıyor, kullanıcı
    /// render'ı bekliyor ve iş <c>overlay-unsupported-clip</c> ile düşüyordu (ham API ile
    /// ölçüldü). Artık istek kuyruğa hiç girmiyor.
    /// </para>
    /// <para>
    /// KOD BİLEREK RASTER HATTININ KODUYLA AYNIDIR (<c>overlay-unsupported-clip</c>): aynı
    /// kusur, hangi kapının yakaladığından bağımsız olarak kullanıcıya aynı makine kodunu
    /// göstermelidir. Koşullar da raster hattının koşullarının AYNADAKİ EŞİDİR
    /// (<c>SkiaOverlayRasterService.RenderText</c>/<c>RenderShape</c>): kontur rengi yalnız
    /// <c>widthPx &gt; 0</c> iken, arka plan rengi yalnız arka plan varken okunur. Kapı daha
    /// GENİŞ olsaydı raster hattının sorunsuz çizeceği belgeleri reddederdi (yanlış 422).
    /// </para>
    /// </summary>
    private static void EnsureRasterContract(ExportClipPlan clip)
    {
        switch (clip.Source)
        {
            case TextClip { Text: { } text }:
                EnsureColor(clip.Id, text.Fill, "text.fill");
                if (text.Stroke is { WidthPx: > 0 } textStroke)
                {
                    EnsureColor(clip.Id, textStroke.Color, "text.stroke.color");
                }

                if (text.Background is { } background)
                {
                    EnsureColor(clip.Id, background.Color, "text.background.color");
                }

                break;

            case ShapeClip shapeClip:
                // 'shape' gövdesiz bir şekil klibi çizilemez. (Metin tarafının aynı kuralı
                // RasterBoxOf'ta, kutuyu sorarken yaşar.)
                var shape = shapeClip.Shape
                    ?? throw new UnsupportedFeatureException("overlay-unsupported-clip",
                        $"'{clip.Id}' şekil klibinde 'shape' gövdesi yok — çizilecek bir şey "
                        + "tanımlanmamış.");
                EnsureColor(clip.Id, shape.Fill, "shape.fill");
                if (shape.Stroke is { WidthPx: > 0 } shapeStroke)
                {
                    EnsureColor(clip.Id, shapeStroke.Color, "shape.stroke.color");
                }

                break;
        }
    }

    /// <summary>
    /// Tek renk alanı. Dilbilgisi TEK YERDEN (<see cref="HexColor.TryParse"/>) sorulur —
    /// ikinci bir ayrıştırıcı yazmak iki kapının zamanla ayrışması demekti (kapı kabul eder,
    /// raster reddeder ya da tersi).
    /// </summary>
    private static void EnsureColor(Guid clipId, string? value, string field)
    {
        if (!HexColor.TryParse(value, out _))
        {
            throw new UnsupportedFeatureException("overlay-unsupported-clip",
                $"'{clipId}' klibinin '{field}' alanı geçersiz renk değeri taşıyor: "
                + $"'{value}'. Beklenen biçim: #RGB, #RRGGBB ya da #RRGGBBAA.");
        }
    }

    /// <summary>
    /// Raster (metin/şekil) klibinin PROJE PİKSELİNDEKİ kutusu, Validate aşamasının
    /// bildiği kadarıyla. <see cref="Exact"/> ise gerçek bbox'tır; değilse GERÇEĞİ ASLA
    /// AŞMAYAN bir alt sınırdır (dolayısıyla ondan üretilen ret KESİNDİR — yanlış 422 yok).
    /// </summary>
    private readonly record struct RasterBox(double WidthPx, double HeightPx, bool Exact);

    /// <summary>
    /// Raster klibinin iki tavanı da Validate aşamasında:
    /// <list type="number">
    ///   <item><b>Raster tuvali:</b> PNG en az <c>bbox × 1</c> boyutunda üretilir
    ///     (SkiaOverlayRasterService.ChooseRasterScale çarpanı 1'e kadar düşürür, altına inmez)
    ///     → bbox'ın kendisi <see cref="TextRasterOptions.MaxRasterDimension"/>'ı aşamaz.</item>
    ///   <item><b>Katman ara tuvali:</b> <c>bbox × transform.scale</c> (+ çapa pad'i, + rotate
    ///     köşegeni) <see cref="LayerGeometry.MaxLayerDimension"/>'ı aşamaz — medya kliplerindeki
    ///     kuralın aynısı, yalnız fit kutusu tuval değil bbox.</item>
    /// </list>
    /// İki sabit BİRE BİR aynıdır (8192; TextRasterOptions'ta da öyle yazar) ve
    /// <c>MaxRasterDimension_MirrorsMaxLayerDimension</c> testiyle sabitlenmiştir.
    /// </summary>
    private static void EnsureRasterFits(ExportClipPlan clip, GeometryContext geometry)
    {
        var box = RasterBoxOf(clip, geometry);

        if (box.WidthPx > LayerGeometry.MaxLayerDimension
            || box.HeightPx > LayerGeometry.MaxLayerDimension)
        {
            throw new UnsupportedFeatureException("overlay-too-large",
                $"'{clip.Id}' {clip.KindTr} klibinin çizim kutusu tek başına çok büyük: "
                + $"{Num(box.WidthPx)}x{Num(box.HeightPx)} piksel"
                + (box.Exact ? "" : " (en iyi durumda; gerçek kutu daha da büyük)")
                + $"; üst sınır {LayerGeometry.MaxLayerDimension.ToString(CultureInfo.InvariantCulture)}. "
                + (clip.Kind == ExportClipKind.Text
                    ? "Font boyutunu, satır sayısını ya da metin uzunluğunu küçültün."
                    : "Proje çözünürlüğünü küçültün (şeklin doğal kutusu tüm karedir)."));
        }

        var placement = LayerGeometry.Compute(
            PlacementTransform(clip), geometry.Width, geometry.Height, box.WidthPx, box.HeightPx);

        // TAVAN her hâlükârda: alt sınır GERÇEĞİ AŞMAZ, dolayısıyla ondan doğan ret KESİNDİR.
        EnsureLayerCeiling(clip.Id, clip.KindTr, placement);

        if (!box.Exact)
        {
            // TABAN alt sınırdan SORULAMAZ ve bu yön simetrik değildir: tavan için "gerçek ≥
            // alt sınır" yeterlidir, taban için ÜST sınır gerekir — metin genişliğinin
            // fonttan bağımsız bir üst sınırı YOKTUR. Alt sınırdan taban sorulsaydı ölçüm
            // yolu kapalı her kurulumda geçerli metinler reddedilirdi (yanlış 422).
            return;
        }

        // Kutu GERÇEK (şekilde sözleşme gereği, metinde ölçümle) → taban sorulabilir. Kaynak
        // (PNG'nin kendi piksel boyutu) Validate aşamasında henüz yok; kapı kaynaktan BAĞIMSIZ
        // yarıyı sorar. Bu yarı 5. tur denetiminin BLOCKER 1'indeki iki varyantı da kapatır:
        // bbox 223x104 @ölçek 0.010 → kutu 2x1, bbox 6x20 @0.010 → kutu 0x0.
        EnsureLayerFloor(clip.Id, clip.KindTr, clip, box.WidthPx, box.HeightPx, 0, 0);
    }

    /// <summary>
    /// Raster kutusunu çözer. Şekil: sözleşme gereği proje karesi (ölçüm YOK, KESİN).
    /// Metin: ölçüm yolu varsa gerçek bbox, yoksa font-bağımsız alt sınır.
    /// <para>
    /// Ölçüm bir ALTYAPI işidir (font kökü, manifest, Skia): başarısızlığı KULLANICI hatasına
    /// (422) çevirmeyiz — alt sınıra düşülür, gerçek tavan Compile'da zaten durmaktadır.
    /// </para>
    /// </summary>
    private static RasterBox RasterBoxOf(ExportClipPlan clip, GeometryContext geometry)
    {
        if (clip.Kind == ExportClipKind.Shape)
        {
            // ShapeGeometry.Compute: BoxWidthPx/BoxHeightPx DAİMA proje karesidir (şemada
            // şekle özel genişlik/yükseklik alanı yoktur) → ölçüme gerek yok.
            return new RasterBox(geometry.Width, geometry.Height, Exact: true);
        }

        var text = (clip.Source as TextClip)?.Text
            ?? throw new InvalidTimelineException($"'{clip.Id}' metin klibinde 'text' alanı yok.");

        // Raster hattının Compile öncesi ilk kapısı (SkiaOverlayRasterService.RenderText):
        // ölçüsüz metin PNG üretemez. Kural Validate'te de yaşamalı, yoksa iş kuyruğa girer.
        if (!double.IsFinite(text.FontSizePx) || text.FontSizePx <= 0
            || !double.IsFinite(text.LineHeight) || text.LineHeight <= 0)
        {
            throw new InvalidTimelineException(
                $"'{clip.Id}' metin klibi geçersiz ölçü taşıyor (fontSizePx="
                + $"{Num(text.FontSizePx)}, lineHeight={Num(text.LineHeight)}) — ikisi de pozitif olmalı.");
        }

        if (geometry.Measurer is { } measurer)
        {
            try
            {
                var layout = measurer.Measure(text, geometry.Settings);
                if (double.IsFinite(layout.BboxWidthPx) && double.IsFinite(layout.BboxHeightPx)
                    && layout.BboxWidthPx > 0 && layout.BboxHeightPx > 0)
                {
                    if (layout.FontIsDeterministic)
                    {
                        return new RasterBox(layout.BboxWidthPx, layout.BboxHeightPx, Exact: true);
                    }

                    // ÖLÇÜM YAPILDI AMA PİNLİ DEĞİL (sistem fontu — üç modlu politikanın 2.
                    // modu). Bu kutu küratörlü fontun kutusunun ne üst ne alt sınırıdır: ölçüldü,
                    // bbox genişliği -21,1% ile +7,9% arasında ayrışıyor (TextLayout
                    // .FontIsDeterministic'te düzenek ve tam tablo). Ona dayanan bir RET, üst
                    // sınırı KURULUM DURUMUNA bağlar ve yanlış 422 üretebilirdi; ona dayanan bir
                    // KABUL de aldatıcıdır. Kapı font-BAĞIMSIZ alt sınıra düşer (aşağıda) —
                    // gerçek tavan render anında, çizilen rasterin GERÇEK kutusuyla sorulur.
                    //
                    // 'Unmeasured' defterine YAZILMAZ: ölçüm patlamadı, yalnız pinli değil.
                    // Yazılsaydı fontları indirilmemiş her kurulumda metin içeren her istek
                    // 503 alırdı — oysa o kurulumda export ÇALIŞIR (belirlenimci olmayan
                    // piksellerle).
                    return LowerBoundBox(text);
                }
            }
            catch (FontNotFoundException unknownId) when (unknownId.ExpectedPath is null)
            {
                // BELGE HATASI — kurulum arızası DEĞİL. ExpectedPath'in null olması
                // FontNotFoundException'ın iki fabrikasını birbirinden ayırır: UnknownId
                // (manifestte BÖYLE BİR ID YOK) yol taşımaz, FileMissing (id tanımlı ama TTF
                // indirilmemiş) taşır. İlki kurulumdan BAĞIMSIZ ve KALICIDIR — font kökü
                // düzeltilse bile aynı belge aynı hatayı verir, dolayısıyla "yeniden deneyin"
                // demek (503) yanlış olurdu.
                //
                // Bu dal API'nin manifest ön kontrolünün ARDINDADIR ve onunla AYNI kodu
                // taşır: iki manifest okuyucusu (FontManifestProvider ile ölçerin kendi
                // manifesti) ayrıştığında ya da API tarafı manifesti hiç okuyamadığında
                // cevabın 503'e KAYMAMASINI garanti eder — kullanıcı hangi okuyucunun fark
                // ettiğinden bağımsız olarak aynı 'font-missing' 422'sini görür.
                throw new UnsupportedFeatureException("font-missing",
                    $"'{clip.Id}' metin klibi sunucunun tanımadığı bir fontId taşıyor: "
                    + $"'{text.FontId}'. {unknownId.Message}");
            }
            catch (Exception)
            {
                // BURADAN SONRASI ALTYAPIDANDIR (ve bilerek geniştir): küratörlü TTF
                // indirilmemiş (FontNotFoundException.FileMissing — ExpectedPath dolu),
                // manifest bozuk (FontManifestException), font dosyası açılamıyor/sha pini
                // tutmuyor (FontLoadException), SkiaSharp yerel kütüphanesi yüklenemedi
                // (TypeInitializationException/DllNotFoundException — API süreci bu hattı bu
                // değişiklikten ÖNCE hiç kullanmıyordu). Hiçbiri kullanıcının belgesiyle
                // ilgili değildir: dar bir catch, ölçümün patladığı bir kurulumda her export
                // isteğini 500'e çevirirdi. Kapı alt sınıra düşer, gerçek tavan Compile'da
                // durmaya devam eder.
            }

            // Ölçer VARDI ama kesin kutu ÜRETMEDİ (istisna ya da geçersiz/0 bbox). Bu bir
            // KURULUM arızasıdır — derleyici onu 422'ye çeviremez (belge suçsuz), ama artık
            // sessizce de yutmaz: plana yazılır ve kararı HTTP katmanı verir (İŞ 4; bkz.
            // ExportEndpoints — ölçüm yolu kapalıyken metin export'u ZATEN çalışamaz).
            geometry.Unmeasured.Add(clip.Id);
        }

        return LowerBoundBox(text);
    }

    private static RasterBox LowerBoundBox(TextClipText text)
    {
        var (lowW, lowH) = TextBoxLowerBound(text);
        return new RasterBox(lowW, lowH, Exact: false);
    }

    /// <summary>
    /// Metin bbox'ının FONTTAN BAĞIMSIZ KESİN ALT SINIRI. <see cref="TextLayoutEngine"/>'de
    /// bbox = birleşim(içerik kutusu, mürekkep+kontur, arka plan kutusu) ve sonra DIŞA
    /// yuvarlanır; birleşimin her bileşeni bbox için bir alt sınırdır:
    /// <list type="bullet">
    ///   <item>yükseklik ≥ içerik yüksekliği = <c>fontSizePx * lineHeight * satırSayısı</c>
    ///     (CSS line-height modeli — fonta BAĞLI DEĞİL);</item>
    ///   <item>arka plan varsa kutu her yönde <c>paddingPx</c> büyür → ±2*padding.</item>
    /// </list>
    /// GENİŞLİK için font-bağımsız bir alt sınır YOKTUR (glif ilerlemesi fonta bağlıdır, bir
    /// font sıfır genişlikli glif tanımlayabilir) — bu yüzden yalnız arka plan payı sayılır.
    /// Genişlikten doğan gerçek taşmayı ÖLÇÜM (varsa) ya da Compile yakalar.
    /// </summary>
    internal static (double WidthPx, double HeightPx) TextBoxLowerBound(TextClipText text)
    {
        ArgumentNullException.ThrowIfNull(text);

        var lineCount = TextLayoutEngine.SplitLines(text.Content ?? string.Empty).Count;
        var contentHeight = text.FontSizePx * text.LineHeight * lineCount;
        var padding = text.Background is { PaddingPx: var p } && double.IsFinite(p) && p > 0 ? p : 0d;
        return (2d * padding, contentHeight + (2d * padding));
    }

    /// <summary>
    /// Sentinel dönme açısı: kanal ANİMASYONLU olduğunda yerleşimin "dönüyor" dalına
    /// girmesi için kullanılır. Gerçek açı ifade/komutla beslenir; ara tuval
    /// <c>ow=oh=hypot(iw,ih)</c> olduğu için açıdan BAĞIMSIZDIR, dolayısıyla sentinel'in
    /// değeri bellek tavanını etkilemez.
    /// </summary>
    private const double RotationSentinelDeg = 90d;

    /// <summary>
    /// Yerleşim hesabına giren transform: keyframe'li kanallar statik alanı EZER (§3.3).
    ///  - ölçek animasyonluysa kutu ve BELLEK TAVANI en büyük keyframe değerinden hesaplanır
    ///    (ara tuval en büyük karede en büyüktür — denetim #2'nin aynı gerekçesi);
    ///  - dönme animasyonluysa katman "dönüyor" sayılır: rotate filtresi üretilir, overlay
    ///    çapa çarpanı 0.5'e düşer, gereken yerde çapa pad'i kurulur;
    ///  - x/y animasyonu geometriyi DEĞİL yalnız overlay konumunu etkiler → burada rol almaz.
    /// </summary>
    private static Transform PlacementTransform(ExportClipPlan clip)
    {
        var transform = clip.Transform;
        var animation = clip.Animation;
        if (animation.Scale is null && animation.Rotation is null)
        {
            return transform;
        }

        return new Transform
        {
            X = transform.X,
            Y = transform.Y,
            Scale = animation.Scale is { } scale ? Math.Max(transform.Scale, scale.MaxValue) : transform.Scale,
            RotationDeg = animation.Rotation is null ? transform.RotationDeg : RotationSentinelDeg,
            AnchorX = transform.AnchorX,
            AnchorY = transform.AnchorY,
        };
    }

    /// <summary>
    /// TABAN KAPISI (§2.3 adım 1'in önkoşulu) — dejenerelik. Kutu tek başına yeterli değildir:
    /// kaynağın EN-BOY ORANI kutununkinden çok farklıysa <c>scale</c>'in sığdırdığı eksen
    /// 1 pikselin ALTINA düşer, ffmpeg o ekseni 0 hesaplar ve 0'ı "girdi boyutunu koru" diye
    /// yorumlar. Sonuç iki dala ayrılır ve İKİSİ DE kabul edilemez (gerçek ffmpeg 8.0 ölçümü):
    /// <list type="bullet">
    ///   <item>çıktı normalize pad hedefini AŞARSA → <c>Padded dimensions cannot be smaller</c>,
    ///     ffmpeg <c>-22</c>: iş KUYRUK SONRASI ölür (1920x100 kaynak, kutu 19x11 → 18x100);</item>
    ///   <item>pad hedefine SIĞARSA → hiçbir hata yok, katman SESSİZCE yanlış boyutta çizilir
    ///     (200x10 kaynak, kutu 19x11 → 18x10; önizleme 20x1 çizerken export 10 KAT yüksek).</item>
    /// </list>
    /// <para>
    /// EN KÜÇÜK ölçekle sorulur: <c>scale</c> animasyonlu yolda <c>eval=frame</c> ile kare kare
    /// yeniden değerlendirilir (bkz. <see cref="ScaleFilter"/>), yani ölçeğin tabanı dejenere
    /// bir kareye düşerse o karelerde katman bozulur. TAVAN kuralı (<see cref="EnsureLayerCeiling"/>)
    /// simetrik olarak MAKSİMUM ölçekle sorulur — bkz. <see cref="PlacementTransform"/>.
    /// İkisini aynı uçtan sormak 5. tur denetiminin BLOCKER 1'iydi.
    /// </para>
    /// <para>
    /// KAYNAK BİLİNİYORken tam model (<see cref="LayerGeometry.IsDegenerate"/>), bilinmiyorken
    /// yalnız kaynaktan bağımsız yarı (<see cref="LayerGeometry.IsBelowScaleFloor"/>) sorulur:
    /// ölçüm/defter yokluğu yanlış ret üretmez, kapının gördüğü kümeyi daraltır.
    /// </para>
    /// </summary>
    private static void EnsureLayerFloor(
        Guid clipId, string kindTr, ExportClipPlan clip, double fitWidth, double fitHeight,
        long srcWidth, long srcHeight)
    {
        var minScale = MinScaleOf(clip);
        if (!double.IsFinite(minScale) || minScale <= 0
            || !double.IsFinite(fitWidth) || !double.IsFinite(fitHeight)
            || fitWidth <= 0 || fitHeight <= 0)
        {
            return; // bu ihlalleri ValidateGeometry/ClipAnimation kendi diliyle raporlar
        }

        // KUTU ARİTMETİĞİ YOLA GÖRE DEĞİŞİR ve kapı hangisinin derleneceğini bilmek ZORUNDADIR:
        // statik ölçekte kutuyu compiler yuvarlar ve sabit yazar; animasyonlu ölçekte ham çarpım
        // ifadesi yazılır ve tamsayıya çeviren ffmpeg'dir — KIRPARAK. Kapı ilk sürümünde iki
        // yolda da roundHalfUp varsayıyordu; sonuç, kapının kabul ettiği bir belgenin ffmpeg'de
        // ölmesiydi (223x104 bbox, taban 0.015 → ifade 3.345/1.56 → ffmpeg kutusu 3x1 → çıkış
        // 2x104, exit -12). GERÇEK FARE E2E'si bunu yakaladı; kapı artık yolun aritmetiğini kullanır.
        var truncated = clip.Animation.Scale is not null;
        var (boxWidth, boxHeight) = truncated
            ? LayerGeometry.ScaleBoxTruncated(fitWidth, fitHeight, minScale)
            : LayerGeometry.ScaleBox(fitWidth, fitHeight, minScale);
        var known = srcWidth > 0 && srcHeight > 0;
        var rejected = known
            ? LayerGeometry.IsDegenerate(boxWidth, boxHeight, srcWidth, srcHeight)
            : LayerGeometry.IsBelowScaleFloor(boxWidth, boxHeight);
        if (!rejected)
        {
            return;
        }

        var suggestion = LayerGeometry.MinScaleFor(fitWidth, fitHeight, srcWidth, srcHeight, truncated);
        var box = $"{boxWidth.ToString(CultureInfo.InvariantCulture)}x"
                  + $"{boxHeight.ToString(CultureInfo.InvariantCulture)}";
        // Animasyonlu klipte ret STATİK alandan değil KEYFRAME'den doğar; kullanıcı hangi
        // sayıyı düzelteceğini bilmeli (statik alan 1.0 iken "ölçeğiniz çok küçük" demek,
        // canlı ölçümde tam olarak yaşandığı gibi, panelde karşılığı olmayan bir mesajdır).
        var animated = clip.Animation.Scale is not null
            ? $" (ölçek animasyonlu; en küçük keyframe değeri {Num(minScale)})"
            : "";

        // Hangi eksen ve NE KADAR altına düşüyor — kullanıcı "ölçeği küçülttüm, neden
        // reddedildi" sorusunun cevabını sayıyla görmeli (EnsureLayerCeiling'in kardeş dili).
        var reason = known
            ? $"{srcWidth.ToString(CultureInfo.InvariantCulture)}x"
              + $"{srcHeight.ToString(CultureInfo.InvariantCulture)} piksellik kaynak {box} "
              + $"piksellik kutuya sığdırılınca {FittedAxisNote(boxWidth, boxHeight, srcWidth, srcHeight)} "
              + "düşüyor ve dışa aktarıcı katmanı çizemez. Bu klibin kaynağı çok geniş (ya da "
              + "çok dar) en-boy oranlı."
            : $"katmanın çizim kutusu {box} piksele iniyor; dışa aktarıcı her eksende en az "
              + "2 piksel ister (altında ffmpeg kutuyu 0 hesaplar ve katmanı kaynağın kendi "
              + "boyutunda çizer).";

        throw new UnsupportedFeatureException("degenerate-layer",
            $"'{clipId}' klibinin ölçeği çok küçük{animated}: {reason} "
            + $"{kindTr} klibinin ölçeğini en az {Num(suggestion)} yapın.");
    }

    /// <summary>Dejenere eksenin adı ve sığdırılan kesirli boyutu ("yüksekliği 0.93 px'e").</summary>
    private static string FittedAxisNote(long boxWidth, long boxHeight, long srcWidth, long srcHeight)
    {
        var fittedWidth = (double)boxHeight * srcWidth / srcHeight;
        var fittedHeight = (double)boxWidth * srcHeight / srcWidth;
        var axis = fittedHeight < 1 ? "yüksekliği" : "genişliği";
        var fitted = fittedHeight < 1 ? fittedHeight : fittedWidth;
        return $"{axis} bir pikselin altına ({Num(Math.Round(fitted, 2))} px)";
    }

    /// <summary>
    /// TAVAN KAPISI — asgari boyut kuralı OLMADAN. Ayrı durur çünkü tavan MAKSİMUM ölçekten,
    /// taban (<see cref="EnsureLayerFloor"/>) MİNİMUM ölçekten sorulur; ayrıca raster
    /// kliplerinin alt sınır yolu (bkz. <see cref="EnsureRasterFits"/>) yalnız bu yarıyı sorabilir.
    /// </summary>
    private static void EnsureLayerCeiling(Guid clipId, string kindTr, LayerPlacement placement)
    {
        if (placement.IntermediateWidth <= LayerGeometry.MaxLayerDimension
            && placement.IntermediateHeight <= LayerGeometry.MaxLayerDimension)
        {
            return;
        }

        var rotationNote = placement.Rotates
            ? " (dönme, katmanı köşegeni kadar büyük bir ara tuvale açar"
              + (placement.NeedsAnchorPad ? "; merkez dışı çapa bu tuvali ayrıca büyütür)" : ")")
            : "";
        throw new UnsupportedFeatureException("transform-scale",
            $"'{clipId}' klibinin ölçeği çok büyük: katman "
            + $"{placement.BoxWidth.ToString(CultureInfo.InvariantCulture)}x"
            + $"{placement.BoxHeight.ToString(CultureInfo.InvariantCulture)} piksele, "
            + "ara tuval "
            + $"{placement.IntermediateWidth.ToString(CultureInfo.InvariantCulture)}x"
            + $"{placement.IntermediateHeight.ToString(CultureInfo.InvariantCulture)} piksele çıkıyor"
            + rotationNote
            + $"; üst sınır {LayerGeometry.MaxLayerDimension.ToString(CultureInfo.InvariantCulture)}. "
            + $"{kindTr} klibinin ölçeğini (gerekirse dönme açısını) küçültüp yeniden deneyin.");
    }

    /// <summary>
    /// atempo katlama zinciri (tasarım 04 §2.4): filtrenin geçerli aralığı 0.5–100'dür,
    /// dışına düşen k tekrarlı çarpanlara bölünür (k=0.25 → 0.5, 0.5). rate = 1 iken
    /// zincir BOŞTUR — hiç filtre üretilmez (tarihsel snapshot'lar bayt bayt korunur).
    /// </summary>
    internal static IEnumerable<double> AtempoChain(double rate)
    {
        if (rate == 1d)
        {
            yield break;
        }

        var k = rate;
        while (k < 0.5d)
        {
            yield return 0.5d;
            k /= 0.5d;
        }

        while (k > 100d)
        {
            yield return 100d;
            k /= 100d;
        }

        yield return k;
    }

    /// <summary>
    /// atempo'nun WSOLA hazırlık gecikmesi (µs, GİRİŞ ekseninde) — <see cref="AtempoCompensationMs"/>
    /// formülünün <c>A</c> katsayısı. Ölçülmüş değerdir, tahmin DEĞİL.
    /// </summary>
    internal const double AtempoPrimingUs = 8430d;

    /// <summary>Aynı formülün ÇIKIŞ ekseninde sabit kalan payı (µs) — <c>B</c> katsayısı.</summary>
    internal const double AtempoPrimingTailUs = 1120d;

    /// <summary>
    /// atempo zincirinin A/V senkron telafisi (ms, <c>adelay</c> için).
    /// <para>
    /// <b>NEDEN GEREKLİ (gerçek ölçüm, ffmpeg 8.0, 48 kHz).</b> atempo WSOLA'dır ve akışın
    /// BAŞINDAN sabit bir pay yutar: kapılanmış burst kaynağı (8 sn, 1 kHz × 100 ms patlamalar,
    /// 0.5 sn'de bir) enerji-ağırlıklı patlama MERKEZİ ile ölçüldüğünde ses TIMELINE ekseninde
    /// ERKENE kayıyor. Telafi ÖNCESİ / SONRASI en büyük sapma (aynı ölçüm, aynı kaynak):
    /// <code>
    ///   rate 2     8.71 ms  →  3.71 ms      akış eksiği 10.7 ms → 0 (tam kilit)
    ///   rate 4     6.99 ms  →  3.99 ms      akış eksiği 16.0 ms → 0
    ///   rate 0.5  18.83 ms  →  1.63 ms      akış eksiği 53.3 ms → 0
    ///   rate 0.25 46.54 ms  → 11.54 ms      akış eksiği 160.0 ms → 0
    /// </code>
    /// 30 fps'te bir çıkış karesi 33.33 ms'tir: telafisiz hâlde rate 0.25 bunu 1.4 kare aşıyordu.
    /// </para>
    /// <para>
    /// <b>FORMÜL AMPİRİKTİR — kapalı formu yoktur ve tahmin edilmemiştir.</b> tempo taraması
    /// (0.5, 0.6, 0.75, 0.9, 1.25, 1.5, 2, 3, 4, 8) ölçülen kaymanın <c>A/rate + B</c> biçimine
    /// ±1 ms içinde oturduğunu gösterdi (A = 8.43 ms giriş ekseninde, B = 1.12 ms çıkış
    /// ekseninde). Pay filtrenin İÇ pencere/priming davranışından gelir, ffmpeg sürümüne
    /// bağlıdır ve bu yüzden <b>gerçek render ölçen bir regresyon testine bağlanmıştır</b>
    /// (ExportM5GoldenTests.Speed_KeepsAudioOnTheTimeline_MeasuredOnsets): ffmpeg davranışı
    /// değişirse test kırmızıya döner, sabit sessizce bayatlamaz.
    /// </para>
    /// <para>
    /// Zincirin katlanmış olması (0.25 → 0.5,0.5) formülü değiştirmez: TOPLAM rate üstünden
    /// hesaplanır; iki aşamalı zincirde ölçülen artık sapma 11.5 ms'tir (bir karenin ~%35'i).
    /// </para>
    /// </summary>
    internal static int AtempoCompensationMs(double rate)
    {
        if (rate == 1d)
        {
            return 0; // atempo hiç üretilmez → telafi edilecek gecikme de yok
        }

        var us = (AtempoPrimingUs / rate) + AtempoPrimingTailUs;
        return (int)Math.Round(us / 1000d, MidpointRounding.AwayFromZero);
    }

    // ───────────────────────── Ses zinciri ─────────────────────────

    /// <summary>
    /// Geçişle bağlanmış ses segmentlerinin oluşturduğu tek akış (§5.4 acrossfade zinciri).
    /// Geçiş yoksa grup TEK segmentlidir ve çıktısı M3'teki zincirle BAYT BAYT aynıdır.
    /// </summary>
    private sealed record AudioGroup(long StartUs)
    {
        public List<AudioSegment> Segments { get; } = [];
    }

    private sealed class AudioSegment
    {
        public required int InputIndex { get; init; }

        public required ExportClipPlan Clip { get; init; }

        public required ClipAudio Audio { get; init; }

        /// <summary>Track komşuları (§8.4 seamless splice kararı için) — duyulabilirlikten bağımsız.</summary>
        public required MediaClip? PrevClip { get; init; }

        public required MediaClip? NextClip { get; init; }

        /// <summary>SESİN gerçekten kullandığı geçiş payları (kullanılmayan pay atrim'le kırpılır).</summary>
        public required long HeadInUs { get; init; }

        public long HeadOutUs { get; set; }

        public Transition? EnteringTransition { get; init; }
    }

    /// <summary>
    /// Ses grubunu grafiğe yazar ve <c>[aN]</c> etiketini döndürür. Segment zincirleri
    /// acrossfade ile katlanır, timeline ofseti (adelay) EN SONDA bir kez uygulanır —
    /// acrossfade toplam süreyi Σd'de tuttuğu için A/V senkronu korunur (§5.4).
    /// </summary>
    private static string EmitAudioGroup(
        AudioGroup group, int audioIndex, ExportPlan plan, SampleBudget budget)
    {
        var label = $"a{audioIndex.ToString(CultureInfo.InvariantCulture)}";
        var delayMs = (group.StartUs + 500) / 1000; // µs → ms, half-up
        var delay = delayMs > 0
            ? $"adelay={delayMs.ToString(CultureInfo.InvariantCulture)}|{delayMs.ToString(CultureInfo.InvariantCulture)}"
            : null;

        if (group.Segments.Count == 1)
        {
            var only = BuildAudioChain(group.Segments[0], audioIndex, 0, plan, budget);
            var parts = delay is null ? only : only + "," + delay;
            return $"[{group.Segments[0].InputIndex.ToString(CultureInfo.InvariantCulture)}:a]"
                   + parts + $"[{label}]";
        }

        var lines = new List<string>(group.Segments.Count + group.Segments.Count);
        var segmentLabels = new List<string>(group.Segments.Count);
        for (var i = 0; i < group.Segments.Count; i++)
        {
            var segmentLabel = $"g{audioIndex.ToString(CultureInfo.InvariantCulture)}"
                               + $"_{i.ToString(CultureInfo.InvariantCulture)}";
            segmentLabels.Add(segmentLabel);
            lines.Add($"[{group.Segments[i].InputIndex.ToString(CultureInfo.InvariantCulture)}:a]"
                      + BuildAudioChain(group.Segments[i], audioIndex, i, plan, budget)
                      + $"[{segmentLabel}]");
        }

        var acc = segmentLabels[0];
        for (var i = 1; i < group.Segments.Count; i++)
        {
            var transition = group.Segments[i].EnteringTransition!;
            var last = i == group.Segments.Count - 1;
            var outLabel = last && delay is null
                ? label
                : $"f{audioIndex.ToString(CultureInfo.InvariantCulture)}"
                  + $"_{i.ToString(CultureInfo.InvariantCulture)}";
            // §5.4: acrossfade'in offset'i yoktur — A'nın son D'si ile B'nin ilk D'sini bindirir;
            // segmentler aynı D/2 payını aldığı için pencere video xfade'iyle ÖRTÜŞÜR.
            lines.Add($"[{acc}][{segmentLabels[i]}]acrossfade="
                      + $"d={TimeFormat.Sec(transition.DurationUs)}:c1=tri:c2=tri[{outLabel}]");
            acc = outLabel;
        }

        if (delay is not null)
        {
            lines.Add($"[{acc}]{delay}[{label}]");
        }

        return string.Join(";\n", lines);
    }

    /// <summary>
    /// Klibin DOKÜMANDA BEYAN EDİLEN ses ayarı (kaynağa bakmadan), yoksa null. apps/editor
    /// resolve.ts (clipAudioOf + isClipMuted) ile birebir aynı semantik:
    ///  - video klibi: gömülü ses; audio alanı null ise (detach) ses YOK;
    ///  - ses klibi: kendi sesi; null alan birim kazanca düşer;
    ///  - görsel klibi ve TÜM overlay klipleri (metin/şekil/çıkartma): hiç ses yok;
    ///  - track.muted ya da clip.audio.muted → ses YOK; track.hidden ses üretimini ETKİLEMEZ.
    /// </summary>
    private static ClipAudio? DeclaredAudioOf(ExportClipPlan clip, Track track)
    {
        if (clip.Media is not { } media)
        {
            return null; // metin/şekil/çıkartma ses üretmez
        }

        if (track.Muted || media.Kind == MediaClipKind.Image)
        {
            return null;
        }

        var audio = media.Kind == MediaClipKind.Audio
            ? media.Audio ?? new ClipAudio { Volume = 1, FadeInUs = 0, FadeOutUs = 0, Muted = false }
            : media.Audio;
        return audio is { Muted: false } ? audio : null;
    }

    /// <summary>
    /// Klibin DUYULABİLİR ses ayarı: beyan edilen ses + kaynakta gerçekten ses stream'i olması.
    /// </summary>
    private static ClipAudio? AudibleAudioOf(ExportClipPlan clip, Track track, ExportAssetSource? source) =>
        source is { HasAudio: true } ? DeclaredAudioOf(clip, track) : null;

    /// <summary>
    /// ATIL klip: track GİZLİ ve klip şema gereği ses de üretemiyor → ne görüntü ne ses.
    /// Böyle bir klip hiçbir ffmpeg girişi açmaz; asset'i indirmeye (plan.AssetIds), raster
    /// hattına (plan.RasterClips) ve worker'ın kaynak-aralığı kapısına (plan.Clips) sokmaya da
    /// gerek yoktur — render EDİLMEYEN bir klibin tüm export'u "source-out-of-range" ile
    /// düşürmesi böylece imkânsızlaşır (M4 dalga 1 denetimi).
    /// Kaynağa bağlı olmayan (yalnız dokümandan okunan) bir karardır: Validate'te de,
    /// Compile'da da AYNI sonucu verir.
    /// </summary>
    private static bool IsInert(ExportClipPlan clip, Track track) =>
        track.Hidden && DeclaredAudioOf(clip, track) is null;

    /// <summary>
    /// KLİP-VARLIK TÜR KURALININ TEK TANIMI: bu klip kaynak dosyadan NEYİ okur (okumuyorsa null)?
    /// <para>
    /// Cevap klip TÜRÜNDEN değil, derleyicinin o klip için kuracağı zincirden çıkar — aşağıdaki
    /// üç dal <see cref="Compile"/>'ın giriş açma koşullarının birebir aynısıdır:
    /// </para>
    /// <list type="bullet">
    ///   <item>metin/şekil klibi kendi PNG'siyle girer, hiçbir varlık okumaz;</item>
    ///   <item>ses klibi YALNIZ ses okur, o da beyan edilen bir ses varsa (susturulmuş track'te
    ///     giriş bile açılmaz — orada ses akışı ARAMAK yanlış ret olurdu);</item>
    ///   <item>görsel klipler (video/görsel/çıkartma) görüntü okur, o da GÖRÜNÜR track'te:
    ///     gizli track'teki video klibinin görüntüsü çizilmez, sesi varsa mikse girer ama
    ///     sesin varlığı OPSİYONELDİR (sessiz video meşrudur) — bu yüzden defterde yeri yoktur.
    ///     Zaman ekseni olmayan giriş (<c>-loop 1</c>) ile aralık okuyan giriş (<c>-ss/-t</c>)
    ///     AYRI ihtiyaçlardır; ikisini karıştıran belge ffmpeg'i anlamsız bir çıkış koduyla
    ///     düşürür (M6 denetimi, N3).</item>
    /// </list>
    /// </summary>
    private static ExportSourceNeed? NeedOf(ExportClipPlan clip, Track track)
    {
        if (clip.NeedsServerRaster || clip.AssetId is null)
        {
            return null;
        }

        if (clip.Kind == ExportClipKind.Audio)
        {
            return DeclaredAudioOf(clip, track) is null ? null : ExportSourceNeed.Audio;
        }

        if (track.Hidden)
        {
            return null;
        }

        return clip.IsStillInput ? ExportSourceNeed.Still : ExportSourceNeed.Motion;
    }

    /// <summary>
    /// WORKER YARISI: indirilen dosyanın ffprobe olguları defterdeki kullanımlardan birini
    /// karşılamıyorsa o kullanımı ve eksikliğin Türkçe adını döndürür (yoksa null).
    /// <para>
    /// Senkron yarısı <c>asset-clip-type</c>'tır ve AYNI defteri (<see cref="ExportPlan.AssetUses"/>)
    /// DB olgularıyla sorar. İki yarının farklı karar vermesi ancak DB satırı ile dosyanın
    /// çelişmesiyle mümkündür — ki o hâlde asset zaten Ready olamaz
    /// (<c>ProcessAssetJob.GateByKind</c>).
    /// </para>
    /// </summary>
    public static (ExportAssetUse Use, string Missing)? FindStreamMismatch(
        ExportPlan plan, Guid assetId, bool hasVideo, bool hasAudio, long? durationUs)
    {
        ArgumentNullException.ThrowIfNull(plan);

        foreach (var use in plan.AssetUses.Where(u => u.AssetId == assetId))
        {
            if (use.UnmetBy(hasVideo, hasAudio, durationUs) is { } missing)
            {
                return (use, missing);
            }
        }

        return null;
    }

    /// <summary>
    /// Klip ses zinciri (rendering-semantics §8 + görev sözleşmesi):
    /// [atempo] → [atrim] → asetpts → [adelay = atempo telafisi] → aformat → apad + atrim=end
    /// (UZUNLUK KİLİDİ) → volume (sabit ya da asendcmd'li keyframe) → afade in/out (curve=tri)
    /// → 5 ms micro-fade (§8.4). Timeline ofseti (adelay) ve acrossfade GRUP seviyesindedir
    /// (EmitAudioGroup).
    /// No-op filtreler (volume=1, fade=0, delay=0) determinism ve hız için ÜRETİLMEZ — snapshot
    /// sabitler.
    /// Micro-fade kuralı (§8.4, preview'daki gain.ts ile aynı mantık): her sert kesim kenarına
    /// 5 ms lineer fade; o kenarda kullanıcı fade'i varsa atlanır (fade zaten sıfıra iner);
    /// GEÇİŞ olan kenarda da atlanır (acrossfade zaten yumuşatır);
    /// seamless splice istisnası — AYNI TRACK'te bitişik + aynı asset + B.sourceIn==A.sourceOut
    /// + aynı rate ise ortak kenarda micro-fade uygulanmaz (split edilmiş klipte ses çukuru olmasın).
    /// <para>
    /// Zaman ekseni: giriş, geçiş paylarıyla AÇILMIŞTIR. Sesin kullanmadığı pay
    /// (<c>clip.HeadInUs - segment.HeadInUs</c>) baştaki atrim ile kırpılır — aksi halde
    /// duyulabilir ses komşunun timeline bölgesine taşardı.
    /// </para>
    /// </summary>
    private static string BuildAudioChain(
        AudioSegment segment, int audioIndex, int segmentIndex, ExportPlan plan,
        SampleBudget budget)
    {
        var clip = segment.Clip;
        var audio = segment.Audio;
        var durationUs = clip.TimelineDurationUs;
        var headInUs = segment.HeadInUs;
        var headOutUs = segment.HeadOutUs;

        var parts = new List<string>();

        // HIZ (tasarım 04 §2.4 + §8.3): atempo zinciri EN BAŞTADIR. Giriş KAYNAK ekseninde
        // açılır (-ss/-t), atempo'dan sonra akış TIMELINE eksenindedir — aşağıdaki atrim,
        // afade ve micro-fade pencerelerinin hepsi timeline-domain'dir, dolayısıyla atempo
        // onlardan ÖNCE gelmek zorundadır.
        foreach (var tempo in AtempoChain(clip.Rate))
        {
            parts.Add($"atempo={Num(tempo)}");
        }

        // Girişin açtığı toplam pencere ile SESİN kullanacağı pencere farklıysa kırp.
        var trimStartUs = clip.HeadInUs - headInUs;
        var trimDurationUs = headInUs + durationUs + headOutUs;
        var inputDurationUs = clip.HeadInUs + durationUs + clip.HeadOutUs;
        if (trimStartUs > 0 || trimDurationUs < inputDurationUs)
        {
            parts.Add($"atrim=start={TimeFormat.Sec(trimStartUs)}"
                      + $":end={TimeFormat.Sec(trimStartUs + trimDurationUs)}");
        }

        parts.Add("asetpts=PTS-STARTPTS");

        // atempo TELAFİSİ (§8.3, GERÇEK ÖLÇÜM — AtempoCompensationMs yorumundaki tablo):
        // WSOLA zinciri akışın BAŞINDAN sabit bir pay yutar, yani atempo'dan geçen ses TIMELINE
        // ekseninde ERKENE kayar. Telafi asetpts'ten SONRA yazılır: adelay'i asetpts'in ÖNÜNE
        // koymak ölçülen tuzaktır — asetpts=PTS-STARTPTS eklenen sessizliği PTS'ten geri düşer,
        // örnekler yerinde kalır ama aşağıdaki atrim=end penceresi telafi kadar UZAR
        // (ölçüldü: 4 sn hedefte 4.005 sn).
        var compensationMs = AtempoCompensationMs(clip.Rate);
        if (compensationMs > 0)
        {
            // all=1: kanal sayısı burada henüz kaynağınkidir (aformat AŞAĞIDA) — iki değerli
            // biçim 5.1 kaynakta yalnız ilk iki kanalı geciktirir ve kanalları AYRIŞTIRIRDI.
            parts.Add($"adelay={compensationMs.ToString(CultureInfo.InvariantCulture)}:all=1");
        }

        parts.Add("aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000");

        // UZUNLUK KİLİDİ (§8.3): akış, sözleşmedeki pencereye (headIn + süre + headOut) SABİTLENİR.
        // Gerekçe ÖLÇÜM: atempo zinciri kuyruktan da yutuyor (ffmpeg 8.0, 8 sn kaynak → rate
        // 2/4/0.5/0.25 için sırasıyla 10.7/16.0/53.3/160.0 ms EKSİK akış) ve kaynağın ses
        // stream'i videosundan kısa bitebilir. apad sonsuz sessizlik üretir, atrim onu kesip
        // EOF verir → hem eksik kuyruk dolar hem de fazlalık kırpılır; acrossfade'in Σd
        // sözleşmesi de ancak segment uzunlukları kesinken tutar.
        parts.Add("apad");
        parts.Add($"atrim=end={TimeFormat.Sec(trimDurationUs)}");

        // §8.1 volume: sabit çarpan ya da §3.4 frame örneklemesiyle sürülen keyframe eğrisi.
        // Komut, filtreyle AYNI LİNEER ZİNCİRDEDİR → kare-kesindir (StepExpression yorumundaki
        // framesync tuzağı yalnız çok girişli filtrelerde vardır); ses zincirinde sendcmd DEĞİL
        // asendcmd kullanılır (medya tipi uyuşmazlığı ölçüldü).
        if (clip.Animation.Volume is { } volumeTrack)
        {
            var tag = $"@v{audioIndex.ToString(CultureInfo.InvariantCulture)}"
                      + $"s{segmentIndex.ToString(CultureInfo.InvariantCulture)}";
            var samples = KeyframeCompiler.Samples(
                volumeTrack,
                clip.TimelineStartUs,
                FrameOf(clip.TimelineStartUs, plan.FpsNum, plan.FpsDen),
                FrameOf(clip.TimelineEndUs, plan.FpsNum, plan.FpsDen),
                plan.FpsNum, plan.FpsDen,
                // Komut ekseni ZİNCİR eksenidir: t=0 pencerenin başıdır, klip timeline başı
                // headIn kadar sonradır (geçiş payı) → offset = headIn - timelineStart.
                headInUs - clip.TimelineStartUs);
            budget.Charge(clip.Id, samples.Count, VolumeChannelTr, VolumeBudgetAction);
            parts.Add(KeyframeCompiler.ASendCmdFilter(
                samples.Select(s => KeyframeCompiler.Command(
                    s.TimeUs, $"volume{tag}", "volume", Num(s.Value)))));
            // Taban değer İLK keyframe'dir: ilk komut kendi karesinde uygulanır, ondan önceki
            // kareler (geçiş payı) §3.3 gereği ilk keyframe değerini görür.
            parts.Add($"volume{tag}={Num(volumeTrack.Keys[0].Value)}");
        }
        else if (audio.Volume != 1)
        {
            parts.Add($"volume={Num(audio.Volume)}");
        }

        if (audio.FadeInUs > 0)
        {
            parts.Add($"afade=t=in:st={FadeStart(headInUs)}"
                      + $":d={TimeFormat.Sec(audio.FadeInUs)}:curve=tri");
        }

        if (audio.FadeOutUs > 0)
        {
            parts.Add(
                $"afade=t=out:st={TimeFormat.Sec(headInUs + durationUs - audio.FadeOutUs)}"
                + $":d={TimeFormat.Sec(audio.FadeOutUs)}:curve=tri");
        }

        // §8.4 micro-fade'ler: kullanıcı fade'i o kenarı zaten sıfıra indiriyorsa, kenarda GEÇİŞ
        // varsa ya da kenar seamless splice ise atlanır; klip 5 ms'den kısaysa hiç üretilmez.
        var microIn = audio.FadeInUs <= 0
                      && segment.EnteringTransition is null
                      && !(segment.PrevClip is not null && clip.Media is not null
                           && IsSeamlessSplice(segment.PrevClip, clip.Media))
                      && durationUs > MicroFadeUs;
        var microOut = audio.FadeOutUs <= 0
                       && headOutUs == 0
                       && !(segment.NextClip is not null && clip.Media is not null
                            && IsSeamlessSplice(clip.Media, segment.NextClip))
                       && durationUs > MicroFadeUs;
        if (microIn)
        {
            parts.Add($"afade=t=in:st={FadeStart(headInUs)}"
                      + $":d={TimeFormat.Sec(MicroFadeUs)}:curve=tri");
        }

        if (microOut)
        {
            parts.Add(
                $"afade=t=out:st={TimeFormat.Sec(headInUs + durationUs - MicroFadeUs)}"
                + $":d={TimeFormat.Sec(MicroFadeUs)}:curve=tri");
        }

        return string.Join(',', parts);
    }

    /// <summary>
    /// afade başlangıcı: geçiş payı yokken tarihsel <c>st=0</c> biçimi AYNEN korunur
    /// (M3'ten beri commit'li snapshot'lar), payla birlikte tam saniye literal'i yazılır.
    /// </summary>
    private static string FadeStart(long us) => us == 0 ? "0" : TimeFormat.Sec(us);

    /// <summary>
    /// §8.4 seamless splice: aynı asset'in kaynağında tam bitişik devam — timeline'da boşluksuz,
    /// B.sourceIn == A.sourceOut ve rate eşit. Formül apps/editor gain.ts isSeamlessSplice ile
    /// birebir aynıdır (preview↔export paritesi).
    /// </summary>
    public static bool IsSeamlessSplice(MediaClip a, MediaClip b) =>
        a.AssetId == b.AssetId
        && a.Speed?.Rate == b.Speed?.Rate
        && a.TimelineStartUs + a.TimelineDurationUs == b.TimelineStartUs
        && a.SourceOutUs == b.SourceInUs;

    // ───────────────────────── Yardımcılar ─────────────────────────

    /// <summary>Proje fps grid'ine snap (rendering-semantics §1.4) — Timecode half-up sözleşmesiyle.</summary>
    private static long SnapUs(long us, int fpsNum, int fpsDen) =>
        UsOf(FrameOf(us, fpsNum, fpsDen), fpsNum, fpsDen);

    /// <summary>µs → proje grid frame numarası (rendering-semantics §1.4 frameFromUs).</summary>
    private static long FrameOf(long us, int fpsNum, int fpsDen) =>
        new Timecode(us).ToFrameNumber(fpsNum, fpsDen);

    /// <summary>Frame numarası → µs (rendering-semantics §1.4 usFromFrame).</summary>
    private static long UsOf(long frame, int fpsNum, int fpsDen) =>
        Timecode.FromFrameNumber(frame, fpsNum, fpsDen).Micros;

    /// <summary>Genel sayı literal'i — InvariantCulture, en fazla 6 kesir hanesi.</summary>
    private static string Num(double value) =>
        value.ToString("0.######", CultureInfo.InvariantCulture);

    /// <summary>
    /// Şema hex rengi (#RGB | #RRGGBB | #RRGGBBAA) → ffmpeg renk literal'i (0xRRGGBB).
    /// Alpha bileşeni kullanılmaz (taban tuval opak).
    /// </summary>
    private static string FfmpegColor(string? hex)
    {
        var value = (hex ?? "").TrimStart('#');
        var rgb = value.Length switch
        {
            3 => string.Concat(value.Select(c => new string(c, 2))),
            6 => value,
            8 => value[..6],
            _ => "000000",
        };
        return "0x" + rgb.ToUpperInvariant();
    }
}
