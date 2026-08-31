using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Api.Auth;
using VideoEdit.Contracts;
using VideoEdit.Infrastructure;

namespace VideoEdit.Api.Hubs;

/// <summary>
/// Canlı iş ilerlemesi hub'ı (tasarım 03 §5 — <c>/hubs/progress</c>). İstemci gruba abone
/// olur, mesajlar worker → Redis → <see cref="RedisProgressForwarder"/> → grup yoluyla akar;
/// hub'ın kendisi hiçbir veri ÜRETMEZ, yalnız abonelik kapısıdır. Polling
/// (<c>GET /api/jobs/{id}</c> ve liste uçları) YEDEK olarak aynen çalışır — hub düşerse
/// istemci ona döner; kalıcı doğruluk kaynağı her zaman Jobs satırıdır.
/// <para>
/// SAHİPLİK KAPISI (IDOR matrisinin hub'a uzantısı — CrossUserAccessTests.Hub_*): abonelik
/// istekleri REST uçlarıyla AYNI filtreyi sorar (iş için <c>Jobs.RequestedBy == userId</c>,
/// asset işleme için <c>Assets.OwnerId == userId</c> + soft-delete). Ret, REST'in 404
/// semantiğinin aynasıdır: kaynağın VARLIĞI da sızdırılmaz — "bulunamadı ya da size ait
/// değil" tek cümledir, 403/404 ayrımı yoktur. Grup adları tahmin edilebilir olduğu İÇİN bu
/// kapı zorunludur: kapısız <c>job:{id}</c> aboneliği, id'yi bilen herkese başkasının iş
/// durumunu (hata mesajları dahil) canlı yayınlardı.
/// </para>
/// <para>
/// Kimlik: JWT, YALNIZ bu hub yolunda query-string'den kabul edilir (WebSocket handshake
/// başlık taşıyamaz — Program.cs <c>OnMessageReceived</c>, log redact notuyla birlikte).
/// <c>[Authorize]</c> + uç kaydındaki <c>RequireAuthorization</c> çifti: anonim bağlantı
/// negotiate'te 401 alır, hub metotlarına hiç ulaşmaz.
/// </para>
/// </summary>
[Authorize]
public sealed class JobProgressHub(AppDbContext db) : Hub
{
    /// <summary>
    /// Ret mesajı — REST 404'ünün hub karşılığı: varlık/sahiplik ayrımı sızdırılmaz.
    /// </summary>
    public const string NotFoundMessage = "İş ya da medya bulunamadı (ya da size ait değil).";

    /// <summary>Bir export işinin <c>job:{id}</c> grubuna abone olur (sahiplik kapılı).</summary>
    public async Task SubscribeJob(Guid jobId)
    {
        var userId = Context.User?.GetUserId()
            ?? throw new HubException("Kimlik doğrulanmadı.");
        var owns = await db.Jobs.AsNoTracking()
            .AnyAsync(j => j.Id == jobId && j.RequestedBy == userId, Context.ConnectionAborted);
        if (!owns)
        {
            throw new HubException(NotFoundMessage);
        }

        await Groups.AddToGroupAsync(
            Context.ConnectionId, JobProgressChannel.JobGroup(jobId), Context.ConnectionAborted);
    }

    /// <summary>
    /// Bir asset'in işleme ilerlemesi için <c>asset:{id}</c> grubuna abone olur. Ayrı metot,
    /// çünkü ProcessAsset işinin id'si istemciye hiç dönmez (upload complete cevabı yalnız
    /// durum taşır) — istemcinin elindeki tek kimlik asset id'sidir. Kapı, asset uçlarıyla
    /// aynı filtredir: sahiplik + soft-delete.
    /// </summary>
    public async Task SubscribeAsset(Guid assetId)
    {
        var userId = Context.User?.GetUserId()
            ?? throw new HubException("Kimlik doğrulanmadı.");
        var owns = await db.Assets.AsNoTracking()
            .AnyAsync(a => a.Id == assetId && a.OwnerId == userId && a.DeletedAt == null,
                Context.ConnectionAborted);
        if (!owns)
        {
            throw new HubException(NotFoundMessage);
        }

        await Groups.AddToGroupAsync(
            Context.ConnectionId, JobProgressChannel.AssetGroup(assetId), Context.ConnectionAborted);
    }

    /// <summary>
    /// Abonelikten çıkar. Kapı YOK ve bu bilinçli: yalnız çağıranın KENDİ bağlantısı
    /// (<c>Context.ConnectionId</c>) gruptan düşer — başkasının aboneliğine dokunulamaz,
    /// üye olunmayan gruptan çıkmak zararsız no-op'tur.
    /// </summary>
    public Task UnsubscribeJob(Guid jobId) =>
        Groups.RemoveFromGroupAsync(
            Context.ConnectionId, JobProgressChannel.JobGroup(jobId), Context.ConnectionAborted);

    /// <summary>Asset grubundan çıkar (aynı gerekçeyle kapısız).</summary>
    public Task UnsubscribeAsset(Guid assetId) =>
        Groups.RemoveFromGroupAsync(
            Context.ConnectionId, JobProgressChannel.AssetGroup(assetId), Context.ConnectionAborted);
}
