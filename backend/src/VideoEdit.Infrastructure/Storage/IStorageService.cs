namespace VideoEdit.Infrastructure.Storage;

/// <summary>ListParts sonucu: R2'de gerçekten var olan bir part (resume için).</summary>
public sealed record StorageUploadedPart(int PartNumber, long SizeBytes, string ETag);

/// <summary>CompleteMultipartUpload girdisi (partNumber'a göre SIRALI verilmeli).</summary>
public sealed record StorageCompletedPart(int PartNumber, string ETag);

/// <summary>HeadObject sonucu.</summary>
public sealed record StorageObjectInfo(long SizeBytes);

/// <summary>
/// R2 (S3-uyumlu) medya bucket'ı üzerindeki depolama operasyonları.
/// Tüm key'ler medya bucket'ına (R2Options.Bucket) göredir; exports bucket M3'te
/// ayrı bir yüzeyle eklenir. Presign metodları YEREL imzalama yapar (ağ çağrısı yok).
/// </summary>
public interface IStorageService
{
    /// <summary>Multipart upload başlatır; R2 objesine sunucu-belirlenmiş Content-Type yazılır. UploadId döner.</summary>
    Task<string> CreateMultipartUploadAsync(string key, string contentType, CancellationToken ct = default);

    /// <summary>Tek part için 1 saatlik presigned PUT URL'i (partNumber 1 tabanlı).</summary>
    string PresignUploadPart(string key, string uploadId, int partNumber);

    /// <summary>Upload'ı tamamlar. parts partNumber'a göre SIRALI olmalı (R2/S3 zorunluluğu — tasarım 02 tuzak #4).</summary>
    Task CompleteMultipartUploadAsync(
        string key, string uploadId, IReadOnlyList<StorageCompletedPart> parts, CancellationToken ct = default);

    Task AbortMultipartUploadAsync(string key, string uploadId, CancellationToken ct = default);

    /// <summary>R2'deki gerçek part durumu (resume) — istemci state'ine güvenilmez (tasarım 02 §1.5).</summary>
    Task<IReadOnlyList<StorageUploadedPart>> ListPartsAsync(string key, string uploadId, CancellationToken ct = default);

    /// <summary>Obje metadata'sı; obje yoksa null (complete sonrası boyut doğrulaması için).</summary>
    Task<StorageObjectInfo?> HeadObjectAsync(string key, CancellationToken ct = default);

    /// <summary>12 saatlik presigned GET URL'i (media-urls toplu servisi — tasarım 02 §4).</summary>
    string PresignGet(string key);

    /// <summary>Prefix altındaki tüm objeleri siler (asset GC — batch'li DeleteObjects).</summary>
    Task DeletePrefixAsync(string prefix, CancellationToken ct = default);

    /// <summary>SADECE Development startup'ında çağrılır: bucket'lar yoksa oluşturur (MinIO).</summary>
    Task EnsureBucketsExistAsync(CancellationToken ct = default);
}
