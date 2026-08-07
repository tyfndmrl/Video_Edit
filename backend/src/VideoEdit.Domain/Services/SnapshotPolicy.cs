namespace VideoEdit.Domain.Services;

/// <summary>
/// Snapshot kararı için bağlam. LastSnapshot* alanları proje hiç snapshot'lanmadıysa null'dır.
/// </summary>
/// <param name="Kind">Alınmak istenen snapshot'ın türü (Checkpoint/PreRestore zorunlu anlardır).</param>
/// <param name="CurrentRevisionNumber">Autosave SONRASI güncel revision numarası.</param>
/// <param name="LastSnapshotRevisionNumber">Son snapshot'ın revision numarası (yoksa null).</param>
/// <param name="LastSnapshotAt">Son snapshot'ın zamanı (yoksa null).</param>
/// <param name="NowUtc">Şimdi (UTC).</param>
public readonly record struct SnapshotDecisionContext(
    RevisionKind Kind,
    long CurrentRevisionNumber,
    long? LastSnapshotRevisionNumber,
    DateTimeOffset? LastSnapshotAt,
    DateTimeOffset NowUtc);

/// <summary>
/// Snapshot kuralı YALNIZ sunucuda yaşar (baş mimar kararı 1.c) — client checkpoint'e karışmaz.
/// </summary>
public interface ISnapshotPolicy
{
    bool ShouldSnapshot(in SnapshotDecisionContext context);
}

/// <summary>
/// Hibrit kural: (a) son snapshot'tan bu yana ≥ 20 revision, VEYA
/// (b) ≥ 5 dakika geçti VE en az 1 değişiklik var, VEYA
/// (c) Kind = Checkpoint / PreRestore (zorunlu anlar).
/// Hiç snapshot yoksa ilk fırsatta bir tane alınır (bootstrap).
/// </summary>
public sealed class SnapshotPolicy : ISnapshotPolicy
{
    public const int RevisionThreshold = 20;
    public static readonly TimeSpan TimeThreshold = TimeSpan.FromMinutes(5);

    public bool ShouldSnapshot(in SnapshotDecisionContext context)
    {
        // (c) Zorunlu anlar: manuel checkpoint ve restore öncesi.
        if (context.Kind is RevisionKind.Checkpoint or RevisionKind.PreRestore)
        {
            return true;
        }

        // Bootstrap: hiç snapshot yok.
        if (context.LastSnapshotRevisionNumber is not { } lastRevision || context.LastSnapshotAt is not { } lastAt)
        {
            return true;
        }

        var revisionsSince = context.CurrentRevisionNumber - lastRevision;

        // (a) Revision eşiği.
        if (revisionsSince >= RevisionThreshold)
        {
            return true;
        }

        // (b) Zaman eşiği + en az bir değişiklik.
        if (context.NowUtc - lastAt >= TimeThreshold && revisionsSince > 0)
        {
            return true;
        }

        return false;
    }
}
