namespace VideoEdit.Worker.Jobs;

/// <summary>
/// Asset işleme sınırları ("Processing" config section'ı — env: Processing__MaxDurationUs).
/// </summary>
public sealed class ProcessingOptions
{
    public const string SectionName = "Processing";

    /// <summary>
    /// Kabul edilen azami medya süresi (µs). Aşan kaynak probe SONRASI, transcode ÖNCESİ
    /// Failed('too-long') olur — saatlerce ffmpeg yakılmaz. Varsayılan 4 saat.
    /// </summary>
    public long MaxDurationUs { get; set; } = 4L * 60 * 60 * 1_000_000;
}
