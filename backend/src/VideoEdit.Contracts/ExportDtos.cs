namespace VideoEdit.Contracts;

// Export API sözleşmesi (tasarım 04 §4.1). JSON camelCase: profile, jobId, progressPercent...

/// <summary>POST /api/projects/{id}/exports gövdesi. profile: şimdilik yalnız "1080p".</summary>
public sealed record CreateExportRequest(string? Profile);

/// <summary>202 yanıtı — istemci GET /api/jobs/{jobId} ile durumu izler.</summary>
public sealed record ExportJobCreatedResponse(Guid JobId);

/// <summary>POST /api/jobs/{id}/cancel yanıtı.</summary>
public sealed record ExportCancelResponse(string Status);

/// <summary>
/// GET /api/jobs/{id} ve export listesi öğesi.
/// status: "queued" | "running" | "succeeded" | "failed" | "canceled".
/// downloadUrl yalnız Succeeded export'ta dolar (exports bucket'ından 24 saatlik presigned GET).
/// </summary>
public sealed record ExportJobDto(
    Guid Id,
    Guid? ProjectId,
    string Status,
    string? Profile,
    int ProgressPercent,
    string? ProgressStage,
    string? Error,
    string? DownloadUrl,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt);
