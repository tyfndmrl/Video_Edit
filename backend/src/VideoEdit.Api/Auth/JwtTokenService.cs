using System.Text;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using VideoEdit.Domain.Entities;

namespace VideoEdit.Api.Auth;

/// <summary>Access token üretimi: JWT, HS256, 15 dk.</summary>
public sealed class JwtTokenService(IOptions<JwtOptions> options, TimeProvider clock)
{
    public (string Token, int ExpiresInSeconds) CreateAccessToken(AppUser user)
    {
        var opts = options.Value;
        if (string.IsNullOrWhiteSpace(opts.Secret) || opts.Secret.Length < 32)
        {
            throw new InvalidOperationException(
                "Jwt:Secret yapılandırılmamış veya 32 karakterden kısa (prod'da env: Jwt__Secret).");
        }

        var now = clock.GetUtcNow();
        var expires = now.AddMinutes(opts.AccessTokenMinutes);

        var handler = new JsonWebTokenHandler { SetDefaultTimesOnTokenCreation = false };
        var token = handler.CreateToken(new SecurityTokenDescriptor
        {
            Issuer = opts.Issuer,
            Audience = opts.Audience,
            IssuedAt = now.UtcDateTime,
            NotBefore = now.UtcDateTime,
            Expires = expires.UtcDateTime,
            Claims = new Dictionary<string, object>
            {
                [JwtRegisteredClaimNames.Sub] = user.Id.ToString(),
                [JwtRegisteredClaimNames.Email] = user.Email ?? "",
                [JwtRegisteredClaimNames.Name] = user.DisplayName,
            },
            SigningCredentials = new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(opts.Secret)),
                SecurityAlgorithms.HmacSha256),
        });

        return (token, opts.AccessTokenMinutes * 60);
    }
}
