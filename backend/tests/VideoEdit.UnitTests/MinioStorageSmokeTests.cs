using Microsoft.Extensions.Options;
using VideoEdit.Infrastructure.Storage;

namespace VideoEdit.UnitTests;

/// <summary>
/// MINIO_AVAILABLE env değişkeni set DEĞİLSE atlanır. CI'ın dotnet job'u gerçek bir
/// MinIO konteyneri kaldırıp bu değişkeni set eder (ci.yml "Start MinIO" + Test adımı),
/// yani bu testler CI'DA DA KOŞAR; lokalde `compose.dev.yml` MinIO'su ayaktayken
/// `MINIO_AVAILABLE=1 dotnet test` ile koşar.
/// </summary>
public sealed class MinioFactAttribute : FactAttribute
{
    public MinioFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MINIO_AVAILABLE")))
        {
            Skip = "MINIO_AVAILABLE is not set — start MinIO (compose.dev.yml) and set MINIO_AVAILABLE=1 to run.";
        }
    }
}

/// <summary>
/// R2StorageService'in S3-uyumlu bir sunucuya karşı entegrasyon duman testi.
/// Özellikle tasarım 02 §1.3 tuzağını sabitler: yeni AWS SDK checksum varsayılanları
/// (CRC32 trailer) WHEN_REQUIRED'a çekilmeden CreateMultipartUpload/PutObject 501 döner.
/// Ayrı "-smoke" bucket'ı kullanır; her koşu benzersiz prefix ile izole ve kendini temizler.
/// </summary>
public sealed class MinioStorageSmokeTests : IDisposable
{
    private readonly R2StorageService _storage;
    private readonly HttpClient _http = new();

    public MinioStorageSmokeTests()
    {
        _storage = new R2StorageService(Options.Create(new R2Options
        {
            // compose.dev.yml MinIO değerleri (appsettings.Development.json ile aynı).
            ServiceUrl = "http://localhost:9000",
            AccessKeyId = "videoedit",
            SecretAccessKey = "devpassword123",
            Bucket = "videoedit-media-smoke",
            ExportsBucket = "", // duman testinde exports bucket'ı gereksiz
        }));
    }

    public void Dispose()
    {
        _storage.Dispose();
        _http.Dispose();
    }

    [MinioFact]
    public async Task MultipartLifecycle_Init_PresignPut_ListParts_Complete_Head_Get_DeletePrefix()
    {
        var prefix = $"smoke/{Guid.NewGuid():N}";
        var key = $"{prefix}/original/source.mp4";
        var payload = new byte[1024 * 1024]; // tek part = son part → 5 MiB alt sınırı uygulanmaz
        Random.Shared.NextBytes(payload);

        await _storage.EnsureBucketsExistAsync();

        // Init + presigned PUT (istemcinin yapacağı çağrının birebir aynısı).
        var uploadId = await _storage.CreateMultipartUploadAsync(key, "video/mp4");
        Assert.False(string.IsNullOrEmpty(uploadId));

        var putUrl = _storage.PresignUploadPart(key, uploadId, partNumber: 1);
        using var putResponse = await _http.PutAsync(putUrl, new ByteArrayContent(payload));
        Assert.True(putResponse.IsSuccessStatusCode,
            $"Presigned PUT failed: {(int)putResponse.StatusCode} {await putResponse.Content.ReadAsStringAsync()}");
        var etag = putResponse.Headers.ETag?.Tag;
        Assert.False(string.IsNullOrEmpty(etag), "PUT yanıtında ETag yok (CORS ExposeHeaders tuzağının sunucu tarafı).");

        // Resume kaynağı: ListParts gerçek durumu göstermeli.
        var listed = await _storage.ListPartsAsync(key, uploadId);
        var part = Assert.Single(listed);
        Assert.Equal(1, part.PartNumber);
        Assert.Equal(payload.Length, part.SizeBytes);
        Assert.Equal(etag!.Trim('"'), part.ETag.Trim('"'));

        // Complete + boyut doğrulaması (complete endpoint'inin yaptığı kontrol).
        await _storage.CompleteMultipartUploadAsync(key, uploadId, [new StorageCompletedPart(1, etag!)]);
        var head = await _storage.HeadObjectAsync(key);
        Assert.NotNull(head);
        Assert.Equal(payload.Length, head!.SizeBytes);

        // Presigned GET içerik bütünlüğü.
        var getUrl = _storage.PresignGet(key);
        var downloaded = await _http.GetByteArrayAsync(getUrl);
        Assert.Equal(payload, downloaded);

        // Prefix silme (asset GC yolu) → obje kaybolmalı.
        await _storage.DeletePrefixAsync(prefix);
        Assert.Null(await _storage.HeadObjectAsync(key));
    }

    [MinioFact]
    public async Task AbortMultipartUpload_RemovesPendingUpload()
    {
        var prefix = $"smoke/{Guid.NewGuid():N}";
        var key = $"{prefix}/original/source.mp4";

        await _storage.EnsureBucketsExistAsync();
        var uploadId = await _storage.CreateMultipartUploadAsync(key, "video/mp4");
        await _storage.AbortMultipartUploadAsync(key, uploadId);

        // Abort sonrası ListParts NoSuchUpload vermeli (upload artık yok).
        await Assert.ThrowsAsync<Amazon.S3.AmazonS3Exception>(
            () => _storage.ListPartsAsync(key, uploadId));
    }
}
