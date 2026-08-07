namespace VideoEdit.Api.Auth;

public sealed class JwtOptions
{
    public const string SectionName = "Jwt";

    /// <summary>HS256 imza anahtarı — en az 32 karakter. Dev: appsettings.Development.json; prod: env (Jwt__Secret).</summary>
    public string Secret { get; set; } = "";

    public string Issuer { get; set; } = "videoedit";
    public string Audience { get; set; } = "videoedit";
    public int AccessTokenMinutes { get; set; } = 15;
}
