using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using Xunit;

namespace VideoEdit.UnitTests;

public class AssetTransitionTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 6, 12, 0, 0, TimeSpan.Zero);

    private static readonly HashSet<(AssetStatus From, AssetStatus To)> ValidTransitions =
    [
        (AssetStatus.Uploading, AssetStatus.Uploaded),
        (AssetStatus.Uploading, AssetStatus.Failed),
        (AssetStatus.Uploaded, AssetStatus.Processing),
        (AssetStatus.Uploaded, AssetStatus.Failed),
        (AssetStatus.Processing, AssetStatus.Ready),
        (AssetStatus.Processing, AssetStatus.Failed),
        (AssetStatus.Failed, AssetStatus.Processing),
    ];

    private static Asset NewAsset(AssetStatus status)
    {
        var asset = Asset.Create(Guid.CreateVersion7(), AssetKind.Video, "clip.mp4", "video/mp4", 1024, Now);
        asset.Status = status;
        return asset;
    }

    [Fact]
    public void FullTransitionMatrix_MatchesStateMachine()
    {
        var statuses = Enum.GetValues<AssetStatus>();
        foreach (var from in statuses)
        {
            foreach (var to in statuses)
            {
                var asset = NewAsset(from);
                if (ValidTransitions.Contains((from, to)))
                {
                    asset.TransitionTo(to, Now);
                    Assert.Equal(to, asset.Status);
                }
                else
                {
                    var ex = Assert.Throws<DomainException>(() => asset.TransitionTo(to, Now));
                    Assert.Contains($"{from} -> {to}", ex.Message);
                    Assert.Equal(from, asset.Status); // durum değişmemeli
                }
            }
        }
    }

    [Fact]
    public void HappyPath_UploadingToReady_StampsReadyAt()
    {
        var asset = NewAsset(AssetStatus.Uploading);
        asset.TransitionTo(AssetStatus.Uploaded, Now);
        asset.TransitionTo(AssetStatus.Processing, Now);
        Assert.Null(asset.ReadyAt);
        asset.TransitionTo(AssetStatus.Ready, Now);
        Assert.Equal(AssetStatus.Ready, asset.Status);
        Assert.Equal(Now, asset.ReadyAt);
    }

    [Fact]
    public void Ready_IsTerminal()
    {
        var asset = NewAsset(AssetStatus.Ready);
        foreach (var to in Enum.GetValues<AssetStatus>())
        {
            Assert.Throws<DomainException>(() => asset.TransitionTo(to, Now));
        }
    }

    [Fact]
    public void SameStateTransition_Throws()
    {
        foreach (var status in Enum.GetValues<AssetStatus>())
        {
            var asset = NewAsset(status);
            Assert.Throws<DomainException>(() => asset.TransitionTo(status, Now));
        }
    }

    [Fact]
    public void Fail_SetsReason_AndRetryClearsIt()
    {
        var asset = NewAsset(AssetStatus.Processing);
        asset.Fail("ffprobe could not parse the file", Now);

        Assert.Equal(AssetStatus.Failed, asset.Status);
        Assert.Equal("ffprobe could not parse the file", asset.FailureReason);

        asset.TransitionTo(AssetStatus.Processing, Now); // retry
        Assert.Equal(AssetStatus.Processing, asset.Status);
        Assert.Null(asset.FailureReason);
    }

    [Fact]
    public void TransitionToProcessing_StampsProcessingStartedAt()
    {
        var asset = NewAsset(AssetStatus.Uploaded);
        Assert.Null(asset.ProcessingStartedAt);

        asset.TransitionTo(AssetStatus.Processing, Now);
        Assert.Equal(Now, asset.ProcessingStartedAt);
    }

    [Fact]
    public void Retry_FailedToProcessing_RestampsProcessingStartedAt()
    {
        // Reaper'ın "stalled" saati her Processing girişinde yenilenmeli — eski damga
        // kalsaydı retry edilen asset anında yeniden stalled sayılırdı.
        var first = Now;
        var second = Now.AddHours(2);

        var asset = NewAsset(AssetStatus.Uploaded);
        asset.TransitionTo(AssetStatus.Processing, first);
        asset.Fail("ffmpeg crashed", first);
        asset.TransitionTo(AssetStatus.Processing, second); // retry

        Assert.Equal(second, asset.ProcessingStartedAt);
        Assert.Null(asset.FailureReason);
    }

    [Theory]
    [InlineData("stalled")]  // reaper: 30 dk'dan uzun Processing
    [InlineData("expired")]  // reaper: 7 günden eski Uploading
    [InlineData("aborted")]  // kullanıcı iptali
    public void Fail_ReaperAndAbortReasons_AreValidFromLifecycleStates(string reason)
    {
        var uploading = NewAsset(AssetStatus.Uploading);
        uploading.Fail(reason, Now);
        Assert.Equal(AssetStatus.Failed, uploading.Status);
        Assert.Equal(reason, uploading.FailureReason);

        var processing = NewAsset(AssetStatus.Processing);
        processing.Fail(reason, Now);
        Assert.Equal(AssetStatus.Failed, processing.Status);
        Assert.Equal(reason, processing.FailureReason);
    }

    [Fact]
    public void Create_IsUserScoped_WithUserScopedStorageKey()
    {
        var ownerId = Guid.CreateVersion7();
        var asset = Asset.Create(ownerId, AssetKind.Video, "My Video.MP4", "video/mp4", 123, Now);

        Assert.Equal(AssetStatus.Uploading, asset.Status);
        Assert.Equal(ownerId, asset.OwnerId);
        Assert.StartsWith($"u/{ownerId}/a/{asset.Id}/original/", asset.StorageKey);
    }
}
