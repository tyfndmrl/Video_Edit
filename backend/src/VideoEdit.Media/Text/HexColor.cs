using System.Globalization;
using SkiaSharp;

namespace VideoEdit.Media.Text;

/// <summary>
/// Şema renk biçimi (<c>packages/timeline-schema</c>: <c>#RGB</c> | <c>#RRGGBB</c> |
/// <c>#RRGGBBAA</c>) → <see cref="SKColor"/>.
/// <para>
/// DİKKAT — <c>SKColor.TryParse</c> KULLANILMAZ: Skia 8 haneli hex'i <c>#AARRGGBB</c> (alpha
/// ÖNDE) okur, şemamız ise <c>#RRGGBBAA</c> (alpha SONDA, CSS uzlaşımı) tanımlar. Skia'nın
/// parser'ı kullanılsaydı <c>#ff0000ff</c> (opak kırmızı) MAVİ olarak çizilirdi.
/// </para>
/// </summary>
public static class HexColor
{
    public static SKColor Parse(string? hex, string fieldName)
    {
        if (!TryParse(hex, out var color))
        {
            throw new UnsupportedOverlayClipException(
                $"'{fieldName}' geçersiz renk değeri taşıyor: '{hex}'. "
                + "Beklenen biçim: #RGB, #RRGGBB ya da #RRGGBBAA.");
        }

        return color;
    }

    public static bool TryParse(string? hex, out SKColor color)
    {
        color = SKColors.Transparent;
        if (string.IsNullOrWhiteSpace(hex) || hex[0] != '#')
        {
            return false;
        }

        var body = hex.AsSpan(1);
        foreach (var c in body)
        {
            if (!Uri.IsHexDigit(c))
            {
                return false;
            }
        }

        switch (body.Length)
        {
            case 3:
                {
                    var r = (byte)(Nibble(body[0]) * 17);
                    var g = (byte)(Nibble(body[1]) * 17);
                    var b = (byte)(Nibble(body[2]) * 17);
                    color = new SKColor(r, g, b, 255);
                    return true;
                }

            case 6:
                color = new SKColor(Byte(body[..2]), Byte(body[2..4]), Byte(body[4..6]), 255);
                return true;

            case 8:
                color = new SKColor(Byte(body[..2]), Byte(body[2..4]), Byte(body[4..6]), Byte(body[6..8]));
                return true;

            default:
                return false;
        }
    }

    private static int Nibble(char c) => Convert.ToInt32(c.ToString(), 16);

    private static byte Byte(ReadOnlySpan<char> pair) =>
        byte.Parse(pair, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
}
