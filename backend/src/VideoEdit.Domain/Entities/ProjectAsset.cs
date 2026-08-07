namespace VideoEdit.Domain.Entities;

/// <summary>
/// Project ↔ Asset many-to-many join tablosu (composite PK: ProjectId + AssetId).
/// "Aynı videoyu iki projede kullan" hedefinin veri modeli karşılığı.
/// </summary>
public class ProjectAsset
{
    public Guid ProjectId { get; set; }
    public Guid AssetId { get; set; }
    public DateTimeOffset AddedAt { get; set; }
}
