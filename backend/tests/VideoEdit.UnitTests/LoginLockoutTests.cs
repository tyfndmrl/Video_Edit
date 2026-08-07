using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using VideoEdit.Api.Endpoints;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;

namespace VideoEdit.UnitTests;

/// <summary>
/// AuthEndpoints.AuthenticateAsync lockout davranışı: başarısız şifre denemeleri
/// AccessFailedAsync ile sayılır, eşik aşılınca hesap kilitlenir (doğru şifre bile geçmez),
/// başarılı giriş sayacı sıfırlar. Tüm başarısızlıklar null döner (generic 401 → hesap
/// varlığı/kilit durumu sızdırılmaz).
/// </summary>
public sealed class LoginLockoutTests : IDisposable
{
    private const string Email = "lockout@test.local";
    private const string Password = "Correct#Horse1";
    private const int MaxFailedAttempts = 3;

    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly UserManager<AppUser> _users;

    public LoginLockoutTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
        _users = CreateUserManager(_db);
    }

    public void Dispose()
    {
        _users.Dispose();
        _db.Dispose();
        _connection.Dispose();
    }

    private static UserManager<AppUser> CreateUserManager(AppDbContext db)
    {
        var options = new IdentityOptions();
        options.User.RequireUniqueEmail = true;
        options.Lockout.AllowedForNewUsers = true;
        options.Lockout.MaxFailedAccessAttempts = MaxFailedAttempts;
        options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);

        return new UserManager<AppUser>(
            new UserStore<AppUser, IdentityRole<Guid>, AppDbContext, Guid>(db),
            Options.Create(options),
            new PasswordHasher<AppUser>(),
            [new UserValidator<AppUser>()],
            [new PasswordValidator<AppUser>()],
            new UpperInvariantLookupNormalizer(),
            new IdentityErrorDescriber(),
            services: null!,
            NullLogger<UserManager<AppUser>>.Instance);
    }

    private async Task<AppUser> CreateUserAsync()
    {
        var user = AppUser.Create(Email, "Lockout Test", DateTimeOffset.UtcNow);
        var result = await _users.CreateAsync(user, Password);
        Assert.True(result.Succeeded, string.Join("; ", result.Errors.Select(e => e.Description)));
        return user;
    }

    [Fact]
    public async Task UnknownEmail_ReturnsNull()
    {
        Assert.Null(await AuthEndpoints.AuthenticateAsync(_users, "nobody@test.local", Password));
    }

    [Fact]
    public async Task WrongPassword_CountsFailure_AndLocksOutAfterThreshold()
    {
        var user = await CreateUserAsync();

        for (var attempt = 1; attempt <= MaxFailedAttempts; attempt++)
        {
            Assert.Null(await AuthEndpoints.AuthenticateAsync(_users, Email, "wrong-password"));
        }

        // Eşik aşıldı → hesap kilitli.
        Assert.True(await _users.IsLockedOutAsync(user));

        // Kilitliyken DOĞRU şifre bile giremez (generic başarısızlık: null).
        Assert.Null(await AuthEndpoints.AuthenticateAsync(_users, Email, Password));
    }

    [Fact]
    public async Task SuccessfulLogin_ResetsAccessFailedCount()
    {
        var user = await CreateUserAsync();

        // Eşiğin altında başarısız denemeler.
        Assert.Null(await AuthEndpoints.AuthenticateAsync(_users, Email, "wrong-password"));
        Assert.Null(await AuthEndpoints.AuthenticateAsync(_users, Email, "wrong-password"));
        Assert.Equal(2, await _users.GetAccessFailedCountAsync(user));

        // Başarılı giriş: kullanıcı döner ve sayaç sıfırlanır.
        var authenticated = await AuthEndpoints.AuthenticateAsync(_users, Email, Password);
        Assert.NotNull(authenticated);
        Assert.Equal(user.Id, authenticated.Id);
        Assert.Equal(0, await _users.GetAccessFailedCountAsync(user));
        Assert.False(await _users.IsLockedOutAsync(user));
    }
}
