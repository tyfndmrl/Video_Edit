namespace VideoEdit.Domain;

/// <summary>Asset durum makinesi: Uploading → Uploaded → Processing → Ready | Failed. Failed → Processing (retry).</summary>
public enum AssetStatus
{
    Uploading = 0,
    Uploaded = 1,
    Processing = 2,
    Ready = 3,
    Failed = 4,
}

public enum AssetKind
{
    Video = 0,
    Audio = 1,
    Image = 2,
}

public enum RevisionKind
{
    Auto = 0,
    Checkpoint = 1,
    PreRestore = 2,
}

public enum JobType
{
    ProcessAsset = 0,
    Export = 1,
}

public enum JobStatus
{
    Queued = 0,
    Running = 1,
    Succeeded = 2,
    Failed = 3,
    Canceled = 4,
}
