using System.Globalization;
using System.Text;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media;
using VideoEdit.Media.Export;
using VideoEdit.Media.Text;
using MediaEasing = VideoEdit.Media.Easing;
using MediaKeyframe = VideoEdit.Media.Keyframe;

namespace VideoEdit.UnitTests;

/// <summary>
/// FilterGraph Compiler snapshot testleri: sabit fixture dokümanları → üretilen
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
            // İlk klip 1 sn'de başlar → baştaki boşlukta taban tuval görünür.
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
            // frame defteri + trim=end_frame olmadan ±1 frame kayma üretebilir (denetim reprosu).
            // Klip2: frame 32'de başlar (1067733 µs — grid'de), 60 frame sürer.
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_001_000,
                ExportTestDocs.Audio()),
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_067_733, 2_000_000, 4_002_000,
                ExportTestDocs.Audio(volume: 0.5)),
        ]);

    // ---------- Çok katman fixture'ları ----------

    /// <summary>İki tam-kare video katmanı: tracks[0] EN ÜST — render sırası sondan başa.</summary>
    private static TimelineDoc TwoVideoLayers() => ExportTestDocs.MultiTrackDoc(
    [
        // ÜST katman: 1-3 sn arası görünür; altındaki taban katmanı bu pencerede örter.
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_000_000, 0, 2_000_000,
                ExportTestDocs.Audio()),
        ]),
        // ALT (taban) katman: 0-4 sn tam kare.
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 4_000_000,
                ExportTestDocs.Audio()),
        ]),
    ]);

    /// <summary>Transform'lu PiP: ölçek 0.35, sağ üst çeyreğe taşınmış (rendering-semantics §2).</summary>
    private static TimelineDoc PipTransform() => ExportTestDocs.MultiTrackDoc(
    [
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_000_000, 0, 2_000_000,
                transform: ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.35)),
        ]),
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 4_000_000,
                ExportTestDocs.Audio()),
        ]),
    ]);

    /// <summary>Opaklık + dönme: alpha'lı katman format=rgba + colorchannelmixer + rotate.</summary>
    private static TimelineDoc LayerOpacity() => ExportTestDocs.MultiTrackDoc(
    [
        // ÜST: yarı saydam, 30° döndürülmüş, sol alt çapalı (çapa telafisi pad'i üretir).
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 0, 0, 2_000_000,
                transform: ExportTestDocs.Transform(scale: 0.5, rotationDeg: 30, anchorX: 0, anchorY: 1),
                opacity: 0.5),
        ]),
        // ORTA: yarı saydam ama dönmesiz (yalnız colorchannelmixer).
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000, opacity: 0.25),
        ]),
        // ALT: opak taban.
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
        ]),
    ]);

    /// <summary>
    /// hidden track GÖRSEL üretmez ama SES üretmeye devam eder; muted track ses üretmez
    /// (apps/editor resolve.ts semantiği — hidden yalnız görsel gizlemedir).
    /// </summary>
    private static TimelineDoc HiddenAndMutedTracks() => ExportTestDocs.MultiTrackDoc(
    [
        // ÜST: gizli — overlay YOK, ses VAR.
        ExportTestDocs.VideoTrack(hidden: true, clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000, ExportTestDocs.Audio()),
        ]),
        // ORTA: susturulmuş — overlay VAR, ses YOK.
        ExportTestDocs.VideoTrack(muted: true, clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 0, 0, 2_000_000, ExportTestDocs.Audio()),
        ]),
        // ALT: normal.
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
        ]),
    ]);

    /// <summary>
    /// Denetim #1 reprosu: OPAK katman, ALPHA'lı katmanın ÜSTÜNDE. Katman başına format
    /// seçiminde alt overlay RGB'de, üst overlay yuv420'de blend ederdi → zincirin ortasında
    /// RGB↔YUV dönüşümü ve gözle görülür renk kayması (gerçek render ölçümü: MSE 187 > 60).
    /// Sözleşme: format seçimi GRAFİK BAŞINADIR — tüm overlay'ler :format=rgb.
    /// </summary>
    private static TimelineDoc OpaqueOverAlpha() => ExportTestDocs.MultiTrackDoc(
    [
        // ÜST: tamamen OPAK PiP (alpha yok, dönme yok) — alttaki alpha'lı katmanın üstüne biner.
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000,
                transform: ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.5)),
        ]),
        // ORTA: yarı saydam tam kare katman (grafiğin alpha taşıyan tek katmanı).
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 0, 0, 2_000_000, opacity: 0.5),
        ]),
        // ALT: opak taban.
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
        ]),
    ]);

    /// <summary>
    /// Aynı track'te ARDIŞIK iki PiP klibi (aynı yerleşim) + altında tam kare taban katman.
    /// Üst track'in iki klibi TEK concat zincirinde birleşir ve tuvale TEK overlay ile biner —
    /// klip başına overlay yalnız gerçek katmanlaşmada üretilir (ölçülen performans bulgusu).
    /// </summary>
    private static TimelineDoc LayerRunConcat() => ExportTestDocs.MultiTrackDoc(
    [
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_000_000, 0, 1_000_000,
                transform: ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.5)),
            ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 2_000_000, 0, 1_000_000,
                transform: ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.5)),
        ]),
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 4_000_000, ExportTestDocs.Audio()),
        ]),
    ]);

    /// <summary>
    /// Tek görsel (still image) klibi: -loop 1 -t girişi + tek katmanlı hızlı yol + ses yok
    /// (anullsrc). Kullanıcının "fotoğrafı sürükleyip dışa aktarma" akışının birebir karşılığı.
    /// </summary>
    private static TimelineDoc ImageClip() => ExportTestDocs.Doc(
        clips: ExportTestDocs.ImageClip(ExportTestDocs.AssetC, 0, 4_000_000));

    /// <summary>Görsel klip ÜST katmanda (PiP, yarı saydam) — video taban katmanın üstünde.</summary>
    private static TimelineDoc ImageOverVideo() => ExportTestDocs.MultiTrackDoc(
    [
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.ImageClip(ExportTestDocs.AssetC, 1_000_000, 2_000_000,
                transform: ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.35),
                opacity: 0.8),
        ]),
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 4_000_000, ExportTestDocs.Audio()),
        ]),
    ]);

    // ---------- Geçişler (rendering-semantics §5) ----------

    /// <summary>
    /// §5.2 sözleşmesinin taşıyıcısı: klipler timeline'da BİTİŞİK (0-2 sn, 2-4 sn), geçiş
    /// kesime iliştirilmiş metadata'dır. D = 400 ms = 12 frame @30 (ÇİFT frame → D/2 = 6 frame
    /// tam sayı); kaynaklar 1 sn'den başlar, yani her iki tarafta D/2 = 200 ms pay VAR.
    /// Toplam süre geçişten ETKİLENMEZ: 4 sn.
    /// </summary>
    private static TimelineDoc TransitionSingle(
        TransitionType type = TransitionType.Crossfade, ClipAudio? audio = null)
    {
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000, audio);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000, audio);
        ExportTestDocs.Link(a, b, 400_000, type);
        return ExportTestDocs.Doc(clips: [a, b]);
    }

    /// <summary>
    /// Geçişli kesim + TEK boyutlu ölçek kutusu. 1920x1080 tuvalde scale 0.501 →
    /// roundHalfUp: 962 x 541 — YÜKSEKLİK TEK. Bu fixture kuralın İKİ yarısını tek dizede
    /// sabitler:
    ///   * <c>scale=962:541</c> — ölçek hedefi HAM kutudur, çifte indirilMEZ (indirseydik
    ///     içerik 962→960 küçülür ve geçişSİZ yolla ayrışırdı; gerçek ffmpeg ile ölçüldü);
    ///   * <c>pad=962:540:...</c> — normalize pad hedefi kutunun ÇİFTE İNDİRİLMİŞ halidir,
    ///     çünkü scale çıktısı daima çifttir ve tek hedefe pad'lemek ofseti kırpıp katmanı
    ///     1 px kaydırırdı.
    /// Kutu paritesi kapısı kalkmadan bu doküman derlenemiyordu (worker'da "Başarısız").
    /// </summary>
    private static TimelineDoc TransitionOddBox()
    {
        var odd = ExportTestDocs.Transform(scale: 0.501);
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000,
            transform: odd);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000,
            transform: odd);
        ExportTestDocs.Link(a, b, 400_000);
        return ExportTestDocs.Doc(clips: [a, b]);
    }

    /// <summary>Zincirleme: 3 klip, 2 geçiş (farklı tipler) — kümülatif offset §5.3'ten gelir.</summary>
    private static TimelineDoc TransitionChain()
    {
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000,
            ExportTestDocs.Audio());
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000,
            ExportTestDocs.Audio());
        var c = ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 4_000_000, 1_000_000, 3_000_000,
            ExportTestDocs.Audio());
        ExportTestDocs.Link(a, b, 400_000);
        ExportTestDocs.Link(b, c, 200_000, TransitionType.WipeLeft); // 6 frame @30
        return ExportTestDocs.Doc(clips: [a, b, c]);
    }

    /// <summary>
    /// Geçişli track ÇOK KATMANLI kompozisyonla birlikte: alt track kendi içinde tek birleşik
    /// akışa (xfade) derlenir, sonra üst katman PiP'iyle tuvale biner (tasarım 04 §2.3).
    /// </summary>
    private static TimelineDoc TransitionWithPipLayer()
    {
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000,
            ExportTestDocs.Audio());
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000,
            ExportTestDocs.Audio());
        ExportTestDocs.Link(a, b, 400_000, TransitionType.FadeToBlack);
        return ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 1_000_000, 0, 2_000_000,
                    transform: ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.35)),
            ]),
            ExportTestDocs.VideoTrack(clips: [a, b]),
        ]);
    }

    // ---------- Overlay varlıkları (metin / şekil / çıkartma) ----------

    /// <summary>Metin katmanı video tabanın üstünde: raster PNG -loop 1 -t ile girer, ses ÜRETMEZ.</summary>
    private static TimelineDoc TextOverVideo() => ExportTestDocs.MultiTrackDoc(
    [
        ExportTestDocs.OverlayTrack(clips:
        [
            ExportTestDocs.TextClip(1_000_000, 2_000_000,
                transform: ExportTestDocs.Transform(y: 0.3)),
        ]),
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 4_000_000, ExportTestDocs.Audio()),
        ]),
    ]);

    /// <summary>Şekil (yarı saydam) + çıkartma (asset PNG) katmanları — ikisi de sessizdir.</summary>
    private static TimelineDoc ShapeAndSticker() => ExportTestDocs.MultiTrackDoc(
    [
        ExportTestDocs.OverlayTrack(clips:
        [
            ExportTestDocs.StickerClip(ExportTestDocs.AssetC, 0, 2_000_000,
                transform: ExportTestDocs.Transform(x: -0.25, y: 0.25, scale: 0.25)),
        ]),
        ExportTestDocs.OverlayTrack(clips:
        [
            ExportTestDocs.ShapeClip(0, 2_000_000,
                transform: ExportTestDocs.Transform(scale: 0.5), opacity: 0.4),
        ]),
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
        ]),
    ]);

    /// <summary>Video track + audio track miksi: ses klibi görsel katman ÜRETMEZ.</summary>
    private static TimelineDoc AudioTrackMix() => ExportTestDocs.MultiTrackDoc(
    [
        ExportTestDocs.VideoTrack(clips:
        [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 3_000_000, ExportTestDocs.Audio()),
        ]),
        ExportTestDocs.AudioTrack(clips:
        [
            ExportTestDocs.AudioClip(ExportTestDocs.AssetC, 0, 0, 4_000_000,
                ExportTestDocs.Audio(volume: 0.35, fadeOutUs: 1_000_000)),
        ]),
    ]);

    // ---------- M5 fixture'ları: hız, renk düzeltme, LUT, keyframe ----------

    /// <summary>2x hızlı + 0.25x yavaş klip, ikisi de sesli (atempo katlaması dahil).</summary>
    private static TimelineDoc SpeedChange() => ExportTestDocs.Doc(
        clips:
        [
            ExportTestDocs.SpeedClip(ExportTestDocs.AssetA, 0, 0, 4_000_000, 2,
                ExportTestDocs.Audio()),
            ExportTestDocs.SpeedClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 2_000_000, 0.25,
                ExportTestDocs.Audio(volume: 0.5)),
        ]);

    /// <summary>§4.1'in ALTI parametresi birden — aşama sırası snapshot'ta sabitlenir.</summary>
    private static TimelineDoc ColorAdjustAllParams()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000,
            ExportTestDocs.Audio());
        clip.Effects =
        [
            ExportTestDocs.ColorAdjust(
                exposure: 0.3, temperature: 0.45, tint: -0.2,
                contrast: 0.15, brightness: 0.05, saturation: 0.2),
        ];
        return ExportTestDocs.Doc(clips: clip);
    }

    /// <summary>LUT %75 karışım (split/blend) + tam güçte LUT (düz lut3d) — §4.2'nin iki dalı.</summary>
    private static TimelineDoc LutEffects()
    {
        var blended = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000);
        blended.Effects = [ExportTestDocs.Lut(LutAsset, 0.75)];
        var full = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 0, 2_000_000);
        full.Effects = [ExportTestDocs.ColorAdjust(saturation: -0.5), ExportTestDocs.Lut(LutAsset)];
        return ExportTestDocs.Doc(clips: [blended, full]);
    }

    /// <summary>
    /// TAMAMI LİNEER keyframe'ler → ifade yolu: overlay x/y 'if' zinciri, scale eval=frame,
    /// rotate ifadesi, 0→1 opaklık fade'i. Alt katman animasyonun tuval üstünde olduğunu gösterir.
    /// </summary>
    private static TimelineDoc KeyframeLinear()
    {
        var animated = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_000_000, 0, 2_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5));
        animated.Keyframes = new KeyframeTracks
        {
            X = [ExportTestDocs.Kf(0, -0.25), ExportTestDocs.Kf(1_000_000, 0.25),
                 ExportTestDocs.Kf(2_000_000, 0)],
            Y = [ExportTestDocs.Kf(0, 0), ExportTestDocs.Kf(2_000_000, -0.2)],
            // Ölçek animasyonu DÖNME ile birlikte kullanılamaz (rotate çıkış tuvalini config
            // anında kurar ve büyüyen katmanı kırpar) — dönme eğrili fixture'da sınanır.
            Scale = [ExportTestDocs.Kf(0, 0.5), ExportTestDocs.Kf(2_000_000, 1)],
            Opacity = [ExportTestDocs.Kf(0, 0), ExportTestDocs.Kf(500_000, 1)],
        };
        return ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips: [animated]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 3_000_000,
                    ExportTestDocs.Audio()),
            ]),
        ]);
    }

    /// <summary>
    /// EĞRİLİ easing → sendcmd yolu: overlay x (kompozit eksen) + opaklık (klip ekseni).
    /// Klip kısa tutulur — snapshot frame başına komut taşır.
    /// </summary>
    private static TimelineDoc KeyframeEased()
    {
        var animated = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 400_000,
            transform: ExportTestDocs.Transform(scale: 0.5));
        animated.Keyframes = new KeyframeTracks
        {
            X = [ExportTestDocs.Kf(0, -0.25, ExportTestDocs.EaseInOut()),
                 ExportTestDocs.Kf(400_000, 0.25)],
            Opacity = [ExportTestDocs.Kf(0, 0.2, ExportTestDocs.EaseIn()),
                       ExportTestDocs.Kf(400_000, 0.8)],
            RotationDeg = [ExportTestDocs.Kf(0, 0, ExportTestDocs.EaseInOut()),
                           ExportTestDocs.Kf(400_000, 45)],
        };
        return ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips: [animated]),
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000)]),
        ]);
    }

    /// <summary>
    /// SES SEVİYESİ keyframe'i (§8.1 + §3.4): lineer kanal + easing'li kanal AYNI dokümanda —
    /// ikisi de aynı frame örneklemesinden geçer (ses tarafında ifade yolu YOKTUR: volume
    /// filtresi zaman ifadesi almaz, tek yol asendcmd'dir).
    /// </summary>
    private static TimelineDoc VolumeKeyframes()
    {
        var video = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 400_000,
            ExportTestDocs.Audio());
        video.Keyframes = new KeyframeTracks
        {
            Volume = [ExportTestDocs.Kf(0, 0), ExportTestDocs.Kf(400_000, 1)],
        };

        var music = ExportTestDocs.AudioClip(ExportTestDocs.AssetC, 0, 0, 400_000);
        music.Keyframes = new KeyframeTracks
        {
            Volume = [ExportTestDocs.Kf(0, 1, ExportTestDocs.EaseInOut()),
                      ExportTestDocs.Kf(400_000, 0.25)],
        };

        return ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips: [video]),
            ExportTestDocs.AudioTrack(clips: [music]),
        ]);
    }

    /// <summary>LUT (.cube) varlığı — MEDYA defterinden ayrıdır (probe edilmez).</summary>
    private static readonly Guid LutAsset = Guid.Parse("00000000-0000-0000-0000-0000000000d4");

    private static Dictionary<Guid, ExportAssetSource> LutSources()
    {
        var sources = SdrSources(hasAudio: false);
        sources[LutAsset] = new ExportAssetSource("luts/teal.cube", false, null, null);
        return sources;
    }

    private static Dictionary<Guid, ExportAssetSource> SdrSources(bool hasAudio = true) => new()
    {
        [ExportTestDocs.AssetA] = new ExportAssetSource("assets/a.mp4", hasAudio, "bt709", "bt709"),
        [ExportTestDocs.AssetB] = new ExportAssetSource("assets/b.mp4", hasAudio, "bt709", "bt709"),
        [ExportTestDocs.AssetC] = new ExportAssetSource("assets/c.mp4", hasAudio, "bt709", "bt709"),
    };

    private static Dictionary<Guid, ExportAssetSource> HdrSources() => new()
    {
        [ExportTestDocs.AssetA] = new ExportAssetSource("assets/hdr.mov", true, "smpte2084", "bt2020"),
    };

    public static TheoryData<string> FixtureNames() =>
    [
        "single-clip", "multi-clip-contiguous", "with-gaps",
        "muted-audio", "audio-fades", "hdr-source", "ntsc-fps", "ntsc-gap",
        "two-video-layers", "pip-transform", "layer-opacity",
        "hidden-muted-tracks", "audio-track-mix", "opaque-over-alpha",
        "layer-run-concat", "image-clip", "image-over-video",
        "transition-single", "transition-audio", "transition-chain",
        "transition-pip-layer", "transition-odd-box", "text-over-video", "shape-and-sticker",
        // M5: hız, renk düzeltme, LUT, keyframe (ifade yolu + sendcmd yolu)
        "speed-change", "color-adjust", "lut-effects", "keyframe-linear", "keyframe-eased",
        "volume-keyframes",
    ];

    private static (TimelineDoc Doc, Dictionary<Guid, ExportAssetSource> Sources) Fixture(string name) =>
        name switch
        {
            "speed-change" => (SpeedChange(), SdrSources()),
            "color-adjust" => (ColorAdjustAllParams(), SdrSources()),
            "lut-effects" => (LutEffects(), LutSources()),
            "keyframe-linear" => (KeyframeLinear(), SdrSources()),
            "keyframe-eased" => (KeyframeEased(), SdrSources(hasAudio: false)),
            "volume-keyframes" => (VolumeKeyframes(), SdrSources()),
            "transition-single" => (TransitionSingle(), SdrSources(hasAudio: false)),
            "transition-audio" => (TransitionSingle(audio: ExportTestDocs.Audio(volume: 0.8)), SdrSources()),
            "transition-chain" => (TransitionChain(), SdrSources()),
            "transition-pip-layer" => (TransitionWithPipLayer(), SdrSources()),
            "transition-odd-box" => (TransitionOddBox(), SdrSources(hasAudio: false)),
            "text-over-video" => (TextOverVideo(), SdrSources()),
            "shape-and-sticker" => (ShapeAndSticker(), ImageSources()),
            "single-clip" => (SingleClip(), SdrSources(hasAudio: false)),
            "multi-clip-contiguous" => (MultiClipContiguous(), SdrSources()),
            "with-gaps" => (WithGaps(), SdrSources(hasAudio: false)),
            "muted-audio" => (MutedAudio(), SdrSources()),
            "audio-fades" => (AudioFades(), SdrSources()),
            "hdr-source" => (HdrSource(), HdrSources()),
            "ntsc-fps" => (NtscFps(), SdrSources()),
            "ntsc-gap" => (NtscGap(), SdrSources()),
            "two-video-layers" => (TwoVideoLayers(), SdrSources()),
            "pip-transform" => (PipTransform(), SdrSources()),
            "layer-opacity" => (LayerOpacity(), SdrSources()),
            "hidden-muted-tracks" => (HiddenAndMutedTracks(), SdrSources()),
            "audio-track-mix" => (AudioTrackMix(), SdrSources()),
            "opaque-over-alpha" => (OpaqueOverAlpha(), SdrSources()),
            "layer-run-concat" => (LayerRunConcat(), SdrSources()),
            // Görsel asset'in ses stream'i YOKTUR — kaynak defteri de bunu böyle bildirir.
            "image-clip" => (ImageClip(), ImageSources()),
            "image-over-video" => (ImageOverVideo(), ImageSources()),
            _ => throw new ArgumentOutOfRangeException(nameof(name)),
        };

    /// <summary>AssetC bir PNG (ses yok, video stream'i tek kare), AssetA sesli video.</summary>
    private static Dictionary<Guid, ExportAssetSource> ImageSources() => new()
    {
        [ExportTestDocs.AssetA] = new ExportAssetSource("assets/a.mp4", true, "bt709", "bt709"),
        [ExportTestDocs.AssetB] = new ExportAssetSource("assets/b.mp4", true, "bt709", "bt709"),
        [ExportTestDocs.AssetC] = new ExportAssetSource("assets/photo.png", false, "bt709", "bt709"),
    };

    /// <summary>Metin bbox'ı — raster hattının bildirdiği PROJE PİKSELİ boyutu (§7).</summary>
    private const double TextBboxWidth = 640;

    private const double TextBboxHeight = 160;

    /// <summary>
    /// Worker'ın raster hattından üreteceği defterin taklidi: dokümandaki metin/şekil klipleri
    /// için deterministik yol + doğal (bbox) boyut. Şeklin şemada içsel boyutu YOKTUR → bbox'ı
    /// proje tuvalidir (scale=1 = tam kare).
    /// </summary>
    private static Dictionary<Guid, ExportRasterSource> RastersFor(TimelineDoc doc)
    {
        var map = new Dictionary<Guid, ExportRasterSource>();
        var index = 0;
        foreach (var track in doc.Tracks)
        {
            foreach (var clip in track.Clips)
            {
                var n = index.ToString(CultureInfo.InvariantCulture);
                switch (clip)
                {
                    case TextClip text:
                        map[text.Id] = new ExportRasterSource(
                            $"rasters/text-{n}.png", TextBboxWidth, TextBboxHeight);
                        index++;
                        break;
                    case ShapeClip shape:
                        map[shape.Id] = new ExportRasterSource(
                            $"rasters/shape-{n}.png", doc.Settings.Width, doc.Settings.Height);
                        index++;
                        break;
                }
            }
        }

        return map;
    }

    // ---------- Snapshot testleri ----------

    /// <summary>Fixture'ı worker ile aynı şekilde derler (kaynak defteri + raster defteri).</summary>
    private static CompiledExport CompileFixture(string name)
    {
        var (doc, sources) = Fixture(name);
        return ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p, RastersFor(doc));
    }

    [Theory]
    [MemberData(nameof(FixtureNames))]
    public void Compile_MatchesSnapshot(string name)
    {
        var compiled = CompileFixture(name);
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

    [Theory]
    [MemberData(nameof(FixtureNames))]
    public void EveryOverlayCoordinate_IsFloored(string name)
    {
        // YAPISAL MUHAFIZ: overlay hedefi TEK BİR kuralla tamsayıya iner ve o kural ifadenin
        // İÇİNDEDİR. Yeni bir kod yolu (yeni klip türü, yeni animasyon kanalı) floor'suz bir
        // koordinat yazarsa burası KIRMIZIYA düşer — ölçüm gerektiren piksel testleri yalnız
        // kendi fixture'larını görür, bu tarama grafın TAMAMINI görür.
        //
        // NEDEN TEK KURAL: floor'suz bırakılan bir koordinat, overlay'in kendi (int) çevrimiyle
        // SIFIRA DOĞRU kırpılır; aynı belgenin pad'li ve pad'siz yolu o an 1 px ayrışır ve
        // ölçek > 1'de sapmanın işareti değişir (ölçümler ExportCompiler.FloorOverlay'de).
        var script = Render(CompileFixture(name));
        var coordinates = 0;
        foreach (var line in script.Split(";\n"))
        {
            var marker = line.IndexOf("]overlay=", StringComparison.Ordinal);
            if (marker < 0)
            {
                continue;
            }

            var arguments = line[(marker + "]overlay=".Length)..].Split(':');
            foreach (var argument in arguments)
            {
                if (!argument.StartsWith("x=", StringComparison.Ordinal)
                    && !argument.StartsWith("y=", StringComparison.Ordinal))
                {
                    continue;
                }

                var value = argument[2..].Trim('\'');
                Assert.True(
                    value.StartsWith("floor(", StringComparison.Ordinal)
                    && value.EndsWith(')'),
                    $"{name}: overlay koordinatı floor'a sarılmamış → '{argument}'");
                coordinates++;
            }
        }

        // İfade x/y'yi virgülle bölmediğinden emin ol: bölme yanlışsa yukarıdaki döngü hiç
        // koordinat görmeden "geçerdi". Overlay varsa EN AZ iki koordinat sayılmalıdır.
        Assert.Equal(script.Contains("]overlay=", StringComparison.Ordinal), coordinates >= 2);
    }

    [Theory]
    [MemberData(nameof(FixtureNames))]
    public void TheGraphNeverInvokesThePerPixelExprInterpreter(string name)
    {
        // PERFORMANS MUHAFIZI (2026-08-24 maliyet profili — docs/performans-raporu.md §9.1):
        // blend=all_expr her piksel × kanal için AVExpr yorumlayıcısını çalıştırır ve tek
        // başına 60 sn'lik referans bileşimin %46'sıydı (1080p 68,7 → 37,4 s). §4.2 karışımı
        // yerli 'normal' moda taşındı (all_opacity = 1-intensity); eşdeğerlik dyadik
        // yoğunlukta bayt-aynı, dyadik olmayanda <= ±1 LSB'dir (ölçülen zarf ve gerekçe:
        // ClipEffects.LutBlendFilter yorumu + ExportM5GoldenTests LSB sınır golden'ı). Bu
        // tarama grafiğin TAMAMINI görür: LutBlendFilter eski biçime dönerse ya da YENİ bir
        // kod yolu yorumlayıcı tabanlı blend/geq yazarsa burası kırmızıya düşer (geq aynı
        // yorumlayıcı sınıfıdır — kare başına ifade).
        var script = Render(CompileFixture(name));
        Assert.DoesNotContain("all_expr", script);
        Assert.DoesNotContain("geq=", script);
        if (name == "lut-effects")
        {
            // intensity=0.75'in yerli karşılığı; InvariantCulture (nokta) zorunlu.
            Assert.Contains("blend=all_mode=normal:all_opacity=0.25", script);
        }
    }

    [Fact]
    public void Compile_IsDeterministic_AcrossRuns()
    {
        var first = Render(ExportCompiler.Compile(LayerOpacity(), SdrSources(), ExportProfile.Hd1080p));
        var second = Render(ExportCompiler.Compile(LayerOpacity(), SdrSources(), ExportProfile.Hd1080p));
        Assert.Equal(first, second);
    }

    [Fact]
    public void Compile_UnderTurkishCulture_ProducesIdenticalOutput()
    {
        // TR locale ondalık ayracı virgüldür — script'e "0,5" sızarsa ffmpeg patlar (tuzak #1).
        // Fixture transform/opaklık/açı içerir: yeni geometri literal'leri de kapsanır.
        var invariant = Render(ExportCompiler.Compile(LayerOpacity(), SdrSources(), ExportProfile.Hd1080p));

        var culture = CultureInfo.CurrentCulture;
        var uiCulture = CultureInfo.CurrentUICulture;
        try
        {
            CultureInfo.CurrentCulture = new CultureInfo("tr-TR");
            CultureInfo.CurrentUICulture = new CultureInfo("tr-TR");
            var turkish = Render(ExportCompiler.Compile(LayerOpacity(), SdrSources(), ExportProfile.Hd1080p));
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
    public void Compile_Gaps_ShowTheBackgroundCanvas_PinnedToFrameLedger()
    {
        var compiled = ExportCompiler.Compile(WithGaps(), SdrSources(hasAudio: false), ExportProfile.Hd1080p);

        // Boşluklar ayrı segment ÜRETMEZ: taban tuval tüm timeline boyunca (6 sn = 180 frame)
        // akar, klipler üstüne bindirilir; klipsiz aralıkta tuval görünür.
        Assert.Contains(
            "color=c=0x000000:s=1920x1080:r=30/1:d=6.033333,trim=end_frame=180,"
            + "format=rgba,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[base]",
            compiled.FilterGraphScript);
        Assert.DoesNotContain("concat=", compiled.FilterGraphScript);

        // Klipler frame defterine sabitlenir (2 sn @30fps = 60 frame) ve timeline'daki
        // yerlerine setpts ile kaydırılır.
        Assert.Contains("fps=30/1,trim=end_frame=60,scale=1920:1080:", compiled.FilterGraphScript);
        Assert.Contains("setpts=PTS-STARTPTS+1.000000/TB", compiled.FilterGraphScript);
        Assert.Contains("setpts=PTS-STARTPTS+4.000000/TB", compiled.FilterGraphScript);

        // Kompozisyon SONRASI setparams çıktı frame'lerini BT.709/tv işaretler.
        Assert.Contains(
            "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[vout]",
            compiled.FilterGraphScript);
        Assert.Equal(6_000_000, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Compile_NtscGap_FrameLedgerProducesExactFrameCounts()
    {
        // Denetim reprosu: 30000/1001'de klip sınırlarının µs-farkı kesirlidir; frame defteri
        // trim=end_frame ile TAM frame sayısını sabitler.
        var compiled = ExportCompiler.Compile(NtscGap(), SdrSources(), ExportProfile.Hd1080p);

        Assert.Contains("fps=30000/1001,trim=end_frame=30,", compiled.FilterGraphScript); // klip1
        Assert.Contains("fps=30000/1001,trim=end_frame=60,", compiled.FilterGraphScript); // klip2
        // adelay frame defterinden: klip2 frame 32 → 1067733 µs → 1068 ms (half-up).
        Assert.Contains("adelay=1068|1068", compiled.FilterGraphScript);
        // Taban tuval de aynı defterden: 92 frame.
        Assert.Contains("trim=end_frame=92,", compiled.FilterGraphScript);
        Assert.Equal(3_069_733, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Validate_ClipEdgeOffProjectFrameGrid_ThrowsInvalidTimeline()
    {
        // Güvenlik ağı: editör KENARLARI grid'de üretir; grid dışı bir kenar frame defterini
        // (trim=start_frame:end_frame) bozar ve sessiz snap yerine sözleşme ihlali olarak
        // görünür olmalıdır.
        var offStart = ExportTestDocs.Doc(fpsNum: 30000, fpsDen: 1001,
            clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 50_000, 0, 1_001_000));
        var startError = Assert.Throws<InvalidTimelineException>(
            () => ExportCompiler.Validate(offStart));
        Assert.Contains("edges are not on the project frame grid", startError.Message);

        // Başlangıç ızgarada ama BİTİŞ değil (0 + 1_000_000; 29.97'de kare sınırı 1_001_000).
        var offEnd = ExportTestDocs.Doc(fpsNum: 30000, fpsDen: 1001,
            clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(offEnd));
    }

    [Fact]
    public void Validate_GridAlignedEdgesWithOffGridDuration_IsAccepted()
    {
        // REGRESYON (teslim RED blocker'ı): kapı SÜREYİ değil KENARLARI ister. 30 fps'te
        // frame1=33_333, frame2=66_667 → frame1'den frame2'ye giden klip 33_334 µs sürer ve
        // bu değer ızgarada YOKTUR. Eski süre tabanlı kapı, editörün BÖLME/KIRPMA gibi en sıradan
        // işlemlerinin ürettiği belgeyi reddediyordu (kaydedilebiliyor ama export 422).
        var doc = ExportTestDocs.Doc(fpsNum: 30, fpsDen: 1, clips: [
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 33_333),
            ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 33_333, 0, 33_334),
            ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 66_667, 0, 33_333),
        ]);

        var plan = ExportCompiler.Validate(doc);

        // Defter kesintisiz: 0,1,2,3 — kliplerin µs süreleri farklı olsa da her biri TEK kare.
        Assert.Equal(100_000, plan.TotalDurationUs);
        Assert.Equal(3, plan.Tracks[0].Clips.Count);
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

        // MİKS UZUNLUK KİLİDİ: 'duration=longest' EN UZUN GİRİŞ kadardır, TOPLAM SÜRE kadar
        // değil — dolgu olmadan son ses klibi timeline'dan önce bitince ses akışı da erken
        // bitiyordu. Eşik TOPLAM SÜREDİR ve bu fixture'da o süre en uzun ses girişinden
        // (5 sn > 3 sn) UZUNDUR; sabiti buradan okumak iddiayı tautoloji yapardı.
        //
        // BİÇİM DE SABİTLENİR, sırasıyla: önce atrim=end fazlalığı kırpar, SONRA
        // apad=whole_dur eksiği doldurur. Argümansız 'apad' (SINIRSIZ üreteç) burada
        // ffmpeg'i asıyordu; asılan şeklin koşan karşılığı
        // ExportRenderGoldenTests.AudioMix_WithTwoAudibleGroups_... testidir.
        Assert.Equal(5_000_000, compiled.ExpectedDurationUs);
        Assert.Contains(
            "amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.98,"
            + "atrim=end=5.000000,apad=whole_dur=5.000000[aout]",
            compiled.FilterGraphScript);
        Assert.DoesNotContain("alimiter=limit=0.98,apad,", compiled.FilterGraphScript);
        Assert.Contains("volume=0.5", compiled.FilterGraphScript);
        Assert.Contains("afade=t=in:st=0:d=0.500000:curve=tri", compiled.FilterGraphScript);
        Assert.Contains("afade=t=out:st=2.000000:d=1.000000:curve=tri", compiled.FilterGraphScript);
        Assert.Contains("adelay=3000|3000", compiled.FilterGraphScript);
    }

    // ---------- Çok katman kompozisyonu ----------

    [Fact]
    public void Compile_MultipleTracks_ComposeBottomToTop_TracksZeroIsTopmost()
    {
        // Şema sözleşmesi (docs/design/01 §1.2): tracks[0] EN ÜST katmandır → overlay zinciri
        // taban tuvalden başlayıp SONDAN BAŞA ilerler; en son bindirilen katman en üsttedir.
        var compiled = ExportCompiler.Compile(TwoVideoLayers(), SdrSources(), ExportProfile.Hd1080p);

        // Alt katman (tracks[1] = AssetA, 4 sn) ilk giriştir ve tuvale ilk bindirilir.
        Assert.Equal("assets/a.mp4", compiled.Inputs[0].Path);
        Assert.Equal("assets/b.mp4", compiled.Inputs[1].Path);
        Assert.Contains("[base][v0]overlay=", compiled.FilterGraphScript);
        Assert.Contains("[c0][v1]overlay=", compiled.FilterGraphScript);
        Assert.Contains("[c1]setparams=", compiled.FilterGraphScript);

        // Üst katman (AssetB) 1-3 sn penceresinde görünür; bitiş yarım frame geri çekilir.
        Assert.Contains("enable='between(t,1.000000,2.983334)'", compiled.FilterGraphScript);
        Assert.Contains("setpts=PTS-STARTPTS+1.000000/TB", compiled.FilterGraphScript);

        // Süre alt katmanın sonu; iki klibin sesi de mikse girer.
        Assert.Equal(4_000_000, compiled.ExpectedDurationUs);
        Assert.Contains("amix=inputs=2:", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_PipTransform_UsesNormativePlacementFormula()
    {
        // rendering-semantics §2: fit=contain × scale tek ölçekte; P = (W/2 + x*W, H/2 + y*H);
        // overlay_x = P.x - anchorX*w. 1920x1080, scale 0.35, x=0.25, y=-0.25, çapa merkez:
        //   kutu   = (round(1920*0.35), round(1080*0.35)) = (672, 378)
        //   P      = (960 + 480, 540 - 270) = (1440, 270)
        var compiled = ExportCompiler.Compile(PipTransform(), SdrSources(), ExportProfile.Hd1080p);

        Assert.Contains(
            "scale=672:378:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic",
            compiled.FilterGraphScript);
        Assert.Contains("overlay=x=floor(1440-0.5*w):y=floor(270-0.5*h):", compiled.FilterGraphScript);
        // Opak PiP de rgba ile girer ve RGB'de blend edilir: kompozisyon modu grafik başınadır,
        // katman başına DEĞİL (denetim #1) — 4:2:0 tuval overlay konumunu çift piksele kırpardı.
        Assert.Contains("format=rgba,settb=AVTB,setpts=PTS-STARTPTS+1.000000/TB[v1]",
            compiled.FilterGraphScript);
        Assert.DoesNotContain("format=yuv420p", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_CompositeColorMode_IsGraphWide_NotPerLayer()
    {
        // Denetim #1 (HIGH): opak katman alpha'lı katmanın ÜSTÜNDE. Katman başına seçimde üst
        // overlay :format=rgb ALMAZDI ve zincirin ortasında RGB↔YUV dönüşümü oluşurdu.
        // Sözleşme: HER overlay :format=rgb, HER katman format=rgba, taban tuval de rgba.
        foreach (var name in new[]
                 {
                     "opaque-over-alpha", "layer-opacity", "pip-transform", "two-video-layers",
                     "with-gaps", "hidden-muted-tracks", "layer-run-concat", "image-over-video",
                     "transition-pip-layer", "text-over-video", "shape-and-sticker",
                 })
        {
            var script = CompileFixture(name).FilterGraphScript;
            var overlays = script.Split(";\n").Where(l => l.Contains("]overlay=")).ToList();
            Assert.NotEmpty(overlays);
            Assert.All(overlays, line =>
                Assert.True(line.Contains(":format=rgb[", StringComparison.Ordinal),
                    $"{name}: overlay RGB'de blend etmiyor → {line}"));

            // Alt örneklenmiş (4:2:0) ara format grafiğin HİÇBİR yerinde olmamalı: overlay
            // normalize_xy x/y'yi chroma adımına kırpar → opak/alpha katmanlar farklı piksele
            // otururdu (denetim #15).
            Assert.DoesNotContain("format=yuv420p", script);
            Assert.DoesNotContain(":format=yuv420[", script);
        }
    }

    [Fact]
    public void Compile_EveryLayerChain_DeclaresBt709BeforeAnyFormatConversion()
    {
        // §6.1 "untagged SDR = BT.709/tv" varsayımı RGB'ye geçişten ÖNCE beyan edilmezse
        // swscale kendi varsayılanını kullanır (SD'de BT.601) ve kompozisyon renkleri kayar.
        var script = CompileFixture("opaque-over-alpha").FilterGraphScript;

        foreach (var line in script.Split(";\n").Where(l => l.Contains(":v]")))
        {
            var declaration = line.IndexOf(ExportCompiler.SourceColorParams, StringComparison.Ordinal);
            var conversion = line.IndexOf("format=rgba", StringComparison.Ordinal);
            Assert.True(declaration >= 0, $"katman renk beyanı yok → {line}");
            Assert.True(declaration < conversion,
                $"renk beyanı format dönüşümünden SONRA geliyor (dönüşümü etkilemez) → {line}");
        }
    }

    [Fact]
    public void Compile_OpacityAndRotation_UseStraightAlphaChain()
    {
        var compiled = ExportCompiler.Compile(LayerOpacity(), SdrSources(), ExportProfile.Hd1080p);

        // §6.3: opaklık straight alpha çarpanıdır → format=rgba + colorchannelmixer=aa.
        Assert.Contains("format=rgba,colorchannelmixer=aa=0.25", compiled.FilterGraphScript);
        Assert.Contains("format=rgba,colorchannelmixer=aa=0.5", compiled.FilterGraphScript);
        // Tüm katmanlar RGB'de blend edilir (yuv420 blend YASAK).
        Assert.Contains(":format=rgb[c0]", compiled.FilterGraphScript);
        Assert.Contains(":format=rgb[c1]", compiled.FilterGraphScript);
        Assert.Contains(":format=rgb[c2]", compiled.FilterGraphScript);

        // §2.5: çapa (0,1) merkezde değil → çapayı tuval ortasına getiren şeffaf pad,
        // ardından merkez etrafında rotate = ÇAPA etrafında rotate.
        Assert.Contains("pad=w=iw*2:h=ih*2:x=iw*1:y=ih*0:color=#00000000",
            compiled.FilterGraphScript);
        Assert.Contains("rotate=a=0.523599:c=none:ow=2*ceil(hypot(iw\\,ih)/2):oh=ow",
            compiled.FilterGraphScript);
        // Dönen katmanda overlay telafisi w/2, h/2'ye sadeleşir.
        Assert.Contains("overlay=x=floor(960-0.5*w):y=floor(540-0.5*h):", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_HiddenTrack_KeepsAudio_MutedTrackDoesNot()
    {
        // resolve.ts semantiği: hidden = YALNIZ görsel gizleme; muted = ses yok.
        var compiled = ExportCompiler.Compile(HiddenAndMutedTracks(), SdrSources(), ExportProfile.Hd1080p);

        // 3 track var ama yalnız 2 görsel katman (gizli olan overlay üretmez).
        Assert.Contains("[base][v0]overlay=", compiled.FilterGraphScript);
        Assert.Contains("[c0][v1]overlay=", compiled.FilterGraphScript);
        Assert.DoesNotContain("[v2]", compiled.FilterGraphScript);

        // Ses: alt (normal) + üst (gizli) = 2 giriş; ortadaki muted track ses üretmez.
        Assert.Contains("amix=inputs=2:duration=longest:normalize=0", compiled.FilterGraphScript);

        // Gizli track'in klibi giriş olarak AÇILIR (sesi lazım) ama :v referansı YOKTUR.
        Assert.Equal(3, compiled.Inputs.Count);
        Assert.Contains("[2:a]", compiled.FilterGraphScript);
        Assert.DoesNotContain("[2:v]", compiled.FilterGraphScript);
        // Susturulmuş track'in klibi görsel olarak vardır ama ses zinciri üretmez.
        Assert.Contains("[1:v]", compiled.FilterGraphScript);
        Assert.DoesNotContain("[1:a]", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_FullyInertClip_OpensNoInput()
    {
        // Gizli VE susturulmuş track: ne görüntü ne ses → giriş bile açılmaz (boşuna decode yok).
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(hidden: true, muted: true, clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000, ExportTestDocs.Audio()),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000, ExportTestDocs.Audio()),
            ]),
        ]);
        var compiled = ExportCompiler.Compile(doc, SdrSources(), ExportProfile.Hd1080p);

        Assert.Single(compiled.Inputs);
        Assert.Equal("assets/a.mp4", compiled.Inputs[0].Path);
        // Süre yine de gizli katmanın sonunu kapsar (timeline uzunluğu görünürlükten bağımsız).
        Assert.Equal(2_000_000, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Compile_AudioTrackClip_ProducesNoVideoLayer()
    {
        var compiled = ExportCompiler.Compile(AudioTrackMix(), SdrSources(), ExportProfile.Hd1080p);

        // Ses klibi görsel katman üretmez: tek overlay (video track'in klibi).
        Assert.Contains("[base][v0]overlay=", compiled.FilterGraphScript);
        Assert.DoesNotContain("[v1]", compiled.FilterGraphScript);
        // Ses klibi mikse girer; müzik 4 sn olduğu için toplam süreyi o belirler.
        Assert.Contains("amix=inputs=2:duration=longest:normalize=0", compiled.FilterGraphScript);
        Assert.Contains("volume=0.35", compiled.FilterGraphScript);
        Assert.Equal(4_000_000, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Compile_TracksOverlapAcrossLayers_IsAllowed()
    {
        // Track İÇİNDE overlap yasak; track'ler ARASI overlap kompozisyonun ta kendisidir.
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000)]),
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000)]),
        ]);

        var plan = ExportCompiler.Validate(doc);
        Assert.Equal(2, plan.Tracks.Count);
        Assert.Equal(2, plan.Clips.Count);
        // Render sırası: en alt katman (docIndex 1) önce.
        Assert.Equal(1, plan.Tracks[0].DocIndex);
        Assert.Equal(0, plan.Tracks[1].DocIndex);
    }

    // ---------- Katman run'ları (ölçülen performans regresyonu) ----------

    [Fact]
    public void Compile_SingleFullCanvasTrack_SkipsTheBaseCanvasAndOverlayEntirely()
    {
        // Denetim bulgusu (HIGH). Eski (M3) hat N klibi TEK concat ile birleştiriyordu (kare
        // başına O(1)); çok-katman hattı HER KLİP için tam çözünürlükte bir RGBA overlay katı ekledi ve
        // 'enable=' yalnız blend'i kapatıyordu. Sözleşme: tek katmanlı proje M3 davranışına
        // döner — taban tuval YOK, overlay YOK, letterbox pad + tek concat.
        var compiled = ExportCompiler.Compile(MultiClipContiguous(), SdrSources(), ExportProfile.Hd1080p);

        Assert.DoesNotContain("overlay=", compiled.FilterGraphScript);
        Assert.DoesNotContain("color=c=0x000000:s=1920x1080", compiled.FilterGraphScript);
        // Kompozisyon yoksa RGB tuvale de gerek yoktur: zincir yuv420p'de kalır (renk
        // gidiş-dönüşü YOK — kayıpsız karşılaştırmada tuval yolu PSNR 35.87 dB, bu yol ∞).
        Assert.DoesNotContain("format=rgba", compiled.FilterGraphScript);
        Assert.DoesNotContain(":format=rgb", compiled.FilterGraphScript);
        Assert.Contains("pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x000000,setsar=1,format=yuv420p",
            compiled.FilterGraphScript);
        Assert.Contains("[s0_0][s0_1]concat=n=2:v=1:a=0[v0]", compiled.FilterGraphScript);
        Assert.Contains("[v0]setparams=colorspace=bt709:", compiled.FilterGraphScript);
        Assert.Equal(5_000_000, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Compile_ContiguousClipsOnALayerTrack_ShareOneConcatAndOneOverlay()
    {
        // Gerçek katmanlaşmada (alt katman + üstte PiP) taban tuval ve overlay KALIR, ama üst
        // track'in ARDIŞIK iki klibi tek concat zincirinde birleşir → iki değil TEK overlay.
        var compiled = ExportCompiler.Compile(LayerRunConcat(), SdrSources(), ExportProfile.Hd1080p);

        var overlays = compiled.FilterGraphScript.Split(";\n")
            .Where(l => l.Contains("]overlay=")).ToList();
        Assert.Equal(2, overlays.Count);                       // taban katman + PiP run'ı
        Assert.Contains("[base][v0]overlay=", compiled.FilterGraphScript);
        Assert.Contains("[s1_0][s1_1]concat=n=2:v=1:a=0,setpts=PTS-STARTPTS+1.000000/TB[v1]",
            compiled.FilterGraphScript);

        // Run'ın enable penceresi İKİ klibi birden kapsar (1 sn → 3 sn, bitiş yarım frame geri).
        Assert.Contains("enable='between(t,1.000000,2.983334)'", compiled.FilterGraphScript);

        // concat girişleri aynı boyutta olmalı: segmentler yerleşim kutusuna şeffaf pad'lenir
        // (gerçek ölçek çıktısı kaynağın aspect'ine bağlıdır — compiler kaynak boyutunu bilmez).
        Assert.Contains("format=rgba,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=#00000000",
            compiled.FilterGraphScript);
        // Segmentler 0'dan başlar; timeline ofseti concat SONRASINA taşınır.
        Assert.Contains("settb=AVTB,setpts=PTS-STARTPTS[s1_0]", compiled.FilterGraphScript);
        Assert.Contains("settb=AVTB,setpts=PTS-STARTPTS[s1_1]", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_RunsBreakOnGapsPlacementChangesAndNonVisualClips()
    {
        // Run = ARDIŞIK + AYNI YERLEŞİM. Üçünü de tek dokümanda kırıyoruz:
        //   klip1 0-1 sn PiP(A)  ─┐ bitişik ama YERLEŞİM farklı → ayrı run
        //   klip2 1-2 sn PiP(B)  ─┘
        //   klip3 3-4 sn PiP(B)   → aynı yerleşim ama BOŞLUK var → ayrı run
        var pipA = ExportTestDocs.Transform(x: 0.25, scale: 0.5);
        var pipB = ExportTestDocs.Transform(x: -0.25, scale: 0.5);
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 1_000_000, transform: pipA),
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_000_000, 0, 1_000_000, transform: pipB),
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 3_000_000, 0, 1_000_000, transform: pipB),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 4_000_000, ExportTestDocs.Audio()),
            ]),
        ]);
        var compiled = ExportCompiler.Compile(doc, SdrSources(), ExportProfile.Hd1080p);

        // 1 taban + 3 ayrı run = 4 overlay, hiç concat yok.
        Assert.Equal(4, compiled.FilterGraphScript.Split(";\n").Count(l => l.Contains("]overlay=")));
        Assert.DoesNotContain("concat=", compiled.FilterGraphScript);
        Assert.Contains("[c2][v3]overlay=", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_NonCenteredAnchorRun_IsNotConcatenated()
    {
        // Kutuya normalize eden pad SİMETRİKTİR: yalnız çapa merkezdeyse geometriyi korur.
        // Merkez dışı çapada run BÖLÜNÜR (bugünkü klip-başına overlay yolu) — sessizce
        // 1 px kaydırmaktansa optimizasyondan vazgeçilir.
        var corner = ExportTestDocs.Transform(scale: 0.5, anchorX: 0, anchorY: 0);
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 1_000_000, transform: corner),
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_000_000, 0, 1_000_000, transform: corner),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
            ]),
        ]);
        var compiled = ExportCompiler.Compile(doc, SdrSources(), ExportProfile.Hd1080p);

        Assert.DoesNotContain("concat=", compiled.FilterGraphScript);
        Assert.Equal(3, compiled.FilterGraphScript.Split(";\n").Count(l => l.Contains("]overlay=")));
        // Çapa (0,0) → telafi çarpanı 0 → overlay konumu sade sabittir (P'nin kendisi).
        Assert.Contains("overlay=x=floor(960):y=floor(540):", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_PartialCoverOrTranslucentSingleTrack_KeepsTheBaseCanvas()
    {
        // Hızlı yol YALNIZ "tek run + tuvali baştan sona birim dönüşümle kaplıyor + opak" ise
        // açılır. Üç karşı örnek: (a) ölçek < 1 → çevresinde tuval görünmeli;
        // (b) opaklık < 1 → tuvalle harmanlanmalı; (c) klip timeline'ı kaplamıyor → boşlukta tuval.
        var scaled = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 2_000_000, transform: ExportTestDocs.Transform(scale: 0.5)));
        var translucent = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 2_000_000, opacity: 0.5));
        var late = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 1_000_000, 0, 2_000_000));

        foreach (var (doc, what) in new[]
                 {
                     (scaled, "ölçek 0.5"), (translucent, "opaklık 0.5"), (late, "1 sn'de başlıyor"),
                 })
        {
            var script = ExportCompiler.Compile(doc, SdrSources(hasAudio: false), ExportProfile.Hd1080p)
                .FilterGraphScript;
            Assert.True(script.Contains("[base][v0]overlay=", StringComparison.Ordinal),
                $"{what}: taban tuval atlanmamalıydı → {script}");
            Assert.Contains("format=rgba", script);
        }
    }

    [Fact]
    public void Validate_InertClips_AreExcludedFromTheAssetAndSourceRangeLedgers()
    {
        // Atıl klip (gizli VE susturulmuş track) hiçbir ffmpeg girişi açmaz — ama eskiden
        // asset'i yine de plan.AssetIds'e giriyordu: worker onu R2'den İNDİRİYOR, probe'luyor ve
        // kaynak-aralığı kapısına sokuyordu. Render EDİLMEYEN bir klip "source-out-of-range" ile
        // TÜM export'u düşürebiliyordu (ölçülen denetim bulgusu).
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(hidden: true, muted: true, clips:
            [
                // Kaynak süresini AŞAN aralık: eski davranışta export'u düşürürdü.
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 9_000_000, ExportTestDocs.Audio()),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000, ExportTestDocs.Audio()),
            ]),
        ]);

        var plan = ExportCompiler.Validate(doc);
        Assert.Equal([ExportTestDocs.AssetA], plan.AssetIds);   // atıl asset İNDİRİLMEZ
        Assert.Single(plan.Clips);
        Assert.Null(VideoEdit.Worker.Jobs.ExportJob.FindSourceOutOfRange(
            plan.Clips, ExportTestDocs.AssetB, probeDurationUs: 3_000_000, plan.FpsNum, plan.FpsDen));

        // Süre yine de atıl katmanın sonunu kapsar (timeline uzunluğu görünürlükten bağımsız).
        Assert.Equal(9_000_000, plan.TotalDurationUs);
        // Gizli ama SESLİ track atıl DEĞİLDİR — asset'i indirilir ve kapıya girer.
        var audible = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(hidden: true, clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 2_000_000, ExportTestDocs.Audio())]),
        ]);
        Assert.Contains(ExportTestDocs.AssetB, ExportCompiler.Validate(audible).AssetIds);
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
    public void Compile_SeamlessSplice_IsTrackLocal()
    {
        // Seamless splice AYNI TRACK'teki komşuluk kuralıdır: farklı katmanlarda aynı asset'in
        // bitişik parçaları ortak kenar SAYILMAZ (ikisi de kendi micro-fade'ini alır).
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 2_000_000, 2_000_000, 5_000_000,
                    ExportTestDocs.Audio()),
            ]),
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000, ExportTestDocs.Audio()),
            ]),
        ]);
        var compiled = ExportCompiler.Compile(doc, SdrSources(), ExportProfile.Hd1080p);
        var audioLines = compiled.FilterGraphScript.Split(";\n")
            .Where(l => l.Contains(":a]")).ToList();

        Assert.All(audioLines, l => Assert.Contains("afade=t=in:st=0:d=0.005000:curve=tri", l));
        Assert.All(audioLines, l => Assert.Contains("afade=t=out:st=", l));
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
        var track = Assert.Single(plan.Tracks);
        Assert.Equal(TrackType.Video, track.Track.Type);
    }

    [Fact]
    public void Validate_OnlyEmptyTracks_ThrowsInvalidTimeline()
    {
        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        doc.Tracks[0].Clips.Clear();
        Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(doc));
    }

    [Theory]
    [InlineData("#000")]
    [InlineData("#fff")]
    [InlineData("#FFF")]
    [InlineData("#abc")]
    [InlineData("#000000")]
    [InlineData("#AbCdEf")]
    [InlineData("#aabbcc")]
    [InlineData("#11223344")]
    [InlineData("#AABBCCDD")]
    public void Validate_ProjectBackgroundColor_AcceptsEveryShapeTheSchemaAllows(string color)
    {
        // YANLIŞ RET YOK: kapı klip renkleriyle AYNI dilbilgisini kullanır (3/6/8 hane,
        // büyük-küçük harf serbest). Bu satırlar kapının GENİŞ tarafını sabitler; dar tarafı
        // aşağıdaki testtedir.
        var doc = ExportTestDocs.Doc(
            backgroundColor: color,
            clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        Assert.NotNull(ExportCompiler.Validate(doc));
    }

    [Theory]
    [InlineData("#GGGGGG")]
    [InlineData("#zzz")]
    [InlineData("#12345")]
    [InlineData("#0000000")]
    [InlineData("#f")]
    [InlineData("#00000000ff")]
    [InlineData("mavi")]
    [InlineData("000000")]
    [InlineData("")]
    public void Validate_ProjectBackgroundColor_RejectsAnythingElse_WithATypedCode(string color)
    {
        // Kapı YOKKEN ölçülen davranış (ham API): '#GGGGGG' 202 alıp render'da
        // 'ffmpeg exited with code -22' ile düşüyordu; kalanlar 202 alıp BAŞARIYLA bitiyor
        // ama arkaplan SESSİZCE SİYAH oluyordu.
        var doc = ExportTestDocs.Doc(
            backgroundColor: color,
            clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("project-background-color", ex.Feature);
        Assert.Contains("settings.backgroundColor", ex.Message, StringComparison.Ordinal);
        Assert.Contains($"'{color}'", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Validate_ProjectBackgroundColor_Missing_SaysMissing_NotEmptyString()
    {
        // EKSİK ALAN ≠ GEÇERSİZ DEĞER. Depoda bu şekilde iki belge ölçüldü: settings'i
        // 'background'/'sampleRateHz' yazan eski bir denetim betiğinden geliyorlar, yani
        // 'backgroundColor' HİÇ YOK. Tek cümleli sürüm "geçersiz: ''" diyor ve kullanıcıyı
        // belgede olmayan bir boş dizeyi aramaya gönderiyordu.
        var doc = ExportTestDocs.Doc(
            clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        doc.Settings.BackgroundColor = null!;

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("project-background-color", ex.Feature);
        Assert.Contains("alanı yok", ex.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("''", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Validate_VolumeKeyframes_AreCompiled_NotRejected()
    {
        // §3.3 MVP kanal listesi volume'u İÇERİR ve §8.1 "ffmpeg'de volume sendcmd örneklemesi"
        // der: editör yazıyor, önizleme çalıştırıyor, export de artık uyguluyor. Eskiden burada
        // UnsupportedFeature("keyframes-volume") atılıyordu — 422 ile reddedilen bir doküman
        // önizlemede ÇALIŞIYORDU (sözleşme çelişkisi).
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000,
            ExportTestDocs.Audio());
        clip.Keyframes = new KeyframeTracks
        {
            Volume = [ExportTestDocs.Kf(0, 1), ExportTestDocs.Kf(500_000, 0)],
        };
        var doc = ExportTestDocs.Doc(clips: clip);

        var plan = ExportCompiler.Validate(doc);
        var planned = Assert.Single(plan.Tracks[0].Clips);
        Assert.NotNull(planned.Animation.Volume);
        Assert.True(planned.Animation.AnimatesAudio);
        // GÖRSEL animasyon bayrağı KAPALI kalmalı: açılsaydı klip kendi katman run'ına
        // ayrılır (concat birleşmesi bozulur), geçişle birlikte kullanımı yasaklanır ve
        // SES klibinde "görsel keyframe olamaz" kapısına takılırdı.
        Assert.False(planned.Animation.Any);
    }

    [Fact]
    public void Compile_VolumeKeyframes_WithATransition_TagEachSegmentSeparately()
    {
        // Geçişli kesimde iki klip TEK acrossfade grubuna girer ve HER SEGMENT kendi ses
        // zincirini alır → volume filtre örneklerinin etiketleri ÇAKIŞMAMALI (çakışsaydı bir
        // segmentin komutu diğerinin gain'ini de sürerdi). Ayrıca 'transition-keyframes'
        // yasağı GÖRSEL kanallar içindir; ses seviyesi keyframe'i geçişle birlikte GEÇERLİDİR.
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000,
            ExportTestDocs.Audio());
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000,
            ExportTestDocs.Audio());
        a.Keyframes = new KeyframeTracks
        {
            Volume = [ExportTestDocs.Kf(0, 1), ExportTestDocs.Kf(2_000_000, 0.25)],
        };
        b.Keyframes = new KeyframeTracks
        {
            Volume = [ExportTestDocs.Kf(0, 0.25), ExportTestDocs.Kf(2_000_000, 1)],
        };
        ExportTestDocs.Link(a, b, 400_000);

        var script = ExportCompiler
            .Compile(ExportTestDocs.Doc(clips: [a, b]), SdrSources(), ExportProfile.Hd1080p)
            .FilterGraphScript;

        Assert.Contains("volume@v0s0=1", script, StringComparison.Ordinal);
        Assert.Contains("volume@v0s1=0.25", script, StringComparison.Ordinal);
        Assert.Equal(2, script.Split("asendcmd=c='").Length - 1);
        // Komut ekseni ZİNCİR eksenidir: b klibinin penceresi D/2 = 0.2 sn ERKEN başlar,
        // yani klip-göreli 0 anı zincirde 0.2 sn'ye düşer (ilk komut oradadır).
        Assert.Contains("0.200000 volume@v0s1 volume 0.25", script, StringComparison.Ordinal);
    }

    [Fact]
    public void Validate_VolumeKeyframes_OutOfRange_Throws()
    {
        // §8.1: volume lineer genlik çarpanıdır, şema aralığı [0..2]. Sessiz clamp YOK.
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000,
            ExportTestDocs.Audio());
        clip.Keyframes = new KeyframeTracks
        {
            Volume = [ExportTestDocs.Kf(0, 1), ExportTestDocs.Kf(500_000, 2.5)],
        };
        var doc = ExportTestDocs.Doc(clips: clip);

        var ex = Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(doc));
        Assert.Contains("[0..2]", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Validate_VolumeKeyframes_OnAudioClip_AreAllowed()
    {
        // Ses klibinde GÖRSEL keyframe tipli hatadır (karşılığı yok) ama ses seviyesi
        // keyframe'i tam olarak ORAYA aittir — iki kural birbirine karışmamalı.
        var clip = ExportTestDocs.AudioClip(ExportTestDocs.AssetC, 0, 0, 1_000_000);
        clip.Keyframes = new KeyframeTracks
        {
            Volume = [ExportTestDocs.Kf(0, 0), ExportTestDocs.Kf(1_000_000, 1)],
        };
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000),
            ]),
            ExportTestDocs.AudioTrack(clips: [clip]),
        ]);

        var plan = ExportCompiler.Validate(doc);
        var planned = Assert.Single(
            plan.Tracks.SelectMany(t => t.Clips), c => c.Kind == ExportClipKind.Audio);
        Assert.NotNull(planned.Animation.Volume);
        Assert.False(planned.Animation.Any); // görsel keyframe kapısı tetiklenmemeli
    }

    [Fact]
    public void Validate_DuplicateColorAdjust_Throws()
    {
        // Önizleme uber-shader'ı TEK parametre kümesi uygular (compositor.ts) → iki colorAdjust'ın
        // hangi sırayla uygulandığı export'ta bile tanımlı olsa parity KIRILIRDI.
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Effects =
        [
            ExportTestDocs.ColorAdjust(contrast: 0.2),
            ExportTestDocs.ColorAdjust(saturation: 0.3),
        ];
        var doc = ExportTestDocs.Doc(clips: clip);

        var ex = Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(doc));
        Assert.Contains("colorAdjust", ex.Message);
    }

    [Fact]
    public void Validate_ColorAdjustOutOfRange_Throws()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Effects = [ExportTestDocs.ColorAdjust(contrast: 1.5)];
        var doc = ExportTestDocs.Doc(clips: clip);

        Assert.Contains("[-1..1]",
            Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(doc)).Message);
    }

    [Fact]
    public void Validate_DisabledEffect_IsIgnored_AndProducesNoFilter()
    {
        // enabled=false efekt hiç yokmuş gibi davranmalı: kapalı bir efekt yüzünden export
        // düşerse kullanıcı efekti kapatarak sorunu çözemez.
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Effects = [ExportTestDocs.ColorAdjust(contrast: 0.5, enabled: false)];
        var compiled = ExportCompiler.Compile(
            ExportTestDocs.Doc(clips: clip), SdrSources(), ExportProfile.Hd1080p);

        Assert.DoesNotContain("lutrgb", compiled.FilterGraphScript);
        Assert.DoesNotContain("colorchannelmixer", compiled.FilterGraphScript);
    }

    [Fact]
    public void Validate_ZeroedColorAdjust_ProducesNoFilterAtAll()
    {
        // §4.1: "Tüm parametreler 0 ise compiler efekt filtresi HİÇ üretmez."
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Effects = [ExportTestDocs.ColorAdjust()];
        var compiled = ExportCompiler.Compile(
            ExportTestDocs.Doc(clips: clip), SdrSources(), ExportProfile.Hd1080p);

        Assert.DoesNotContain("lutrgb", compiled.FilterGraphScript);
        Assert.DoesNotContain("exposure=", compiled.FilterGraphScript);
        Assert.DoesNotContain("format=rgba", compiled.FilterGraphScript); // hızlı yol bozulmadı
    }

    [Fact]
    public void Validate_LutWithoutAsset_ThrowsTypedError()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Effects = [ExportTestDocs.Lut(ExportTestDocs.AssetC)];
        var doc = ExportTestDocs.Doc(clips: clip);

        // Plan LUT'u ayrı defterde tutar; kaynak defterinde yoksa TİPLİ hata (worker retry etmez).
        Assert.Contains(ExportTestDocs.AssetC, ExportCompiler.Validate(doc).LutAssetIds);
        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Compile(
            doc,
            new Dictionary<Guid, ExportAssetSource>
            {
                [ExportTestDocs.AssetA] = new("assets/a.mp4", false, "bt709", "bt709"),
            },
            ExportProfile.Hd1080p));
        Assert.Equal("lut-asset", ex.Feature);
    }

    [Fact]
    public void Validate_LutAssetIds_AreSeparateFromMediaAssetIds()
    {
        // Worker AssetIds'i ffprobe'dan geçirir ve video stream'i şart koşar; .cube dosyası
        // orada olsaydı "no video stream" ile TÜM export düşerdi (M5 denetim kapısı).
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Effects = [ExportTestDocs.Lut(ExportTestDocs.AssetC, 0.5)];
        var plan = ExportCompiler.Validate(ExportTestDocs.Doc(clips: clip));

        Assert.Equal([ExportTestDocs.AssetA], plan.AssetIds);
        Assert.Equal([ExportTestDocs.AssetC], plan.LutAssetIds);
    }

    [Fact]
    public void Validate_SpeedRate_OutOfSchemaRange_Throws()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Speed = new MediaClipSpeed { Rate = 25 };
        clip.TimelineDurationUs = 40_000;
        var doc = ExportTestDocs.Doc(clips: clip);

        Assert.Contains("[0.1..10]",
            Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(doc)).Message);
    }

    [Fact]
    public void Validate_SpeedDurationContract_MustMatchTheSchemaFormula()
    {
        // §1.3: timelineDurationUs = roundHalfUp((out-in)/rate). Editör yanlış süre yazarsa
        // export sessizce KAYMAZ, sözleşme ihlali görünür olur.
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Speed = new MediaClipSpeed { Rate = 2 };
        clip.TimelineDurationUs = 1_000_000; // olması gereken: 500_000
        var doc = ExportTestDocs.Doc(clips: clip);

        Assert.Contains("duration contract",
            Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(doc)).Message);
    }

    [Fact]
    public void Compile_SpeedRate_EmitsSetptsRegridAndAtempoChain()
    {
        // tasarım 04 §2.4. Video: fps normalize → setpts=PTS/k → TEKRAR fps (çıktı ızgarası)
        // → trim (frame defteri). Ses: atempo zinciri EN BAŞTA (sonraki pencereler timeline
        // eksenindedir). k=0.25 için 0.5×0.5 katlaması.
        var fast = ExportTestDocs.SpeedClip(
            ExportTestDocs.AssetA, 0, 0, 4_000_000, 2, ExportTestDocs.Audio());
        var fastCompiled = ExportCompiler.Compile(
            ExportTestDocs.Doc(clips: fast), SdrSources(), ExportProfile.Hd1080p);
        Assert.Contains("fps=30/1,setpts=PTS/2,fps=30/1,trim=end_frame=60,",
            fastCompiled.FilterGraphScript);
        Assert.Contains("[0:a]atempo=2,asetpts=PTS-STARTPTS", fastCompiled.FilterGraphScript);
        Assert.Equal(2_000_000, fastCompiled.ExpectedDurationUs);
        // Kaynak trim'i KAYNAK ekseninde kalır: 4 sn kaynak okunur, 2 sn timeline üretilir.
        Assert.Equal(["-ss", "0.000000", "-t", "4.000000", "-i", "assets/a.mp4"],
            fastCompiled.Inputs[0].ToArgs());

        var slow = ExportTestDocs.SpeedClip(
            ExportTestDocs.AssetA, 0, 0, 1_000_000, 0.25, ExportTestDocs.Audio());
        var slowCompiled = ExportCompiler.Compile(
            ExportTestDocs.Doc(clips: slow), SdrSources(), ExportProfile.Hd1080p);
        Assert.Contains("setpts=PTS/0.25,fps=30/1,trim=end_frame=120,", slowCompiled.FilterGraphScript);
        Assert.Contains("[0:a]atempo=0.5,atempo=0.5,asetpts=PTS-STARTPTS",
            slowCompiled.FilterGraphScript);
        Assert.Equal(4_000_000, slowCompiled.ExpectedDurationUs);
    }

    [Theory]
    [InlineData(1d, new double[0])]
    [InlineData(2d, new[] { 2d })]
    [InlineData(0.5d, new[] { 0.5d })]
    [InlineData(0.25d, new[] { 0.5d, 0.5d })]
    [InlineData(0.1d, new[] { 0.5d, 0.5d, 0.5d, 0.8d })]
    public void AtempoChain_FoldsOutOfRangeRates(double rate, double[] expected)
    {
        var chain = ExportCompiler.AtempoChain(rate).ToArray();
        Assert.Equal(expected.Length, chain.Length);
        for (var i = 0; i < expected.Length; i++)
        {
            Assert.Equal(expected[i], chain[i], 9);
        }

        // Katlamanın ÇARPIMI daima orijinal hızdır — süre sözleşmesi buna dayanır.
        Assert.Equal(rate, chain.Length == 0 ? 1d : chain.Aggregate(1d, (a, b) => a * b), 9);
    }

    [Fact]
    public void Compile_SpeedWithTransition_ScalesTheHandleIntoTheSourceDomain()
    {
        // §5.2: sourceIn' = sourceIn - roundHalfUp((D/2) * rate). 2x hızda 200 ms'lik
        // timeline payı kaynakta 400 ms'tir — timeline payını doğrudan kullanmak geçişi
        // yarı yarıya donmuş kareyle doldururdu.
        var a = ExportTestDocs.SpeedClip(ExportTestDocs.AssetA, 0, 1_000_000, 5_000_000, 2);
        var b = ExportTestDocs.SpeedClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 5_000_000, 2);
        ExportTestDocs.Link(a, b, 400_000);
        var compiled = ExportCompiler.Compile(
            ExportTestDocs.Doc(clips: [a, b]), SdrSources(hasAudio: false), ExportProfile.Hd1080p);

        // D/2 = 200 ms timeline = 400 ms kaynak → A 1.0→5.4 (4.4 sn), B 0.6→5.0 (4.4 sn).
        Assert.Equal(["-ss", "1.000000", "-t", "4.400000", "-i", "assets/a.mp4"],
            compiled.Inputs[0].ToArgs());
        Assert.Equal(["-ss", "0.600000", "-t", "4.400000", "-i", "assets/b.mp4"],
            compiled.Inputs[1].ToArgs());
        // Timeline tarafı DEĞİŞMEZ: segment defteri 60 + 6 frame, offset kapalı formda.
        Assert.Contains("trim=end_frame=66,", compiled.FilterGraphScript);
        Assert.Contains("xfade=transition=fade:duration=0.400000:offset=1.800000",
            compiled.FilterGraphScript);
        Assert.Equal(4_000_000, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Compile_SpeedWithTransition_RejectsInsufficientSourceHandle()
    {
        // Aynı geçiş rate=1'de geçerli (200 ms pay var), rate=2'de GEÇERSİZ (400 ms gerekir).
        var a = ExportTestDocs.SpeedClip(ExportTestDocs.AssetA, 0, 1_000_000, 5_000_000, 2);
        var b = ExportTestDocs.SpeedClip(ExportTestDocs.AssetB, 2_000_000, 300_000, 4_300_000, 2);
        ExportTestDocs.Link(a, b, 400_000);

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(
            ExportTestDocs.Doc(clips: [a, b])));
        Assert.Equal("transition-handle", ex.Feature);
    }

    [Fact]
    public void Compile_SpeedOnStillImage_ProducesNoSpeedFilters()
    {
        // Görselin ZAMAN EKSENİ YOKTUR: -loop 1 -t zaten TIMELINE süresi kadar kare üretir,
        // setpts=PTS/k eklemek kare sayısını ikinci kez bölerdi.
        var image = ExportTestDocs.ImageClip(ExportTestDocs.AssetC, 0, 2_000_000);
        image.Speed = new MediaClipSpeed { Rate = 2 };
        image.SourceOutUs = 4_000_000; // (out-in)/rate = 2 sn ✓
        var compiled = ExportCompiler.Compile(
            ExportTestDocs.Doc(clips: image), ImageSources(), ExportProfile.Hd1080p);

        Assert.DoesNotContain("setpts=PTS/", compiled.FilterGraphScript);
        Assert.True(compiled.Inputs[0].Loop);
        Assert.Equal(2_000_000, compiled.ExpectedDurationUs);
    }

    // ---------- Geçiş derlemesi (rendering-semantics §5) ----------

    [Fact]
    public void Compile_SingleTransition_UsesXfadeWithTheNormativeOffset()
    {
        // §5.2 + §5.3. Klipler BİTİŞİK (0-2 sn, 2-4 sn); D = 400 ms = 12 frame; D/2 = 6 frame.
        //  - girişler D/2 kadar UZAR: A kaynakta 200 ms fazla okur (1.0→3.2), B 200 ms erken
        //    başlar (0.8→3.0) — ikisi de 2.2 sn;
        //  - segment defterleri 66 frame (60 + 6);
        //  - offset = acc - D = 66 - 12 = 54 frame = 1.8 sn; kapalı form d_0 - D/2 = 2.0 - 0.2 ✓;
        //  - toplam süre 4 sn KALIR → sonraki kliplerin timeline pozisyonları kaymaz.
        var compiled = CompileFixture("transition-single");

        Assert.Equal(["-ss", "1.000000", "-t", "2.200000", "-i", "assets/a.mp4"],
            compiled.Inputs[0].ToArgs());
        Assert.Equal(["-ss", "0.800000", "-t", "2.200000", "-i", "assets/b.mp4"],
            compiled.Inputs[1].ToArgs());
        Assert.Contains("fps=30/1,trim=end_frame=66,", compiled.FilterGraphScript);
        Assert.Contains("[s0_0][s0_1]xfade=transition=fade:duration=0.400000:offset=1.800000[v0]",
            compiled.FilterGraphScript);
        Assert.DoesNotContain("concat=", compiled.FilterGraphScript);
        Assert.Equal(4_000_000, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Compile_TransitionChain_AccumulatesOffsetsPerDesign04()
    {
        // 3 klip, 2 geçiş (400 ms + 200 ms). §5.3: offset_i = (Σ_{j<=i} d_j) - D_i/2.
        //   offset_1 = 2.0 - 0.2 = 1.8 ;  offset_2 = 4.0 - 0.1 = 3.9
        // Segment defterleri: 66 / 69 / 63 frame → 66+69-12 = 123, 123+63-6 = 180 = 6 sn.
        var compiled = CompileFixture("transition-chain");

        Assert.Contains("xfade=transition=fade:duration=0.400000:offset=1.800000[x0_1]",
            compiled.FilterGraphScript);
        Assert.Contains("xfade=transition=wipeleft:duration=0.200000:offset=3.900000[v0]",
            compiled.FilterGraphScript);
        Assert.Contains("trim=end_frame=69,", compiled.FilterGraphScript); // ortadaki klip: 6+60+3
        Assert.Contains("trim=end_frame=63,", compiled.FilterGraphScript); // son klip: 3+60
        Assert.Equal(6_000_000, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Compile_TransitionAudio_UsesAcrossfade_AndDropsMicroFadesOnThatEdge()
    {
        // §5.4: acrossfade=d=D (offset yok — uçtan bindirir), c1/c2=tri (§8.2 ile tutarlı).
        // Segmentler videoyla AYNI D/2 payını aldığı için pencere xfade ile örtüşür ve toplam
        // ses süresi Σd kalır (2.2 + 2.2 - 0.4 = 4.0) → A/V senkron.
        // §8.4: geçişin olduğu kenarda micro-fade ÜRETİLMEZ (acrossfade zaten sıfıra indirir).
        var compiled = CompileFixture("transition-audio");

        Assert.Contains("[g0_0][g0_1]acrossfade=d=0.400000:c1=tri:c2=tri[a0]",
            compiled.FilterGraphScript);
        var lines = compiled.FilterGraphScript.Split(";\n");
        var first = Assert.Single(lines, l => l.StartsWith("[0:a]"));
        Assert.Contains("afade=t=in:st=0:d=0.005000:curve=tri", first);   // dış kenar
        Assert.DoesNotContain("afade=t=out", first);                       // geçiş kenarı
        var second = Assert.Single(lines, l => l.StartsWith("[1:a]"));
        Assert.DoesNotContain("afade=t=in", second);                       // geçiş kenarı
        Assert.Contains("afade=t=out:st=2.195000:d=0.005000:curve=tri", second);
        // Ses de geçiş payıyla okur; kırpmaya (atrim) gerek yoktur.
        Assert.DoesNotContain("atrim=start", compiled.FilterGraphScript);
        Assert.Contains("amix=inputs=1:", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_TransitionUnderALayerComposition_CompilesTheTrackToOneStreamFirst()
    {
        // Tasarım 04 §2.3: geçişli track ÖNCE kendi içinde birleşik akışa derlenir, sonra üst
        // katman kompozisyonuna girer. Burada alt track xfade'lenir, üstteki PiP tuvale ayrı
        // overlay olarak biner — iki overlay, tek xfade.
        var compiled = CompileFixture("transition-pip-layer");
        var script = compiled.FilterGraphScript;

        Assert.Equal(2, script.Split(";\n").Count(l => l.Contains("]overlay=")));
        Assert.Contains("xfade=transition=fadeblack:duration=0.400000:offset=1.800000[v0]", script);
        Assert.Contains("[base][v0]overlay=", script);
        Assert.Contains("[c0][v1]overlay=", script);
        // Kompozisyon yolunda segmentler kutuya şeffaf pad'lenir (xfade AYNI boyut ister).
        Assert.Contains("format=rgba,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#00000000", script);
        Assert.Equal(4_000_000, compiled.ExpectedDurationUs);
    }

    [Theory]
    [InlineData(TransitionType.Crossfade, "fade")]
    [InlineData(TransitionType.FadeToBlack, "fadeblack")]
    [InlineData(TransitionType.WipeLeft, "wipeleft")]
    [InlineData(TransitionType.WipeRight, "wiperight")]
    [InlineData(TransitionType.SlideUp, "slideup")]
    [InlineData(TransitionType.Dissolve, "dissolve")]
    public void Compile_TransitionTypes_MapToTheNormativeXfadeNames(TransitionType type, string expected)
    {
        // rendering-semantics §5.3 tablosu — tam altı tip, birebir.
        Assert.Equal(expected, ExportCompiler.XfadeName(type));
        var compiled = ExportCompiler.Compile(
            TransitionSingle(type), SdrSources(hasAudio: false), ExportProfile.Hd1080p);
        Assert.Contains($"xfade=transition={expected}:", compiled.FilterGraphScript);
    }

    [Fact]
    public void Validate_AsymmetricTransition_ThrowsInvalidTimeline()
    {
        // §5.2 simetri invariant'ı: geçiş kesimin İKİ tarafına da yazılır ve derin-eşittir.
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000);
        a.TransitionOut = new Transition { Type = TransitionType.Crossfade, DurationUs = 400_000 };
        var oneSided = ExportTestDocs.Doc(clips: [a, b]);
        var ex = Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(oneSided));
        Assert.Contains("simetri", ex.Message);

        // Tek taraflı transitionIn de yakalanır (kesimin öteki tarafı boş).
        var c = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000);
        var d = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000);
        d.TransitionIn = new Transition { Type = TransitionType.Crossfade, DurationUs = 400_000 };
        Assert.Throws<InvalidTimelineException>(
            () => ExportCompiler.Validate(ExportTestDocs.Doc(clips: [c, d])));

        // Derin-eşitlik: aynı kesimde farklı süre/tip sözleşme ihlalidir.
        var e = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000);
        var f = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000);
        e.TransitionOut = new Transition { Type = TransitionType.Crossfade, DurationUs = 400_000 };
        f.TransitionIn = new Transition { Type = TransitionType.Crossfade, DurationUs = 200_000 };
        Assert.Throws<InvalidTimelineException>(
            () => ExportCompiler.Validate(ExportTestDocs.Doc(clips: [e, f])));
    }

    [Fact]
    public void Validate_TransitionDurationRules_ThrowInvalidTimeline()
    {
        // (a) grid dışı D: frame defterini bozar.
        Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(Linked(410_000)));

        // (b) TEK frame sayısı: D/2 tam frame olmaz → pencere kesime simetrik oturamaz.
        var odd = Assert.Throws<InvalidTimelineException>(
            () => ExportCompiler.Validate(Linked(366_667))); // 11 frame @30
        Assert.Contains("ÇİFT frame", odd.Message);

        // (c) üst sınır: D, kısa komşunun yarısını aşamaz (2 sn klipte D <= 1 sn).
        var tooLong = Assert.Throws<InvalidTimelineException>(
            () => ExportCompiler.Validate(Linked(1_200_000)));
        Assert.Contains("çok uzun", tooLong.Message);

        // (d) 2 frame'in altı yasak.
        Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(Linked(33_333)));

        static TimelineDoc Linked(long durationUs)
        {
            var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000);
            var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000);
            ExportTestDocs.Link(a, b, durationUs);
            return ExportTestDocs.Doc(clips: [a, b]);
        }
    }

    [Fact]
    public void Validate_TransitionWithoutSourceHandle_ThrowsTypedFeatureError()
    {
        // §5.2/§5.5: B'nin BAŞ payı yetmiyorsa geçiş kurulamaz — sessiz kısaltma YOK.
        // B kaynakta 0'dan başlıyor, D/2 = 200 ms geri gitmek imkânsız.
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 0, 2_000_000);
        ExportTestDocs.Link(a, b, 400_000);

        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(ExportTestDocs.Doc(clips: [a, b])));
        Assert.Equal("transition-handle", ex.Feature);
        Assert.Contains("geçiş payı yok", ex.Message);
    }

    [Fact]
    public void Validate_TransitionAcrossAGap_ThrowsInvalidTimeline()
    {
        // Geçiş BİTİŞİK kesime aittir (§5.1); araya boşluk girerse kesim yoktur.
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 3_000_000, 1_000_000, 3_000_000);
        ExportTestDocs.Link(a, b, 400_000);

        var ex = Assert.Throws<InvalidTimelineException>(
            () => ExportCompiler.Validate(ExportTestDocs.Doc(clips: [a, b])));
        Assert.Contains("BİTİŞİK", ex.Message);
    }

    [Fact]
    public void Validate_TransitionBetweenDifferentPlacements_ThrowsInvalidTimeline()
    {
        // xfade iki girişin AYNI boyutta olmasını şart koşar; run bölünemeyeceği için farklı
        // yerleşim sessizce kaydırmak yerine görünür sözleşme ihlalidir.
        //
        // KURAL YERİ DEĞİŞTİ (İŞ 1): eskiden YALNIZ Compile'daydı, dolayısıyla API'nin 422 ön
        // kapısı onu göremiyordu ve böyle bir belge 202 alıp worker'da düşüyordu (ham API ile
        // ölçüldü). Hesap saf doküman aritmetiğidir → artık Validate'te. Compile'daki dal
        // SİGORTA olarak duruyor ve AYNI cümleyi üretiyor (aşağıda ikisi de sınanır).
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5));
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000,
            transform: ExportTestDocs.Transform(scale: 0.25));
        ExportTestDocs.Link(a, b, 400_000);
        var doc = ExportTestDocs.Doc(clips: [a, b]);

        var validated = Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(doc));
        Assert.Contains("yerleşimi", validated.Message);

        var compiled = Assert.Throws<InvalidTimelineException>(
            () => ExportCompiler.Compile(doc, SdrSources(hasAudio: false), ExportProfile.Hd1080p));
        Assert.Equal(validated.Message, compiled.Message);
    }

    [Fact]
    public void Validate_TransitionPlacementGate_DoesNotFireWhereNoXfadeIsBuilt()
    {
        // YANLIŞ RET KONTROLÜ. Kapı Compile'daki `joined` koşuluna bağlıdır: geçiş VİDEODA
        // ancak iki taraf da GÖRSEL katman ürettiğinde xfade'e çevrilir.
        //  - GİZLİ track: yalnız ses kalır (acrossfade yerleşim bilmez),
        //  - SES klibi: görsel katman zaten yok.
        // İki halde de farklı yerleşim reddedilMEMELİDİR.
        var hiddenA = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000,
            audio: ExportTestDocs.Audio(), transform: ExportTestDocs.Transform(scale: 0.5));
        var hiddenB = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000,
            audio: ExportTestDocs.Audio(), transform: ExportTestDocs.Transform(scale: 0.25));
        ExportTestDocs.Link(hiddenA, hiddenB, 400_000);

        var audioA = ExportTestDocs.AudioClip(ExportTestDocs.AssetC, 0, 1_000_000, 3_000_000);
        var audioB = ExportTestDocs.AudioClip(ExportTestDocs.AssetC, 2_000_000, 1_000_000, 3_000_000);
        audioA.Transform = ExportTestDocs.Transform(scale: 0.5);
        audioB.Transform = ExportTestDocs.Transform(scale: 0.25);
        ExportTestDocs.Link(audioA, audioB, 400_000);

        Assert.NotNull(ExportCompiler.Validate(ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(hidden: true, clips: [hiddenA, hiddenB]),
            ExportTestDocs.AudioTrack(clips: [audioA, audioB]),
        ])));
    }

    [Fact]
    public void Validate_TransitionOnARotatedOffCenterAnchorLayer_ThrowsUnsupportedFeature()
    {
        // İkinci geçiş-yerleşim kuralı da Validate'e taşındı (İŞ 1): dönmüş + merkez dışı
        // çapa, kutuya normalize pad'in çapa telafisini yanlış tabana oturtur.
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5, rotationDeg: 30, anchorX: 0.25));
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5, rotationDeg: 30, anchorX: 0.25));
        ExportTestDocs.Link(a, b, 400_000);
        var doc = ExportTestDocs.Doc(clips: [a, b]);

        var validated = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("transition-rotated-anchor", validated.Feature);

        var compiled = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Compile(doc, SdrSources(hasAudio: false), ExportProfile.Hd1080p));
        Assert.Equal(validated.Message, compiled.Message);
    }

    [Fact]
    public void Validate_RotatedOffCenterAnchor_WithoutATransition_IsAccepted()
    {
        // Negatif kontrol: kural GEÇİŞE bağlıdır. Aynı yerleşim, geçiş OLMADAN kabul edilir
        // (run bölünebilir, normalize pad'e gerek yoktur).
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5, rotationDeg: 30, anchorX: 0.25));
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5, rotationDeg: 30, anchorX: 0.25));

        Assert.NotNull(ExportCompiler.Validate(ExportTestDocs.Doc(clips: [a, b])));
    }

    [Fact]
    public void Compile_TransitionRunStartingMidTimeline_ShiftsTheCombinedStreamAfterTheXfade()
    {
        // xfade GİRİŞLERİNİN PTS'i 0'dan başlamak ZORUNDADIR (offset birleşik akışın kendi
        // zamanındadır). Timeline ofseti bu yüzden segmentlere değil, BİRLEŞTİRME SONRASINA
        // uygulanır — segmentlere uygulansaydı offset yanlış eksene düşerdi.
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 1_000_000, 1_000_000, 3_000_000);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 3_000_000, 1_000_000, 3_000_000);
        ExportTestDocs.Link(a, b, 400_000);
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips: [a, b]),
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 0, 0, 6_000_000)]),
        ]);
        var script = ExportCompiler.Compile(
            doc, SdrSources(hasAudio: false), ExportProfile.Hd1080p).FilterGraphScript;

        // Segmentler 0'dan başlar…
        Assert.Contains("settb=AVTB,setpts=PTS-STARTPTS[s1_0]", script);
        Assert.Contains("settb=AVTB,setpts=PTS-STARTPTS[s1_1]", script);
        // …xfade offset'i akışın KENDİ zamanındadır (1.8 sn, timeline'daki 2.8 değil)…
        Assert.Contains("xfade=transition=fade:duration=0.400000:offset=1.800000[x1_1]", script);
        // …ve timeline ofseti xfade SONRASINDA uygulanır.
        Assert.Contains("[x1_1]setpts=PTS-STARTPTS+1.000000/TB[v1]", script);
        Assert.Contains("enable='between(t,1.000000,4.983334)'", script);
    }

    [Fact]
    public void Compile_TransitionOnARotatedOffCenterAnchorLayer_ThrowsUnsupportedFeature()
    {
        // Geçişte run BÖLÜNEMEZ → kutuya normalize pad ZORUNLUDUR. §2.5'in çapa telafisi pad'i
        // gerçek görüntü boyutuna (iw/ih) göre ölçeklenir; normalize sonrası iw kutu boyutudur
        // → çapa letterbox payı kadar KAYARDI. Sessiz kayma yerine tipli hata.
        var rotated = ExportTestDocs.Transform(scale: 0.5, rotationDeg: 30, anchorX: 0, anchorY: 1);
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000,
            transform: rotated);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000,
            transform: rotated);
        ExportTestDocs.Link(a, b, 400_000);
        var doc = ExportTestDocs.Doc(clips: [a, b]);

        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Compile(doc, SdrSources(hasAudio: false), ExportProfile.Hd1080p));
        Assert.Equal("transition-rotated-anchor", ex.Feature);
        Assert.Contains("DÖNDÜRÜLMÜŞ", ex.Message);
        // Mesaj YALNIZ bu gerekçeyi anlatmalı: kutu paritesi artık kapı değil, dolayısıyla
        // "çift kutu" gibi ikinci bir gerekçe mesaja karışmamalı…
        Assert.DoesNotContain("çift", ex.Message, StringComparison.OrdinalIgnoreCase);
        // …ve önerilen eylem arayüzde GERÇEKTEN yapılabilir olmalı (çapa alanı editörde YOK,
        // dönme alanı var: clip-rotation).
        Assert.DoesNotContain("Çapayı merkeze", ex.Message);
        Assert.Contains("dönmesini 0", ex.Message);

        // Aynı çapa, DÖNMESİZ → geçiş çalışır ve pad çapa ORANLI yazılır (geometri korunur).
        var flat = ExportTestDocs.Transform(scale: 0.5, anchorX: 0, anchorY: 1);
        var c = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000, transform: flat);
        var d = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000,
            transform: flat);
        ExportTestDocs.Link(c, d, 400_000);
        var ok = ExportCompiler.Compile(
            ExportTestDocs.Doc(clips: [c, d]), SdrSources(hasAudio: false), ExportProfile.Hd1080p);
        Assert.Contains("pad=960:540:0:(oh-ih)*1:color=#00000000", ok.FilterGraphScript);
        Assert.Contains("xfade=transition=fade:", ok.FilterGraphScript);
    }

    [Fact]
    public void Compile_ContiguousClipsWithAnOddBox_StillConcatIntoOneRun()
    {
        // Kutu paritesi CanConcatRun'ın da kapısıydı: TEK kutulu bitişik klipler eskiden run'ı
        // BÖLDÜRÜR ve klip başına ayrı overlay üretirdi. Pad hedefi çifte indirildiği için o
        // kapı kalktı — aynı yerleşimli bitişik klipler artık geçişsiz yolda da TEK concat'e
        // düşer (görüntü değişmez: ölçülen bbox pad'siz yolla BİREBİR aynı).
        var odd = ExportTestDocs.Transform(x: 0.25, y: -0.25, scale: 0.501);
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 1_000_000, transform: odd),
                ExportTestDocs.VideoClip(ExportTestDocs.AssetC, 1_000_000, 0, 1_000_000, transform: odd),
            ]),
        ]);

        var script = ExportCompiler.Compile(
            doc, SdrSources(hasAudio: false), ExportProfile.Hd1080p).FilterGraphScript;

        Assert.Contains("concat=n=2:v=1:a=0[v0]", script);
        Assert.Equal(1, script.Split(";\n").Count(l => l.Contains("]overlay=")));
        // Ölçek hedefi HAM kutu (962x541), pad hedefi ÇİFT (962x540) — iki karar tek satırda.
        Assert.Contains("scale=962:541:force_original_aspect_ratio=decrease", script);
        Assert.Contains("pad=962:540:(ow-iw)/2:(oh-ih)/2:color=#00000000", script);
        Assert.DoesNotContain("pad=962:541", script);
        Assert.DoesNotContain("scale=962:540", script);
    }

    // ───────────────────── Dejenerelik kapısı ─────────────────────

    /// <summary>Afiş kaynak defteri (1920x100 — en-boy 19.2:1, dejenerelik eşiği 0.011).</summary>
    private static Dictionary<Guid, ExportAssetSource> BannerSources(int width = 1920, int height = 100) =>
        new()
        {
            [ExportTestDocs.AssetA] = new("a.mp4", false, "bt709", "bt709", width, height),
            [ExportTestDocs.AssetB] = new("b.mp4", false, "bt709", "bt709", width, height),
            [ExportTestDocs.AssetC] = new("c.mp4", false, "bt709", "bt709", width, height),
        };

    /// <summary>
    /// Yalnız BOYUT taşıyan asset defteri (dejenerelik kapısının kolu). Süre/dosya adı
    /// bilerek boştur: bu testlerin konusu geometri kapısıdır ve defterin diğer alanları
    /// null iken ilgili kapılar (kaynak aralığı, LUT türü) ATLANIR.
    /// </summary>
    private static Dictionary<Guid, ExportAssetFacts> Sizes(int width, int height) => new()
    {
        [ExportTestDocs.AssetA] = new ExportAssetFacts(width, height),
        [ExportTestDocs.AssetB] = new ExportAssetFacts(width, height),
        [ExportTestDocs.AssetC] = new ExportAssetFacts(width, height),
    };

    /// <summary>Sağ tık "böl"ün ürettiği şekil: aynı asset, aynı yerleşim, BİTİŞİK iki klip.</summary>
    private static TimelineDoc SplitBannerDoc(double scale)
    {
        var transform = ExportTestDocs.Transform(scale: scale);
        return ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000, transform: transform),
                ExportTestDocs.VideoClip(
                    ExportTestDocs.AssetA, 1_000_000, 1_000_000, 2_000_000, transform: transform),
            ]),
        ]);
    }

    [Fact]
    public void Compile_DegenerateLayer_ThrowsTypedError_InsteadOfDyingInFfmpeg()
    {
        // RAPOR EDİLEN VAKA: 1920x100 afiş → böl (iki bitişik klip) → ikisine de ölçek 0.010 →
        // kutu 19x11. Sığdırılan yükseklik 0.99 px → ffmpeg o ekseni 0 hesaplar, 18x100 çizer ve
        // normalize pad (hedef 18x10) "Padded dimensions cannot be smaller" ile -22 verirdi.
        // Artık derleme TİPLİ hatayla durur; ffmpeg hiç çağrılmaz.
        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Compile(
            SplitBannerDoc(0.010), BannerSources(), ExportProfile.Hd1080p));

        Assert.Equal("degenerate-layer", ex.Feature);
        Assert.Contains("1920x100", ex.Message);        // NEDEN: kaynağın oranı
        Assert.Contains("19x11", ex.Message);           // hangi kutuda
        Assert.Contains("yüksekliği", ex.Message);      // hangi eksen
        Assert.Contains("en az 0.011", ex.Message);     // EYLEM: tek ve kesin bir sayı
    }

    [Fact]
    public void Compile_DegenerateLayer_IsRejectedOnTheTransitionPathToo()
    {
        // Geçişli kesimde run BÖLÜNEMEZ → pad ZORUNLU → bu vaka parite düzeltmesinden sonra
        // "202 kabul + worker'da ölüm"e dönüşmüştü (canlı ölçülen RED vakası). Kapı onu
        // yeniden SENKRON hataya çevirir — ama artık DOĞRU gerekçeyle ('degenerate-layer',
        // eskiden 'katman döndürülmüş ve çapası merkezde değil' deniyordu).
        var transform = ExportTestDocs.Transform(scale: 0.010);
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000, transform: transform);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000, transform: transform);
        ExportTestDocs.Link(a, b, 400_000);

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Compile(
            ExportTestDocs.Doc(clips: [a, b]), BannerSources(), ExportProfile.Hd1080p));

        Assert.Equal("degenerate-layer", ex.Feature);
        Assert.DoesNotContain("DÖNDÜRÜLMÜŞ", ex.Message);
    }

    [Fact]
    public void Compile_DegenerateLayer_IsRejectedEvenWhenFfmpegWouldNotComplain()
    {
        // ÖNCEDEN DE VAR OLAN SESSİZ SINIF: 200x10 kaynak, kutu 19x11 → çıktı 18x10. Pad hedefi
        // 18x10 olduğu için ffmpeg HİÇ ŞİKÂYET ETMEZ (exit 0) — katman, önizlemenin çizdiği
        // 20x1 yerine 10 KAT yüksek çizilirdi. Bu vaka düzeltme ÖNCESİNDE de sessizce bozuktu;
        // kapı yalnız yeni bir sınıfı değil, eski sessiz bozulmayı da kapatır.
        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Compile(
            SplitBannerDoc(0.010), BannerSources(200, 10), ExportProfile.Hd1080p));

        Assert.Equal("degenerate-layer", ex.Feature);
        Assert.Contains("200x10", ex.Message);
    }

    [Fact]
    public void Compile_ScaleJustAboveTheThreshold_StillConcatsIntoOneRun()
    {
        // Kapının ÜST tarafı: bir ızgara adımı yukarısı hem kabul edilmeli hem de parite
        // düzeltmesinin kazancını (tek kutulu bitişik kliplerin TEK concat'e düşmesi) korumalı.
        // 0.011 → kutu 21x12: genişlik TEK. Eskiden bu doküman run'ı böldürürdü.
        var script = ExportCompiler.Compile(
            SplitBannerDoc(0.011), BannerSources(), ExportProfile.Hd1080p).FilterGraphScript;

        Assert.Contains("concat=n=2:v=1:a=0[v0]", script);
        Assert.Equal(1, script.Split(";\n").Count(l => l.Contains("]overlay=")));
        Assert.Contains("scale=21:12:force_original_aspect_ratio=decrease", script);
        Assert.Contains("pad=20:12:(ow-iw)/2:(oh-ih)/2:color=#00000000", script);
    }

    [Fact]
    public void Compile_WithoutSourceSizes_SkipsTheGateAndProducesTheIdenticalScript()
    {
        // KAPI ÇIKTIYI DEĞİŞTİRMEZ: boyut defteri yalnız RET üretir, filtergraph'a girmez.
        // (Bu tur ExportSnapshots altındaki 29 mevcut snapshot'ın bayt bayt korunmasının nedeni
        // budur — snapshot fixture'ları boyut taşımaz; 30. dosya, transition-odd-box.txt, bu
        // turda YENİ üretildi.) Aynı doküman, boyutlu ve boyutsuz defterle AYNI script'i vermeli.
        var doc = SplitBannerDoc(0.5);
        var withSizes = ExportCompiler.Compile(doc, BannerSources(), ExportProfile.Hd1080p);
        var without = ExportCompiler.Compile(doc, SdrSources(hasAudio: false), ExportProfile.Hd1080p);

        Assert.Equal(without.FilterGraphScript, withSizes.FilterGraphScript);

        // Ve boyut BİLİNMEZKEN dejenere doküman bile derlenir (yanlış ret imkânsız).
        Assert.NotNull(ExportCompiler.Compile(
            SplitBannerDoc(0.010), SdrSources(hasAudio: false), ExportProfile.Hd1080p));
    }

    [Fact]
    public void Validate_DegenerateLayer_IsRejectedSynchronouslyWhenSizesAreKnown()
    {
        var doc = SplitBannerDoc(0.010);

        // Boyut defteri YOKSA Validate geçer (API asset hâlâ işlenirken yanlış 422 vermez)…
        Assert.NotNull(ExportCompiler.Validate(doc));

        // …VARSA aynı doküman senkron olarak reddedilir (iş kuyruğa hiç girmez).
        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(doc, null, Sizes(1920, 100)));
        Assert.Equal("degenerate-layer", ex.Feature);
    }

    [Fact]
    public void Validate_DegeneracyIsAskedAtTheSmallestScaleKeyframe_NotTheLargest()
    {
        // scale animasyonu eval=frame ile KARE KARE uygulanır: tabanı dejenere bir kareye düşen
        // animasyon o karelerde bozulur. Tavan kuralı (MaxLayerDimension) simetrik olarak
        // MAKSİMUM ölçekle sorulur — bu iki kural aynı transform'un iki UCUNA bakar.
        var clip = ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 1.0));
        clip.Keyframes = new KeyframeTracks
        {
            Scale = [ExportTestDocs.Kf(0, 1.0), ExportTestDocs.Kf(1_000_000, 0.010)],
        };
        var doc = ExportTestDocs.Doc(clips: clip);

        // Statik ölçek 1.0 olduğu için TAVAN kuralı hiçbir şey görmez; TABAN dejeneredir.
        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(doc, null, Sizes(1920, 100)));
        Assert.Equal("degenerate-layer", ex.Feature);
        // Kutu ANİMASYONLU yolun aritmetiğiyle: floor(1920*0.010)=19, floor(1080*0.010)=10.
        // (Statik yolda aynı ölçek 19x11 verir — iki yol iki farklı kutu üretir.)
        Assert.Contains("19x10", ex.Message);
    }

    [Fact]
    public void Validate_NormalAspectSources_AreNeverRejectedAcrossTheWholeEditorScaleGrid()
    {
        // YANLIŞ RET TARAMASI: kapı normal medyada HİÇ tetiklenmemeli. Editörün yazabildiği her
        // ölçek (0.010 … 4.266, 3 ondalık) × yaygın kaynak oranları. Tavana çarpanlar 'transform-scale'
        // ile reddedilir; burada aranan YALNIZ 'degenerate-layer'dır.
        int[][] sources = [[1920, 1080], [1080, 1920], [3840, 2160], [640, 480], [512, 512], [2560, 1080]];
        foreach (var src in sources)
        {
            var sizes = Sizes(src[0], src[1]);
            for (var step = 10; step <= 4266; step++)
            {
                var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
                    ExportTestDocs.AssetA, 0, 0, 1_000_000,
                    transform: ExportTestDocs.Transform(scale: step / 1000d)));
                try
                {
                    ExportCompiler.Validate(doc, null, sizes);
                }
                catch (UnsupportedFeatureException ex) when (ex.Feature != "degenerate-layer")
                {
                    // tavan (transform-scale) — bu testin konusu değil
                }
                catch (UnsupportedFeatureException ex)
                {
                    Assert.Fail($"yanlış ret: kaynak {src[0]}x{src[1]}, ölçek {step / 1000d} → {ex.Message}");
                }
            }
        }
    }

    [Fact]
    public void Compile_TransitionWhereOnlyOneSideIsAudible_TrimsTheExtendedAudioBack()
    {
        // Geçiş kesimi SESTE ancak İKİ taraf da duyulabilirse onurlandırılır. Tek taraf
        // duyulabilirse giriş yine D/2 uzar (video xfade'i için ŞART) ama o klibin sesi
        // komşunun timeline bölgesine TAŞMAMALIDIR → atrim ile geri kırpılır.
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000,
            ExportTestDocs.Audio());
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000,
            ExportTestDocs.Audio(muted: true));
        ExportTestDocs.Link(a, b, 400_000);
        var compiled = ExportCompiler.Compile(
            ExportTestDocs.Doc(clips: [a, b]), SdrSources(), ExportProfile.Hd1080p);

        // Video geçişi kurulur (iki klip de görsel).
        Assert.Contains("xfade=transition=fade:duration=0.400000:offset=1.800000", compiled.FilterGraphScript);
        // Ses tek zincirdir ve 2 sn'ye kırpılır (2.2 sn'lik giriş penceresinden).
        Assert.Contains("[0:a]atrim=start=0.000000:end=2.000000,asetpts=PTS-STARTPTS",
            compiled.FilterGraphScript);
        Assert.DoesNotContain("acrossfade", compiled.FilterGraphScript);
        Assert.Contains("amix=inputs=1:", compiled.FilterGraphScript);
        // Kırpılmış kenar sert kesimdir → micro-fade orada ÜRETİLİR (§8.4).
        Assert.Contains("afade=t=out:st=1.995000:d=0.005000:curve=tri", compiled.FilterGraphScript);
    }

    [Fact]
    public void Validate_TransitionExtendsTheSourceRangeLedger()
    {
        // Worker'ın kaynak-aralığı kapısı GENİŞLETİLMİŞ aralığı görmelidir: A kaynaktan D/2
        // fazla okur. Kapı bunu görmezse yeterli kuyruk payı olmayan geçiş yakalanmaz ve
        // ffmpeg sessizce donmuş kare üretirdi (§5.2 handle invariant'ının worker ayağı).
        var plan = ExportCompiler.Validate(TransitionSingle());

        var outgoing = plan.Clips.Single(c => c.AssetId == ExportTestDocs.AssetA);
        Assert.Equal(3_200_000, outgoing.SourceOutUs);  // 3.0 + D/2
        var incoming = plan.Clips.Single(c => c.AssetId == ExportTestDocs.AssetB);
        Assert.Equal(800_000, incoming.SourceInUs);     // 1.0 - D/2

        // Kaynak 3.1 sn ise kapı ARTIK tetiklenir (geçişsiz halde 3.0 yeterliydi).
        Assert.NotNull(VideoEdit.Worker.Jobs.ExportJob.FindSourceOutOfRange(
            plan.Clips, ExportTestDocs.AssetA, probeDurationUs: 3_100_000, plan.FpsNum, plan.FpsDen));
    }

    // ---------- Metin / şekil / çıkartma overlay'leri ----------

    [Fact]
    public void Compile_TextClip_UsesTheRasterAsALoopedInput_WithBboxSizedBox()
    {
        // Tasarım 04 §3 + rendering-semantics §7: metin klibi başına TEK şeffaf PNG; giriş
        // -loop 1 -t (zaman ekseni yok). Ölçek kutusu TUVAL DEĞİL rasterin kendi bbox'ıdır —
        // fit=contain uygulansaydı 640x160'lık metin 1920x480'e şişer, fontSizePx anlamını
        // yitirirdi (her punto aynı ekran boyutunu verirdi).
        var compiled = CompileFixture("text-over-video");

        Assert.True(compiled.Inputs[1].Loop);
        Assert.Equal(["-loop", "1", "-t", "2.033333", "-i", "rasters/text-0.png"],
            compiled.Inputs[1].ToArgs());
        Assert.Contains("scale=640:160:force_original_aspect_ratio=decrease", compiled.FilterGraphScript);
        // P = (960, 540 + 0.3*1080) = (960, 864); çapa merkez.
        Assert.Contains("overlay=x=floor(960-0.5*w):y=floor(864-0.5*h):", compiled.FilterGraphScript);
        Assert.Contains("enable='between(t,1.000000,2.983334)'", compiled.FilterGraphScript);

        // Metin SES ÜRETMEZ: mikse yalnız video klibi girer.
        Assert.Contains("amix=inputs=1:", compiled.FilterGraphScript);
        Assert.DoesNotContain("[1:a]", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_ShapeAndSticker_ComposeLikeAnyOtherLayer()
    {
        // Şeklin şemada içsel boyutu YOKTUR → rasteri proje tuvalidir (scale=1 = tam kare),
        // dolayısıyla scale 0.5 tam olarak medya klibindeki gibi 960x540 kutu verir.
        // Çıkartma rasterlenmez: kendi asset dosyası GÖRSEL klip semantiğiyle girer.
        var compiled = CompileFixture("shape-and-sticker");
        var script = compiled.FilterGraphScript;

        // Girişler render sırasında (sondan başa): video, şekil rasteri, çıkartma asset'i.
        Assert.Equal("assets/a.mp4", compiled.Inputs[0].Path);
        Assert.Equal("rasters/shape-0.png", compiled.Inputs[1].Path);
        Assert.Equal("assets/photo.png", compiled.Inputs[2].Path);
        Assert.True(compiled.Inputs[1].Loop);
        Assert.True(compiled.Inputs[2].Loop);

        Assert.Contains("scale=960:540:force_original_aspect_ratio=decrease", script); // şekil
        Assert.Contains("colorchannelmixer=aa=0.4", script);
        Assert.Contains("scale=480:270:force_original_aspect_ratio=decrease", script); // çıkartma
        // çıkartma P
        Assert.Contains("overlay=x=floor(480-0.5*w):y=floor(810-0.5*h):", script);
        Assert.Equal(3, script.Split(";\n").Count(l => l.Contains("]overlay=")));

        // İkisi de sessiz: yalnız video klibinin sesi mikse girer.
        Assert.Contains("amix=inputs=1:", script);
        Assert.DoesNotContain("[1:a]", script);
        Assert.DoesNotContain("[2:a]", script);
    }

    [Fact]
    public void Validate_RasterClips_AreListedForTheRasterPipeline_ExceptInertOnes()
    {
        // Worker yalnız GERÇEKTEN render edilecek metin/şekil klipleri için SkiaSharp çalıştırır:
        // gizli track'teki overlay klibi ne görüntü ne ses üretir → boşuna PNG üretilmez.
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.OverlayTrack(hidden: true, clips: [ExportTestDocs.TextClip(0, 1_000_000)]),
            ExportTestDocs.OverlayTrack(clips: [ExportTestDocs.TextClip(0, 1_000_000)]),
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000)]),
        ]);

        var plan = ExportCompiler.Validate(doc);
        var raster = Assert.Single(plan.RasterClips);
        Assert.Equal(ExportClipKind.Text, raster.Kind);
        Assert.Equal(doc.Tracks[1].Clips[0], raster.Source);
        // Metin klibinin asset'i yoktur → indirme defterinde yalnız video vardır.
        Assert.Equal([ExportTestDocs.AssetA], plan.AssetIds);
        // Metin/şekil kaynak-aralığı kapısına GİRMEZ (dosyada zaman aralığı yok).
        Assert.Single(plan.Clips);
    }

    [Fact]
    public void Validate_RasterClipLedger_MatchesTheWorkerRasterPlanner()
    {
        // İKİ AJANIN KURALI AYNI OLMAK ZORUNDA: worker (OverlayRasterPlanner) hangi klipler
        // için PNG üretiyorsa, compiler TAM o klipler için raster BEKLER. Ayrışırlarsa export
        // ya "no raster provided" ile düşer ya da boşuna PNG üretilir.
        // Kural: metin + şekil DAHİL; çıkartma HARİÇ (kendi asset'i); gizli track HARİÇ (atıl).
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.OverlayTrack(clips:
            [
                ExportTestDocs.TextClip(0, 1_000_000),
                ExportTestDocs.ShapeClip(1_000_000, 1_000_000),
                ExportTestDocs.StickerClip(ExportTestDocs.AssetC, 2_000_000, 1_000_000),
            ]),
            ExportTestDocs.OverlayTrack(hidden: true, clips: [ExportTestDocs.TextClip(0, 1_000_000)]),
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 3_000_000)]),
        ]);

        var plan = ExportCompiler.Validate(doc);
        Assert.Equal(
            plan.RasterClips.Select(c => c.Id).Order(),
            VideoEdit.Media.Text.OverlayRasterPlanner.Collect(doc).Select(i => i.ClipId).Order());
        Assert.Equal(2, plan.RasterClips.Count); // görünür metin + görünür şekil
    }

    [Fact]
    public void Compile_RasterClipWithoutARaster_ThrowsArgumentException()
    {
        // Worker sözleşmesi: plan.RasterClips'teki her klip için raster ÜRETİLMİŞ olmalıdır.
        var (doc, sources) = Fixture("text-over-video");
        var ex = Assert.Throws<ArgumentException>(
            () => ExportCompiler.Compile(doc, sources, ExportProfile.Hd1080p));
        Assert.Contains("no raster provided", ex.Message);
    }

    [Fact]
    public void Validate_KeyframesAndEffectsOnOverlayClips_AreSupported()
    {
        // M5: keyframe ve efektler overlay kliplerinde de derlenir (metin/şekil rasteri normal
        // katman zincirinden geçer). Ölçek kutusunun tabanı rasterin KENDİ bbox'ıdır (§7) —
        // animasyonlu ölçekte de öyle olmalı, tuval DEĞİL.
        var text = ExportTestDocs.TextClip(0, 1_000_000);
        text.Keyframes = new KeyframeTracks
        {
            Opacity = [ExportTestDocs.Kf(0, 0), ExportTestDocs.Kf(500_000, 1)],
            Scale = [ExportTestDocs.Kf(0, 1), ExportTestDocs.Kf(1_000_000, 2)],
        };
        text.Effects = [ExportTestDocs.ColorAdjust(saturation: -1)];
        var doc = ExportTestDocs.MultiTrackDoc([ExportTestDocs.OverlayTrack(clips: [text])]);
        var textId = ((TextClip)doc.Tracks[0].Clips[0]).Id;

        var compiled = ExportCompiler.Compile(
            doc, SdrSources(), ExportProfile.Hd1080p,
            new Dictionary<Guid, ExportRasterSource>
            {
                [textId] = new("rasters/text.png", TextBboxWidth, TextBboxHeight),
            });

        // Ölçek ifadesi bbox tabanlıdır (640x160), tuval (1920x1080) DEĞİL.
        Assert.Contains("scale=w='if(lt(t,0.000000),640,", compiled.FilterGraphScript);
        Assert.Contains(":h='if(lt(t,0.000000),160,", compiled.FilterGraphScript);
        // 0→1 lineer opaklık fade'e map'lenir (sendcmd'e gerek yok).
        Assert.Contains("fade=t=in:st=0.000000:d=0.500000:alpha=1", compiled.FilterGraphScript);
        // saturation = -1 tam gri (colorchannelmixer BT.709 matrisi).
        Assert.Contains("colorchannelmixer=rr=0.2126:", compiled.FilterGraphScript);
    }

    [Fact]
    public void Validate_KeyframesOnAudioClip_Throw()
    {
        // Ses klibi görsel katman üretmez → transform/opaklık animasyonunun karşılığı yoktur.
        var clip = ExportTestDocs.AudioClip(ExportTestDocs.AssetC, 0, 0, 1_000_000);
        clip.Keyframes = new KeyframeTracks { Opacity = [ExportTestDocs.Kf(0, 1)] };
        var doc = ExportTestDocs.MultiTrackDoc([ExportTestDocs.AudioTrack(clips: [clip])]);

        Assert.Equal("keyframes-audio-clip",
            Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc)).Feature);
    }

    [Fact]
    public void Validate_KeyframesWithTransition_Throw()
    {
        // Geçişte iki klip TEK akışa katlanır → run bölünemez, katman yerleşimi kesim boyunca
        // sabit olmalıdır (xfade "iki giriş aynı boyutta" da şart koşar).
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000);
        b.Keyframes = new KeyframeTracks
        {
            X = [ExportTestDocs.Kf(0, 0), ExportTestDocs.Kf(1_000_000, 0.25)],
        };
        ExportTestDocs.Link(a, b, 400_000);

        Assert.Equal("transition-keyframes",
            Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(
                ExportTestDocs.Doc(clips: [a, b]))).Feature);
    }

    [Fact]
    public void Validate_UnsortedKeyframes_Throw()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000);
        clip.Keyframes = new KeyframeTracks
        {
            X = [ExportTestDocs.Kf(500_000, 0), ExportTestDocs.Kf(500_000, 0.25)],
        };

        Assert.Contains("ARTAN",
            Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(
                ExportTestDocs.Doc(clips: clip))).Message);
    }

    [Fact]
    public void Validate_AnimatedScale_ValidatesTheCeilingFromTheLARGESTKeyframe()
    {
        // Bellek tavanı ARA TUVALDEN doğrulanır (denetim #2) ve animasyonlu ölçekte ara tuval
        // EN BÜYÜK karede en büyüktür. Taban ölçek küçük olsa bile tavan aşılabilir.
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5));
        clip.Keyframes = new KeyframeTracks
        {
            Scale = [ExportTestDocs.Kf(0, 0.5), ExportTestDocs.Kf(2_000_000, 6)],
        };

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(
            ExportTestDocs.Doc(clips: clip)));
        Assert.Equal("transform-scale", ex.Feature);
    }

    [Fact]
    public void Compile_LinearPositionKeyframes_UseAnIfChainExpression_NotSendcmd()
    {
        // tasarım 04 §2.5 ucuz yol: TAMAMI LİNEER kanal piecewise-linear ifadeye derlenir —
        // kare başına komut yok. İfade KOMPOZİT eksendedir (overlay'in t'si tuval karesidir),
        // bu yüzden keyframe zamanlarına klibin timeline başlangıcı EKLENİR.
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 1_000_000, 0, 2_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5));
        clip.Keyframes = new KeyframeTracks
        {
            X = [ExportTestDocs.Kf(0, -0.25), ExportTestDocs.Kf(1_000_000, 0.25)],
        };
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips: [clip]),
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 3_000_000)]),
        ]);
        var compiled = ExportCompiler.Compile(doc, SdrSources(hasAudio: false), ExportProfile.Hd1080p);

        // P.x = W/2 + x*W → -0.25 ⇒ 480, +0.25 ⇒ 1440. Zaman ekseni 1.0 → 2.0 sn.
        Assert.Contains(
            "x='floor(if(lt(t,1.000000),480,if(lt(t,2.000000),480+(1440-480)*(t-1.000000)"
            + "/(2.000000-1.000000),1440))-0.5*w)'",
            compiled.FilterGraphScript);
        Assert.DoesNotContain("sendcmd", compiled.FilterGraphScript);
    }

    [Fact]
    public void Compile_EasedPositionKeyframes_UseAFrameSampledDecisionTree_NotSendcmd()
    {
        // §3.4: eğrili easing kapalı forma GÖMÜLMEZ, FRAME BAŞINA örneklenir. Örnekler
        // sendcmd yerine DENGELİ İKİLİ KARAR AĞACI ifadesine gömülür — sendcmd overlay'i
        // güvenilir süremez (overlay iki girişlidir ve framesync ile tamponlar; ölçüm
        // KeyframeCompiler.StepExpression yorumunda).
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5));
        clip.Keyframes = new KeyframeTracks
        {
            X = [ExportTestDocs.Kf(0, -0.25, ExportTestDocs.EaseInOut()), ExportTestDocs.Kf(1_000_000, 0.25)],
        };
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips: [clip]),
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000)]),
        ]);
        var compiled = ExportCompiler.Compile(doc, SdrSources(hasAudio: false), ExportProfile.Hd1080p);

        Assert.DoesNotContain("sendcmd", compiled.FilterGraphScript);
        Assert.Contains("overlay=x='floor(if(lt(t,", compiled.FilterGraphScript);
        Assert.EndsWith("-0.5*w)'", OverlayXArgument(compiled.FilterGraphScript), StringComparison.Ordinal);

        // Örneklenen HER kare için bir yaprak vardır ve yaprak değeri §3.2'nin C# referansıyla
        // (32 iterasyon bisection) BİREBİR aynı olmalıdır — preview ile aynı fonksiyon ailesi.
        for (var frame = 0; frame < 30; frame++)
        {
            var timeUs = Timecode.FromFrameNumber(frame, 30, 1).Micros;
            var value = MediaEasing.SampleKeyframes(
            [
                new MediaKeyframe(0, -0.25, EasingValue.EaseInOut),
                new MediaKeyframe(1_000_000, 0.25, EasingValue.Linear),
            ], timeUs);
            var literal = (960 + (value * 1920)).ToString("0.######", CultureInfo.InvariantCulture);
            Assert.Contains(literal, compiled.FilterGraphScript);
        }

        // Karar ağacı DENGELİDİR: 30 yaprak için derinlik 5 civarıdır, 30 DEĞİL (iç içe 30 'if'
        // ffmpeg'in özyinelemeli ifade ayrıştırıcısını uzun kliplerde taşırırdı).
        Assert.InRange(MaxIfNesting(OverlayXArgument(compiled.FilterGraphScript)), 1, 8);
    }

    /// <summary>Script'teki ilk <c>overlay=x=…</c> argümanını (tırnaklı ifade) döndürür.</summary>
    private static string OverlayXArgument(string script)
    {
        var start = script.IndexOf("overlay=x='", StringComparison.Ordinal) + "overlay=x=".Length;
        var end = script.IndexOf("':y=", start, StringComparison.Ordinal) + 1;
        return script[start..end];
    }

    /// <summary>İfadedeki en derin parantez seviyesindeki 'if(' sayısı (ağaç derinliği).</summary>
    private static int MaxIfNesting(string expression)
    {
        var depth = 0;
        var max = 0;
        for (var i = 0; i < expression.Length; i++)
        {
            if (expression[i] == 'i' && i + 2 < expression.Length
                && expression[i + 1] == 'f' && expression[i + 2] == '(')
            {
                depth++;
                max = Math.Max(max, depth);
            }
            else if (expression[i] == ')')
            {
                depth = Math.Max(0, depth - 1);
            }
        }

        return max;
    }

    [Fact]
    public void Compile_ArbitraryOpacityCurve_UsesSendcmdColorchannelmixer()
    {
        // tasarım 04 §2.5 madde 2: 0→1 / 1→0 DIŞINDAKİ her opaklık eğrisi sendcmd ile
        // colorchannelmixer aa'ya yazılır (filtre zaman ifadesi ALMAZ).
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 0.5));
        clip.Keyframes = new KeyframeTracks
        {
            Opacity = [ExportTestDocs.Kf(0, 0.2), ExportTestDocs.Kf(1_000_000, 0.8)],
        };
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips: [clip]),
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 2_000_000)]),
        ]);
        var compiled = ExportCompiler.Compile(doc, SdrSources(hasAudio: false), ExportProfile.Hd1080p);

        Assert.Contains("colorchannelmixer@k1=aa=0.2", compiled.FilterGraphScript);
        Assert.Contains("0.000000 colorchannelmixer@k1 aa 0.2;", compiled.FilterGraphScript);
        Assert.DoesNotContain("fade=t=", compiled.FilterGraphScript);
        // KATMAN sendcmd'i klip-göreli t ister → zincirin başında setpts sıfırlaması olmalı.
        Assert.Contains("trim=end_frame=30,setpts=PTS-STARTPTS,", compiled.FilterGraphScript);
        // sendcmd hedefinin HEMEN ÖNÜNDEDİR: aralarına iki girişli bir filtre girerse komut
        // framesync tamponu yüzünden yanlış kareye düşer (M5 ölçümü).
        Assert.Contains("',colorchannelmixer@k1=aa=", compiled.FilterGraphScript);
    }

    [Fact]
    public void Validate_ExcessivelyLongEasedAnimation_HitsTheSampleBudget()
    {
        // §3.4 örneklemesi klip uzunluğuyla DOĞRUSAL büyür. Tavan aşıldığında graph okunamaz
        // hale gelir (worker onu loglar) — sessiz kırpma yerine tipli hata, ve mesaj İŞE
        // YARAYAN eylemi (easing'i lineere çevirmek) söyler.
        //
        // KURAL YERİ DEĞİŞTİ (İŞ 1): kural artık Validate'te de yaşar — hesap saf doküman
        // aritmetiğidir. Compile'daki sigorta AYNI cümleyi üretir.
        const long durationUs = 2_100_000_000; // 2100 sn @30fps = 63_000 kare
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, durationUs,
            transform: ExportTestDocs.Transform(scale: 0.5));
        clip.Keyframes = new KeyframeTracks
        {
            X = [ExportTestDocs.Kf(0, -0.25, ExportTestDocs.EaseInOut()),
                 ExportTestDocs.Kf(durationUs, 0.25)],
        };
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips: [clip]),
            ExportTestDocs.VideoTrack(clips:
                [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, durationUs)]),
        ]);

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("keyframe-sample-budget", ex.Feature);
        Assert.Contains("LİNEER yapın", ex.Message);
        // TEK klip bütçeyi tek başına aşıyor → mesaj "önceki klipler tüketti" DEMEMELİ.
        Assert.Contains("tek başına", ex.Message);
        Assert.DoesNotContain("ÖNCEKİ", ex.Message);

        var compiled = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Compile(doc, SdrSources(hasAudio: false), ExportProfile.Hd1080p));
        Assert.Equal(ex.Message, compiled.Message);
    }

    [Fact]
    public void Validate_SharedSampleBudget_BlamesTheSharingNotTheClip_AndLinearEasingFixesIt()
    {
        // ÖLÇÜLEN MESAJ KUSURU: bütçe TÜM klipler arasında PAYLAŞILIR, ama aşımı bildiren
        // mesaj yalnız son klibi ve onun (60 000 yanında hiç olan) kendi örnek sayısını
        // söylüyordu — kullanıcı suçlanan klibi kısaltarak sorunu ÇÖZEMEZDİ.
        //
        // Aşağıdaki belgede hiçbir klip tek başına bütçeyi aşmaz; toplamları aşar.
        // (60 sn @30fps = 1800 kare; 'scale' kanalı ScaleWidth + ScaleHeight olarak İKİ KEZ
        // örneklenir → klip başına ~3600 örnek. 17 klip ≈ 61 200 > 60 000.)
        var doc = ExportTestDocs.CurvedScaleDoc(clipCount: 17);

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("keyframe-sample-budget", ex.Feature);
        Assert.Contains("ORTAK örnekleme bütçesini aşıyor", ex.Message);
        Assert.Contains("ÖNCEKİ", ex.Message);      // kaç klip harcadı
        Assert.Contains("TÜM kliplere", ex.Message); // bütçe klibe ait DEĞİL
        Assert.Contains("LİNEER yapın", ex.Message);

        // ÖNERİLEN EYLEMİN GERÇEKTEN İŞE YARADIĞININ KANITI: aynı belgede yalnız easing
        // lineere çevrilir (klip sayısı, süre, keyframe sayısı AYNI) → kabul edilir, çünkü
        // lineer kanal kapalı forma derlenir ve bütçeden hiç harcamaz.
        var linear = ExportTestDocs.LinearScaleDoc(clipCount: 17);
        Assert.NotNull(ExportCompiler.Validate(linear));
        Assert.NotNull(ExportCompiler.Compile(
            linear, SdrSources(hasAudio: false), ExportProfile.Hd1080p));
    }


    [Fact]
    public void Compile_KeyframedClip_GetsItsOwnRun_AndDisablesTheFastPath()
    {
        // Animasyonlu klip komşularıyla concat edilemez (overlay ifadesi run başına tektir) ve
        // tek katmanlı hızlı yolu da kapatır (yerleşim kare kare değişiyor).
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 1_000_000, 1_000_000, 2_000_000);
        b.Keyframes = new KeyframeTracks
        {
            X = [ExportTestDocs.Kf(0, 0), ExportTestDocs.Kf(1_000_000, 0.25)],
        };
        var compiled = ExportCompiler.Compile(
            ExportTestDocs.Doc(clips: [a, b]), SdrSources(hasAudio: false), ExportProfile.Hd1080p);

        Assert.DoesNotContain("concat=", compiled.FilterGraphScript);
        Assert.Contains("color=c=0x000000:s=1920x1080", compiled.FilterGraphScript); // taban tuval
        Assert.Equal(2, compiled.FilterGraphScript.Split(";\n").Count(l => l.Contains("]overlay")));
    }


    [Fact]
    public void Compile_OversizedTextRaster_ThrowsTypedFeatureError()
    {
        // Metin kutusu RASTER boyutundan türer. Tavan artık Validate'te DE var (bkz. aşağıdaki
        // "Raster katman tavanı" bloğu), ama Compile'daki kapı KALDIRILMADI: burada bbox her
        // zaman GERÇEKTİR, yani Validate'in alt-sınır yolunun göremediği vaka burada durur.
        var doc = ExportTestDocs.MultiTrackDoc(
            [ExportTestDocs.OverlayTrack(clips: [ExportTestDocs.TextClip(0, 1_000_000)])]);
        var textId = ((TextClip)doc.Tracks[0].Clips[0]).Id;
        var rasters = new Dictionary<Guid, ExportRasterSource>
        {
            [textId] = new("rasters/huge.png", 9000, 400),
        };

        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Compile(doc, SdrSources(), ExportProfile.Hd1080p, rasters));
        Assert.Equal("transform-scale", ex.Feature);
        Assert.Contains("metin", ex.Message);
    }

    // ---------- Görsel (still image) klipler ----------

    [Fact]
    public void Compile_ImageClip_UsesLoopedInput_WithoutSeek()
    {
        // Denetim bulgusu: ürün kullanıcıyı görsel yüklemeye AKTİF olarak yönlendiriyordu
        // (fileTypes.ts PNG/JPG/WebP diyor, worker işliyor, timeline'a eklenebiliyor) ama
        // compiler 422 atıyordu — kullanıcı emeğini kaybediyordu. Sözleşme: -loop 1 -t <süre>,
        // SEEK YOK (tek karelik girişte -ss kareyi kaçırır — PosterRecipe ile aynı gerekçe).
        var compiled = ExportCompiler.Compile(ImageClip(), ImageSources(), ExportProfile.Hd1080p);

        var input = Assert.Single(compiled.Inputs);
        Assert.True(input.Loop);
        // -t bir frame CÖMERT (4 sn + 1 frame): görsel demuxer'ının kendi fps'i proje fps'inden
        // farklı olabilir; kesin kare sayısını zincirdeki trim=end_frame sabitler.
        Assert.Equal(["-loop", "1", "-t", "4.033333", "-i", "assets/photo.png"], input.ToArgs());
        Assert.DoesNotContain("-ss", compiled.ToFfmpegArgs("graph.txt", "out.mp4"));
        Assert.Contains("fps=30/1,trim=end_frame=120,", compiled.FilterGraphScript);

        // Görsel ses üretmez → miks yok, toplam süre kadar sessizlik.
        Assert.Contains("anullsrc=channel_layout=stereo:sample_rate=48000", compiled.FilterGraphScript);
        Assert.DoesNotContain("[0:a]", compiled.FilterGraphScript);
        Assert.Equal(4_000_000, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Validate_ImageClip_IsExcludedFromTheSourceRangeLedger()
    {
        // Görsel klibin sourceIn/sourceOut'u dosyada bir zaman aralığına KARŞILIK GELMEZ
        // (editör 4 sn'lik sentetik aralık üretir). Worker'ın kaynak-aralığı kapısı bu klibi
        // görürse, süresi ~0 olan PNG için "reads source range beyond asset duration" der ve
        // TÜM export'u düşürürdü — plan.Clips bu yüzden görselleri dışarıda bırakır.
        var plan = ExportCompiler.Validate(ImageOverVideo());

        Assert.Equal(2, plan.AssetIds.Count);                    // görsel yine de İNDİRİLİR
        Assert.Contains(ExportTestDocs.AssetC, plan.AssetIds);
        var ranged = Assert.Single(plan.Clips);                  // ama aralık defterinde YOK
        Assert.Equal(MediaClipKind.Video, ranged.Kind);

        // Kapı, görsel asset'in ölçülen süresiyle (tek kare ≈ 40 ms) tetiklenMEZ.
        Assert.Null(VideoEdit.Worker.Jobs.ExportJob.FindSourceOutOfRange(
            plan.Clips, ExportTestDocs.AssetC, probeDurationUs: 40_000, plan.FpsNum, plan.FpsDen));
    }

    [Fact]
    public void Compile_ImageLayerOverVideo_ComposesLikeAnyOtherLayer()
    {
        var compiled = ExportCompiler.Compile(ImageOverVideo(), ImageSources(), ExportProfile.Hd1080p);

        // Alt katman video (giriş 0), üst katman görsel (giriş 1 — loop'lu).
        Assert.False(compiled.Inputs[0].Loop);
        Assert.True(compiled.Inputs[1].Loop);
        Assert.Contains("[base][v0]overlay=", compiled.FilterGraphScript);
        Assert.Contains("[c0][v1]overlay=", compiled.FilterGraphScript);
        // Görsel katman da diğerleriyle aynı geometri/opaklık zincirinden geçer.
        Assert.Contains("scale=672:378:", compiled.FilterGraphScript);
        Assert.Contains("colorchannelmixer=aa=0.8", compiled.FilterGraphScript);
        Assert.Contains("enable='between(t,1.000000,2.983334)'", compiled.FilterGraphScript);
        // Ses yalnız video klibinden gelir (görselde ses yok).
        Assert.Contains("amix=inputs=1:", compiled.FilterGraphScript);
        Assert.DoesNotContain("[1:a]", compiled.FilterGraphScript);
    }

    [Fact]
    public void Validate_NonPositiveScale_ThrowsInvalidTimeline()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 0));
        Assert.Throws<InvalidTimelineException>(
            () => ExportCompiler.Validate(ExportTestDocs.Doc(clips: clip)));
    }

    [Fact]
    public void Validate_ScaleBeyondLayerLimit_Throws()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 25)); // 1920*25 = 48000 px
        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(ExportTestDocs.Doc(clips: clip)));
        Assert.Equal("transform-scale", ex.Feature);
    }

    [Fact]
    public void Validate_RotationAndAnchorPadBlowUpTheIntermediateCanvas_Throws()
    {
        // Denetim #2 (HIGH): tavan YALNIZ scale kutusuna uygulanınca çapa pad'i (2x) ve
        // rotate hypot'u (~1.41x) tavanın üstüne çıkıyordu. Gerçek ffmpeg ölçümü (verbose):
        //   scale 2 + çapa(0,0) + 30° → kutu 3840x2160 (tavanın ALTINDA) ama
        //   'overlay w:8812 h:8812 fmt:rgba' = 310 MB/KARE ara tuval → worker OOM.
        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 2, rotationDeg: 30, anchorX: 0, anchorY: 0)));

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("transform-scale", ex.Feature);
        Assert.Contains("8812x8812", ex.Message);       // reddedilen ara tuval kullanıcıya söylenir
        Assert.Contains("3840x2160", ex.Message);       // kutu da görünür ("ölçek küçük ama neden?")

        // AYNI ölçek, dönme YOK → ara tuval kutunun kendisidir (3840x2160) ve kabul edilir.
        var noRotation = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 2, anchorX: 0, anchorY: 0)));
        var plan = ExportCompiler.Validate(noRotation);
        Assert.Single(plan.Clips);
    }

    [Fact]
    public void Validate_RotationWithCenterAnchor_UsesDiagonalCeiling()
    {
        // Merkez çapada pad yoktur ama rotate yine köşegen kadar tuval açar:
        // scale 3.9 → kutu 7488x4212 (tavanın ALTINDA), Dg = ceil(hypot) = 8592 → REDDEDİLİR.
        var rotated = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 3.9, rotationDeg: 12)));
        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(rotated));
        Assert.Contains("8592x8592", ex.Message);

        // Aynı katman dönmeden geçer (7488x4212 ≤ 8192).
        var flat = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 3.9)));
        Assert.Single(ExportCompiler.Validate(flat).Clips);
    }

    [Fact]
    public void Validate_AbsurdScale_CannotOverflowPastTheCeiling()
    {
        // Tavan karşılaştırması long üstünde yapılır; aşırı ölçekte double→long dönüşümü taşar.
        // .NET Core 3.0'dan beri bu dönüşüm SPEC GEREĞİ doyurur (long.MaxValue) — test bu
        // varsayımı sabitler: runtime davranışı değişirse tavan sessizce atlanmasın.
        foreach (var scale in new[] { 1e16, 1e30, double.MaxValue })
        {
            var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
                ExportTestDocs.AssetA, 0, 0, 1_000_000,
                transform: ExportTestDocs.Transform(scale: scale)));
            var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
            Assert.Equal("transform-scale", ex.Feature);
        }
    }

    // ---------- Raster (metin/şekil) katman tavanı ----------
    //
    // KÖK NEDEN: tavan+taban kuralı raster klipleri için YALNIZ Compile'da
    // (PlacementOf) koşuyordu; ValidateGeometry raster dalında erken dönüyordu. API'nin 422
    // ön kapısı yalnız Validate'i çağırdığı için kural GÖRÜNMÜYORDU: iş kuyruğa giriyor ve
    // dakikalar sonra worker'da düşüyordu (canlı ölçümle doğrulandı).
    // Aşağıdaki testler TAVANIN Validate'te olduğunu ve gevşemediğini sabitler; TABAN
    // (EnsureLayerFloor) ayrı bir bölümde, ölçek animasyonuyla birlikte sınanır.

    /// <summary>Sabit bbox döndüren ölçer — kurulu font olmadan ÖLÇÜMLÜ yolu sürer.</summary>
    private sealed class StubMeasurer(double widthPx, double heightPx) : ITextRasterService
    {
        public Task<RasterResult> RenderAsync(
            Clip clip, ProjectSettings settings, string outputPath, CancellationToken ct = default) =>
            throw new InvalidOperationException("Validate raster ÜRETMEZ, yalnız ölçer.");

        public TextLayout Measure(TextClipText text, ProjectSettings settings) =>
            new([], text.FontSizePx * text.LineHeight, widthPx, heightPx,
                0, 0, widthPx, heightPx, false);
    }

    private static TimelineDoc TextDoc(TextClip clip) =>
        ExportTestDocs.MultiTrackDoc([ExportTestDocs.OverlayTrack(clips: [clip])]);

    [Fact]
    public void Validate_HugeTextLayer_IsRejectedWithoutAnyFontInstalled()
    {
        // Baş mimarın CANLI ölçümü: fontSizePx 2000 + uzun tek satır + scale 4 → 202 + worker
        // çöküşü. Alt sınır (fonttan BAĞIMSIZ) 2000*1.2*1 = 2400 px; ×4 = 9600 > 8192 → 422.
        var clip = ExportTestDocs.TextClip(0, 1_000_000,
            content: new string('A', 400), transform: ExportTestDocs.Transform(scale: 4));
        clip.Text!.FontSizePx = 2000;

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(TextDoc(clip)));
        Assert.Equal("transform-scale", ex.Feature);
        Assert.Contains("metin", ex.Message);
        Assert.Contains("8192", ex.Message);
    }

    [Fact]
    public void Validate_TextLayerLowerBound_CountsLinesAndBackgroundPadding()
    {
        // Alt sınırın iki bileşeni de gerçektir: satır SAYISI (içerik yüksekliği) ve arka plan
        // payı (kutu her yönde büyür). 400*1.2*8 = 3840; +2*160 = 4160; ×2 = 8320 > 8192.
        var clip = ExportTestDocs.TextClip(0, 1_000_000,
            content: string.Join('\n', Enumerable.Repeat("satır", 8)),
            transform: ExportTestDocs.Transform(scale: 2));
        clip.Text!.FontSizePx = 400;
        clip.Text.Background = new Background { Color = "#000000", PaddingPx = 160, RadiusPx = 0 };

        Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(TextDoc(clip)));

        // NEGATİF KONTROL: arka planı kaldır → 3840*2 = 7680 ≤ 8192 → kabul edilir.
        // (Yani ret payın KENDİSİNDEN geliyor, "büyük metin" genellemesinden değil.)
        clip.Text.Background = null;
        Assert.Single(ExportCompiler.Validate(TextDoc(clip)).RasterClips);
    }

    [Fact]
    public void Validate_MeasuredTextBox_CatchesWidthOverflowTheLowerBoundCannotSee()
    {
        // Genişliğin font-BAĞIMSIZ alt sınırı YOKTUR (glif ilerlemesi fonta bağlıdır), yani
        // "küçük punto + çok uzun tek satır" ancak ÖLÇÜMLE yakalanır. İki koşum, tek fark ölçer.
        var clip = ExportTestDocs.TextClip(0, 1_000_000, content: new string('W', 3000));
        clip.Text!.FontSizePx = 100;

        Assert.Single(ExportCompiler.Validate(TextDoc(clip)).RasterClips);          // ölçer yok → görünmez
        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(TextDoc(clip), new StubMeasurer(165_000, 120)));
        Assert.Equal("overlay-too-large", ex.Feature);   // bbox tek başına raster tavanını aşıyor

        // Ölçüm KABUL de edebilmeli: aynı yol, sığan bir kutuyla 422 ÜRETMEZ.
        Assert.Single(ExportCompiler.Validate(TextDoc(clip), new StubMeasurer(1200, 120)).RasterClips);
    }

    [Fact]
    public void Validate_MeasuredTextBox_AppliesTheScaleCeilingToo()
    {
        // Ölçülen kutu raster tavanının ALTINDA (4000 ≤ 8192) ama ölçekle katman tavanını
        // aşıyor: 4000 × 3 = 12000 → "transform-scale".
        var clip = ExportTestDocs.TextClip(0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 3));

        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(TextDoc(clip), new StubMeasurer(4000, 500)));
        Assert.Equal("transform-scale", ex.Feature);
        Assert.Contains("12000x1500", ex.Message);
    }

    [Fact]
    public void Validate_MeasurementFailure_FallsBackToTheLowerBound_NeverToAFalse422()
    {
        // ALTYAPI arızası (küratörlü TTF indirilmemiş): kullanıcının belgesini geçersiz
        // YAPMAZ — alt sınıra düşülür, belge kabul edilir ve klip "ölçülemedi" defterine
        // yazılır (HTTP katmanı oradan 503 üretir).
        var plan = ExportCompiler.Validate(
            TextDoc(ExportTestDocs.TextClip(0, 1_000_000)), new FontsNotInstalledMeasurer());
        Assert.Single(plan.RasterClips);
        Assert.Single(plan.UnmeasuredTextClipIds);
    }

    [Fact]
    public void Validate_MeasurerDoesNotKnowTheFontId_IsADocumentFault_NotAnOutage()
    {
        // AYNI METODUN ZIT YARISI. İki fabrika farklı OLGU taşır ve ayrımın tek işareti
        // ExpectedPath'tir: FileMissing yol taşır (kurulum), UnknownId taşımaz (belge).
        // Ayrım yapılmazsa bilinmeyen bir fontId "sunucu şu an ölçemiyor, yeniden deneyin"
        // (503) diye raporlanır — ama o istek hiçbir kurulumda çalışmaz.
        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(
            TextDoc(ExportTestDocs.TextClip(0, 1_000_000)), new UnknownFontIdMeasurer()));

        Assert.Equal("font-missing", ex.Feature);
    }

    /// <summary>KURULUM arızası: id manifestte tanımlı, TTF diskte yok.</summary>
    private sealed class FontsNotInstalledMeasurer : ITextRasterService
    {
        public Task<RasterResult> RenderAsync(
            Clip clip, ProjectSettings settings, string outputPath, CancellationToken ct = default) =>
            throw new InvalidOperationException("Validate raster ÜRETMEZ, yalnız ölçer.");

        public TextLayout Measure(TextClipText text, ProjectSettings settings) =>
            throw FontNotFoundException.FileMissing("roboto", "400", "/fonts/roboto/Regular.ttf");
    }

    /// <summary>BELGE hatası: manifestte böyle bir fontId yok (yol YOK).</summary>
    private sealed class UnknownFontIdMeasurer : ITextRasterService
    {
        public Task<RasterResult> RenderAsync(
            Clip clip, ProjectSettings settings, string outputPath, CancellationToken ct = default) =>
            throw new InvalidOperationException("Validate raster ÜRETMEZ, yalnız ölçer.");

        public TextLayout Measure(TextClipText text, ProjectSettings settings) =>
            throw FontNotFoundException.UnknownId(text.FontId, "(test)", []);
    }

    [Fact]
    public void Validate_TextWithoutUsableMetrics_ThrowsInvalidTimeline()
    {
        // Raster hattının kendi kapısı (SkiaOverlayRasterService.RenderText: "geçersiz ölçü")
        // de Compile-öncesiydi → iş kuyruğa giriyordu. Aynı kural Validate'te.
        // (NaN/∞ denenmez: TimelineDoc JSON'dan gelir ve System.Text.Json onları YAZAMAZ —
        //  double.IsFinite kontrolü yine de durur, çünkü kural doküman kaynağından bağımsızdır.)
        foreach (var (size, lineHeight) in new[] { (0d, 1.2d), (64d, 0d), (-1d, 1.2d) })
        {
            var clip = ExportTestDocs.TextClip(0, 1_000_000);
            clip.Text!.FontSizePx = size;
            clip.Text.LineHeight = lineHeight;
            Assert.Throws<InvalidTimelineException>(() => ExportCompiler.Validate(TextDoc(clip)));
        }
    }

    [Fact]
    public void Validate_ShapeLayer_MeasuresTheProjectFrameAsItsBox()
    {
        // Şeklin doğal kutusu SÖZLEŞME GEREĞİ proje karesidir (ShapeGeometry) — ölçüm gerekmez,
        // tavan KESİN hesaplanır: 1920 × 5 = 9600 > 8192 → 422 (worker'da düşmez).
        var doc = ExportTestDocs.MultiTrackDoc([ExportTestDocs.OverlayTrack(clips:
            [ExportTestDocs.ShapeClip(0, 1_000_000, transform: ExportTestDocs.Transform(scale: 5))])]);
        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("transform-scale", ex.Feature);
        Assert.Contains("şekil", ex.Message);

        // NEGATİF KONTROL: 1920 × 4 = 7680 ≤ 8192 → aynı klip kabul edilir.
        var fits = ExportTestDocs.MultiTrackDoc([ExportTestDocs.OverlayTrack(clips:
            [ExportTestDocs.ShapeClip(0, 1_000_000, transform: ExportTestDocs.Transform(scale: 4))])]);
        Assert.Single(ExportCompiler.Validate(fits).RasterClips);
    }

    [Fact]
    public void Validate_ShapeLayerBelowTheScaleFloor_IsRejectedAsADegenerateLayer()
    {
        // Kutu KESİN olduğunda TABAN kuralı da Validate'te işler. Hata sınıfı 'degenerate-layer':
        // kutu < 2 dejenereliğin KAYNAKTAN BAĞIMSIZ yarısıdır (force_divisible_by=2 onu 0'a
        // indirir), yani ayrı bir arıza değil aynı arızanın ölçülebilen yarısıdır.
        var doc = ExportTestDocs.MultiTrackDoc([ExportTestDocs.OverlayTrack(clips:
            [ExportTestDocs.ShapeClip(0, 1_000_000, transform: ExportTestDocs.Transform(scale: 0.0005))])]);
        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Validate(doc));
        Assert.Equal("degenerate-layer", ex.Feature);
        Assert.Contains("en az 0.002", ex.Message);   // EYLEM: (2-0.5)/1080 = 0.00139 → 0.002

        // NEGATİF KONTROL: önerilen sayı GERÇEKTEN kabul edilir (mesaj yalan söylememeli).
        var fits = ExportTestDocs.MultiTrackDoc([ExportTestDocs.OverlayTrack(clips:
            [ExportTestDocs.ShapeClip(0, 1_000_000, transform: ExportTestDocs.Transform(scale: 0.002))])]);
        Assert.Single(ExportCompiler.Validate(fits).RasterClips);
    }

    // ── Ölçek animasyonu: TAVAN en büyük keyframe'den, TABAN en küçüğünden (canlı ölçülen blocker) ──
    //
    // ADLANDIRMA: buradaki "taban" KEYFRAME MİNİMUMUDUR, örneklenen eğrinin
    // minimumu değil — kapı AnimationTrack.MinValue okur (bkz. ExportCompiler.MinScaleOf'un
    // KAPSAM NOTU: undershoot'lu serbest bir cubicBezier ara değerleri bu tabanın altına
    // indirebilir; editör böyle bir eğri yazamaz, ham API'den yazılan belgede kapı Compile'da
    // gerçek boyutla yeniden koşar).
    //
    // ÖLÇÜLEN HATA: yerleşim (dolayısıyla tavan) PlacementTransform ile ölçeğin MAKSİMUMUNDAN
    // kuruluyordu; kutu ≥ 2 kuralı da o yerleşimden soruluyordu. Yani en küçük keyframe hiçbir
    // kapıya görünmüyordu ve raster klibinde ValidateGeometry zaten erken dönüyordu. Canlı
    // ölçüm (gerçek fare): metin ekle → ölçek keyframe'i → tabanı 0.010 yap → POST /exports
    // 202, iş worker'da 'degenerate-layer' ile öldü. İkinci varyant daha kötüydü: bbox 6x20 →
    // kutu 0x0 → filtergraph'a alt-piksel hedef yazıldı ve ffmpeg 99 kare yazdıktan SONRA
    // 'Picture size 0x4 is invalid' ile öldü (exit -12).

    /// <summary>Ölçek kanalı animasyonlu bir metin klibi (taban = son keyframe).</summary>
    private static TextClip AnimatedScaleTextClip(
        double staticScale, double floorScale, string content = "MERHABA")
    {
        var clip = ExportTestDocs.TextClip(0, 1_000_000, content: content,
            transform: ExportTestDocs.Transform(scale: staticScale));
        clip.Keyframes = new KeyframeTracks
        {
            Scale = [ExportTestDocs.Kf(0, staticScale), ExportTestDocs.Kf(1_000_000, floorScale)],
        };
        return clip;
    }

    [Fact]
    public void Validate_TextLayerWhoseSmallestScaleKeyframeCollapsesTheBox_IsRejectedSynchronously()
    {
        // Canlı ölçümdeki VARYANT 1: ölçülen bbox 223x104 (PNG @2x = 446x208), taban 0.010 →
        // kutu 2x1. Statik ölçek 1.0 olduğu için TAVAN kuralı hiçbir şey görmez.
        var clip = AnimatedScaleTextClip(1.0, 0.010);
        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(TextDoc(clip), new StubMeasurer(223, 104)));

        Assert.Equal("degenerate-layer", ex.Feature);
        Assert.Contains("2x1", ex.Message);                       // hangi kutuya iniyor
        Assert.Contains("en küçük keyframe değeri 0.01", ex.Message); // NEREYE bakacağı
        Assert.Contains("en az 0.02", ex.Message);                // EYLEM: 2/104 = 0.01923 → 0.020
    }

    [Fact]
    public void Validate_TextLayerWhoseSmallestScaleKeyframeCollapsesTheBoxToZero_IsRejectedSynchronously()
    {
        // VARYANT 2 (daha kötü): bbox 6x20, taban 0.010 → kutu 0x0. Eski kapı burada
        // "bilinmiyor" diyip GEÇİRİYORDU (IsDegenerate kutu ≤ 0'da false dönüyordu) ve
        // filtergraph'a scale=w='...*0.06':h='...*0.2' yazılıyordu.
        var clip = AnimatedScaleTextClip(1.0, 0.010, content: ".");
        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(TextDoc(clip), new StubMeasurer(6, 20)));

        Assert.Equal("degenerate-layer", ex.Feature);
        Assert.Contains("0x0", ex.Message);
        Assert.Contains("en az 0.334", ex.Message);  // 2/6 = 0.3333 → 0.334 — genişlik bağlıyor
    }

    [Fact]
    public void Validate_TextLayerCeilingIsAskedAtTheLargestScaleKeyframe_NotTheSmallest()
    {
        // SİMETRİK YÖN: aynı klipte tavan MAKSİMUMDAN sorulmaya devam etmeli. Taban 0.5
        // (kutu 2000x100 — sığar), tavan 5.0 (kutu 20000x1000 — 8192'yi aşar).
        var clip = AnimatedScaleTextClip(0.5, 0.5);
        clip.Keyframes = new KeyframeTracks
        {
            Scale = [ExportTestDocs.Kf(0, 0.5), ExportTestDocs.Kf(1_000_000, 5.0)],
        };
        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(TextDoc(clip), new StubMeasurer(4000, 200)));
        Assert.Equal("transform-scale", ex.Feature);
        Assert.Contains("20000x1000", ex.Message);
    }

    [Fact]
    public void Validate_ScaleKeyframeFloorAboveTheThreshold_IsAccepted_AndTheSuggestedScaleWorks()
    {
        // YANLIŞ RET KONTROLÜ — sınırın İKİ yanı. bbox 223x104, animasyonlu (KIRPILAN) kutu:
        //   0.019 → floor(4.237)=4, floor(1.976)=1 → REDDEDİLİR,
        //   0.020 → floor(4.46)=4,  floor(2.08)=2  → KABUL EDİLİR.
        // Eşik 0.015 DEĞİLDİR: 0.015 statik yolun (roundHalfUp) eşiğidir ve animasyonlu yolda
        // ffmpeg'i öldürüyordu — gerçek fare E2E'sinin ölçtüğü şey tam olarak budur.
        Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(
                TextDoc(AnimatedScaleTextClip(1.0, 0.019)), new StubMeasurer(223, 104)));

        var plan = ExportCompiler.Validate(
            TextDoc(AnimatedScaleTextClip(1.0, 0.020)), new StubMeasurer(223, 104));
        Assert.Single(plan.RasterClips);

        // Aynı 0.015 STATİK olarak hâlâ kabul edilir: iki yol iki farklı kutu üretir ve kapı
        // ikisini KARIŞTIRMAMALIDIR (statikte kutu 3x2, animasyonluda 3x1).
        var stat = ExportTestDocs.TextClip(0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 0.015));
        Assert.Single(ExportCompiler.Validate(TextDoc(stat), new StubMeasurer(223, 104)).RasterClips);

        // Ve normal bir başlık animasyonu (1.0 → 0.5) hiçbir şekilde reddedilmemeli.
        Assert.Single(ExportCompiler.Validate(
            TextDoc(AnimatedScaleTextClip(1.0, 0.5)), new StubMeasurer(223, 104)).RasterClips);
    }

    [Fact]
    public void Validate_TextFloorGate_IsSkippedWhenTheBoxIsOnlyALowerBound()
    {
        // ÖLÇÜM YOKKEN kutu bir ALT SINIRDIR ve alt sınırdan TABAN sorulamaz: gerçek kutu daha
        // BÜYÜKTÜR, yani "alt sınır 2'nin altında" hiçbir şey kanıtlamaz. Aynı belge ölçümsüz
        // kabul edilir (yanlış 422 yok), ölçümle reddedilir — fark YALNIZ ölçerdir.
        Assert.Single(ExportCompiler.Validate(
            TextDoc(AnimatedScaleTextClip(1.0, 0.010))).RasterClips);
        Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(
                TextDoc(AnimatedScaleTextClip(1.0, 0.010)), new StubMeasurer(223, 104)));
    }

    [Fact]
    public void Compile_TextLayerWhoseSmallestScaleKeyframeCollapsesTheBox_NeverReachesFfmpeg()
    {
        // KUYRUK SONRASI ÖLÜMÜN İKİNCİ SAVUNMASI: ölçüm hattı kapalı bir kurulumda belge
        // Validate'i geçer, ama worker Compile'da GERÇEK PNG boyutunu bilir. Orada da tipli
        // hata çıkmalı — ffmpeg'in -12'si ya da sessiz yanlış geometri DEĞİL.
        var clip = AnimatedScaleTextClip(1.0, 0.010);
        var doc = TextDoc(clip);
        var rasters = new Dictionary<Guid, ExportRasterSource>
        {
            [clip.Id] = new("rasters/text.png", 223, 104, 446, 208),
        };

        var ex = Assert.Throws<UnsupportedFeatureException>(() => ExportCompiler.Compile(
            doc, SdrSources(hasAudio: false), ExportProfile.Hd1080p, rasters));
        Assert.Equal("degenerate-layer", ex.Feature);

        // NEGATİF KONTROL: aynı yolda tabanı eşiğin üstüne çek → derleme TAMAMLANIR ve
        // üretilen ifadenin TABAN DEĞERİ ffmpeg'in kırpmasından sonra ≥ 2 kalır.
        var ok = AnimatedScaleTextClip(1.0, 0.020);
        var script = ExportCompiler.Compile(
            TextDoc(ok), SdrSources(hasAudio: false), ExportProfile.Hd1080p,
            new Dictionary<Guid, ExportRasterSource>
            {
                [ok.Id] = new("rasters/text.png", 223, 104, 446, 208),
            }).FilterGraphScript;

        // İfadenin tabanı GERÇEKTEN filtergraph'ta: 223*0.020 = 4.46, 104*0.020 = 2.08.
        Assert.Contains("scale=w='", script);
        Assert.Contains("4.46", script);
        Assert.Contains("2.08", script);
        Assert.Equal((4L, 2L), LayerGeometry.ScaleBoxTruncated(223, 104, 0.020));
    }

    [Fact]
    public void Validate_MediaFloorGate_AsksTheSmallestScaleKeyframeEvenWithoutASourceLedger()
    {
        // Medya klibinde kaynak defteri OLMASA da kaynaktan bağımsız yarı sorulabilir:
        // 1920x1080 tuvalde taban 0.001 → kutu 2x1. Bu belge eskiden 202 alıyordu.
        var clip = ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 1.0));
        clip.Keyframes = new KeyframeTracks
        {
            Scale = [ExportTestDocs.Kf(0, 1.0), ExportTestDocs.Kf(1_000_000, 0.001)],
        };
        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(ExportTestDocs.Doc(clips: clip)));
        Assert.Equal("degenerate-layer", ex.Feature);
        Assert.Contains("1x1", ex.Message);   // floor(1.92)=1, floor(1.08)=1

        // NEGATİF KONTROL: editörün yazabildiği en küçük ölçek (0.010 → kutu 19x11) defter
        // yokken REDDEDİLMEZ — kaynaktan bağımsız yarı normal medyayı hiç kesmemeli.
        var editable = ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, 1_000_000,
            transform: ExportTestDocs.Transform(scale: 1.0));
        editable.Keyframes = new KeyframeTracks
        {
            Scale = [ExportTestDocs.Kf(0, 1.0), ExportTestDocs.Kf(1_000_000, 0.010)],
        };
        Assert.Single(ExportCompiler.Validate(ExportTestDocs.Doc(clips: editable)).Clips);
    }

    [Fact]
    public void Validate_EditorReachableScaleKeyframeFloors_OverTheSweptBboxes_AreDecidedByTheGate()
    {
        // KAPSAM TARAMASI: editörün yazabildiği HER ölçek tabanı (0.010 … 4.266, 3 ondalık)
        // × birkaç metin bbox'ı. Her vaka İKİ sonuçtan birine düşmeli: ya kapı reddeder, ya da
        // yerleşimin tabanı GERÇEKTEN çizilebilir (kutu ≥ 2). "Kabul edildi ama kutu < 2"
        // bileşimi = kuyruk sonrası ölüm; bu tarama tam olarak onu 0'a sabitler.
        double[][] boxes = [[223, 104], [6, 20], [640, 160], [1200, 90], [64, 64]];
        var rejected = 0;
        var accepted = 0;
        foreach (var box in boxes)
        {
            var measurer = new StubMeasurer(box[0], box[1]);
            for (var step = 10; step <= 4266; step++)
            {
                var floor = step / 1000d;
                var doc = TextDoc(AnimatedScaleTextClip(Math.Max(1.0, floor), floor));
                try
                {
                    ExportCompiler.Validate(doc, measurer);
                }
                catch (UnsupportedFeatureException)
                {
                    rejected++;
                    continue;
                }

                // KUTU, ANİMASYONLU YOLUN aritmetiğiyle sorulur (ffmpeg ifadeyi KIRPAR):
                // roundHalfUp ile sormak tam olarak kapının kaçırdığı bandı gizlerdi.
                var (w, h) = LayerGeometry.ScaleBoxTruncated(box[0], box[1], floor);
                Assert.False(
                    LayerGeometry.IsBelowScaleFloor(w, h),
                    $"bbox {box[0]}x{box[1]}, taban {floor}: kutu {w}x{h} kabul edildi");
                accepted++;
            }
        }

        Assert.True(rejected > 0, "hiçbir vaka reddedilmedi — tarama kapıyı hiç sürmemiş olabilir");
        Assert.True(accepted > 0, "hiçbir vaka kabul edilmedi — kapı her şeyi kesiyor olabilir");
    }

    [Fact]
    public void Validate_AnimatedMediaOnTheSweptNormalAspects_IsNotRejected_AcrossTheEditorScaleGrid()
    {
        // YANLIŞ RET TARAMASININ ANİMASYONLU EŞİ: taban kuralı animasyonlu yolda daha SIKI bir
        // aritmetik kullanır (kırpma), yani normal medyayı kesme riski de orada daha yüksektir.
        // Editörün yazabildiği her ölçek TABANI × yaygın kaynak oranları; aranan YALNIZ
        // 'degenerate-layer'dır (tavana çarpanlar 'transform-scale' ile reddedilir).
        int[][] sources = [[1920, 1080], [1080, 1920], [3840, 2160], [640, 480], [512, 512], [2560, 1080]];
        foreach (var src in sources)
        {
            var sizes = Sizes(src[0], src[1]);
            for (var step = 10; step <= 4266; step++)
            {
                var clip = ExportTestDocs.VideoClip(
                    ExportTestDocs.AssetA, 0, 0, 1_000_000,
                    transform: ExportTestDocs.Transform(scale: 1.0));
                clip.Keyframes = new KeyframeTracks
                {
                    Scale = [ExportTestDocs.Kf(0, 1.0), ExportTestDocs.Kf(1_000_000, step / 1000d)],
                };
                try
                {
                    ExportCompiler.Validate(ExportTestDocs.Doc(clips: clip), null, sizes);
                }
                catch (UnsupportedFeatureException ex) when (ex.Feature != "degenerate-layer")
                {
                    // tavan (transform-scale) — bu testin konusu değil
                }
                catch (UnsupportedFeatureException ex)
                {
                    Assert.Fail(
                        $"yanlış ret: kaynak {src[0]}x{src[1]}, en küçük keyframe {step / 1000d} → {ex.Message}");
                }
            }
        }
    }

    [Fact]
    public void Validate_OrdinaryOverlayClips_AreStillAccepted()
    {
        // Kapının ana negatif kontrolü: 64 px metin + yarım kare şekil + çıkartma REDDEDİLMEZ.
        var doc = ExportTestDocs.MultiTrackDoc([ExportTestDocs.OverlayTrack(clips:
        [
            ExportTestDocs.TextClip(0, 1_000_000, transform: ExportTestDocs.Transform(scale: 2)),
            ExportTestDocs.ShapeClip(1_000_000, 1_000_000,
                transform: ExportTestDocs.Transform(scale: 0.5)),
            ExportTestDocs.StickerClip(ExportTestDocs.AssetC, 2_000_000, 1_000_000),
        ])]);

        Assert.Equal(2, ExportCompiler.Validate(doc).RasterClips.Count);
    }

    [Fact]
    public void MaxRasterDimension_MirrorsMaxLayerDimension()
    {
        // Validate'in bbox kapısı LayerGeometry.MaxLayerDimension'ı kullanır; rasteri gerçekten
        // üreten taraf ise TextRasterOptions.MaxRasterDimension'ı. İkisi ayrışırsa kapı ya
        // yanlış 422 verir ya da worker'da düşen bir işi geçirir.
        Assert.Equal(LayerGeometry.MaxLayerDimension, new TextRasterOptions().MaxRasterDimension);
    }

    [Fact]
    public void Validate_OpacityOutOfRange_ThrowsInvalidTimeline()
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000, opacity: 1.5);
        Assert.Throws<InvalidTimelineException>(
            () => ExportCompiler.Validate(ExportTestDocs.Doc(clips: clip)));
    }

    [Fact]
    public void Validate_OverlappingClipsWithinOneTrack_ThrowsInvalidTimeline()
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
