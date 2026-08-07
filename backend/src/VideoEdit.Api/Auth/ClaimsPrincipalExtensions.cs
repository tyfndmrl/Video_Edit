using System.Security.Claims;
using Microsoft.IdentityModel.JsonWebTokens;

namespace VideoEdit.Api.Auth;

public static class ClaimsPrincipalExtensions
{
    /// <summary>JWT "sub" claim'inden kullanıcı id'si (MapInboundClaims=false varsayımıyla).</summary>
    public static Guid GetUserId(this ClaimsPrincipal principal)
    {
        var sub = principal.FindFirstValue(JwtRegisteredClaimNames.Sub)
                  ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(sub, out var id)
            ? id
            : throw new InvalidOperationException("Authenticated principal has no valid 'sub' claim.");
    }
}
