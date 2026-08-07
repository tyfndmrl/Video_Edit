using VideoEdit.Media;

namespace VideoEdit.UnitTests;

public class FfmpegProgressParserTests
{
    [Fact]
    public void OutTimeUs_ParsesMicroseconds()
    {
        Assert.True(FfmpegProgressParser.TryParseOutTimeUs("out_time_us=1500000", out var us));
        Assert.Equal(1_500_000, us);
    }

    [Fact]
    public void OutTimeMs_IsMicrosecondsDespiteTheName()
    {
        // ffmpeg tuzağı: out_time_ms İSMİNE RAĞMEN mikrosaniyedir (AV_TIME_BASE birimi).
        Assert.True(FfmpegProgressParser.TryParseOutTimeUs("out_time_ms=1500000", out var us));
        Assert.Equal(1_500_000, us); // 1.5 sn — milisaniye okusaydık 1500 sn olurdu
    }

    [Theory]
    [InlineData("out_time_ms=N/A")]
    [InlineData("out_time_us=N/A")]
    [InlineData("out_time_us=-9223372036854775808")] // ffmpeg başlangıçta basabilir
    [InlineData("out_time=00:00:01.500000")]
    [InlineData("frame=42")]
    [InlineData("progress=continue")]
    [InlineData("")]
    public void NonNumericOrForeignLines_AreRejected(string line)
    {
        Assert.False(FfmpegProgressParser.TryParseOutTimeUs(line, out _));
    }

    [Fact]
    public void Zero_IsValid()
    {
        Assert.True(FfmpegProgressParser.TryParseOutTimeUs("out_time_us=0", out var us));
        Assert.Equal(0, us);
    }

    [Fact]
    public void EndMarker_Detected()
    {
        Assert.True(FfmpegProgressParser.IsEnd("progress=end"));
        Assert.False(FfmpegProgressParser.IsEnd("progress=continue"));
    }
}
