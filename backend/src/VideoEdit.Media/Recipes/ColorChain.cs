namespace VideoEdit.Media.Recipes;

/// <summary>
/// Renk hattı sabitleri (rendering-semantics §6.2 — NORMATİF).
/// HDR→SDR tonemap zinciri proxy üreticisi ile M3 export compiler'ında ÖZDEŞTİR:
/// iki taraf da BU sabiti kullanır — kopyalanmaz, parametreleştirilmez.
/// </summary>
public static class ColorChain
{
    /// <summary>
    /// Normatif HDR→SDR zinciri (rendering-semantics §6.2'deki komut parçası birebir).
    /// HLG/PQ ayrımını zscale girişteki transfer tag'inden otomatik alır.
    /// </summary>
    public const string HdrToSdr =
        "zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,"
        + "zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p";

    /// <summary>HDR transfer fonksiyonları: PQ (smpte2084) ve HLG (arib-std-b67).</summary>
    private static readonly string[] HdrTransfers = ["smpte2084", "arib-std-b67"];

    /// <summary>
    /// HDR tespiti (rendering-semantics §6.2): color_trc ∈ {smpte2084, arib-std-b67}
    /// VEYA color_primaries = bt2020.
    /// </summary>
    public static bool IsHdr(string? colorTransfer, string? colorPrimaries) =>
        (colorTransfer is not null && HdrTransfers.Contains(colorTransfer))
        || colorPrimaries == "bt2020";

    /// <summary>
    /// Kaynağa uygulanacak zincir: transfer HDR olarak tag'liyse sabit AYNEN kullanılır;
    /// BT.2020-primaries-ama-HDR-transfer-tag'siz kaynakta (rendering-semantics §6.2 son
    /// paragraf) probe'daki transfer değeri ilk zscale'e `tin=` olarak eklenir ki zscale
    /// girişi yanlış yorumlamasın. Transfer hiç yoksa sabit aynen kalır (zscale kendi
    /// varsayımını uygular).
    /// </summary>
    public static string ForSource(string? colorTransfer)
    {
        if (string.IsNullOrEmpty(colorTransfer) || HdrTransfers.Contains(colorTransfer))
        {
            return HdrToSdr;
        }

        const string firstStage = "zscale=t=linear:npl=100";
        return HdrToSdr.Replace(firstStage, $"{firstStage}:tin={colorTransfer}");
    }
}
