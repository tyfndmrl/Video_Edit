using System.Text.Json;
using VideoEdit.Contracts;

namespace VideoEdit.UnitTests;

/// <summary>
/// Cross-language zaman sözleşmesi parity'si: packages/timeline-schema/test-vectors/time-vectors.json
/// hem vitest (time.test.ts) hem bu xUnit paketi tarafından koşulur. Sözleşme
/// (docs/rendering-semantics.md §1): us&lt;-&gt;frame half-up (floor(x+0.5), JS Math.round parity),
/// süre = round((sourceOutUs-sourceInUs)/rate), timecode frame sayısı FLOOR + non-drop HH:MM:SS:FF.
/// </summary>
public class TimeVectorParityTests
{
    private sealed record UsToFrameCase(int FpsNum, int FpsDen, long TimeUs, long Expected);

    private sealed record FrameToUsCase(int FpsNum, int FpsDen, long Frame, long Expected);

    private sealed record DurationCase(long SourceInUs, long SourceOutUs, double Rate, long Expected);

    private sealed record TimecodeCase(int FpsNum, int FpsDen, long TimeUs, string Expected);

    private sealed record TimeVectorFile(
        List<UsToFrameCase> UsToFrame,
        List<FrameToUsCase> FrameToUs,
        List<DurationCase> Duration,
        List<TimecodeCase> Timecode);

    private static readonly TimeVectorFile Vectors = Load();

    private static TimeVectorFile Load()
    {
        var path = TestVectorFiles.Resolve("packages/timeline-schema/test-vectors/time-vectors.json");
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        return JsonSerializer.Deserialize<TimeVectorFile>(File.ReadAllText(path), options)
            ?? throw new InvalidOperationException($"Could not parse {path}");
    }

    [Fact]
    public void VectorFile_HasAllSections()
    {
        Assert.NotEmpty(Vectors.UsToFrame);
        Assert.NotEmpty(Vectors.FrameToUs);
        Assert.NotEmpty(Vectors.Duration);
        Assert.NotEmpty(Vectors.Timecode);
    }

    public static TheoryData<int, int, long, long> UsToFrameCases()
    {
        var data = new TheoryData<int, int, long, long>();
        foreach (var c in Vectors.UsToFrame)
        {
            data.Add(c.FpsNum, c.FpsDen, c.TimeUs, c.Expected);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(UsToFrameCases))]
    public void ToFrameNumber_MatchesReferenceVectors(int fpsNum, int fpsDen, long timeUs, long expected)
    {
        Assert.Equal(expected, Timecode.FromMicros(timeUs).ToFrameNumber(fpsNum, fpsDen));
    }

    public static TheoryData<int, int, long, long> FrameToUsCases()
    {
        var data = new TheoryData<int, int, long, long>();
        foreach (var c in Vectors.FrameToUs)
        {
            data.Add(c.FpsNum, c.FpsDen, c.Frame, c.Expected);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(FrameToUsCases))]
    public void FromFrameNumber_MatchesReferenceVectors(int fpsNum, int fpsDen, long frame, long expected)
    {
        Assert.Equal(expected, Timecode.FromFrameNumber(frame, fpsNum, fpsDen).Micros);
    }

    public static TheoryData<long, long, double, long> DurationCases()
    {
        var data = new TheoryData<long, long, double, long>();
        foreach (var c in Vectors.Duration)
        {
            data.Add(c.SourceInUs, c.SourceOutUs, c.Rate, c.Expected);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(DurationCases))]
    public void ClipTimelineDurationUs_MatchesReferenceVectors(
        long sourceInUs, long sourceOutUs, double rate, long expected)
    {
        Assert.Equal(expected, Timecode.ClipTimelineDurationUs(sourceInUs, sourceOutUs, rate));
    }

    public static TheoryData<int, int, long, string> TimecodeCases()
    {
        var data = new TheoryData<int, int, long, string>();
        foreach (var c in Vectors.Timecode)
        {
            data.Add(c.FpsNum, c.FpsDen, c.TimeUs, c.Expected);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(TimecodeCases))]
    public void ToTimecodeString_MatchesReferenceVectors(int fpsNum, int fpsDen, long timeUs, string expected)
    {
        Assert.Equal(expected, Timecode.FromMicros(timeUs).ToTimecodeString(fpsNum, fpsDen));
    }

    [Fact]
    public void RoundingContract_IsHalfUpNotBankers()
    {
        // Half-up = floor(x+0.5): 0.5 yukarı, banker's gibi çifte yuvarlama YOK.
        // 25 fps'te 20000us = 0.5 frame -> 1 (banker's 0 verirdi).
        Assert.Equal(1, Timecode.FromMicros(20_000).ToFrameNumber(25, 1));
        // 60000us = 1.5 frame -> 2 (banker's da 2; ayrım yukarıdaki vakada).
        Assert.Equal(2, Timecode.FromMicros(60_000).ToFrameNumber(25, 1));
        // duration: 5us / rate 2 = 2.5 -> 3 (time-vectors.json ile tutarlı).
        Assert.Equal(3, Timecode.ClipTimelineDurationUs(0, 5, 2));
    }
}
