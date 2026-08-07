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

    /// <summary>
    /// Export orijinal LRU cache kök dizini (tasarım 04 §4.2). Boşsa OS temp altına düşer.
    /// Docker'da kalıcı volume'a (/data/cache) bağlanmalıdır.
    /// </summary>
    public string? CacheDirectory { get; set; }

    /// <summary>LRU cache tavanı (bayt) — aşınca en eski asset dizinleri silinir. Varsayılan 20 GiB.</summary>
    public long MaxCacheBytes { get; set; } = 20L * 1024 * 1024 * 1024;
}
