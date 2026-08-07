using System.Text.Json;

namespace VideoEdit.Domain.Entities;

/// <summary>
/// Arka plan işi kaydı. Export işlerinde timeline GÖMÜLÜ snapshot olarak taşınır
/// (revision referansı değil — retention/cleanup job'ı referansı silebilir; baş mimar kararı 1.c).
/// M0'da kuyruk (Hangfire) henüz bağlanmaz; tablo hazırdır.
/// </summary>
public class Job
{
    public Guid Id { get; set; }
    public JobType Type { get; set; }
    public JobStatus Status { get; set; }

    public Guid? AssetId { get; set; }
    public Guid? ProjectId { get; set; }

    /// <summary>Export: iş anındaki timeline'ın gömülü kopyası (jsonb).</summary>
    public JsonDocument? TimelineSnapshot { get; set; }

    public Guid RequestedBy { get; set; }

    public int ProgressPercent { get; set; }
    public string? ProgressStage { get; set; }

    /// <summary>Export çıktısının R2 key'i (Succeeded olunca).</summary>
    public string? OutputKey { get; set; }

    public string? ErrorMessage { get; set; }
    public int AttemptCount { get; set; }

    /// <summary>Hangfire'daki karşılık gelen background job id'si (enqueue sonrası dolar) — izleme/cancel için.</summary>
    public string? HangfireJobId { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }

    /// <summary>
    /// Son progress kalp atışı (worker her progress yazımında damgalar). Reaper "stalled"
    /// kararını buna bakarak verir: yakın zamanda heartbeat varsa iş canlıdır, süpürülmez.
    /// </summary>
    public DateTimeOffset? LastProgressAt { get; set; }

    public static Job Create(JobType type, Guid requestedBy, DateTimeOffset nowUtc,
        Guid? assetId = null, Guid? projectId = null, JsonDocument? timelineSnapshot = null) => new()
    {
        Id = Guid.CreateVersion7(),
        Type = type,
        Status = JobStatus.Queued,
        AssetId = assetId,
        ProjectId = projectId,
        TimelineSnapshot = timelineSnapshot,
        RequestedBy = requestedBy,
        CreatedAt = nowUtc,
    };
}
