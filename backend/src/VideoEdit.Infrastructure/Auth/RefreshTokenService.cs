using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Domain.Entities;

namespace VideoEdit.Infrastructure.Auth;

public enum RefreshFailure
{
    /// <summary>Token bulunamadı veya biçimsiz.</summary>
    NotFound,

    /// <summary>Token süresi dolmuş.</summary>
    Expired,

    /// <summary>Revoke edilmiş token tekrar kullanıldı — theft detection tetiklendi,
    /// kullanıcının TÜM refresh token'ları iptal edildi.</summary>
    ReuseDetected,
}

public sealed record RefreshRotationResult(
    bool Success,
    Guid UserId,
    string? NewRawToken,
    RefreshToken? NewToken,
    RefreshFailure? Failure)
{
    public static RefreshRotationResult Ok(Guid userId, string rawToken, RefreshToken token) =>
        new(true, userId, rawToken, token, null);

    public static RefreshRotationResult Fail(RefreshFailure failure, Guid userId = default) =>
        new(false, userId, null, null, failure);
}

public interface IRefreshTokenService
{
    /// <summary>Yeni refresh token üretir: 32 byte random → ham base64url client'a, SHA-256 hex hash DB'ye.</summary>
    Task<(string RawToken, RefreshToken Token)> IssueAsync(Guid userId, DateTimeOffset nowUtc, CancellationToken ct = default);

    /// <summary>
    /// Rotation: geçerli token revoke edilir, yenisi verilir, eski kayda ReplacedByTokenId yazılır.
    /// Revoke edilmiş token tekrar gelirse (çalıntı şüphesi) kullanıcının tüm token'ları iptal edilir.
    /// </summary>
    Task<RefreshRotationResult> RotateAsync(string rawToken, DateTimeOffset nowUtc, CancellationToken ct = default);

    /// <summary>Kullanıcının tüm aktif refresh token'larını iptal eder (logout / theft response).</summary>
    Task RevokeAllForUserAsync(Guid userId, DateTimeOffset nowUtc, CancellationToken ct = default);
}

public sealed class RefreshTokenService(AppDbContext db) : IRefreshTokenService
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(30);

    public async Task<(string RawToken, RefreshToken Token)> IssueAsync(
        Guid userId, DateTimeOffset nowUtc, CancellationToken ct = default)
    {
        var (raw, hash) = GenerateToken();
        var token = RefreshToken.Create(userId, hash, nowUtc, Lifetime);
        db.RefreshTokens.Add(token);
        await db.SaveChangesAsync(ct);
        return (raw, token);
    }

    public async Task<RefreshRotationResult> RotateAsync(
        string rawToken, DateTimeOffset nowUtc, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(rawToken))
        {
            return RefreshRotationResult.Fail(RefreshFailure.NotFound);
        }

        var hash = Hash(rawToken);
        var existing = await db.RefreshTokens.SingleOrDefaultAsync(t => t.TokenHash == hash, ct);
        if (existing is null)
        {
            return RefreshRotationResult.Fail(RefreshFailure.NotFound);
        }

        if (existing.RevokedAt is not null)
        {
            // Theft detection: rotate edilmiş (revoke edilmiş) token tekrar kullanıldı.
            // Zincirin tamamı tehlikede kabul edilir — kullanıcının tüm token'ları iptal.
            await RevokeAllForUserAsync(existing.UserId, nowUtc, ct);
            return RefreshRotationResult.Fail(RefreshFailure.ReuseDetected, existing.UserId);
        }

        if (existing.ExpiresAt <= nowUtc)
        {
            return RefreshRotationResult.Fail(RefreshFailure.Expired, existing.UserId);
        }

        var (raw, newHash) = GenerateToken();
        var replacement = RefreshToken.Create(existing.UserId, newHash, nowUtc, Lifetime);

        // ATOMİK revoke: UPDATE ... WHERE Id = @id AND RevokedAt IS NULL.
        // İki eşzamanlı rotation isteğinden yalnız biri satırı günceller; kaybeden 0 satır
        // görür — token o anda başka istek tarafından kullanılmış demektir → theft-detection.
        var claimed = await db.RefreshTokens
            .Where(t => t.Id == existing.Id && t.RevokedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(t => t.RevokedAt, nowUtc)
                .SetProperty(t => t.ReplacedByTokenId, replacement.Id), ct);

        if (claimed == 0)
        {
            await RevokeAllForUserAsync(existing.UserId, nowUtc, ct);
            return RefreshRotationResult.Fail(RefreshFailure.ReuseDetected, existing.UserId);
        }

        // Tracked kopyayı DB ile senkronla (ExecuteUpdate change tracker'ı atlar).
        // OriginalValues da senkronlanır ki SaveChanges ikinci bir UPDATE üretmesin
        // (State=Unchanged ataması current değerleri original'a resetler — önce eşitle).
        existing.RevokedAt = nowUtc;
        existing.ReplacedByTokenId = replacement.Id;
        var entry = db.Entry(existing);
        entry.OriginalValues.SetValues(entry.CurrentValues);
        entry.State = EntityState.Unchanged;

        db.RefreshTokens.Add(replacement);
        await db.SaveChangesAsync(ct);

        return RefreshRotationResult.Ok(existing.UserId, raw, replacement);
    }

    public async Task RevokeAllForUserAsync(Guid userId, DateTimeOffset nowUtc, CancellationToken ct = default)
    {
        var active = await db.RefreshTokens
            .Where(t => t.UserId == userId && t.RevokedAt == null)
            .ToListAsync(ct);
        foreach (var token in active)
        {
            token.RevokedAt = nowUtc;
        }

        await db.SaveChangesAsync(ct);
    }

    private static (string Raw, string Hash) GenerateToken()
    {
        Span<byte> bytes = stackalloc byte[32];
        RandomNumberGenerator.Fill(bytes);
        var raw = Base64Url.EncodeToString(bytes);
        return (raw, Hash(raw));
    }

    private static string Hash(string raw) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));
}
