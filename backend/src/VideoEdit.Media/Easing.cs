namespace VideoEdit.Media;

/// <summary>
/// Easing tipi — timeline sözleşmesindeki <c>Easing</c> discriminated union'ının karşılığı
/// (packages/timeline-schema/src/easing.ts).
/// </summary>
public enum EasingType
{
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
    CubicBezier,
}

/// <summary>Cubic-bezier kontrol noktaları: P1=(X1,Y1), P2=(X2,Y2); uçlar (0,0) ve (1,1) sabittir.</summary>
public readonly record struct BezierCoefficients(double X1, double Y1, double X2, double Y2);

/// <summary>
/// Bir easing değeri: preset (linear/easeIn/easeOut/easeInOut) veya serbest cubicBezier.
/// Katsayılar yalnız <see cref="EasingType.CubicBezier"/> için anlamlıdır.
/// </summary>
public readonly record struct EasingValue(EasingType Type, double X1, double Y1, double X2, double Y2)
{
    public static readonly EasingValue Linear = new(EasingType.Linear, 0, 0, 0, 0);
    public static readonly EasingValue EaseIn = new(EasingType.EaseIn, 0, 0, 0, 0);
    public static readonly EasingValue EaseOut = new(EasingType.EaseOut, 0, 0, 0, 0);
    public static readonly EasingValue EaseInOut = new(EasingType.EaseInOut, 0, 0, 0, 0);

    public static EasingValue CubicBezier(double x1, double y1, double x2, double y2) =>
        new(EasingType.CubicBezier, x1, y1, x2, y2);
}

/// <summary>Tek bir keyframe. <see cref="TimeUs"/> klibin timeline başlangıcına görelidir (tamsayı µs).</summary>
/// <param name="TimeUs">Klip-göreli zaman (tamsayı µs); 0 = klibin timeline başlangıcı.</param>
/// <param name="Value">Kanalın bu keyframe'deki değeri — birimi kanal tanımlar
/// (rendering-semantics §3.3; aralık kapıları <c>KeyframeCompiler.Parse</c>'tadır).</param>
/// <param name="Easing">Bu keyframe'den SONRAKİ segmentin easing'i.</param>
public readonly record struct Keyframe(long TimeUs, double Value, EasingValue Easing);

/// <summary>
/// Easing eğrileri ve keyframe örnekleme — packages/timeline-schema/src/easing.ts'in
/// satır satır C# portu. REFERANS implementasyon TS tarafıdır; buradaki davranış
/// docs/rendering-semantics.md §3.2-3.3'e göre birebir aynı olmak ZORUNDADIR
/// (cross-language test vektörleri: packages/timeline-schema/test-vectors/easing-vectors.json).
/// </summary>
public static class Easing
{
    /// <summary>Preset katsayıları — CSS eşdeğerleri. Preview ve export için normatif.</summary>
    public static readonly IReadOnlyDictionary<EasingType, BezierCoefficients> EasingPresets =
        new Dictionary<EasingType, BezierCoefficients>
        {
            [EasingType.EaseIn] = new(0.42, 0, 1, 1),
            [EasingType.EaseOut] = new(0, 0, 0.58, 1),
            [EasingType.EaseInOut] = new(0.42, 0, 0.58, 1),
        };

    /// <summary>
    /// CSS tarzı cubic-bezier easing'i p ∈ [0,1] ilerlemesinde değerlendirir.
    /// Eğri uçları (0,0) ve (1,1)'de sabittir; (x1,y1)/(x2,y2) kontrol noktalarıdır.
    ///
    /// NORMATİF (docs/rendering-semantics.md §3.2): sabit 32 iterasyonlu bisection.
    /// Newton YASAK — yakınsama farkları diller arasında farklı sonuç üretebilir;
    /// sabit iterasyonlu bisection deterministiktir. TS referansının satır satır portu (double).
    /// </summary>
    public static double CubicBezierAt(double x1, double y1, double x2, double y2, double p)
    {
        if (p <= 0)
        {
            return 0;
        }

        if (p >= 1)
        {
            return 1;
        }

        double Bx(double t) => 3 * t * (1 - t) * (1 - t) * x1 + 3 * t * t * (1 - t) * x2 + t * t * t;
        double By(double t) => 3 * t * (1 - t) * (1 - t) * y1 + 3 * t * t * (1 - t) * y2 + t * t * t;
        var lo = 0d;
        var hi = 1d;
        var t = p;
        for (var i = 0; i < 32; i++)
        {
            t = (lo + hi) / 2;
            if (Bx(t) < p)
            {
                lo = t;
            }
            else
            {
                hi = t;
            }
        }

        return By(t);
    }

    /// <summary>Easing değerini bezier katsayılarına çözer; null = linear.</summary>
    public static BezierCoefficients? EasingToBezier(EasingValue easing) => easing.Type switch
    {
        EasingType.Linear => null,
        EasingType.EaseIn or EasingType.EaseOut or EasingType.EaseInOut => EasingPresets[easing.Type],
        EasingType.CubicBezier => new BezierCoefficients(easing.X1, easing.Y1, easing.X2, easing.Y2),
        _ => throw new ArgumentOutOfRangeException(nameof(easing), easing.Type, "Unknown easing type"),
    };

    /// <summary>Segment için eased ilerleme: p ∈ [0,1] -> eased değer ∈ [0,1].</summary>
    public static double EasingProgress(EasingValue easing, double p)
    {
        var bez = EasingToBezier(easing);
        if (bez is null)
        {
            return Math.Min(1, Math.Max(0, p));
        }

        var b = bez.Value;
        return CubicBezierAt(b.X1, b.Y1, b.X2, b.Y2, p);
    }

    /// <summary>
    /// Keyframe track'ini <paramref name="timeUs"/> anında örnekler (klip başlangıcına göreli,
    /// timeline zamanı, tamsayı µs).
    /// - keyframes boş olamaz ve timeUs'a göre artan sıralı olmalıdır (şema invaryantı)
    /// - ilk keyframe'den önce -> ilk değer; son keyframe'den sonra -> son değer
    /// - k[i] ile k[i+1] arasındaki segment k[i].Easing kullanır (ÖNCEKİ keyframe'in easing'i)
    /// </summary>
    public static double SampleKeyframes(IReadOnlyList<Keyframe> keyframes, long timeUs)
    {
        ArgumentNullException.ThrowIfNull(keyframes);
        if (keyframes.Count == 0)
        {
            throw new ArgumentException("SampleKeyframes requires at least one keyframe", nameof(keyframes));
        }

        var first = keyframes[0];
        if (timeUs <= first.TimeUs)
        {
            return first.Value;
        }

        var last = keyframes[keyframes.Count - 1];
        if (timeUs >= last.TimeUs)
        {
            return last.Value;
        }

        // timeUs'u içeren [i, i+1] segmentini bul (lineer tarama; track'ler kısadır).
        for (var i = 0; i < keyframes.Count - 1; i++)
        {
            var a = keyframes[i];
            var b = keyframes[i + 1];
            if (timeUs >= a.TimeUs && timeUs < b.TimeUs)
            {
                var span = b.TimeUs - a.TimeUs;
                if (span <= 0)
                {
                    return b.Value; // savunmacı; şema duplicate'i yasaklar
                }

                var p = (timeUs - a.TimeUs) / (double)span;
                var eased = EasingProgress(a.Easing, p);
                return a.Value + (b.Value - a.Value) * eased;
            }
        }

        return last.Value; // sıralı girdiyle erişilmez
    }
}
