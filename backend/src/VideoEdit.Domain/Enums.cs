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

    /// <summary>
    /// 3D LUT (.cube) — MEDYA DEĞİLDİR: ffprobe'dan geçmez, proxy/filmstrip/waveform/poster
    /// türevi üretilmez; worker yalnız metin doğrulaması yapar (LUT_3D_SIZE + veri satırları,
    /// bkz. CubeLutValidator) ve doğrudan Ready'ye alır. Timeline'a klip olarak KONAMAZ —
    /// yalnız <c>lut</c> efektinin <c>assetId</c>'si olarak kullanılır.
    /// </summary>
    Lut = 3,
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
