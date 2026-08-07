using System.Diagnostics;

namespace VideoEdit.Media.Waveform;

/// <summary>
/// ffmpeg `-vn -ac 1 -ar 8000 -f s16le pipe:1` PCM akışını STREAMING okuyup
/// WaveformPeaksBuilder ile 50 peak/sn JSON üretir (backlog kararı: audiowaveform binary'si
/// YOK, pencereleme .NET içinde). stdout PCM taşıdığı için FfmpegRunner'ın -progress kanalı
/// kullanılamaz; inaktivite watchdog'u okuma başına 120 sn zaman aşımıyla sağlanır.
/// Sıfır-dışı exit → FfmpegFailedException (deterministik; retry'sız Failed yolu).
/// </summary>
public sealed class WaveformGenerator(FfmpegOptions options)
{
    public static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(120);
    private const int StderrTailCapacity = 8 * 1024;

    public async Task GenerateAsync(string inputPath, string outputJsonPath, CancellationToken ct = default)
    {
        var psi = new ProcessStartInfo
        {
            FileName = options.FfmpegPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in (string[])
                 [
                     "-hide_banner", "-nostats", "-i", inputPath,
                     "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1",
                 ])
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = new Process { StartInfo = psi };
        process.Start();
        await using var cancelRegistration = ct.Register(() => TryKill(process));

        // FfmpegRunner ile paylaşılan tail buffer — sınırsız ReadToEnd yerine son ~8 KB tutulur.
        var stderrTail = new ProcessTailBuffer(StderrTailCapacity);
        var stderrTask = ProcessTailBuffer.PumpAsync(process.StandardError, stderrTail);

        var builder = new WaveformPeaksBuilder();
        var buffer = new byte[64 * 1024];
        var stdout = process.StandardOutput.BaseStream;
        var timedOut = false;

        while (true)
        {
            int read;
            using (var readCts = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                readCts.CancelAfter(ReadTimeout);
                try
                {
                    read = await stdout.ReadAsync(buffer, readCts.Token);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    // İnaktivite watchdog'u: 120 sn boyunca PCM gelmedi → süreci öldür.
                    timedOut = true;
                    TryKill(process);
                    break;
                }
            }

            if (read == 0)
            {
                break;
            }

            builder.AddPcmBytes(buffer.AsSpan(0, read));
        }

        await process.WaitForExitAsync(CancellationToken.None);
        await stderrTask;
        ct.ThrowIfCancellationRequested();

        var tail = stderrTail.ToString();
        if (timedOut)
        {
            throw new FfmpegFailedException(
                "ffmpeg produced no PCM output within the watchdog timeout.",
                exitCode: -1, tail, timedOut: true);
        }

        if (process.ExitCode != 0)
        {
            throw new FfmpegFailedException(
                $"ffmpeg PCM extraction failed (exit {process.ExitCode}).",
                process.ExitCode, tail);
        }

        await using var output = File.Create(outputJsonPath);
        builder.WriteJson(output);
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
