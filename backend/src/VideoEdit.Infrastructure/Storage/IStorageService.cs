namespace VideoEdit.Infrastructure.Storage;

/// <summary>ListParts sonucu: R2'de gerçekten var olan bir part (resume için).</summary>
public sealed record StorageUploadedPart(int PartNumber, long SizeBytes, string ETag);

/// <summary>CompleteMultipartUpload girdisi (partNumber'a göre SIRALI verilmeli).</summary>
public sealed record StorageCompletedPart(int PartNumber, string ETag);

/// <summary>HeadObject sonucu.</summary>
public sealed record StorageObjectInfo(long SizeBytes);

/// <summary>
/// GetObject stream'i + toplam boyut. Dispose hem stream'i hem alttaki S3 yanıtını kapatır.
/// Worker'ın "orijinali diske indir" adımı bunu chunk chunk kopyalar (RAM'e almaz).
/// </summary>
public sealed class StorageDownload(Stream content, long length, IDisposable owner) : IDisposable
{
    public Stream Content { get; } = content;
    public long Length { get; } = length;

    public void Dispose()
    {
        Content.Dispose();
        owner.Dispose();
    }
}

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

    /// <summary>
    /// Tek objeyi siler (idempotent — S3 DeleteObject obje yokken de başarı döner).
    /// Complete'in size-mismatch yolu ve abort temizliği kullanır: uyuşmayan/iptal edilen
    /// obje R2'de bırakılırsa kota bypass'ı + depolama sızıntısı olur.
    /// </summary>
    Task DeleteObjectAsync(string key, CancellationToken ct = default);

    /// <summary>
    /// Objeyi okumak için stream açar (worker orijinal indirmesi — stream'lenir, RAM'e alınmaz).
    /// Obje yoksa AmazonS3Exception(404) fırlar — çağıran deterministik hata olarak sınıflar.
    /// </summary>
    Task<StorageDownload> OpenReadAsync(string key, CancellationToken ct = default);

    /// <summary>
    /// Yerel dosyayı tek PutObject ile yükler (türev çıktıları — proxy/sprite/manifest/waveform/
    /// poster; hepsi 5 GiB tek-put sınırının çok altında). Var olan key'in ÜZERİNE YAZAR
    /// (idempotent yeniden işleme — tasarım 02 §3.1).
    /// </summary>
    Task UploadFileAsync(string key, string filePath, string contentType, CancellationToken ct = default);

    /// <summary>SADECE Development startup'ında çağrılır: bucket'lar yoksa oluşturur (MinIO).</summary>
    Task EnsureBucketsExistAsync(CancellationToken ct = default);
}
