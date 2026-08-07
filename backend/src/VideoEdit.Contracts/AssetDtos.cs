namespace VideoEdit.Contracts;

// Asset upload API sözleşmesi — frontend upload motoru bu şekilleri BİREBİR bekler,
// alan adlarını/şekilleri değiştirme (JSON camelCase: fileName, sizeBytes, partNumber, etag...).

/// <summary>POST /api/projects/{projectId}/assets gövdesi.</summary>
public sealed record InitAssetUploadRequest(string FileName, long SizeBytes, string ContentType);

/// <summary>201 yanıtı: partSize her zaman 67108864 (64 MiB, sabit — R2 eşit-part kuralı).</summary>
public sealed record InitAssetUploadResponse(Guid AssetId, string UploadId, long PartSize, int PartCount);

/// <summary>POST /api/assets/{id}/parts/presign gövdesi (istek başına en fazla 20 part).</summary>
public sealed record PresignPartsRequest(int[] PartNumbers);

public sealed record PresignedPartDto(int PartNumber, string Url);

/// <summary>POST /api/assets/{id}/complete gövdesi — parts partNumber'a göre SIRALI gönderilir.</summary>
public sealed record CompleteUploadRequest(IReadOnlyList<CompletedPartDto> Parts);

public sealed record CompletedPartDto(int PartNumber, string Etag);

public sealed record CompleteUploadResponse(string Status);

/// <summary>GET /api/assets/{id}/upload/status yanıtı — ListParts tabanlı resume (R2'deki gerçek durum).</summary>
public sealed record UploadStatusResponse(
    string UploadId,
    long PartSize,
    IReadOnlyList<UploadedPartDto> UploadedParts);

public sealed record UploadedPartDto(int PartNumber, long Size, string Etag);

/// <summary>
/// GET /api/assets/{id} ve proje asset listesi öğesi.
/// kind: "video" | "audio" | "image"; status: "uploading" | "uploaded" | "processing" | "ready" | "failed".
/// Metadata alanları işleme (probe) tamamlanana kadar null'dır.
/// </summary>
public sealed record AssetDto(
    Guid Id,
    string FileName,
    long SizeBytes,
    string ContentType,
    string Kind,
    string Status,
    string? ErrorCode,
    long? DurationMicros,
    int? Width,
    int? Height,
    int? FpsNum,
    int? FpsDen,
    bool? HasAudio,
    DateTimeOffset CreatedAt);

/// <summary>
/// GET /api/projects/{projectId}/media-urls yanıtı: yalnız READY asset'ler,
/// mevcut türev key'leri için 12 saatlik presigned GET URL'leri.
/// Anahtar: assetId (Guid "D" biçimi). İstemci expiresAt'e bakarak arka planda yeniler.
/// </summary>
public sealed record MediaUrlsResponse(
    DateTimeOffset ExpiresAt,
    Dictionary<string, AssetMediaUrlsDto> Assets);

public sealed record AssetMediaUrlsDto(
    string? Original,
    string? Proxy,
    string? Filmstrip,
    string? FilmstripManifest,
    string? Waveform,
    string? Poster);
