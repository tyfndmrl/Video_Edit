using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Auth;
using Xunit;

namespace VideoEdit.UnitTests;

public sealed class RefreshTokenServiceTests : IDisposable
{
    private static readonly DateTimeOffset Now = new(2026, 8, 6, 12, 0, 0, TimeSpan.Zero);

    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly RefreshTokenService _service;

    public RefreshTokenServiceTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(_connection)
            .Options;
        _db = new AppDbContext(options);
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

    [Fact]
    public async Task Issue_StoresSha256Hash_NeverRawToken()
    {
        var userId = await CreateUserAsync();
        var (raw, token) = await _service.IssueAsync(userId, Now);

        Assert.NotEqual(raw, token.TokenHash);
        Assert.Equal(
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))),
            token.TokenHash);
        Assert.Equal(Now + RefreshTokenService.Lifetime, token.ExpiresAt);
        Assert.Null(token.RevokedAt);

        var stored = await _db.RefreshTokens.SingleAsync();
        Assert.Equal(token.TokenHash, stored.TokenHash);
    }

    [Fact]
    public async Task Rotate_RevokesOld_IssuesNew_AndLinksChain()
    {
        var userId = await CreateUserAsync();
        var (raw, old) = await _service.IssueAsync(userId, Now);

        var result = await _service.RotateAsync(raw, Now.AddMinutes(10));

        Assert.True(result.Success);
        Assert.Equal(userId, result.UserId);
        Assert.NotNull(result.NewRawToken);
        Assert.NotEqual(raw, result.NewRawToken);

        var oldStored = await _db.RefreshTokens.SingleAsync(t => t.Id == old.Id);
        Assert.NotNull(oldStored.RevokedAt);
        Assert.Equal(result.NewToken!.Id, oldStored.ReplacedByTokenId);

        var newStored = await _db.RefreshTokens.SingleAsync(t => t.Id == result.NewToken.Id);
        Assert.Null(newStored.RevokedAt);
    }

    [Fact]
    public async Task Rotate_ReusedRevokedToken_TriggersTheftDetection_RevokesAllUserTokens()
    {
        var userId = await CreateUserAsync();
        var (raw1, _) = await _service.IssueAsync(userId, Now);

        // Normal rotation: raw1 revoke edilir, raw2 verilir.
        var rotation = await _service.RotateAsync(raw1, Now.AddMinutes(1));
        Assert.True(rotation.Success);

        // Çalıntı senaryosu: revoke edilmiş raw1 tekrar kullanılıyor.
        var theft = await _service.RotateAsync(raw1, Now.AddMinutes(2));

        Assert.False(theft.Success);
        Assert.Equal(RefreshFailure.ReuseDetected, theft.Failure);

        // Kullanıcının TÜM token'ları (yeni verilen dahil) iptal edilmiş olmalı.
        var tokens = await _db.RefreshTokens.Where(t => t.UserId == userId).ToListAsync();
        Assert.Equal(2, tokens.Count);
        Assert.All(tokens, t => Assert.NotNull(t.RevokedAt));

        // Ve artık en son verilen token da kullanılamaz (revoked → yine theft path'i).
        var afterTheft = await _service.RotateAsync(rotation.NewRawToken!, Now.AddMinutes(3));
        Assert.False(afterTheft.Success);
    }

    [Fact]
    public async Task Rotate_LostRace_AtomicGuardReturnsZeroRows_TriggersTheftDetection()
    {
        // Yarış senaryosu: iki istek aynı refresh token ile eşzamanlı rotation dener.
        // Revoke adımı atomik (UPDATE ... WHERE Id = @id AND RevokedAt IS NULL) olduğu için
        // yalnız biri satırı günceller; kaybeden 0 satır görür ve theft-detection'a girer.
        var userId = await CreateUserAsync();
        var (raw, _) = await _service.IssueAsync(userId, Now);
        // _db, token'ı RevokedAt == null olarak track ediyor — "istek A'nın yüklediği" stale kopya.

        // İstek B (ayrı context, aynı DB) yarışı kazanır: token'ı rotate eder.
        await using var winnerDb = CreateSecondContext();
        var winnerService = new RefreshTokenService(winnerDb);
        var winner = await winnerService.RotateAsync(raw, Now.AddMinutes(1));
        Assert.True(winner.Success);

        // İstek A: identity map'teki stale kopya ön kontrolü geçirir (RevokedAt == null görür),
        // ama atomik UPDATE 0 satır döndürür → ReuseDetected + kullanıcının TÜM token'ları iptal.
        var loser = await _service.RotateAsync(raw, Now.AddMinutes(1));
        Assert.False(loser.Success);
        Assert.Equal(RefreshFailure.ReuseDetected, loser.Failure);
        Assert.Equal(userId, loser.UserId);

        await using var verifyDb = CreateSecondContext();
        var tokens = await verifyDb.RefreshTokens.Where(t => t.UserId == userId).ToListAsync();
        Assert.Equal(2, tokens.Count); // orijinal + kazananın yeni token'ı
        Assert.All(tokens, t => Assert.NotNull(t.RevokedAt));

        // Kazananın yeni token'ı da artık kullanılamaz olmalı.
        var afterTheft = await winnerService.RotateAsync(winner.NewRawToken!, Now.AddMinutes(2));
        Assert.False(afterTheft.Success);
    }

    private AppDbContext CreateSecondContext() =>
        new(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);

    [Fact]
    public async Task Rotate_ExpiredToken_Fails()
    {
        var userId = await CreateUserAsync();
        var (raw, _) = await _service.IssueAsync(userId, Now);

        var result = await _service.RotateAsync(raw, Now + RefreshTokenService.Lifetime + TimeSpan.FromSeconds(1));

        Assert.False(result.Success);
        Assert.Equal(RefreshFailure.Expired, result.Failure);
    }

    [Fact]
    public async Task Rotate_UnknownToken_Fails()
    {
        var result = await _service.RotateAsync("not-a-real-token", Now);
        Assert.False(result.Success);
        Assert.Equal(RefreshFailure.NotFound, result.Failure);
    }

    [Fact]
    public async Task RevokeAllForUser_OnlyTouchesThatUser()
    {
        var user1 = await CreateUserAsync();
        var user2 = await CreateUserAsync();
        await _service.IssueAsync(user1, Now);
        await _service.IssueAsync(user1, Now);
        var (_, other) = await _service.IssueAsync(user2, Now);

        await _service.RevokeAllForUserAsync(user1, Now.AddMinutes(1));

        var user1Tokens = await _db.RefreshTokens.Where(t => t.UserId == user1).ToListAsync();
        Assert.All(user1Tokens, t => Assert.NotNull(t.RevokedAt));

        var user2Token = await _db.RefreshTokens.SingleAsync(t => t.Id == other.Id);
        Assert.Null(user2Token.RevokedAt);
    }
}
