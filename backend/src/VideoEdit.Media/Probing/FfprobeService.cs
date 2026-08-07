using System.Diagnostics;

namespace VideoEdit.Media.Probing;

/// <summary>
/// ffprobe process'ini koşturup MediaProbeParser'a verir. Normatif komut (tasarım 02 §3.2):
/// `ffprobe -v quiet -print_format json -show_format -show_streams &lt;file&gt;`.
/// Sıfır-dışı exit / boş çıktı / parse hatası → UnsupportedMediaException (deterministik gate,
/// retry YOK). Ağ/IO burada söz konusu değildir — dosya yerel diskte olmalıdır.
/// </summary>
public sealed class FfprobeService(FfmpegOptions options)
{
    /// <summary>ffprobe normalde &lt; 2 sn sürer; asılı kalırsa (bozuk container) öldür.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);

    public async Task<MediaProbe> ProbeAsync(string filePath, CancellationToken ct = default)
    {
        var psi = new ProcessStartInfo
        {
            FileName = options.FfprobePath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("-v");
        psi.ArgumentList.Add("quiet");
        psi.ArgumentList.Add("-print_format");
        psi.ArgumentList.Add("json");
        psi.ArgumentList.Add("-show_format");
        psi.ArgumentList.Add("-show_streams");
        psi.ArgumentList.Add(filePath);

        using var process = new Process { StartInfo = psi };
        process.Start();

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(Timeout);
        await using var registration = timeoutCts.Token.Register(() => TryKill(process));

        var stdoutTask = process.StandardOutput.ReadToEndAsync(CancellationToken.None);
        var stderrTask = process.StandardError.ReadToEndAsync(CancellationToken.None);
        await process.WaitForExitAsync(CancellationToken.None);
        var stdout = await stdoutTask;
        var stderr = await stderrTask;

        ct.ThrowIfCancellationRequested();

        if (process.ExitCode != 0 || string.IsNullOrWhiteSpace(stdout))
        {
            throw new UnsupportedMediaException(
                $"ffprobe could not parse the file (exit {process.ExitCode}).",
                stderrTail: stderr.Length > 8192 ? stderr[^8192..] : stderr);
        }

        return MediaProbeParser.Parse(stdout);
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
            // Süreç bu arada bitmiş olabilir — yut.
        }
    }
}
