using System.Text.Json;
using VideoEdit.Media;
using VideoEdit.Media.Export;

namespace VideoEdit.UnitTests;

/// <summary>
/// Cross-language bezier DEĞER-eğrisi ekstremum paritesi:
/// packages/timeline-schema/test-vectors/easing-extrema-vectors.json TS referansından
/// (easing.ts <c>bezierValueExtrema</c> — kapalı form) üretilmiştir; C# portu
/// (<see cref="Easing.BezierValueExtrema"/>) aynı vektörleri dosyadaki toleransla geçmek
/// ZORUNDADIR. Ekstremum, ölçek taban/tavan kapılarının (degenerate-layer /
/// transform-scale) keyframe min/max yerine sorduğu yeni sayıdır — iki dil ayrışırsa
/// editörün ileride kuracağı aynı kapı ile export kapısı farklı belgeleri reddeder.
/// </summary>
public class BezierExtremaParityTests
{
    private sealed record ExtremaVectorFile(double Tolerance, List<ExtremaVectorCase> Cases);

    private sealed record ExtremaVectorCase(
        string Name, double X1, double Y1, double X2, double Y2, double Min, double Max);

    private static readonly ExtremaVectorFile Vectors = Load();

    private static ExtremaVectorFile Load()
    {
        var path = TestVectorFiles.Resolve(
            "packages/timeline-schema/test-vectors/easing-extrema-vectors.json");
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        return JsonSerializer.Deserialize<ExtremaVectorFile>(File.ReadAllText(path), options)
            ?? throw new InvalidOperationException($"Could not parse {path}");
    }

    [Fact]
    public void VectorFile_HasExpectedShape()
    {
        // Preset'ler + overshoot/undershoot/iki-yön/uç sınıfları — dosya budanırsa parite çöker.
        Assert.True(Vectors.Cases.Count >= 15,
            $"vektör dosyası {Vectors.Cases.Count} vaka taşıyor (>= 15 bekleniyordu)");
        Assert.Equal(1e-9, Vectors.Tolerance, 15);
        Assert.Contains(Vectors.Cases, c => c.Min < 0);  // undershoot sınıfı temsil ediliyor
        Assert.Contains(Vectors.Cases, c => c.Max > 1);  // overshoot sınıfı temsil ediliyor
    }

    public static TheoryData<string, double, double, double, double> Cases()
    {
        var data = new TheoryData<string, double, double, double, double>();
        foreach (var c in Vectors.Cases)
        {
            data.Add(c.Name, c.Y1, c.Y2, c.Min, c.Max);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void BezierValueExtrema_MatchesReferenceVectors(
        string name, double y1, double y2, double min, double max)
    {
        var actual = Easing.BezierValueExtrema(y1, y2);
        Assert.True(Math.Abs(actual.Min - min) <= Vectors.Tolerance,
            $"{name} min: expected {min:R}, got {actual.Min:R}");
        Assert.True(Math.Abs(actual.Max - max) <= Vectors.Tolerance,
            $"{name} max: expected {max:R}, got {actual.Max:R}");
    }

    /// <summary>
    /// Kapalı form OPERASYONEL eğriyi (bisection'lı <see cref="Easing.CubicBezierAt"/>)
    /// KAPSAR ve tepe noktasında sıkıdır — karar ölçümünün (20k nokta, kapsama=true,
    /// sapma ≤ 3,1e-8) kalıcı hali. "Kapsar" kapının güvenliği (hiçbir örnek kaçamaz),
    /// "sıkıdır" yanlış-ret bandının epsilon sınıfında kaldığının kanıtıdır.
    /// </summary>
    [Fact]
    public void ClosedForm_CoversAndTightlyBoundsTheOperationalCurve()
    {
        foreach (var c in Vectors.Cases)
        {
            var lo = double.PositiveInfinity;
            var hi = double.NegativeInfinity;
            for (var i = 0; i <= 20_000; i++)
            {
                var v = Easing.CubicBezierAt(c.X1, c.Y1, c.X2, c.Y2, i / 20_000d);
                lo = Math.Min(lo, v);
                hi = Math.Max(hi, v);
            }

            var closed = Easing.BezierValueExtrema(c.Y1, c.Y2);
            Assert.True(closed.Min <= lo + 1e-12, $"{c.Name}: kapalı min taramayı kapsamadı");
            Assert.True(closed.Max >= hi - 1e-12, $"{c.Name}: kapalı max taramayı kapsamadı");
            Assert.True(lo - closed.Min <= 1e-6, $"{c.Name}: kapalı min gevşek ({lo - closed.Min:E2})");
            Assert.True(closed.Max - hi <= 1e-6, $"{c.Name}: kapalı max gevşek ({closed.Max - hi:E2})");
        }
    }

    // ---------- KeyframeCurveExtrema + AnimationTrack ----------

    private static Keyframe Kf(long timeUs, double value, EasingValue? easing = null) =>
        new(timeUs, value, easing ?? EasingValue.Linear);

    private static EasingValue Bez(double y1, double y2) =>
        EasingValue.CubicBezier(0.3, y1, 0.6, y2);

    [Fact]
    public void KeyframeCurveExtrema_EqualsTheKeyframeHull_ForLinearAndPresetTracks()
    {
        // Editör sözlüğü: linear + üç preset. Ekstremum == keyframe zarfı (preset'ler [0,1]
        // içinde — ölçülen gerçek). Bu, editör belgelerinde kapı davranışının değişmediğinin
        // aritmetik kanıtıdır.
        var track = new[]
        {
            Kf(0, 0.5, EasingValue.EaseInOut),
            Kf(1_000, 2, EasingValue.Linear),
            Kf(2_000, 1, EasingValue.EaseOut),
            Kf(3_000, 1.5, EasingValue.EaseIn),
        };

        Assert.Equal(new CurveExtrema(0.5, 2), Easing.KeyframeCurveExtrema(track));

        var animated = new AnimationTrack(track);
        Assert.Equal(animated.MinValue, animated.CurveMin);
        Assert.Equal(animated.MaxValue, animated.CurveMax);
    }

    [Fact]
    public void KeyframeCurveExtrema_UndershootingBezier_DropsBelowTheKeyframeFloor()
    {
        // Karar ölçümünün vakası: 0.02 → 1.0 + (0.3,-4,0.6,1) — 30fps kare örneklemi
        // -1,499'a inmişti; eğri tabanı 0.02 + 0.98 × (-1.5510204081632655).
        var track = new[] { Kf(0, 0.02, Bez(-4, 1)), Kf(1_000_000, 1) };

        var extrema = Easing.KeyframeCurveExtrema(track);
        Assert.Equal(0.02 + (0.98 * -1.5510204081632655), extrema.Min, 12);
        Assert.Equal(1, extrema.Max);

        var animated = new AnimationTrack(track);
        Assert.True(animated.CurveMin < 0, "eğri tabanı negatife inmeliydi");
        Assert.Equal(0.02, animated.MinValue); // keyframe zarfı değişmez — iki sayı ayrı şeyler
    }

    [Fact]
    public void KeyframeCurveExtrema_OvershootingBezier_RisesAboveTheKeyframeCeiling()
    {
        var track = new[] { Kf(0, 1, Bez(0, 6)), Kf(1_000_000, 2) };

        var extrema = Easing.KeyframeCurveExtrema(track);
        Assert.Equal(1, extrema.Min);
        Assert.Equal(1 + 2.9896193771626294, extrema.Max, 12);
    }

    [Fact]
    public void KeyframeCurveExtrema_ZeroDeltaSegment_IsConstantRegardlessOfEasing()
    {
        var track = new[] { Kf(0, 1, Bez(-10, 10)), Kf(1_000, 1) };
        Assert.Equal(new CurveExtrema(1, 1), Easing.KeyframeCurveExtrema(track));
    }

    [Fact]
    public void KeyframeCurveExtrema_SingleKeyframe_IsAConstant()
    {
        Assert.Equal(new CurveExtrema(7, 7), Easing.KeyframeCurveExtrema([Kf(500, 7)]));
    }

    [Fact]
    public void KeyframeCurveExtrema_RejectsEmptyTracks()
    {
        Assert.Throws<ArgumentException>(() => Easing.KeyframeCurveExtrema([]));
    }

    /// <summary>
    /// Kapsama, TRACK düzeyinde ve gerçek örnekleyiciyle: karma (bezier + preset + linear)
    /// bir track'in 2001 tamsayı-µs örneği (SampleKeyframes'in kendisi) hull'un dışına
    /// çıkamaz ve hull gevşek değildir (TS easing.test.ts'teki eş test aynı korpusu koşar).
    /// </summary>
    [Fact]
    public void KeyframeCurveExtrema_CoversDenseSamplingOfSampleKeyframesItself()
    {
        var track = new[]
        {
            Kf(0, 0.4, Bez(-2, 3)),
            Kf(400_000, 1.6, EasingValue.EaseInOut),
            Kf(1_000_000, 0.9, Bez(1.8, -0.9)),
            Kf(1_500_000, 1.1),
        };

        var (min, max) = Easing.KeyframeCurveExtrema(track);
        var lo = double.PositiveInfinity;
        var hi = double.NegativeInfinity;
        for (var i = 0; i <= 2_000; i++)
        {
            var v = Easing.SampleKeyframes(track, (long)Math.Round(i / 2_000d * 1_500_000));
            lo = Math.Min(lo, v);
            hi = Math.Max(hi, v);
        }

        Assert.True(min <= lo + 1e-12, "hull yoğun taramayı kapsamadı (min)");
        Assert.True(max >= hi - 1e-12, "hull yoğun taramayı kapsamadı (max)");
        Assert.True(lo - min <= 1e-3, $"hull gevşek (min tarafı {lo - min:E2})");
        Assert.True(max - hi <= 1e-3, $"hull gevşek (max tarafı {max - hi:E2})");
    }
}
