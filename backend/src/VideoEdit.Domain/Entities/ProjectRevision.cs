using System.Text.Json;

namespace VideoEdit.Domain.Entities;

/// <summary>Versiyon geçmişi snapshot'ı. unique(ProjectId, RevisionNumber).</summary>
public class ProjectRevision
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }

    /// <summary>Project.RevisionNumber'ın snapshot anındaki değeri.</summary>
    public long RevisionNumber { get; set; }

    public JsonDocument Timeline { get; set; } = null!;
    public RevisionKind Kind { get; set; }

    /// <summary>Kullanıcının verdiği checkpoint adı (Kind=Checkpoint).</summary>
    public string? Label { get; set; }

    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }

    public static ProjectRevision Create(
        Guid projectId, long revisionNumber, JsonDocument timeline,
        RevisionKind kind, Guid createdBy, DateTimeOffset nowUtc, string? label = null) => new()
    {
        Id = Guid.CreateVersion7(),
        ProjectId = projectId,
        RevisionNumber = revisionNumber,
        Timeline = timeline,
        Kind = kind,
        Label = label,
        CreatedBy = createdBy,
        CreatedAt = nowUtc,
    };
}
