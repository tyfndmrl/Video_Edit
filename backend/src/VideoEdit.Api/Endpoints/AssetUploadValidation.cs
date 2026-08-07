using VideoEdit.Contracts;
using VideoEdit.Domain;
using VideoEdit.Domain.Services;

namespace VideoEdit.Api.Endpoints;

/// <summary>
/// Asset upload isteklerinin doğrulaması — TimelineRequestValidation ile aynı desen:
/// handler'lardan ayrı statik sınıf, birim testlerinden doğrudan çağrılabilir.
/// Dönen sözlük boşsa geçerli; doluysa ValidationProblem gövdesi olur.
/// </summary>
public static class AssetUploadValidation
{
    public const int MaxFileNameLength = 500; // Asset.OriginalFileName kolon sınırı

    /// <summary>
    /// Init doğrulaması: fileName (boş değil, max 500), sizeBytes (1..MaxFileSizeBytes),
    /// contentType (whitelist → kind). Geçerliyse kind dolu döner.
    /// </summary>
    public static Dictionary<string, string[]> ValidateInit(
        InitAssetUploadRequest request, long maxFileSizeBytes, out AssetKind kind)
    {
        var errors = new Dictionary<string, string[]>();
        kind = default;

        var fileName = request.FileName?.Trim() ?? "";
        if (fileName.Length is 0 or > MaxFileNameLength)
        {
            errors["fileName"] = [$"fileName is required (max {MaxFileNameLength} characters)."];
        }

        if (request.SizeBytes < 1 || request.SizeBytes > maxFileSizeBytes)
        {
            errors["sizeBytes"] = [$"sizeBytes must be between 1 and {maxFileSizeBytes}."];
        }

        if (!UploadRules.TryGetKind(request.ContentType, out kind))
        {
            errors["contentType"] = ["contentType is not allowed. Allowed: video/mp4, video/quicktime, "
                + "video/webm, audio/mpeg, audio/mp4, audio/wav, image/png, image/jpeg, image/webp."];
        }

        return errors;
    }

    /// <summary>Presign doğrulaması: 1..20 adet, hepsi 1..partCount aralığında, tekrarsız.</summary>
    public static Dictionary<string, string[]> ValidatePresign(int[]? partNumbers, int partCount)
    {
        var errors = new Dictionary<string, string[]>();

        if (partNumbers is null || partNumbers.Length == 0)
        {
            errors["partNumbers"] = ["partNumbers must not be empty."];
            return errors;
        }

        if (partNumbers.Length > UploadRules.MaxPresignPartsPerRequest)
        {
            errors["partNumbers"] =
                [$"At most {UploadRules.MaxPresignPartsPerRequest} part numbers per request."];
            return errors;
        }

        if (partNumbers.Any(n => n < 1 || n > partCount))
        {
            errors["partNumbers"] = [$"Part numbers must be within 1..{partCount}."];
        }
        else if (partNumbers.Distinct().Count() != partNumbers.Length)
        {
            errors["partNumbers"] = ["Part numbers must be unique."];
        }

        return errors;
    }

    /// <summary>
    /// Complete doğrulaması: tam 1..partCount sıralı dizi (UploadRules) + boş olmayan etag'lar.
    /// </summary>
    public static Dictionary<string, string[]> ValidateComplete(
        IReadOnlyList<CompletedPartDto>? parts, int partCount)
    {
        var errors = new Dictionary<string, string[]>();

        if (parts is null || parts.Count == 0)
        {
            errors["parts"] = ["parts must not be empty."];
            return errors;
        }

        var sequenceError = UploadRules.ValidateCompletedPartSequence(
            parts.Select(p => p.PartNumber).ToArray(), partCount);
        if (sequenceError is not null)
        {
            errors["parts"] = [sequenceError];
        }

        if (parts.Any(p => string.IsNullOrWhiteSpace(p.Etag)))
        {
            errors["parts.etag"] = ["Every part must carry a non-empty etag "
                + "(missing ETag usually means the bucket CORS lacks ExposeHeaders: ETag)."];
        }

        return errors;
    }
}
