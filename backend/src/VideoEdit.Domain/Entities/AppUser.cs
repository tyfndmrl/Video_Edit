using Microsoft.AspNetCore.Identity;

namespace VideoEdit.Domain.Entities;

public class AppUser : IdentityUser<Guid>
{
    public string DisplayName { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }

    public List<RefreshToken> RefreshTokens { get; set; } = [];

    public static AppUser Create(string email, string displayName, DateTimeOffset nowUtc) => new()
    {
        Id = Guid.CreateVersion7(),
        UserName = email,
        Email = email,
        DisplayName = displayName,
        CreatedAt = nowUtc,
    };
}
