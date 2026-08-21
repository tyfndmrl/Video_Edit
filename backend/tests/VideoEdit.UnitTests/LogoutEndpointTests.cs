using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Api.Endpoints;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Auth;

namespace VideoEdit.UnitTests;

/// <summary>
/// PER-DEVICE LOGOUT ucunun sözleşmesi (M6 borcu "çıkış TÜM cihazları düşürür"ün kapanışı):
/// <c>POST /api/auth/refresh/logout</c> yalnız İSTEKLE GELEN refresh cookie'sinin token'ını
/// iptal eder — kullanıcının öteki cihazlarının token'ları AKTİF kalır ve rotasyona devam
/// eder. Rota bilinçli olarak cookie path'inin (/api/auth/refresh) altındadır: eski
/// /api/auth/logout cookie'yi hiç göremiyordu ve tek çare "hepsini iptal"di.
/// Cookie'siz istek idempotent 204'tür (iptal edilecek oturum yok, cookie yine temizlenir).
/// </summary>
public sealed class LogoutEndpointTests : IDisposable
{
    private static readonly DateTimeOffset Now = new(2026, 8, 21, 12, 0, 0, TimeSpan.Zero);

    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly RefreshTokenService _service;

    public LogoutEndpointTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
        _service = new RefreshTokenService(_db);
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }

    private async Task<Guid> CreateUserAsync()
    {
        var user = Domain.Entities.AppUser.Create($"{Guid.CreateVersion7():N}@test.local", "Test User", Now);
        _db.Users.Add(user);
        await _db.SaveChangesAsync();
        return user.Id;
    }

    /// <summary>Gerçek Cookie başlığı taşıyan istek — tarayıcının göndereceği biçimin aynısı.</summary>
    private static DefaultHttpContext HttpContextWithRefreshCookie(string? rawToken)
    {
        var http = new DefaultHttpContext();
        if (rawToken is not null)
        {
            http.Request.Headers.Cookie = $"{AuthEndpoints.RefreshCookieName}={rawToken}";
        }

        return http;
    }

    [Fact]
    public async Task Logout_RevokesOnlyTheCookieDevice_AndClearsTheCookie()
    {
        var userId = await CreateUserAsync();
        var (rawPhone, phoneToken) = await _service.IssueAsync(userId, Now);
        var (rawDesktop, desktopToken) = await _service.IssueAsync(userId, Now);

        var http = HttpContextWithRefreshCookie(rawPhone);
        var result = await AuthEndpoints.Logout(_service, TimeProvider.System, http, CancellationToken.None);

        Assert.IsType<NoContent>(result);

        // Telefonun token'ı iptal, masaüstününki AKTİF (negatif kontrol: per-device'ın özü).
        var stored = await _db.RefreshTokens.AsNoTracking().ToListAsync();
        Assert.NotNull(stored.Single(t => t.Id == phoneToken.Id).RevokedAt);
        Assert.Null(stored.Single(t => t.Id == desktopToken.Id).RevokedAt);

        // Masaüstü rotasyona devam edebilir — çıkış theft-detection'a dönüşmedi.
        var rotation = await _service.RotateAsync(rawDesktop, Now.AddMinutes(1));
        Assert.True(rotation.Success);

        // Yanıt cookie'yi siler (Path'li Set-Cookie ile boş/expired değer).
        var setCookie = http.Response.Headers.SetCookie.ToString();
        Assert.Contains(AuthEndpoints.RefreshCookieName, setCookie);
        Assert.Contains("expires=", setCookie, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Logout_WithoutACookie_IsIdempotent204_AndRevokesNothing()
    {
        var userId = await CreateUserAsync();
        var (_, token) = await _service.IssueAsync(userId, Now);

        var http = HttpContextWithRefreshCookie(null);
        var result = await AuthEndpoints.Logout(_service, TimeProvider.System, http, CancellationToken.None);

        Assert.IsType<NoContent>(result);
        var stored = await _db.RefreshTokens.AsNoTracking().SingleAsync(t => t.Id == token.Id);
        Assert.Null(stored.RevokedAt); // hiçbir oturuma dokunulmadı
    }

    [Fact]
    public async Task Logout_WithAForeignGarbageCookie_Returns204_AndTouchesNoSession()
    {
        // Uydurma bir token değeriyle çıkış: sessiz no-op — 401 sızıntısı da yok (uç,
        // token'ın var olup olmadığını dışarıya söylemez).
        var userId = await CreateUserAsync();
        var (_, token) = await _service.IssueAsync(userId, Now);

        var http = HttpContextWithRefreshCookie("definitely-not-a-token");
        var result = await AuthEndpoints.Logout(_service, TimeProvider.System, http, CancellationToken.None);

        Assert.IsType<NoContent>(result);
        var stored = await _db.RefreshTokens.AsNoTracking().SingleAsync(t => t.Id == token.Id);
        Assert.Null(stored.RevokedAt);
    }
}
