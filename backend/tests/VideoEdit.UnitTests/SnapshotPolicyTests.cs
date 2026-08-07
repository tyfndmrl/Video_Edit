using VideoEdit.Domain;
using VideoEdit.Domain.Services;
using Xunit;

namespace VideoEdit.UnitTests;

public class SnapshotPolicyTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 6, 12, 0, 0, TimeSpan.Zero);
    private readonly SnapshotPolicy _policy = new();

    [Theory]
    [InlineData(RevisionKind.Checkpoint)]
    [InlineData(RevisionKind.PreRestore)]
    public void ForcedKinds_AlwaysSnapshot_EvenWithFreshSnapshot(RevisionKind kind)
    {
        // Son snapshot 1 saniye önce, 0 revision farkı olsa bile zorunlu.
        var ctx = new SnapshotDecisionContext(kind, 10, 10, Now.AddSeconds(-1), Now);
        Assert.True(_policy.ShouldSnapshot(ctx));
    }

    [Fact]
    public void NoPreviousSnapshot_Snapshots()
    {
        var ctx = new SnapshotDecisionContext(RevisionKind.Auto, 1, null, null, Now);
        Assert.True(_policy.ShouldSnapshot(ctx));
    }

    [Fact]
    public void Under20Revisions_AndUnder5Minutes_DoesNotSnapshot()
    {
        var ctx = new SnapshotDecisionContext(RevisionKind.Auto, 29, 10, Now.AddMinutes(-4), Now);
        Assert.False(_policy.ShouldSnapshot(ctx)); // 19 revision, 4 dk
    }

    [Fact]
    public void Exactly20Revisions_Snapshots()
    {
        var ctx = new SnapshotDecisionContext(RevisionKind.Auto, 30, 10, Now.AddSeconds(-10), Now);
        Assert.True(_policy.ShouldSnapshot(ctx));
    }

    [Fact]
    public void MoreThan20Revisions_Snapshots()
    {
        var ctx = new SnapshotDecisionContext(RevisionKind.Auto, 100, 10, Now.AddSeconds(-10), Now);
        Assert.True(_policy.ShouldSnapshot(ctx));
    }

    [Fact]
    public void FiveMinutesElapsed_WithAtLeastOneChange_Snapshots()
    {
        var ctx = new SnapshotDecisionContext(RevisionKind.Auto, 11, 10, Now.AddMinutes(-5), Now);
        Assert.True(_policy.ShouldSnapshot(ctx));
    }

    [Fact]
    public void FiveMinutesElapsed_ButNoChange_DoesNotSnapshot()
    {
        var ctx = new SnapshotDecisionContext(RevisionKind.Auto, 10, 10, Now.AddMinutes(-30), Now);
        Assert.False(_policy.ShouldSnapshot(ctx));
    }

    [Fact]
    public void JustUnderFiveMinutes_WithChange_DoesNotSnapshot()
    {
        var ctx = new SnapshotDecisionContext(
            RevisionKind.Auto, 11, 10, Now.AddMinutes(-5).AddSeconds(1), Now);
        Assert.False(_policy.ShouldSnapshot(ctx));
    }
}
