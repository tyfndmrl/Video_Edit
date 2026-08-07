using System.Text.Json;

namespace VideoEdit.Domain.Entities;

public class Project
{
    public Guid Id { get; set; }
    public Guid OwnerId { get; set; }
    public string Name { get; set; } = "";

    /// <summary>Current timeline dokümanı (jsonb). Tek doğruluk kaynağı; snapshot'lar ProjectRevision'da.</summary>
    public JsonDocument Timeline { get; set; } = null!;

    /// <summary>Optimistic concurrency token — monoton sayaç, client'a anlamlı sürüm numarası.</summary>
    public long RevisionNumber { get; set; }

    public int FrameRateNum { get; set; } = 30;
    public int FrameRateDen { get; set; } = 1;
    public int Width { get; set; } = 1920;
    public int Height { get; set; } = 1080;
    public int AudioSampleRate { get; set; } = 48000;

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}
