using System.Globalization;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;
using SchemaKeyframe = VideoEdit.Contracts.Timeline.Keyframe;
using SchemaEasing = VideoEdit.Contracts.Timeline.Easing;
using MediaKeyframe = VideoEdit.Media.Keyframe;

namespace VideoEdit.Media.Export;

/// <summary>
/// Tek bir animasyon kanalı (x | y | scale | rotationDeg | opacity) — DOĞRULANMIŞ,
/// zamana göre artan keyframe listesi. <see cref="AllLinear"/> compiler'ın hangi
/// mekanizmayı seçeceğini belirler (rendering-semantics §3.4):
///  - tamamı lineer → piecewise-linear ffmpeg EXPRESSION'ı (ucuz yol, tasarım 04 §2.5);
///  - en az bir segment eğrili → FRAME BAŞINA örneklenmiş sendcmd (genel yol, §3.4).
/// Örnekleme her iki yolda da aynı fonksiyondan (<see cref="Easing.SampleKeyframes"/>)
/// geçer; önizleme de aynı aileyi kullanır → eğri özdeştir.
/// </summary>
public sealed record AnimationTrack(IReadOnlyList<MediaKeyframe> Keys)
{
    /// <summary>Segment easing'i keyframe'in KENDİSİNE aittir (§3.3) — son keyframe etkisizdir.</summary>
    public bool AllLinear { get; } =
        Keys.Take(Math.Max(0, Keys.Count - 1)).All(k => k.Easing.Type == EasingType.Linear);

    public double MinValue => Keys.Min(k => k.Value);

    public double MaxValue => Keys.Max(k => k.Value);

    /// <summary>Klip-göreli <paramref name="timeUs"/> anındaki değer (§3.3).</summary>
    public double Sample(long timeUs) => Easing.SampleKeyframes(Keys, timeUs);
}

/// <summary>
/// Bir klibin animasyon defteri. Boş kanal = null (taban/statik değer geçerlidir, §3.3).
/// <para>
/// MVP kapsamı: <c>x, y, scale, rotationDeg, opacity</c>. <c>volume</c> keyframe'i M5'te
/// KAPSAM DIŞIDIR (§8.1'in sendcmd örneklemesi ses zincirine ayrı bir mekanizma ister) ve
/// <c>fx.*</c> keyframe'i ŞEMADA YOKTUR (baş mimar kararı, §3.3).
/// </para>
/// </summary>
public sealed record ClipAnimation(
    AnimationTrack? X,
    AnimationTrack? Y,
    AnimationTrack? Scale,
    AnimationTrack? Rotation,
    AnimationTrack? Opacity)
{
    public static readonly ClipAnimation None = new(null, null, null, null, null);

    /// <summary>Yerleşimi (konum/ölçek/dönme) zamana bağlı yapan kanallardan biri var mı?</summary>
    public bool AnimatesPlacement => X is not null || Y is not null
                                     || Scale is not null || Rotation is not null;

    public bool Any => AnimatesPlacement || Opacity is not null;

    /// <summary>KATMAN zincirinde (scale/rotate) klip-göreli <c>t</c> gerektiren kanallar.</summary>
    public bool AnimatesLayerChain => Scale is not null || Rotation is not null;
}

/// <summary>
/// Şema <c>KeyframeTracks</c> → doğrulanmış <see cref="ClipAnimation"/> + ffmpeg ifade/komut
/// üretimi (rendering-semantics §3, tasarım 04 §2.5).
/// </summary>
public static class KeyframeCompiler
{
    /// <summary>
    /// Tek derlemede üretilebilecek frame örneği tavanı (§3.4 örneklemesi klip uzunluğuyla
    /// DOĞRUSAL büyür). 60_000 örnek 30 fps'te ~33 dakikalık eğrili animasyona karşılık gelir;
    /// üstünde graph dosyası okunamaz hale gelir (worker onu loglar) ve ifade ağacı gereksiz
    /// büyür. Sessiz kırpma yerine tipli hata.
    /// </summary>
    public const int MaxSamples = 60_000;

    /// <summary>
    /// Klibin keyframe defterini doğrular. Kurallar (§3.3 + şema invaryantları):
    /// boş olmayan kanal, timeUs artan ve tekrarsız, timeUs ≥ 0, cubicBezier x1/x2 ∈ [0..1].
    /// </summary>
    public static ClipAnimation Parse(Guid clipId, KeyframeTracks? tracks)
    {
        if (tracks is null)
        {
            return ClipAnimation.None;
        }

        if (tracks.Volume is { Count: > 0 })
        {
            throw new UnsupportedFeatureException("keyframes-volume",
                $"'{clipId}' klibinde ses seviyesi (volume) keyframe'i var — ses keyframe'leri "
                + "henüz desteklenmiyor. Sabit bir ses seviyesi kullanın.");
        }

        var x = Track(clipId, "x", tracks.X);
        var y = Track(clipId, "y", tracks.Y);
        var scale = Track(clipId, "scale", tracks.Scale);
        var rotation = Track(clipId, "rotationDeg", tracks.RotationDeg);
        var opacity = Track(clipId, "opacity", tracks.Opacity);

        if (scale is not null && scale.MinValue <= 0)
        {
            throw new InvalidTimelineException(
                $"'{clipId}' klibinin ölçek keyframe'lerinden biri pozitif değil "
                + $"(en küçük değer {Num(scale.MinValue)}).");
        }

        if (opacity is not null && (opacity.MinValue < 0 || opacity.MaxValue > 1))
        {
            throw new InvalidTimelineException(
                $"'{clipId}' klibinin opaklık keyframe'leri [0..1] aralığında olmalı "
                + $"(gelen aralık {Num(opacity.MinValue)}..{Num(opacity.MaxValue)}).");
        }

        return x is null && y is null && scale is null && rotation is null && opacity is null
            ? ClipAnimation.None
            : new ClipAnimation(x, y, scale, rotation, opacity);
    }

    /// <summary>
    /// Piecewise-linear ffmpeg ifadesi (tasarım 04 §2.5'in NORMATİF biçimi):
    /// <c>if(lt(t,T1), V1, if(lt(t,T2), V1+(V2-V1)*(t-T1)/(T2-T1), V2))</c>.
    /// Yalnız TAMAMI LİNEER kanallar için üretilir — eğrili kanal sendcmd yoluna gider.
    /// <paramref name="offsetUs"/> keyframe zamanını ifadenin zaman eksenine taşır
    /// (overlay x/y kompozit eksende çalışır → offset = timelineStartUs; scale/rotate klip
    /// ekseninde çalışır → offset = 0). <paramref name="map"/> keyframe değerini filtre
    /// birimine çevirir (ör. normalize x → piksel P.x).
    /// </summary>
    public static string LinearExpression(AnimationTrack track, long offsetUs, Func<double, double> map)
    {
        ArgumentNullException.ThrowIfNull(track);
        ArgumentNullException.ThrowIfNull(map);
        var keys = track.Keys;
        if (keys.Count == 1)
        {
            return Lit(map(keys[0].Value));
        }

        var expression = Lit(map(keys[^1].Value));
        for (var i = keys.Count - 2; i >= 0; i--)
        {
            var t0 = Sec(keys[i].TimeUs + offsetUs);
            var t1 = Sec(keys[i + 1].TimeUs + offsetUs);
            var v0 = Lit(map(keys[i].Value));
            var v1 = Lit(map(keys[i + 1].Value));
            expression =
                $"if(lt(t,{t1}),{v0}+({v1}-{v0})*(t-{t0})/({t1}-{t0}),{expression})";
        }

        return $"if(lt(t,{Sec(keys[0].TimeUs + offsetUs)}),{Lit(map(keys[0].Value))},{expression})";
    }

    /// <summary>
    /// §3.4 frame örneklemesi: klibin kompozit frame aralığındaki HER kare için bir örnek.
    /// Örnekleme noktası frame'in BAŞLANGIÇ zamanıdır (orta değil). Ardışık AYNI değerler
    /// (formatlanmış literal olarak) atlanır — keyframe aralığının dışındaki sabit baş/kuyruk
    /// tek komuta iner, davranış değişmez.
    /// </summary>
    /// <param name="offsetUs">
    /// Komut zamanının yazılacağı eksen: kompozit için 0 (t_us doğrudan), klip ekseni için
    /// <c>-timelineStartUs</c>. Değer örneklemesi DAİMA klip-göreli zamanla yapılır.
    /// </param>
    public static IReadOnlyList<(long TimeUs, double Value)> Samples(
        AnimationTrack track, long clipStartUs, long firstFrame, long lastFrame,
        int fpsNum, int fpsDen, long offsetUs)
    {
        ArgumentNullException.ThrowIfNull(track);
        var samples = new List<(long TimeUs, double Value)>();
        string? previous = null;
        for (var n = firstFrame; n < lastFrame; n++)
        {
            var timeUs = Timecode.FromFrameNumber(n, fpsNum, fpsDen).Micros;
            var value = track.Sample(timeUs - clipStartUs);
            var literal = Num(value);
            if (literal == previous)
            {
                continue;
            }

            previous = literal;
            samples.Add((timeUs + offsetUs, value));
        }

        return samples;
    }

    /// <summary>
    /// §3.4'ün frame örneklemesini ffmpeg İFADESİNE çevirir: her örnek kendi karesi boyunca
    /// SABİTTİR (sendcmd'in "komut frame başında uygulanır" semantiğinin birebir aynısı),
    /// karar ağacı DENGELİ İKİLİ arama biçiminde yazılır.
    /// <para>
    /// <b>Neden sendcmd değil (M5 ölçümü).</b> <c>overlay</c> iki girişli bir filtredir ve
    /// framesync ile TAMPONLAR: sendcmd komutu, tuval karesi filtreden geçtiği anda gönderilir
    /// ama o kare overlay'e hemen girmez — ffmpeg giriş dosyalarını sıraya alırken taban dalı
    /// katman dalının önüne geçebilir. Gerçek render ölçümü (320x240, 60 kare, iki dosya girişi,
    /// kare başına komut): sendcmd overlay'i sürerken 60 karenin 22'si (komut 1. overlay'den
    /// SONRA), 39'u (komut 1. overlay'den ÖNCE) ve 17'si (komut KATMAN zincirinde) YANLIŞ
    /// konumda çıktı — konum bir süre DONUYOR, sonra sıçrıyor. Aynı ölçüm <c>t</c> ifadesiyle
    /// 60/60 doğru. sendcmd yalnız komutu AYNI LİNEER ZİNCİRDE alan filtrelerde güvenlidir
    /// (ölçüldü: colorchannelmixer 60/60) — orada kare, filtreye eşzamanlı olarak iletilir.
    /// Bu yüzden ifade alabilen her parametre (overlay x/y, scale w/h, rotate a) İFADEYLE,
    /// yalnız zaman ifadesi almayan opaklık sendcmd ile sürülür.
    /// </para>
    /// Ağaç derinliği <c>log2(N)</c>'dir: ffmpeg'in ifade ayrıştırıcısı ve değerlendiricisi
    /// ÖZYİNELEMELİDİR, N derinliğinde iç içe <c>if</c> uzun kliplerde C yığınını taşırırdı.
    /// </summary>
    /// <param name="halfFrameUs">
    /// Karar sınırı örnek zamanının YARIM FRAME öncesine konur: frame zamanları ızgarada tam
    /// oturduğu için karşılaştırma kayan nokta eşitliğine hiç yaklaşmaz.
    /// </param>
    public static string StepExpression(
        IReadOnlyList<(long TimeUs, double Value)> samples, long halfFrameUs,
        Func<double, double> map)
    {
        ArgumentNullException.ThrowIfNull(samples);
        ArgumentNullException.ThrowIfNull(map);
        if (samples.Count == 0)
        {
            throw new ArgumentException("step expression needs at least one sample", nameof(samples));
        }

        return Node(0, samples.Count - 1);

        string Node(int lo, int hi)
        {
            if (lo == hi)
            {
                return Lit(map(samples[lo].Value));
            }

            var mid = lo + ((hi - lo + 1) / 2);
            var boundary = Sec(samples[mid].TimeUs - halfFrameUs);
            return $"if(lt(t,{boundary}),{Node(lo, mid - 1)},{Node(mid, hi)})";
        }
    }

    /// <summary>
    /// sendcmd komut listesini TEK satırlık <c>c='…'</c> argümanına çevirir.
    /// <para>
    /// Tasarım 04 §2.5 "komut DOSYASI" der; uygulama komutları filtergraph'a GÖMER. Gerekçe:
    /// <see cref="CompiledExport"/> sözleşmesi worker'a TEK artefakt (graph script'i) verir —
    /// yan dosya eklemek worker'ın yazma sorumluluğunu da değiştirirdi. Gömülü biçim
    /// davranışça özdeştir (ffmpeg sendcmd'in <c>commands</c>/<c>c</c> seçeneği) ve derlemeyi
    /// snapshot'lanabilir bırakır. Tek tırnak içi metin filtergraph ayrıştırıcısında harfi
    /// harfine kopyalanır; komutlarda ':' KULLANILMAZ (filtre seçenek ayracı) — zaman, hedef,
    /// komut ve değer yalnız rakam/nokta/harf/'@' içerir.
    /// </para>
    /// Aralıklar <c>START</c> biçiminde (bitişsiz) yazılır: ffmpeg her aralığı bir kez,
    /// frame zamanı aralığa GİRDİĞİNDE tetikler; açık uçlu aralıklar sıralı olduğu için her
    /// komut tam olarak kendi karesinde uygulanır (gerçek render ile doğrulandı).
    /// </summary>
    public static string SendCmdFilter(IEnumerable<string> commands) =>
        "sendcmd=c='" + string.Join("; ", commands) + "'";

    /// <summary>Tek sendcmd komutu: <c>&lt;zaman&gt; &lt;hedef&gt; &lt;komut&gt; &lt;değer&gt;</c>.</summary>
    public static string Command(long timeUs, string target, string command, string value) =>
        $"{Sec(timeUs)} {target} {command} {value}";

    private static AnimationTrack? Track(Guid clipId, string name, IReadOnlyList<SchemaKeyframe>? keys)
    {
        if (keys is not { Count: > 0 })
        {
            return null;
        }

        var converted = new List<MediaKeyframe>(keys.Count);
        for (var i = 0; i < keys.Count; i++)
        {
            var key = keys[i];
            if (key.TimeUs < 0)
            {
                throw new InvalidTimelineException(
                    $"'{clipId}' klibinin '{name}' keyframe'lerinden birinin zamanı negatif "
                    + $"({key.TimeUs.ToString(CultureInfo.InvariantCulture)} us).");
            }

            if (i > 0 && key.TimeUs <= keys[i - 1].TimeUs)
            {
                throw new InvalidTimelineException(
                    $"'{clipId}' klibinin '{name}' keyframe'leri zamana göre ARTAN ve tekrarsız "
                    + $"olmalı ({keys[i - 1].TimeUs} us'ten sonra {key.TimeUs} us geliyor).");
            }

            if (!double.IsFinite(key.Value))
            {
                throw new InvalidTimelineException(
                    $"'{clipId}' klibinin '{name}' keyframe değerlerinden biri sonlu bir sayı değil.");
            }

            converted.Add(new MediaKeyframe(key.TimeUs, key.Value, EasingOf(clipId, name, key.Easing)));
        }

        return new AnimationTrack(converted);
    }

    /// <summary>Şema easing union'ı → <see cref="EasingValue"/> (§3.1 preset katsayıları).</summary>
    private static EasingValue EasingOf(Guid clipId, string name, SchemaEasing? easing) => easing switch
    {
        null or EasingLinear => EasingValue.Linear,
        EasingEaseIn => EasingValue.EaseIn,
        EasingEaseOut => EasingValue.EaseOut,
        EasingEaseInOut => EasingValue.EaseInOut,
        EasingCubicBezier bezier => Bezier(clipId, name, bezier),
        _ => throw new UnsupportedFeatureException("easing-type",
            $"'{clipId}' klibinin '{name}' keyframe'inde tanınmayan easing tipi "
            + $"({easing.GetType().Name}) var."),
    };

    private static EasingValue Bezier(Guid clipId, string name, EasingCubicBezier bezier)
    {
        // §3.1: x1, x2 ∈ [0..1] ZORUNLUDUR (bisection'ın monoton x(t) varsayımı); y serbesttir.
        if (bezier.X1 is < 0 or > 1 || bezier.X2 is < 0 or > 1
            || !double.IsFinite(bezier.Y1) || !double.IsFinite(bezier.Y2))
        {
            throw new InvalidTimelineException(
                $"'{clipId}' klibinin '{name}' keyframe'indeki cubicBezier easing'i geçersiz: "
                + $"x1/x2 [0..1] aralığında olmalı (gelen değerler x1={Num(bezier.X1)}, "
                + $"x2={Num(bezier.X2)}).");
        }

        return EasingValue.CubicBezier(bezier.X1, bezier.Y1, bezier.X2, bezier.Y2);
    }

    /// <summary>
    /// İfade literal'i: NEGATİF değerler paranteze alınır. ffmpeg eval'de <c>(3--5)</c>
    /// gibi çift işaret ayrıştırma tuzağıdır; <c>(3-(-5))</c> her sürümde güvenlidir.
    /// </summary>
    private static string Lit(double value) =>
        value < 0 ? "(" + Num(value) + ")" : Num(value);

    private static string Sec(long us) => TimeFormat.Sec(us);

    internal static string Num(double value) =>
        value.ToString("0.######", CultureInfo.InvariantCulture);
}
