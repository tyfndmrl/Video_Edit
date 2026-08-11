using System.Globalization;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Recipes;

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
}

/// <summary>
/// FilterGraph Compiler v4 (M5 = HIZ + RENK DÜZELTME/LUT + transform/opaklık KEYFRAME'leri;
/// ses keyframe'i, hız rampası ve minterpolate hâlâ tipli hata).
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
///    muted klip ses üretmez. Zincir: [atrim] → asetpts → aformat(48k fltp stereo) → volume(lineer)
///    → afade in/out (curve=tri, §8.2) → 5 ms micro-fade (§8.4) → [acrossfade zinciri] → adelay;
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

    /// <summary>M4 dalga 2 kapsam + sözleşme doğrulaması. İhlalde ExportCompileException türevi fırlatır.</summary>
    public static ExportPlan Validate(TimelineDoc doc)
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
        var trackPlans = new List<ExportTrackPlan>();
        var sourceRangeClips = new List<MediaClip>();
        var rasterClips = new List<ExportClipPlan>();
        var assetIds = new List<Guid>();
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
                var planned = ValidateClip(clip, width, height);

                // Frame-grid güvenlik ağı (rendering-semantics §1.4): editör klipleri zaten proje
                // fps grid'inde üretir; grid dışı değer frame defterini bozup ±1 frame kayma üretir —
                // sessiz snap yerine sözleşme ihlali görünür olur.
                if (SnapUs(planned.TimelineStartUs, fpsNum, fpsDen) != planned.TimelineStartUs
                    || SnapUs(planned.TimelineDurationUs, fpsNum, fpsDen) != planned.TimelineDurationUs)
                {
                    throw new InvalidTimelineException(
                        $"clip '{planned.Id}' is not aligned to the project frame grid "
                        + $"({fpsNum.ToString(CultureInfo.InvariantCulture)}/{fpsDen.ToString(CultureInfo.InvariantCulture)} fps): "
                        + $"timelineStartUs={planned.TimelineStartUs}, timelineDurationUs={planned.TimelineDurationUs}.");
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

            // Geçiş sözleşmesi (§5.2): simetri + bitişiklik + çift-frame D + üst sınır + handle.
            // Doğrulanan her kesim iki klibe D/2 payı yazar; ihlal TİPLİ Türkçe hatadır.
            ResolveTransitions(clips, fpsNum, fpsDen);

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
                    rasterClips.Add(clip);
                    continue;
                }

                assetIds.Add(clip.AssetId!.Value);
                if (!clip.IsStillInput)
                {
                    sourceRangeClips.Add(EffectiveRangeClip(clip));
                }
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

        return new ExportPlan(
            doc, trackPlans, sourceRangeClips, assetIds.Distinct().ToList(), rasterClips,
            totalDurationUs, fpsNum, fpsDen, width, height, lutAssetIds.Distinct().ToList());
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
                    var placement = PlacementOf(clip, raster, plan);

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
                        throw new InvalidTimelineException(
                            $"'{previous!.Id}' ve '{clip.Id}' klipleri arasında geçiş var ama iki klibin "
                            + "yerleşimi (konum/ölçek/dönme/çapa) farklı — geçişli kliplerin yerleşimi "
                            + "aynı olmalıdır. Geçişi kaldırın ya da iki klibe de aynı dönüşümü verin.");
                    }

                    if (joined && !CanNormalizeToBox(placement))
                    {
                        // Geçişte run BÖLÜNEMEZ, dolayısıyla kutuya normalize pad ZORUNLUDUR.
                        // Bu pad, çapayı DÖNDÜRÜLEN katmanda koruyamaz: §2.5'in çapa telafisi
                        // pad'i gerçek görüntü boyutuna (iw/ih) göre ölçeklenir, normalize
                        // sonrası iw kutu boyutudur → çapa, içeriğin letterbox payı kadar kayar.
                        // Sessizce kaydırmak yerine görünür hata (M4 dalga 1 denetiminin
                        // "1 px sessiz kayma" kararının aynısı).
                        throw new InvalidTimelineException(
                            $"'{clip.Id}' klibinde geçiş var ama katman hem DÖNDÜRÜLMÜŞ hem de çapası "
                            + "merkezde değil — bu bileşimde geçiş katmanı kaydırırdı. Çapayı merkeze "
                            + "alın ya da geçişi kaldırın.");
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

        foreach (var group in audioGroups)
        {
            audioLines.Add(EmitAudioGroup(group, audioLines.Count));
        }

        // ── 1b) Animasyon defterleri (§3.4). EĞRİLİ (non-linear easing) kanallar frame başına
        //      örneklenip sendcmd komutlarına çevrilir; TAMAMI LİNEER kanallar ifadeyle çözülür
        //      ve buradan hiç komut çıkmaz. Örnekleme tavanı bir kez, derleme genelinde ölçülür.
        var sampleBudget = KeyframeCompiler.MaxSamples;
        for (var n = 0; n < runs.Count; n++)
        {
            sampleBudget = BuildAnimationCommands(runs[n], n, plan, sampleBudget);
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
    /// <returns>Kalan örnekleme bütçesi (tavan derleme genelindedir).</returns>
    private static int BuildAnimationCommands(
        LayerRun run, int index, ExportPlan plan, int sampleBudget)
    {
        if (run.AnimatedClip is not { } clip)
        {
            return sampleBudget;
        }

        var budget = sampleBudget;
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

        return budget;

        string? Coordinate(AnimationTrack? track, int size, double anchorFactor, string dimension)
        {
            // §2.5 adım 4: overlay_x = P.x - anchor*w. P.x = W/2 + x*W.
            var expression = Expression(track, clipRelative: false, v => (size / 2d) + (v * size));
            if (expression is null)
            {
                return null;
            }

            return anchorFactor == 0
                ? expression
                : $"{expression}-{Num(anchorFactor)}*{dimension}";
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
            if (samples.Count > budget)
            {
                throw new UnsupportedFeatureException("keyframe-sample-budget",
                    $"'{clip.Id}' klibindeki keyframe animasyonu çok fazla örnek üretiyor "
                    + $"({samples.Count}). Eğrili (easing'li) animasyon KARE KARE örneklenir — "
                    + "animasyonu kısaltın ya da lineer easing kullanın.");
            }

            budget -= samples.Count;
            return samples;
        }
    }

    /// <summary>
    /// Animasyonlu ölçek kutusunun TABANI (<c>scale = 1</c> boyutu): medya/görsel/çıkartma
    /// klibinde proje tuvali, metin/şekil rasterinde kendi bbox'ı (§7). Kutu bunun
    /// <c>scale(t)</c> katıdır — statik yoldaki <c>roundHalfUp</c> yerine ham çarpım kullanılır
    /// (yuvarlamayı ffmpeg'in force_divisible_by=2 kuralı devralır).
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
    ///    merkez dışı çapada pad, çapayı görüntü içindeki oranından kaydırırdı;
    ///  - kutu ÇİFT boyutlu: pad ofseti <c>(ow-iw)/2</c> tamsayı bölmedir; kutu ve ölçek çıktısı
    ///    (force_divisible_by=2 sayesinde) çift olduğunda ofset TAM bölünür, aksi halde katman
    ///    yarım piksel kayardı.
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
    ///    boyutu olduğu için telafi yanlış tabana oturur;
    ///  - kutu TEK boyutluysa pad ofseti tamsayı bölmede yarım piksel kaybeder.
    /// Geçişsiz run bu durumda bölünür (optimizasyondan vazgeçilir); geçişli run BÖLÜNEMEZ →
    /// tipli hata verilir.
    /// </summary>
    private static bool CanNormalizeToBox(LayerPlacement placement) =>
        !placement.NeedsAnchorPad
        && placement.BoxWidth % 2 == 0
        && placement.BoxHeight % 2 == 0;

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

        if (normalizeToBox)
        {
            // concat/xfade girişleri AYNI boyutta olmalı; gerçek ölçek çıktısı kaynağın
            // aspect'ine bağlıdır → şeffaf pad ile kutuya sabitlenir. Ofset ÇAPA ORANINDADIR:
            // merkez çapada (ow-iw)/2 ile birebir aynıdır, merkez dışı çapada ise §2.5'in
            // "çapa görüntünün kendi kutusundaki oranındadır" kuralını korur (geçişli kesimde
            // run bölünemediği için bu genel biçim şarttır).
            chain.Add($"pad={placement.BoxWidth.ToString(CultureInfo.InvariantCulture)}"
                      + $":{placement.BoxHeight.ToString(CultureInfo.InvariantCulture)}"
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

            // ow=oh=hypot(iw,ih) (= §2.5'in Dg'si) dönen kutuyu her açıda kapsar; c=none şeffaf
            // arka plan. Bu tuvalin BÜYÜKLÜĞÜ LayerPlacement.Intermediate* ile önceden hesaplanıp
            // MaxLayerDimension'a karşı doğrulanmıştır (denetim #2) — buradaki ifade ffmpeg'in
            // gerçek iw/ih'siyle aynı değeri config anında bir kez üretir.
            // Filtergraph içinde argüman virgülü KAÇIRILMALIDIR (\,) — aksi halde filtre ayracı sanılır.
            chain.Add($"rotate=a={RotationArgument(run)}:c=none:ow=hypot(iw\\,ih):oh=ow");
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

    /// <summary>overlay_x = P.x - anchorFactor * &lt;w|h&gt; (§2.5); çarpan 0 ise sade sabit.</summary>
    private static string OverlayCoordinate(double target, double anchorFactor, string dimension) =>
        anchorFactor == 0
            ? Num(target)
            : $"{Num(target)}-{Num(anchorFactor)}*{dimension}";

    /// <summary>
    /// Katmanın yerleşimi. Medya/görsel/ÇIKARTMA klibinde ölçek kutusunun tabanı proje
    /// tuvalidir (fit=contain, §2.2); METİN/ŞEKİL rasterinde kendi doğal boyutudur (§7 @2x).
    /// Raster kliplerinin bellek tavanı BURADA doğrulanır — Validate raster boyutunu bilmez.
    /// </summary>
    private static LayerPlacement PlacementOf(
        ExportClipPlan clip, ExportRasterSource? raster, ExportPlan plan)
    {
        if (raster is null)
        {
            return LayerGeometry.Compute(PlacementTransform(clip), plan.Width, plan.Height);
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
        EnsureLayerFits(clip.Id, clip.KindTr, placement);
        return placement;
    }

    // ───────────────────────── Geçişler (rendering-semantics §5) ─────────────────────────

    /// <summary>
    /// Track içindeki geçiş kesimlerini doğrular ve D/2 paylarını kliplere yazar (liste
    /// YERİNDE güncellenir). Kurallar §5.2'dir: bitişiklik, simetri (iki taraf derin-eşit),
    /// D proje frame grid'inde ve ÇİFT frame (D/2 tam frame olsun), D*2 ≤ kısa komşunun
    /// süresi, ve kaynak payı (handle). İhlaller sessizce düzeltilMEZ — editör bu dokümanı
    /// üretmemeliydi.
    /// </summary>
    private static void ResolveTransitions(List<ExportClipPlan> clips, int fpsNum, int fpsDen)
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

    private static ExportClipPlan ValidateClip(Clip clip, int width, int height)
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

        ValidateGeometry(planned, width, height);

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
    /// görsel katman üretmediği için geometri doğrulaması ATLANIR. Metin/şekil kliplerinde
    /// ölçek KUTUSU raster boyutuna bağlıdır ve Validate rasteri bilmez — tavan doğrulaması
    /// onlar için Compile'da (PlacementOf) yapılır.
    /// </summary>
    private static void ValidateGeometry(ExportClipPlan clip, int width, int height)
    {
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
            return; // kutu raster boyutundan türer → tavan Compile'da (PlacementOf)
        }

        var placement = LayerGeometry.Compute(PlacementTransform(clip), width, height);
        EnsureLayerFits(clip.Id, clip.KindTr, placement);
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
    /// Katman bellek tavanı. Tavan ARA TUVALDEN doğrulanır (denetim #2): çapa telafisi pad'i
    /// kutuyu 2x'e, rotate hypot'u ~1.41x'e büyütür — kutuyu doğrulamak gerçek tavanı ~23170
    /// piksele (rgba'da ~2.1 GB/kare, worker OOM) taşırdı. Mesaj hem kutuyu hem ara tuvali
    /// verir ki kullanıcı "ölçek küçük ama neden reddedildi" sorusunun cevabını görsün.
    /// </summary>
    private static void EnsureLayerFits(Guid clipId, string kindTr, LayerPlacement placement)
    {
        if (placement.BoxWidth < 2 || placement.BoxHeight < 2)
        {
            throw new InvalidTimelineException(
                $"'{clipId}' klibinin ölçeği katmanı bir pikselin altına düşürüyor.");
        }

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
    private static string EmitAudioGroup(AudioGroup group, int audioIndex)
    {
        var label = $"a{audioIndex.ToString(CultureInfo.InvariantCulture)}";
        var delayMs = (group.StartUs + 500) / 1000; // µs → ms, half-up
        var delay = delayMs > 0
            ? $"adelay={delayMs.ToString(CultureInfo.InvariantCulture)}|{delayMs.ToString(CultureInfo.InvariantCulture)}"
            : null;

        if (group.Segments.Count == 1)
        {
            var only = BuildAudioChain(group.Segments[0]);
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
                      + BuildAudioChain(group.Segments[i]) + $"[{segmentLabel}]");
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
    /// Klip ses zinciri (rendering-semantics §8 + görev sözleşmesi):
    /// [atrim] → asetpts → aformat → volume → afade in/out (curve=tri) → 5 ms micro-fade (§8.4).
    /// adelay ve acrossfade GRUP seviyesindedir (EmitAudioGroup).
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
    private static string BuildAudioChain(AudioSegment segment)
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
        parts.Add("aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000");

        if (audio.Volume != 1)
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
