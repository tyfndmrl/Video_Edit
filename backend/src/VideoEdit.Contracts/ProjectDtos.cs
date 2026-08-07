using System.Text.Json;

namespace VideoEdit.Contracts;

public sealed record PagedResult<T>(IReadOnlyList<T> Items, int Page, int PageSize, int TotalCount);

public sealed record CreateProjectRequest(
    string Name,
    int? FpsNum,
    int? FpsDen,
    int? Width,
    int? Height,
    int? AudioSampleRate);

public sealed record UpdateProjectRequest(string Name);

/// <summary>Liste görünümü — timeline HARİÇ meta.</summary>
public sealed record ProjectSummaryDto(
    Guid Id,
    string Name,
    long RevisionNumber,
    int FpsNum,
    int FpsDen,
    int Width,
    int Height,
    int AudioSampleRate,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

/// <summary>Tek proje görünümü — timeline + revisionNumber dahil.</summary>
public sealed record ProjectDetailDto(
    Guid Id,
    string Name,
    long RevisionNumber,
    int FpsNum,
    int FpsDen,
    int Width,
    int Height,
    int AudioSampleRate,
    JsonElement Timeline,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

/// <summary>Autosave isteği: If-Match header DEĞİL, body'de baseRevision (baş mimar kararı 1.c).</summary>
public sealed record SaveTimelineRequest(long BaseRevision, JsonElement Timeline);

public sealed record SaveTimelineResponse(long RevisionNumber);

/// <summary>409 gövdesi: güncel doküman — "başka sekmede değişti" diyaloğu için.</summary>
public sealed record TimelineConflictResponse(long RevisionNumber, JsonElement Timeline);

public sealed record RevisionMetaDto(
    Guid Id,
    long RevisionNumber,
    string Kind,
    string? Label,
    Guid CreatedBy,
    DateTimeOffset CreatedAt);

public sealed record RevisionDetailDto(
    Guid Id,
    long RevisionNumber,
    string Kind,
    string? Label,
    Guid CreatedBy,
    DateTimeOffset CreatedAt,
    JsonElement Timeline);

public sealed record CreateCheckpointRequest(string? Label);

public sealed record RestoreRequest(long RevisionNumber);

/// <summary>Restore yanıtı: yeni durum — client dokümanı yeniden yükler ve undo history'yi temizler.</summary>
public sealed record RestoreResponse(long RevisionNumber, JsonElement Timeline);
