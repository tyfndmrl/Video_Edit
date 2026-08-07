namespace VideoEdit.Infrastructure.Storage;

/// <summary>
/// R2 / S3-uyumlu depolama konfigürasyonu.
/// Property adları compose.yml'deki env adlarıyla BİREBİR eşleşir (R2__AccountId,
/// R2__AccessKeyId, R2__SecretAccessKey, R2__Bucket, R2__ExportsBucket) — bkz.
/// backlog "compose R2__* env adları ↔ backend config binding eşleşme testi"
/// (R2OptionsTests bunu doğrular).
/// </summary>
public sealed class R2Options
{
    public const string SectionName = "R2";

    /// <summary>
    /// Set ise doğrudan bu endpoint kullanılır (dev'de MinIO: http://localhost:9000).
    /// Boşsa AccountId'den R2 endpoint'i türetilir.
    /// </summary>
    public string? ServiceUrl { get; set; }

    /// <summary>Cloudflare hesap id'si — ServiceUrl verilmediyse endpoint bundan türetilir.</summary>
    public string? AccountId { get; set; }

    public string AccessKeyId { get; set; } = "";
    public string SecretAccessKey { get; set; } = "";

    /// <summary>Medya bucket'ı (orijinaller + türevler).</summary>
    public string Bucket { get; set; } = "";

    /// <summary>Export çıktıları bucket'ı (farklı lifecycle) — M3'te kullanılır.</summary>
    public string ExportsBucket { get; set; } = "";

    /// <summary>
    /// Etkin S3 endpoint'i: ServiceUrl ?? https://{AccountId}.r2.cloudflarestorage.com.
    /// İkisi de boşsa InvalidOperationException — "https://.r2.cloudflarestorage.com" gibi
    /// çöp bir URL ile sessizce ayağa kalkılmaz (startup guard'larının son savunması).
    /// </summary>
    public string ResolveServiceUrl()
    {
        if (!string.IsNullOrWhiteSpace(ServiceUrl))
        {
            return ServiceUrl;
        }

        if (string.IsNullOrWhiteSpace(AccountId))
        {
            throw new InvalidOperationException(
                "R2 endpoint çözülemedi: R2__ServiceUrl veya R2__AccountId'den en az biri set edilmeli.");
        }

        return $"https://{AccountId}.r2.cloudflarestorage.com";
    }
}
