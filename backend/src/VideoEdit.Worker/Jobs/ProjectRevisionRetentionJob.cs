using Hangfire;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Domain;
using VideoEdit.Infrastructure;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// ProjectRevisions retention işi (recurring, saatte bir — Program.cs'te registre edilir;
/// AssetReaperJob deseninin ikinci recurring işi). Tasarım 03 §"Snapshot politikası"nın
/// bugüne dek hiç yazılmamış retention yarısı: ProjectRevisions sınırsız büyüyordu
/// (poc-bilinen-sinirlar §4.3).
/// <para>
/// KURAL (yalnız <see cref="RevisionKind.Auto"/> kayıtlar; parametreler
/// <see cref="RevisionRetentionOptions"/>):
///  - proje başına EN YENİ KeepLatestAuto (varsayılan 50) Auto snapshot her koşulda kalır;
///  - ThinOlderThan'dan (varsayılan 24 sa) GENÇ Auto kayıtlar son-50 dışında da kalır
///    (yoğun bir günün geçmişi aynı gün silinmez — yaşlanınca kovaya düşer);
///  - daha eskiler ThinBucket (varsayılan 1 sa) kovalarına inceltilir: kovada zaten tutulan
///    bir kayıt (son-50'den, genç-koruma'dan ya da kovanın en yenisi) varsa gerisi silinir.
/// KULLANICININ VERSİYON GEÇMİŞİ ÖZELLİĞİ BOZULMAZ: <see cref="RevisionKind.Checkpoint"/>
/// (adlandırılmış/manuel nokta — tasarım: süresiz) ve <see cref="RevisionKind.PreRestore"/>
/// (restore'un TEK kurtarma yolu) sorguya HİÇ girmez, silinemez. Export bu tabloyu okumaz
/// (Jobs.TimelineSnapshot kendi kopyasını taşır) — silme koşan/sıradaki işi etkilemez.
/// </para>
/// </summary>
public sealed class ProjectRevisionRetentionJob(
    AppDbContext db,
    ILogger<ProjectRevisionRetentionJob> logger,
    TimeProvider clock,
    RevisionRetentionOptions options)
{
    /// <summary>Seçicinin girdisi — Timeline jsonb'u BİLEREK yüklenmez (satırlar MB'lık olabilir).</summary>
    internal readonly record struct AutoRevisionMeta(
        Guid Id, Guid ProjectId, long RevisionNumber, DateTimeOffset CreatedAt);

    // Reaper'la aynı kuyruk: worker yalnız "transcode" dinler; retention hafif bir DB işidir.
    [Queue("transcode")]
    public async Task Run(CancellationToken ct)
    {
        options.Validate();
        var now = clock.GetUtcNow();

        // Yalnız Auto meta çekilir (tarih aritmetiği İSTEMCİ tarafında — AssetReaperJob'la
        // aynı gerekçe: Sqlite test provider'ı DateTimeOffset karşılaştırmasını çeviremez).
        var autos = await db.ProjectRevisions.AsNoTracking()
            .Where(r => r.Kind == RevisionKind.Auto)
            .Select(r => new AutoRevisionMeta(r.Id, r.ProjectId, r.RevisionNumber, r.CreatedAt))
            .ToListAsync(ct);

        var doomed = SelectAutoRevisionsToDelete(autos, now, options);
        if (doomed.Count == 0)
        {
            return;
        }

        // Kind şartı silme sorgusunda da durur: seçici yanlışlıkla Auto-olmayan bir id
        // üretse bile (regresyon) Checkpoint/PreRestore satırı DB'den gidemez.
        var deleted = await db.ProjectRevisions
            .Where(r => doomed.Contains(r.Id) && r.Kind == RevisionKind.Auto)
            .ExecuteDeleteAsync(ct);

        logger.LogInformation(
            "Revision retention: {Deleted} auto snapshot inceltildi ({Scanned} auto tarandı, "
            + "etkin: {Effective}).", deleted, autos.Count, options.DescribeEffective());
    }

    /// <summary>
    /// SAF seçici — birim testli yüzey (<c>RevisionRetentionJobTests</c>). Proje başına,
    /// revizyon numarası azalan sırada tek geçiş: ilk KeepLatestAuto kayıt tutulur; genç
    /// (ThinOlderThan'dan yeni) kayıt tutulur; kalan eski kayıt, SAAT KOVASI daha önce
    /// (hangi nedenle tutulmuş olursa olsun bir kayıtla) görüldüyse silinir, görülmediyse
    /// kovanın temsilcisi olarak tutulur (azalan sıra = kovanın EN YENİSİ kalır).
    /// </summary>
    internal static List<Guid> SelectAutoRevisionsToDelete(
        IReadOnlyList<AutoRevisionMeta> autos, DateTimeOffset now, RevisionRetentionOptions options)
    {
        var doomed = new List<Guid>();
        var youngCutoff = now - options.ThinOlderThan;

        foreach (var project in autos.GroupBy(r => r.ProjectId))
        {
            var ordered = project.OrderByDescending(r => r.RevisionNumber).ToList();
            var seenBuckets = new HashSet<long>();
            for (var i = 0; i < ordered.Count; i++)
            {
                var rev = ordered[i];
                var bucket = rev.CreatedAt.UtcTicks / options.ThinBucket.Ticks;
                if (i < options.KeepLatestAuto || rev.CreatedAt >= youngCutoff)
                {
                    seenBuckets.Add(bucket); // tutulan kayıt kovasını da temsil eder
                    continue;
                }

                if (!seenBuckets.Add(bucket))
                {
                    doomed.Add(rev.Id); // kovanın temsilcisi zaten var — incelt
                }
            }
        }

        return doomed;
    }
}
