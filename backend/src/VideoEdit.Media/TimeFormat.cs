using System.Globalization;

namespace VideoEdit.Media;

/// <summary>
/// ffmpeg komut üretimi için culture-invariant zaman/format yardımcıları.
/// TR locale ondalık ayracı olarak virgül üretir ("0,5") ve ffmpeg patlar — bu sınıftaki
/// her dönüşüm InvariantCulture ile ve double'a düşmeden tamsayı mikrosaniyeden yapılır.
/// (İleride FilterGraph Compiler bu projede yaşayacak.)
/// </summary>
public static class TimeFormat
{
    private const long MicrosPerSecond = 1_000_000;

    /// <summary>
    /// Mikrosaniyeden ffmpeg saniye literal'i: 12_345_678 → "12.345678".
    /// Daima nokta, daima 6 haneli kesir; negatif değerler desteklenir.
    /// </summary>
    public static string Sec(long us)
    {
        var negative = us < 0;
        // long.MinValue dahil güvenli mutlak değer.
        var abs = negative ? unchecked((ulong)(-(us + 1)) + 1UL) : (ulong)us;
        var seconds = abs / MicrosPerSecond;
        var fraction = abs % MicrosPerSecond;
        return string.Create(
            CultureInfo.InvariantCulture,
            $"{(negative ? "-" : "")}{seconds}.{fraction:D6}");
    }

    /// <summary>Rasyonel fps'i ffmpeg filtre argümanı olarak yazar: (30000, 1001) → "30000/1001".</summary>
    public static string Fps(int num, int den)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(num);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(den);
        return string.Create(CultureInfo.InvariantCulture, $"{num}/{den}");
    }

    /// <summary>Genel amaçlı invariant ondalık yazımı (ör. hız çarpanı) — daima nokta.</summary>
    public static string Dec(decimal value) => value.ToString(CultureInfo.InvariantCulture);
}
