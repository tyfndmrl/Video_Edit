using Microsoft.AspNetCore.Identity;
using VideoEdit.Api.Auth;
using VideoEdit.Contracts;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure.Auth;

namespace VideoEdit.Api.Endpoints;

public static class AuthEndpoints
{
    public const string RefreshCookieName = "videoedit_refresh";
    private const string RefreshCookiePath = "/api/auth/refresh";

    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/auth").WithTags("Auth");

        // IP başına 10/dk (Program.cs 'auth' policy) — brute-force/enumeration frenlemesi.
        group.MapPost("/register", Register).RequireRateLimiting("auth");
        group.MapPost("/login", Login).RequireRateLimiting("auth");
        group.MapPost("/refresh", Refresh);
        // PER-DEVICE logout, ROTASI BİLİNÇLİ OLARAK cookie path'inin ALTINDA
        // (/api/auth/refresh/logout): refresh cookie Path=/api/auth/refresh ile verilir ve
        // tarayıcı onu yalnız o path'in altına gönderir — eski /api/auth/logout rotası
        // cookie'yi HİÇ GÖREMEDİĞİ için "bu cihaz hangisi" sorusunu yanıtlayamıyor ve tüm
        // cihazları düşürüyordu. Kimlik, cookie'deki token'ın KENDİSİDİR (ham token'ı bilmek
        // = o oturumun sahibi olmak); access token süresi dolmuş olsa da çıkış çalışmalı,
        // bu yüzden RequireAuthorization YOK (refresh ucuyla aynı model).
        group.MapPost("/refresh/logout", Logout);
        group.MapGet("/me", Me).RequireAuthorization();

        return app;
    }

    private static async Task<IResult> Register(
        RegisterRequest request,
        UserManager<AppUser> users,
        IRefreshTokenService refreshTokens,
        JwtTokenService jwt,
        TimeProvider clock,
        HttpContext http,
        CancellationToken ct)
    {
        var email = request.Email?.Trim() ?? "";
        var displayName = request.DisplayName?.Trim() ?? "";

        var errors = new Dictionary<string, string[]>();
        if (email.Length == 0)
        {
            errors["email"] = ["Email is required."];
        }

        if (displayName.Length is 0 or > 100)
        {
            errors["displayName"] = ["Display name is required (max 100 characters)."];
        }

        if (errors.Count > 0)
        {
            return Results.ValidationProblem(errors);
        }

        var now = clock.GetUtcNow();
        var user = AppUser.Create(email, displayName, now);
        var result = await users.CreateAsync(user, request.Password ?? "");
        if (!result.Succeeded)
        {
            return Results.ValidationProblem(
                result.Errors
                    .GroupBy(e => e.Code)
                    .ToDictionary(g => g.Key, g => g.Select(e => e.Description).ToArray()));
        }

        return await IssueAuthAsync(user, refreshTokens, jwt, now, http, ct);
    }

    private static async Task<IResult> Login(
        LoginRequest request,
        UserManager<AppUser> users,
        IRefreshTokenService refreshTokens,
        JwtTokenService jwt,
        TimeProvider clock,
        HttpContext http,
        CancellationToken ct)
    {
        var user = await AuthenticateAsync(users, request.Email?.Trim() ?? "", request.Password ?? "");
        if (user is null)
        {
            // Generic 401: hesabın varlığı da, kilitli olduğu da SIZDIRILMAZ.
            return Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Invalid email or password.");
        }

        return await IssueAuthAsync(user, refreshTokens, jwt, clock.GetUtcNow(), http, ct);
    }

    /// <summary>
    /// Kimlik doğrulama çekirdeği (lockout dahil) — testlerden doğrudan çağrılabilir.
    /// Başarısız şifre denemesi AccessFailedAsync ile sayılır (eşik aşılınca Identity hesabı
    /// kilitler); kilitli hesapta şifre hiç denenmez; başarılı girişte sayaç sıfırlanır.
    /// Tüm başarısızlık yolları null döner — çağıran generic 401 üretir.
    /// </summary>
    public static async Task<AppUser?> AuthenticateAsync(UserManager<AppUser> users, string email, string password)
    {
        var user = await users.FindByEmailAsync(email);
        if (user is null)
        {
            return null;
        }

        if (users.SupportsUserLockout && await users.IsLockedOutAsync(user))
        {
            return null;
        }

        if (!await users.CheckPasswordAsync(user, password))
        {
            if (users.SupportsUserLockout)
            {
                await users.AccessFailedAsync(user);
            }

            return null;
        }

        if (users.SupportsUserLockout)
        {
            await users.ResetAccessFailedCountAsync(user);
        }

        return user;
    }

    private static async Task<IResult> Refresh(
        UserManager<AppUser> users,
        IRefreshTokenService refreshTokens,
        JwtTokenService jwt,
        TimeProvider clock,
        HttpContext http,
        CancellationToken ct)
    {
        if (!http.Request.Cookies.TryGetValue(RefreshCookieName, out var raw) || string.IsNullOrEmpty(raw))
        {
            return Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Missing refresh token.");
        }

        var now = clock.GetUtcNow();
        var rotation = await refreshTokens.RotateAsync(raw, now, ct);
        if (!rotation.Success)
        {
            // ReuseDetected dahil: cookie temizlenir, client yeniden login olmak zorunda.
            DeleteRefreshCookie(http.Response);
            return Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Invalid refresh token.");
        }

        var user = await users.FindByIdAsync(rotation.UserId.ToString());
        if (user is null)
        {
            DeleteRefreshCookie(http.Response);
            return Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Invalid refresh token.");
        }

        AppendRefreshCookie(http.Response, rotation.NewRawToken!, rotation.NewToken!.ExpiresAt);
        var (token, expiresIn) = jwt.CreateAccessToken(user);
        return Results.Ok(new AuthResponse(token, expiresIn));
    }

    /// <summary>
    /// PER-DEVICE logout: yalnız İSTEĞİ YAPAN cihazın refresh token'ı iptal edilir
    /// (cookie'den okunur); kullanıcının diğer cihazlarındaki oturumlar YAŞAMAYA DEVAM EDER.
    /// "Tüm cihazlardan çıkış" davranışı <see cref="IRefreshTokenService.RevokeAllForUserAsync"/>'ta
    /// durur ve şifre değişimi / theft-detection senaryolarına aittir — logout'a değil.
    /// Cookie yoksa iptal edilecek oturum da yoktur: idempotent 204 (cookie yine temizlenir).
    /// Internal: birim testleri gerçek cookie başlığıyla doğrudan çağırır.
    /// </summary>
    internal static async Task<IResult> Logout(
        IRefreshTokenService refreshTokens,
        TimeProvider clock,
        HttpContext http,
        CancellationToken ct)
    {
        if (http.Request.Cookies.TryGetValue(RefreshCookieName, out var raw)
            && !string.IsNullOrEmpty(raw))
        {
            await refreshTokens.RevokeAsync(raw, clock.GetUtcNow(), ct);
        }

        DeleteRefreshCookie(http.Response);
        return Results.NoContent();
    }

    private static async Task<IResult> Me(
        UserManager<AppUser> users,
        HttpContext http)
    {
        var user = await users.FindByIdAsync(http.User.GetUserId().ToString());
        return user is null
            ? Results.NotFound()
            : Results.Ok(new MeResponse(user.Id, user.Email ?? "", user.DisplayName, user.CreatedAt));
    }

    private static async Task<IResult> IssueAuthAsync(
        AppUser user,
        IRefreshTokenService refreshTokens,
        JwtTokenService jwt,
        DateTimeOffset nowUtc,
        HttpContext http,
        CancellationToken ct)
    {
        var (raw, record) = await refreshTokens.IssueAsync(user.Id, nowUtc, ct);
        AppendRefreshCookie(http.Response, raw, record.ExpiresAt);
        var (token, expiresIn) = jwt.CreateAccessToken(user);
        return Results.Ok(new AuthResponse(token, expiresIn));
    }

    private static void AppendRefreshCookie(HttpResponse response, string rawToken, DateTimeOffset expires) =>
        response.Cookies.Append(RefreshCookieName, rawToken, new CookieOptions
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Strict,
            Path = RefreshCookiePath,
            Expires = expires,
        });

    private static void DeleteRefreshCookie(HttpResponse response) =>
        response.Cookies.Delete(RefreshCookieName, new CookieOptions
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Strict,
            Path = RefreshCookiePath,
        });
}
