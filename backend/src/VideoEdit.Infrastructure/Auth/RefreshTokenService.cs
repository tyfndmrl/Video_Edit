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

    /// <summary>ROTASYONLA iptal edilmiş (halefi olan) token tekrar kullanıldı — theft
    /// detection tetiklendi, kullanıcının TÜM refresh token'ları iptal edildi.</summary>
    ReuseDetected,

    /// <summary>HALEFSİZ iptal edilmiş token (per-device logout ya da RevokeAllForUser)
    /// tekrar kullanıldı. Bu bir zincir çatallanması DEĞİLDİR — korunacak canlı halef yok;
    /// düz 401 verilir, theft cascade TETİKLENMEZ (per-device logout vaadi: öteki cihazlar
    /// açık kalır; logout'la yarışan benign bir refresh tüm oturumları DÜŞÜREMEZ).</summary>
    Revoked,
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
    /// ROTASYONLA iptal edilmiş (halefi olan) token tekrar gelirse çalıntı şüphesidir —
    /// kullanıcının tüm token'ları iptal edilir. HALEFSİZ iptal edilmiş (logout) token'ın
    /// tekrarı ise düz 401'dir: cascade yok (bkz. <see cref="RefreshFailure.Revoked"/>).
    /// </summary>
    Task<RefreshRotationResult> RotateAsync(string rawToken, DateTimeOffset nowUtc, CancellationToken ct = default);

    /// <summary>
    /// PER-DEVICE logout: yalnız verilen ham token'ın kaydını iptal eder — kullanıcının diğer
    /// cihazlarındaki oturumlara DOKUNMAZ. Token bulunamadıysa/zaten iptalse sessiz no-op
    /// (false döner); theft-detection TETİKLENMEZ — bu, token'ın sahibi tarafından İLK ve
    /// meşru kullanımıdır, bir yeniden-kullanım değil. İptalden SONRA aynı ham token refresh'e
    /// gelirse düz 401 alır (halefi olmayan iptal — cascade YOK; "tek cihazdan çıkış" vaadi
    /// logout'la yarışan bir refresh yüzünden "tüm cihazlardan çıkış"a tırmanamaz).
    /// </summary>
    Task<bool> RevokeAsync(string rawToken, DateTimeOffset nowUtc, CancellationToken ct = default);

    /// <summary>
    /// Kullanıcının TÜM aktif refresh token'larını iptal eder. Logout artık BUNU KULLANMAZ
    /// (per-device RevokeAsync kullanır); bu metot theft response için ve ileride şifre
    /// değişimi ("tüm cihazlardan çıkış") için durur.
    /// </summary>
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
            // İptal edilmiş token'ın tekrar kullanımı. KİMİN iptal ettiği ayrımı modelde
            // zaten var (denetim bulgusu — logout'la iptal edilen token halefsizdir):
            //  - ReplacedByTokenId != null → ROTASYONLA iptal: zincirin canlı bir halefi
            //    var ve bu token'ı iki taraf birden kullanmış demektir (çalıntı şüphesi) —
            //    zincirin tamamı tehlikede kabul edilir, kullanıcının tüm token'ları iptal.
            //  - ReplacedByTokenId == null → LOGOUT/RevokeAll ile iptal: halef yok,
            //    korunacak oturum da yok. Replay düz 401 alır; "tek cihazdan çıkış"
            //    özelliğinin içinde tüm cihazları düşüren gizli bir kapı bırakılmaz
            //    (çok cihaz + poll'lu refresh'in logout'la yarışı benign bir tekrardır).
            if (existing.ReplacedByTokenId is null)
            {
                return RefreshRotationResult.Fail(RefreshFailure.Revoked, existing.UserId);
            }

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
            // Yarışı kaybettik — KİME kaybettiğimiz önemli. Satırın taze halini oku
            // (AsNoTracking: identity map'teki stale kopyayı DEĞİL, DB'dekini görür):
            //  - halef yazılmışsa yarışı eşzamanlı bir ROTATION kazandı → zincir çatallandı,
            //    theft yanıtı;
            //  - halef yoksa yarışı bir LOGOUT (ya da RevokeAll) kazandı → logout'la yarışan
            //    meşru refresh'tir, tek cihazın kapanışı yeter; cascade YOK.
            var current = await db.RefreshTokens.AsNoTracking()
                .SingleOrDefaultAsync(t => t.Id == existing.Id, ct);
            if (current?.ReplacedByTokenId is null)
            {
                return RefreshRotationResult.Fail(RefreshFailure.Revoked, existing.UserId);
            }

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

    public async Task<bool> RevokeAsync(string rawToken, DateTimeOffset nowUtc, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(rawToken))
        {
            return false;
        }

        // Atomik tekil iptal (RotateAsync'teki claim deseninin aynısı): yalnız hâlâ aktif
        // satır güncellenir. ReplacedByTokenId YAZILMAZ — bu bir rotation değil, oturum
        // kapanışıdır; zincir kaydında "yenisi yok" olarak görünür.
        var hash = Hash(rawToken);
        var revoked = await db.RefreshTokens
            .Where(t => t.TokenHash == hash && t.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.RevokedAt, nowUtc), ct);
        return revoked == 1;
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
