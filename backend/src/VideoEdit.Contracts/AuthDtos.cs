namespace VideoEdit.Contracts;

public sealed record RegisterRequest(string Email, string Password, string DisplayName);

public sealed record LoginRequest(string Email, string Password);

/// <param name="AccessToken">JWT (15 dk). Refresh token HttpOnly cookie ile taşınır.</param>
/// <param name="ExpiresIn">Access token ömrü, saniye.</param>
public sealed record AuthResponse(string AccessToken, int ExpiresIn);

public sealed record MeResponse(Guid Id, string Email, string DisplayName, DateTimeOffset CreatedAt);
