namespace VideoEdit.Domain.Entities;

public class RefreshToken
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }

    /// <summary>SHA-256 hex hash — ham token asla saklanmaz.</summary>
    public string TokenHash { get; set; } = "";

    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }

    /// <summary>Rotation zinciri: bu token hangi yeni token ile değiştirildi.</summary>
    public Guid? ReplacedByTokenId { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public bool IsActive(DateTimeOffset nowUtc) => RevokedAt is null && ExpiresAt > nowUtc;

    public static RefreshToken Create(Guid userId, string tokenHash, DateTimeOffset nowUtc, TimeSpan lifetime) => new()
    {
        Id = Guid.CreateVersion7(),
        UserId = userId,
        TokenHash = tokenHash,
        CreatedAt = nowUtc,
        ExpiresAt = nowUtc + lifetime,
    };
}
