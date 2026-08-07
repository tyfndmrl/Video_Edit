using System.Diagnostics;

namespace VideoEdit.Media;

/// <summary>FfmpegRunner sonucu. Success değilse StderrTail teşhis içindir.</summary>
public sealed record FfmpegRunResult(int ExitCode, string StderrTail, bool TimedOut)
{
    public bool Success => ExitCode == 0 && !TimedOut;
}

/// <summary>
/// ffmpeg process yönetimi:
///  - argümanlar ProcessStartInfo.ArgumentList ile verilir (string birleştirme YOK —
///    boşluklu path / quoting hataları yapısal olarak imkânsız);
///  - `-progress pipe:1 -nostats` kendisi ekler, out_time_us/out_time_ms parse edip
///    (İKİSİ DE mikrosaniye) toplam süreye oranlayarak callback çağırır;
///  - stderr ring buffer'da son ~8 KB tutulur (hata teşhisi);
///  - watchdog: 120 sn boyunca hiçbir progress/stderr çıktısı yoksa süreç öldürülür;
///  - CancellationToken iptalinde Kill(entireProcessTree: true).
/// Progress callback'i stdout OKUMA DÖNGÜSÜNDEN sırayla await edilir — çağıran tarafta
/// eşzamanlılık koruması gerekmez (DbContext'e yazan callback'ler güvenlidir).
/// </summary>
public sealed class FfmpegRunner(FfmpegOptions options)
{
    public static readonly TimeSpan DefaultWatchdogTimeout = TimeSpan.FromSeconds(120);
    private const int StderrTailCapacity = 8 * 1024;

    /// <param name="args">Reçete argümanları (girdi/filtre/codec/çıktı). Runner başa
    /// -hide_banner -nostats -progress pipe:1 ekler.</param>
    /// <param name="totalDurationUs">Progress oranı için beklenen çıktı süresi (µs);
    /// null ise callback çağrılmaz.</param>
    /// <param name="onProgress">0..1 aralığında oran — stdout okuma döngüsünden seri çağrılır.</param>
    public async Task<FfmpegRunResult> RunAsync(
        IReadOnlyList<string> args,
        long? totalDurationUs = null,
        Func<double, CancellationToken, Task>? onProgress = null,
        TimeSpan? watchdogTimeout = null,
        CancellationToken ct = default)
    {
        var psi = new ProcessStartInfo
        {
            FileName = options.FfmpegPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("-hide_banner");
        psi.ArgumentList.Add("-nostats");
        psi.ArgumentList.Add("-progress");
        psi.ArgumentList.Add("pipe:1");
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = new Process { StartInfo = psi };
        process.Start();

        var lastActivityTicks = Environment.TickCount64;
        var timedOut = false;

        await using var cancelRegistration = ct.Register(() => TryKill(process));

        var stderrTail = new ProcessTailBuffer(StderrTailCapacity);
        var stderrTask = ProcessTailBuffer.PumpAsync(
            process.StandardError, stderrTail,
            () => Volatile.Write(ref lastActivityTicks, Environment.TickCount64));

        // Watchdog: periyodik kontrol; timeout'u aşan sessizlikte süreç ağacını öldür.
        var watchdogLimit = watchdogTimeout ?? DefaultWatchdogTimeout;
        using var watchdogCts = new CancellationTokenSource();
        var watchdogTask = Task.Run(async () =>
        {
            while (!watchdogCts.Token.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), watchdogCts.Token);
                }
                catch (OperationCanceledException)
                {
                    return;
                }

                var idle = TimeSpan.FromMilliseconds(
                    Environment.TickCount64 - Volatile.Read(ref lastActivityTicks));
                if (idle > watchdogLimit)
                {
                    // Yarış düzeltmesi: süreç NORMAL bitmişse (stdout EOF ↔ CancelAsync arası
                    // pencere) timedOut bayrağı SET EDİLMEZ — başarılı koşu timeout sanılmaz.
                    if (process.HasExited)
                    {
                        return;
                    }

                    timedOut = true;
                    TryKill(process);
                    return;
                }
            }
        }, CancellationToken.None);

        // stdout: -progress key=value akışı. Callback İNLİNE await edilir (seri).
        while (await process.StandardOutput.ReadLineAsync(CancellationToken.None) is { } line)
        {
            Volatile.Write(ref lastActivityTicks, Environment.TickCount64);
            if (onProgress is not null
                && totalDurationUs is > 0
                && FfmpegProgressParser.TryParseOutTimeUs(line, out var outUs))
            {
                var fraction = Math.Clamp((double)outUs / totalDurationUs.Value, 0d, 1d);
                await onProgress(fraction, ct);
            }
        }

        await process.WaitForExitAsync(CancellationToken.None);
        await watchdogCts.CancelAsync();
        await Task.WhenAll(stderrTask, watchdogTask);

        ct.ThrowIfCancellationRequested();

        return new FfmpegRunResult(process.ExitCode, stderrTail.ToString(), timedOut);
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Süreç zaten bitmiş olabilir — yut.
        }
    }

}
