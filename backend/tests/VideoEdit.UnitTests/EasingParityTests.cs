using System.Text.Json;
using VideoEdit.Media;

namespace VideoEdit.UnitTests;

/// <summary>
/// Cross-language easing parity: packages/timeline-schema/test-vectors/easing-vectors.json
/// TS referans implementasyonundan (easing.ts cubicBezierAt) üretilmiştir; C# portu
/// (VideoEdit.Media.Easing) aynı vektörleri dosyadaki toleransla geçmek ZORUNDADIR
/// (docs/rendering-semantics.md §3.2 — sabit 32 iterasyonlu bisection).
/// </summary>
public class EasingParityTests
{
    private sealed record EasingVectorFile(double Tolerance, List<EasingVectorCase> Cases);

    private sealed record EasingVectorCase(
        string Preset, double X1, double Y1, double X2, double Y2, double P, double Expected);

    private static readonly EasingVectorFile Vectors = Load();

    private static EasingVectorFile Load()
    {
        var path = TestVectorFiles.Resolve("packages/timeline-schema/test-vectors/easing-vectors.json");
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        return JsonSerializer.Deserialize<EasingVectorFile>(File.ReadAllText(path), options)
            ?? throw new InvalidOperationException($"Could not parse {path}");
    }

    public static TheoryData<string, double, double, double, double, double, double> Cases()
    {
        var data = new TheoryData<string, double, double, double, double, double, double>();
        foreach (var c in Vectors.Cases)
        {
            data.Add(c.Preset, c.X1, c.Y1, c.X2, c.Y2, c.P, c.Expected);
        }

        return data;
    }

    [Fact]
    public void VectorFile_HasExpectedShape()
    {
        // 4 preset x 11 p noktası — dosya sessizce budanırsa parity kanıtı çöker.
        Assert.Equal(44, Vectors.Cases.Count);
        Assert.Equal(1e-6, Vectors.Tolerance, 12);
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void CubicBezierAt_MatchesReferenceVectors(
        string preset, double x1, double y1, double x2, double y2, double p, double expected)
    {
        var actual = Easing.CubicBezierAt(x1, y1, x2, y2, p);
        Assert.True(
            Math.Abs(actual - expected) <= Vectors.Tolerance,
            $"preset={preset} p={p}: expected {expected:R}, got {actual:R} " +
            $"(diff {Math.Abs(actual - expected):E3} > tolerance {Vectors.Tolerance:E1})");
    }

    [Theory]
    [InlineData("easeIn", EasingType.EaseIn)]
    [InlineData("easeOut", EasingType.EaseOut)]
    [InlineData("easeInOut", EasingType.EaseInOut)]
    public void EasingPresets_MatchVectorCoefficients(string preset, EasingType type)
    {
        var fromFile = Vectors.Cases.First(c => c.Preset == preset);
        var coefficients = Easing.EasingPresets[type];
        Assert.Equal(fromFile.X1, coefficients.X1);
        Assert.Equal(fromFile.Y1, coefficients.Y1);
        Assert.Equal(fromFile.X2, coefficients.X2);
        Assert.Equal(fromFile.Y2, coefficients.Y2);
    }

    [Fact]
    public void EasingProgress_Linear_IsClampedIdentity()
    {
        Assert.Equal(0, Easing.EasingProgress(EasingValue.Linear, -0.5));
        Assert.Equal(0.25, Easing.EasingProgress(EasingValue.Linear, 0.25));
        Assert.Equal(1, Easing.EasingProgress(EasingValue.Linear, 1.5));
    }

    [Fact]
    public void SampleKeyframes_ClampsToEndpointValues()
    {
        var track = new[]
        {
            new Keyframe(1_000_000, 10, EasingValue.Linear),
            new Keyframe(2_000_000, 20, EasingValue.Linear),
        };

        Assert.Equal(10, Easing.SampleKeyframes(track, 0));
        Assert.Equal(10, Easing.SampleKeyframes(track, 1_000_000));
        Assert.Equal(20, Easing.SampleKeyframes(track, 2_000_000));
        Assert.Equal(20, Easing.SampleKeyframes(track, 5_000_000));
    }

    [Fact]
    public void SampleKeyframes_UsesPrecedingKeyframesEasing()
    {
        // Segment easing'i ÖNCEKİ keyframe'e aittir (§3.3): [k0,k1] easeIn ile, [k1,k2] linear ile.
        var track = new[]
        {
            new Keyframe(0, 0, EasingValue.EaseIn),
            new Keyframe(1_000_000, 100, EasingValue.Linear),
            new Keyframe(2_000_000, 200, EasingValue.EaseOut), // son keyframe'in easing'i etkisizdir
        };

        var eased = Easing.CubicBezierAt(0.42, 0, 1, 1, 0.5);
        Assert.Equal(100 * eased, Easing.SampleKeyframes(track, 500_000), 12);
        Assert.Equal(150, Easing.SampleKeyframes(track, 1_500_000), 12);
    }

    [Fact]
    public void SampleKeyframes_RejectsEmptyTrack()
    {
        Assert.Throws<ArgumentException>(() => Easing.SampleKeyframes(Array.Empty<Keyframe>(), 0));
    }
}
