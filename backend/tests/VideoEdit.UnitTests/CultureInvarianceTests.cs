using System.Globalization;
using VideoEdit.Contracts;
using VideoEdit.Media;
using Xunit;

namespace VideoEdit.UnitTests;

/// <summary>
/// TR locale ondalık ayracı virgüldür ("0,5") ve ffmpeg'e sızarsa komut patlar.
/// Bu testler CurrentCulture tr-TR iken bile nokta üretildiğini doğrular.
/// </summary>
public class CultureInvarianceTests
{
    private static void WithTurkishCulture(Action action)
    {
        var culture = CultureInfo.CurrentCulture;
        var uiCulture = CultureInfo.CurrentUICulture;
        try
        {
            CultureInfo.CurrentCulture = new CultureInfo("tr-TR");
            CultureInfo.CurrentUICulture = new CultureInfo("tr-TR");
            action();
        }
        finally
        {
            CultureInfo.CurrentCulture = culture;
            CultureInfo.CurrentUICulture = uiCulture;
        }
    }

    [Fact]
    public void TurkishCulture_UsesCommaByDefault_SanityCheck()
    {
        WithTurkishCulture(() =>
        {
            // Ortam gerçekten virgül üretiyor — testin anlamlı olduğunun kanıtı.
            Assert.Equal("0,5", 0.5.ToString(CultureInfo.CurrentCulture));
        });
    }

    [Theory]
    [InlineData(0, "0.000000")]
    [InlineData(1, "0.000001")]
    [InlineData(1_500_000, "1.500000")]
    [InlineData(12_345_678, "12.345678")]
    [InlineData(3_600_000_000, "3600.000000")]
    [InlineData(-2_250_000, "-2.250000")]
    [InlineData(-1, "-0.000001")]
    public void Sec_ProducesDotDecimal_UnderTurkishCulture(long micros, string expected)
    {
        WithTurkishCulture(() => Assert.Equal(expected, TimeFormat.Sec(micros)));
    }

    [Fact]
    public void Sec_HandlesLongMinValue()
    {
        WithTurkishCulture(() => Assert.Equal("-9223372036854.775808", TimeFormat.Sec(long.MinValue)));
    }

    [Fact]
    public void Fps_ProducesRationalString()
    {
        WithTurkishCulture(() => Assert.Equal("30000/1001", TimeFormat.Fps(30000, 1001)));
    }

    [Fact]
    public void Dec_ProducesDot_UnderTurkishCulture()
    {
        WithTurkishCulture(() => Assert.Equal("0.5", TimeFormat.Dec(0.5m)));
    }

    [Fact]
    public void Timecode_FrameRoundTrip_NtscFps()
    {
        // 30000/1001 grid'inde 0..100 frame'ler kayıpsız gidip gelmeli (yuvarlama sözleşmesi).
        for (long frame = 0; frame <= 100; frame++)
        {
            var tc = Timecode.FromFrameNumber(frame, 30000, 1001);
            Assert.Equal(frame, tc.ToFrameNumber(30000, 1001));
        }
    }

    [Fact]
    public void Timecode_RoundsHalfUp_LikeJsMathRound()
    {
        // 50 fps → frame süresi 20.000 µs; tam yarı (10.000 µs) yukarı yuvarlanmalı.
        Assert.Equal(1, new Timecode(10_000).ToFrameNumber(50, 1));
        Assert.Equal(0, new Timecode(9_999).ToFrameNumber(50, 1));
    }

    [Fact]
    public void Timecode_ToTimecodeString_NonDrop()
    {
        WithTurkishCulture(() =>
        {
            // 25 fps: 1 saat 2 dk 3 sn 4 frame.
            var totalFrames = ((3600L + 120 + 3) * 25) + 4;
            var tc = Timecode.FromFrameNumber(totalFrames, 25, 1);
            Assert.Equal("01:02:03:04", tc.ToTimecodeString(25, 1));
        });
    }

    [Fact]
    public void Timecode_TimeSpanConversion_IsMicrosecondExact()
    {
        var tc = new Timecode(12_345_678);
        Assert.Equal(12_345_678, Timecode.FromTimeSpan(tc.ToTimeSpan()).Micros);
    }
}
