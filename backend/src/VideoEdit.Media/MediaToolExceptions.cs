namespace VideoEdit.Media;

/// <summary>
/// DETERMİNİSTİK ingest gate hatası: ffprobe dosyayı parse edemedi ya da dosyada
/// beklenen türde stream yok. Retry ANLAMSIZDIR — pipeline bu hatada asset'i
/// Failed('unsupported-media') işaretler ve Hangfire retry'ını tetiklemez.
/// </summary>
public sealed class UnsupportedMediaException(string message, string? stderrTail = null)
    : Exception(message)
{
    /// <summary>ffprobe stderr kuyruğu (varsa) — teşhis için.</summary>
    public string? StderrTail { get; } = stderrTail;
}

/// <summary>
/// DETERMİNİSTİK ffmpeg çalıştırma hatası (sıfır-dışı exit ya da watchdog kill).
/// Aynı girdiyle tekrar koşmak aynı sonucu üretir — retry'sız Failed yolu.
/// </summary>
public sealed class FfmpegFailedException(string message, int exitCode, string stderrTail, bool timedOut = false)
    : Exception(message)
{
    public int ExitCode { get; } = exitCode;

    /// <summary>stderr'in son ~8 KB'ı (FfmpegRunner ring buffer).</summary>
    public string StderrTail { get; } = stderrTail;

    /// <summary>Watchdog (120 sn progress'siz) süreci öldürdü.</summary>
    public bool TimedOut { get; } = timedOut;
}
