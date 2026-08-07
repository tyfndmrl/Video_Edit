using System.Text.Json;

namespace VideoEdit.Api.Endpoints;

/// <summary>
/// Endpoint metadata'sı: SaveTimeline gibi büyük gövdeli endpoint'lerde Kestrel'in
/// kabul edeceği maksimum istek gövdesi. Program.cs'teki middleware
/// IHttpMaxRequestBodySizeFeature üzerinden uygular (aşımda 413).
/// </summary>
public sealed record MaxRequestBodySizeMetadata(long Bytes);

/// <summary>
/// Timeline isteklerinin YÜZEYSEL doğrulaması (tam şema doğrulaması client'ta zod ile yapılır;
/// burada amaç DB'ye açıkça bozuk/aşırı doküman yazılmasını engellemek).
/// Handler'lardan ayrı statik sınıf: birim testlerinden doğrudan çağrılabilir.
/// </summary>
public static class TimelineRequestValidation
{
    /// <summary>SaveTimeline istek gövdesi üst sınırı (~2 MB).</summary>
    public const long MaxTimelineBodyBytes = 2 * 1024 * 1024;

    public const int MaxTracks = 50;
    public const int MaxTotalClips = 2000;

    /// <summary>İzinli audio sample rate'ler — 44100 (CD) veya 48000 (video standardı).</summary>
    public static readonly int[] AllowedAudioSampleRates = [44100, 48000];

    public static bool IsAllowedAudioSampleRate(int rate) =>
        AllowedAudioSampleRates.Contains(rate);

    /// <summary>
    /// PUT /projects/{id}/timeline gövdesinin yüzeysel kontrolü.
    /// Dönen sözlük boşsa geçerli; doluysa 400 ValidationProblem gövdesi olarak kullanılır.
    /// </summary>
    public static Dictionary<string, string[]> ValidateTimelinePayload(JsonElement timeline, Guid routeProjectId)
    {
        var errors = new Dictionary<string, string[]>();

        if (timeline.ValueKind != JsonValueKind.Object)
        {
            errors["timeline"] = ["timeline must be a JSON object."];
            return errors;
        }

        if (!timeline.TryGetProperty("schemaVersion", out var schemaVersion)
            || schemaVersion.ValueKind != JsonValueKind.Number
            || !schemaVersion.TryGetInt32(out var version)
            || version != 1)
        {
            errors["timeline.schemaVersion"] = ["timeline.schemaVersion must be 1."];
        }

        if (!timeline.TryGetProperty("projectId", out var projectId)
            || projectId.ValueKind != JsonValueKind.String
            || !string.Equals(projectId.GetString(), routeProjectId.ToString("D"), StringComparison.OrdinalIgnoreCase))
        {
            errors["timeline.projectId"] = ["timeline.projectId must match the project id in the route."];
        }

        if (!timeline.TryGetProperty("tracks", out var tracks) || tracks.ValueKind != JsonValueKind.Array)
        {
            errors["timeline.tracks"] = ["timeline.tracks must be an array."];
            return errors;
        }

        var trackCount = tracks.GetArrayLength();
        if (trackCount > MaxTracks)
        {
            errors["timeline.tracks"] = [$"At most {MaxTracks} tracks are allowed (got {trackCount})."];
        }

        var totalClips = 0;
        foreach (var track in tracks.EnumerateArray())
        {
            if (track.ValueKind == JsonValueKind.Object
                && track.TryGetProperty("clips", out var clips)
                && clips.ValueKind == JsonValueKind.Array)
            {
                totalClips += clips.GetArrayLength();
            }
        }

        if (totalClips > MaxTotalClips)
        {
            errors["timeline.clips"] = [$"At most {MaxTotalClips} clips are allowed in total (got {totalClips})."];
        }

        return errors;
    }

    /// <summary>
    /// Sayfalama normalizasyonu: page >= 1, pageSize 1..maxPageSize; Skip long üzerinden
    /// hesaplanır ve int.MaxValue'ya clamp'lenir (page * pageSize int overflow koruması).
    /// </summary>
    public static (int Page, int PageSize, int Skip) NormalizePaging(int page, int pageSize, int maxPageSize = 100)
    {
        page = Math.Max(page, 1);
        pageSize = Math.Clamp(pageSize, 1, maxPageSize);
        var skip = (int)Math.Min((long)(page - 1) * pageSize, int.MaxValue);
        return (page, pageSize, skip);
    }
}
