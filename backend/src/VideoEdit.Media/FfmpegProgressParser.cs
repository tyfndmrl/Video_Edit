using System.Globalization;

namespace VideoEdit.Media;

/// <summary>
/// ffmpeg `-progress pipe:1` satırlarını parse eder.
/// KRİTİK TUZAK: `out_time_ms` İSMİNE RAĞMEN MİKROSANİYEDİR (AV_TIME_BASE birimi) —
/// ffmpeg'in tarihsel isimlendirme hatası. Yeni sürümler ek olarak `out_time_us` yazar;
/// ikisi aynı değeri taşır ve ikisi de µs olarak okunur.
/// </summary>
public static class FfmpegProgressParser
{
    /// <summary>
    /// "out_time_us=..." ya da "out_time_ms=..." satırından mikrosaniye okur.
    /// "N/A" ve negatif değerler (ffmpeg başlangıçta long.MinValue basabilir) reddedilir.
    /// </summary>
    public static bool TryParseOutTimeUs(string line, out long us)
    {
        us = 0;
        ReadOnlySpan<char> value;
        if (line.StartsWith("out_time_us=", StringComparison.Ordinal))
        {
            value = line.AsSpan("out_time_us=".Length);
        }
        else if (line.StartsWith("out_time_ms=", StringComparison.Ordinal))
        {
            value = line.AsSpan("out_time_ms=".Length);
        }
        else
        {
            return false;
        }

        return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out us) && us >= 0;
    }

    /// <summary>"progress=end" satırı — akışın bittiğini bildirir.</summary>
    public static bool IsEnd(string line) => line == "progress=end";
}
