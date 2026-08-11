using SkiaSharp;
using VideoEdit.Media.Text;

namespace VideoEdit.UnitTests;

/// <summary>
/// Şema renk biçimi (<c>#RGB</c> | <c>#RRGGBB</c> | <c>#RRGGBBAA</c>) ayrıştırması.
/// KRİTİK TUZAK: Skia'nın kendi <c>SKColor.TryParse</c>'ı 8 haneli hex'i <c>#AARRGGBB</c>
/// (alpha ÖNDE) okur, şemamız ise CSS uzlaşımıyla alpha'yı SONA koyar. Skia'nın parser'ı
/// kullanılsaydı <c>#ff0000ff</c> (opak kırmızı) MAVİ çizilirdi — bu testler o hatayı kapatır.
/// </summary>
public sealed class HexColorTests
{
    [Fact]
    public void EightDigitHex_IsRrggbbaaNotAarrggbb()
    {
        Assert.True(HexColor.TryParse("#ff0000ff", out var ours));

        Assert.Equal(new SKColor(0xff, 0x00, 0x00, 0xff), ours);

        // Skia'nın yorumu FARKLIDIR — bu farkı bilerek reddediyoruz.
        Assert.True(SKColor.TryParse("#ff0000ff", out var skias));
        Assert.NotEqual(skias.Blue, ours.Blue);
    }

    [Theory]
    [InlineData("#000", 0x00, 0x00, 0x00, 0xff)]
    [InlineData("#fff", 0xff, 0xff, 0xff, 0xff)]
    [InlineData("#f0a", 0xff, 0x00, 0xaa, 0xff)]
    [InlineData("#3366ff", 0x33, 0x66, 0xff, 0xff)]
    [InlineData("#3366FF", 0x33, 0x66, 0xff, 0xff)]
    [InlineData("#3366ff80", 0x33, 0x66, 0xff, 0x80)]
    [InlineData("#00000000", 0x00, 0x00, 0x00, 0x00)]
    public void ValidColors_ParseToTheExpectedChannels(string hex, byte r, byte g, byte b, byte a)
    {
        Assert.True(HexColor.TryParse(hex, out var color));

        Assert.Equal(r, color.Red);
        Assert.Equal(g, color.Green);
        Assert.Equal(b, color.Blue);
        Assert.Equal(a, color.Alpha);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("3366ff")]      // # yok
    [InlineData("#12345")]      // geçersiz uzunluk
    [InlineData("#1234567")]
    [InlineData("#gggggg")]     // hex değil
    [InlineData("rgb(1,2,3)")]
    [InlineData("red")]
    public void InvalidColors_AreRejected(string? hex)
    {
        Assert.False(HexColor.TryParse(hex, out _));
    }

    [Fact]
    public void Parse_ThrowsTypedErrorNamingTheField()
    {
        var ex = Assert.Throws<UnsupportedOverlayClipException>(
            () => HexColor.Parse("nope", "text.fill (abc)"));

        Assert.Contains("text.fill (abc)", ex.Message, StringComparison.Ordinal);
        Assert.Equal("overlay-unsupported-clip", ex.Code);
    }

    [Fact]
    public void ShortHexExpandsByDigitDuplicationLikeCss()
    {
        HexColor.TryParse("#abc", out var shortForm);
        HexColor.TryParse("#aabbcc", out var longForm);

        Assert.Equal(longForm, shortForm);
    }
}
