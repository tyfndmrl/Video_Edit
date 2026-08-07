namespace VideoEdit.Domain.Services;

/// <summary>
/// Multipart upload sözleşmesinin saf (IO'suz) kuralları — endpoint'ler ve birim testleri
/// aynı kaynaktan beslenir.
/// </summary>
public static class UploadRules
{
    /// <summary>
    /// Sabit part boyutu: 64 MiB (tasarım 02 §1.2). R2 son part hariç TÜM part'ların eşit
    /// boyutta olmasını zorunlu kılar — istemci bu değeri asla dinamikleştirmez.
    /// </summary>
    public const long PartSizeBytes = 64 * 1024 * 1024; // 67108864

    /// <summary>Tek presign isteğinde izin verilen en fazla part sayısı.</summary>
    public const int MaxPresignPartsPerRequest = 20;

    /// <summary>
    /// contentType → AssetKind whitelist'i. Buradan türetilemeyen tipler REDDEDİLİR
    /// (mimar denetimi: client beyanına güvenme; asıl doğrulama complete sonrası ffprobe gate).
    /// </summary>
    private static readonly Dictionary<string, AssetKind> ContentTypeKinds = new(StringComparer.Ordinal)
    {
        ["video/mp4"] = AssetKind.Video,
        ["video/quicktime"] = AssetKind.Video,
        ["video/webm"] = AssetKind.Video,
        ["audio/mpeg"] = AssetKind.Audio,
        ["audio/mp4"] = AssetKind.Audio,
        ["audio/wav"] = AssetKind.Audio,
        ["image/png"] = AssetKind.Image,
        ["image/jpeg"] = AssetKind.Image,
        ["image/webp"] = AssetKind.Image,
    };

    /// <summary>
    /// Whitelist kontrolü + Kind türetimi. Parametreli tipler ("video/mp4; codecs=...")
    /// kabul edilmez — tarayıcının file.type'ı düz medya tipidir.
    /// </summary>
    public static bool TryGetKind(string? contentType, out AssetKind kind)
    {
        kind = default;
        if (string.IsNullOrWhiteSpace(contentType))
        {
            return false;
        }

        return ContentTypeKinds.TryGetValue(contentType.Trim().ToLowerInvariant(), out kind);
    }

    /// <summary>ceil(sizeBytes / partSize). sizeBytes &gt;= 1 varsayar (doğrulama endpoint'te).</summary>
    public static int PartCount(long sizeBytes) =>
        (int)((sizeBytes + PartSizeBytes - 1) / PartSizeBytes);

    /// <summary>
    /// Complete gövdesindeki part listesi doğrulaması: TAM OLARAK 1..expectedPartCount,
    /// kesin artan sırada (CompleteMultipartUpload partNumber sırası zorunlu — tasarım 02 tuzak #4).
    /// Geçerliyse null, değilse insan-okur hata mesajı döner.
    /// </summary>
    public static string? ValidateCompletedPartSequence(IReadOnlyList<int> partNumbers, int expectedPartCount)
    {
        if (partNumbers.Count == 0)
        {
            return "parts must not be empty.";
        }

        if (partNumbers.Count != expectedPartCount)
        {
            return $"Expected exactly {expectedPartCount} parts, got {partNumbers.Count}.";
        }

        for (var i = 0; i < partNumbers.Count; i++)
        {
            if (partNumbers[i] != i + 1)
            {
                return $"parts must be sorted by partNumber and cover 1..{expectedPartCount} "
                       + $"exactly once (index {i} has partNumber {partNumbers[i]}, expected {i + 1}).";
            }
        }

        return null;
    }
}
