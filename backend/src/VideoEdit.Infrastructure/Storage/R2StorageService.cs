using System.Net;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.Extensions.Options;

namespace VideoEdit.Infrastructure.Storage;

/// <summary>
/// AWSSDK.S3 tabanlı R2/MinIO istemcisi.
/// R2 uyum notları (tasarım 02 §1.3 tuzakları):
///  - AuthenticationRegion = "auto", ForcePathStyle = true (aksi kriptik 403'ler üretir);
///  - Request/ResponseChecksum = WHEN_REQUIRED — yeni SDK'ların CRC32 trailer varsayılanı
///    R2'de 501 döndürür, bu ayar ŞART;
///  - part boyutu istemcide sabittir (64 MiB) — R2 eşit-part kuralını istemci sözleşmesi korur.
/// </summary>
public sealed class R2StorageService : IStorageService, IDisposable
{
    /// <summary>Part PUT URL ömrü — yavaş bağlantı için re-presign endpoint'i mevcut (tasarım 02 tuzak #6).</summary>
    public static readonly TimeSpan UploadPartUrlLifetime = TimeSpan.FromHours(1);

    /// <summary>Presigned GET ömrü — media-urls toplu yanıtıyla birlikte 12 saat (tasarım 02 §4).</summary>
    public static readonly TimeSpan GetUrlLifetime = TimeSpan.FromHours(12);

    /// <summary>Export indirme URL ömrü (tasarım 04 §4.2: presigned GET 24h).</summary>
    public static readonly TimeSpan ExportGetUrlLifetime = TimeSpan.FromHours(24);

    /// <summary>
    /// Bu boyutun ÜSTÜNDEKİ export çıktısı multipart ile yüklenir (tasarım 04 §4.2: upload
    /// multipart olmalı; tek dev PutObject uzun timeout + baştan-yükleme riskleri taşır).
    /// </summary>
    public const long MultipartExportThresholdBytes = 256L * 1024 * 1024;

    /// <summary>Export multipart part boyutu — R2 eşit-part kuralına uygun sabit (son part kalan).</summary>
    public const long ExportPartSizeBytes = 64L * 1024 * 1024;

    private readonly AmazonS3Client _s3;
    private readonly R2Options _options;
    private readonly Protocol _presignProtocol;

    public R2StorageService(IOptions<R2Options> options)
    {
        _options = options.Value;
        var serviceUrl = _options.ResolveServiceUrl();

        var config = new AmazonS3Config
        {
            ServiceURL = serviceUrl,
            AuthenticationRegion = "auto",
            ForcePathStyle = true,
            RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
            ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
        };

        _s3 = new AmazonS3Client(
            new BasicAWSCredentials(_options.AccessKeyId, _options.SecretAccessKey), config);

        // MinIO dev endpoint'i http — presign'ın da aynı şemayı üretmesi gerekir.
        _presignProtocol = serviceUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            ? Protocol.HTTP
            : Protocol.HTTPS;
    }

    public async Task<string> CreateMultipartUploadAsync(string key, string contentType, CancellationToken ct = default)
    {
        var response = await _s3.InitiateMultipartUploadAsync(new InitiateMultipartUploadRequest
        {
            BucketName = _options.Bucket,
            Key = key,
            // Content-Type SUNUCU tarafından belirlenir (whitelist'ten) — istemci beyanına
            // güvenilmez; presigned GET ile HTML/SVG servis edilip XSS olmasını engeller.
            ContentType = contentType,
        }, ct);
        return response.UploadId;
    }

    public string PresignUploadPart(string key, string uploadId, int partNumber) =>
        _s3.GetPreSignedURL(new GetPreSignedUrlRequest
        {
            BucketName = _options.Bucket,
            Key = key,
            Verb = HttpVerb.PUT,
            UploadId = uploadId,
            PartNumber = partNumber,
            Expires = DateTime.UtcNow.Add(UploadPartUrlLifetime),
            Protocol = _presignProtocol,
        });

    public async Task CompleteMultipartUploadAsync(
        string key, string uploadId, IReadOnlyList<StorageCompletedPart> parts, CancellationToken ct = default)
    {
        await _s3.CompleteMultipartUploadAsync(new CompleteMultipartUploadRequest
        {
            BucketName = _options.Bucket,
            Key = key,
            UploadId = uploadId,
            // Çağıran partNumber sırasını garanti eder (AssetUploadValidation) — burada
            // yeniden sıralamayız ki sözleşme ihlali sessizce maskelenmesin.
            PartETags = parts.Select(p => new PartETag(p.PartNumber, p.ETag)).ToList(),
        }, ct);
    }

    public async Task AbortMultipartUploadAsync(string key, string uploadId, CancellationToken ct = default)
    {
        await _s3.AbortMultipartUploadAsync(new AbortMultipartUploadRequest
        {
            BucketName = _options.Bucket,
            Key = key,
            UploadId = uploadId,
        }, ct);
    }

    public async Task<IReadOnlyList<StorageUploadedPart>> ListPartsAsync(
        string key, string uploadId, CancellationToken ct = default)
    {
        var parts = new List<StorageUploadedPart>();
        string? marker = null;

        while (true)
        {
            var request = new ListPartsRequest
            {
                BucketName = _options.Bucket,
                Key = key,
                UploadId = uploadId,
            };
            if (marker is not null)
            {
                request.PartNumberMarker = marker;
            }

            var response = await _s3.ListPartsAsync(request, ct);
            foreach (var part in response.Parts ?? [])
            {
                parts.Add(new StorageUploadedPart(
                    part.PartNumber.GetValueOrDefault(),
                    part.Size.GetValueOrDefault(),
                    part.ETag ?? ""));
            }

            if (response.IsTruncated == true)
            {
                marker = response.NextPartNumberMarker?.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            else
            {
                break;
            }
        }

        return parts;
    }

    public async Task<StorageObjectInfo?> HeadObjectAsync(string key, CancellationToken ct = default)
    {
        try
        {
            var response = await _s3.GetObjectMetadataAsync(new GetObjectMetadataRequest
            {
                BucketName = _options.Bucket,
                Key = key,
            }, ct);
            return new StorageObjectInfo(response.ContentLength);
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public string PresignGet(string key) =>
        _s3.GetPreSignedURL(new GetPreSignedUrlRequest
        {
            BucketName = _options.Bucket,
            Key = key,
            Verb = HttpVerb.GET,
            Expires = DateTime.UtcNow.Add(GetUrlLifetime),
            Protocol = _presignProtocol,
        });

    public async Task<StorageDownload> OpenReadAsync(string key, CancellationToken ct = default)
    {
        var response = await _s3.GetObjectAsync(new GetObjectRequest
        {
            BucketName = _options.Bucket,
            Key = key,
        }, ct);
        return new StorageDownload(response.ResponseStream, response.ContentLength, response);
    }

    public async Task UploadFileAsync(string key, string filePath, string contentType, CancellationToken ct = default)
    {
        await _s3.PutObjectAsync(new PutObjectRequest
        {
            BucketName = _options.Bucket,
            Key = key,
            FilePath = filePath,
            ContentType = contentType,
        }, ct);
    }

    public async Task DeleteObjectAsync(string key, CancellationToken ct = default)
    {
        // S3/R2 DeleteObject idempotenttir: obje yoksa da 204 döner — çağıranın
        // varlık kontrolü yapması gerekmez.
        await _s3.DeleteObjectAsync(new DeleteObjectRequest
        {
            BucketName = _options.Bucket,
            Key = key,
        }, ct);
    }

    public async Task DeletePrefixAsync(string prefix, CancellationToken ct = default)
    {
        string? continuationToken = null;
        do
        {
            var list = await _s3.ListObjectsV2Async(new ListObjectsV2Request
            {
                BucketName = _options.Bucket,
                Prefix = prefix,
                ContinuationToken = continuationToken,
            }, ct);

            var keys = (list.S3Objects ?? [])
                .Select(o => new KeyVersion { Key = o.Key })
                .ToList();

            if (keys.Count > 0)
            {
                // DeleteObjects tek istekte en fazla 1000 anahtar kabul eder; ListObjectsV2
                // sayfası da en fazla 1000 döndürdüğü için sayfa başına tek çağrı yeterli.
                await _s3.DeleteObjectsAsync(new DeleteObjectsRequest
                {
                    BucketName = _options.Bucket,
                    Objects = keys,
                }, ct);
            }

            continuationToken = list.IsTruncated == true ? list.NextContinuationToken : null;
        } while (continuationToken is not null);
    }

    /// <summary>Eşik kararı saf ve statik — birim testleri sabitler.</summary>
    public static bool ShouldUseMultipartExport(long sizeBytes) => sizeBytes > MultipartExportThresholdBytes;

    /// <summary>
    /// Multipart part aralıkları (offset, length): 64 MiB eşit partlar + kalan son part
    /// (R2 eşit-part kuralı). 1 tabanlı part numarası = listedeki sıra + 1. Saf ve statik.
    /// </summary>
    public static IReadOnlyList<(long Offset, long Length)> ExportPartRanges(long sizeBytes)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(sizeBytes);
        var ranges = new List<(long, long)>();
        for (long offset = 0; offset < sizeBytes; offset += ExportPartSizeBytes)
        {
            ranges.Add((offset, Math.Min(ExportPartSizeBytes, sizeBytes - offset)));
        }

        return ranges;
    }

    public async Task UploadExportAsync(string key, string filePath, string contentType, CancellationToken ct = default)
    {
        var bucket = RequireExportsBucket();
        var sizeBytes = new FileInfo(filePath).Length;

        // ≤256 MiB: tek PutObject yeterli (5 GiB tek-put sınırının çok altı, tek round-trip).
        if (!ShouldUseMultipartExport(sizeBytes))
        {
            await _s3.PutObjectAsync(new PutObjectRequest
            {
                BucketName = bucket,
                Key = key,
                FilePath = filePath,
                ContentType = contentType,
            }, ct);
            return;
        }

        // >256 MiB: multipart — uzun tek istek yerine 64 MiB partlar; hata yolunda Abort
        // (yarım upload R2'de yetim part olarak depolama sızdırmasın).
        var uploadId = (await _s3.InitiateMultipartUploadAsync(new InitiateMultipartUploadRequest
        {
            BucketName = bucket,
            Key = key,
            ContentType = contentType,
        }, ct)).UploadId;

        try
        {
            var ranges = ExportPartRanges(sizeBytes);
            var parts = new List<PartETag>(ranges.Count);
            for (var i = 0; i < ranges.Count; i++)
            {
                var response = await _s3.UploadPartAsync(new UploadPartRequest
                {
                    BucketName = bucket,
                    Key = key,
                    UploadId = uploadId,
                    PartNumber = i + 1,
                    FilePath = filePath,
                    FilePosition = ranges[i].Offset,
                    PartSize = ranges[i].Length,
                }, ct);
                parts.Add(new PartETag(i + 1, response.ETag));
            }

            await _s3.CompleteMultipartUploadAsync(new CompleteMultipartUploadRequest
            {
                BucketName = bucket,
                Key = key,
                UploadId = uploadId,
                PartETags = parts,
            }, ct);
        }
        catch
        {
            try
            {
                await _s3.AbortMultipartUploadAsync(new AbortMultipartUploadRequest
                {
                    BucketName = bucket,
                    Key = key,
                    UploadId = uploadId,
                }, CancellationToken.None);
            }
            catch (Exception)
            {
                // Abort best-effort — asıl hata yutulmaz.
            }

            throw;
        }
    }

    public string PresignExportGet(string key) =>
        _s3.GetPreSignedURL(new GetPreSignedUrlRequest
        {
            BucketName = RequireExportsBucket(),
            Key = key,
            Verb = HttpVerb.GET,
            Expires = DateTime.UtcNow.Add(ExportGetUrlLifetime),
            Protocol = _presignProtocol,
            // Cross-origin <a download> tarayıcıda çalışmaz (same-origin şartı) — indirme,
            // sunulan Content-Disposition ile tarayıcıda tetiklenir. Dosya adı key'deki job
            // id'sinden türetilir (exports/{projectId}/{jobId}.mp4).
            ResponseHeaderOverrides = new ResponseHeaderOverrides
            {
                ContentDisposition =
                    $"attachment; filename=\"export-{Path.GetFileNameWithoutExtension(key)}.mp4\"",
            },
        });

    /// <summary>Exports bucket'ı yapılandırılmadan export yüzeyi kullanılamaz — sessiz çöp key üretme.</summary>
    private string RequireExportsBucket() =>
        string.IsNullOrWhiteSpace(_options.ExportsBucket)
            ? throw new InvalidOperationException(
                "R2 exports bucket yapılandırılmamış (env: R2__ExportsBucket) — export yüzeyi kullanılamaz.")
            : _options.ExportsBucket;

    public async Task EnsureBucketsExistAsync(CancellationToken ct = default)
    {
        await EnsureBucketAsync(_options.Bucket, ct);
        if (!string.IsNullOrWhiteSpace(_options.ExportsBucket))
        {
            await EnsureBucketAsync(_options.ExportsBucket, ct);
        }
    }

    private async Task EnsureBucketAsync(string bucket, CancellationToken ct)
    {
        try
        {
            await _s3.PutBucketAsync(new PutBucketRequest { BucketName = bucket, UseClientRegion = false }, ct);
        }
        catch (AmazonS3Exception ex) when (
            ex.ErrorCode is "BucketAlreadyOwnedByYou" or "BucketAlreadyExists"
            || ex.StatusCode == HttpStatusCode.Conflict)
        {
            // Zaten var — dev için istenen durum.
        }
    }

    public void Dispose() => _s3.Dispose();
}
