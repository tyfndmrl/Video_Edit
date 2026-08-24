using System.Diagnostics;
using System.Globalization;

namespace VideoEdit.Media.Waveform;

/// <summary>
/// ffmpeg `-vn -ac 1 -ar 8000 -f s16le pipe:1` PCM akışını STREAMING okuyup
/// WaveformPeaksBuilder ile 50 peak/sn JSON üretir (backlog kararı: audiowaveform binary'si
/// YOK, pencereleme .NET içinde). stdout PCM taşıdığı için FfmpegRunner'ın -progress kanalı
/// kullanılamaz; inaktivite watchdog'u okuma başına 120 sn zaman aşımıyla sağlanır.
/// ÇIKTI SAATİ TAVANI da -progress'siz kurulur: PCM bayt sayısı zaten çıktı saatinin
/// kendisidir (8000 Hz × 2 B örnek = 16000 B/sn) — beklenen süre biliniyorsa
/// <see cref="FfmpegRunner.OutputTimeCeilingUs"/> payı bayta çevrilir ve aşan süreç öldürülür
/// (kaçak: durmadan PCM basan süreç okuma zaman aşımını ASLA tetiklemez).
/// Sıfır-dışı exit → FfmpegFailedException (deterministik; retry'sız Failed yolu).
/// </summary>
public sealed class WaveformGenerator(FfmpegOptions options)
{
    public static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(120);
    private const int StderrTailCapacity = 8 * 1024;

    /// <summary>Reçetenin örnekleme hızı (`-ar 8000`) — bayt↔süre çevriminin tek kaynağı.</summary>
    public const int PcmSampleRate = 8000;

    /// <summary>s16le mono: örnek başına 2 bayt (`-ac 1 -f s16le`).</summary>
    public const int PcmBytesPerSample = 2;

    /// <summary>
    /// Çıktı saati tavanının bayt eşdeğeri: <see cref="FfmpegRunner.OutputTimeCeilingUs"/>
    /// (µs) × 16000 B/sn. ÖLÇÜLEREK doğrulandı (ffmpeg 8.0, gerçek korpus): PCM bayt saati
    /// beklenen süreye ya eşit çıkıyor (mp3/wav: 3,000000 sn) ya da AAC codec payıyla
    /// milisaniyeler sapıyor (48 kHz AAC kaynakta +8 ms, VFR kaynakta −10,6 ms) — %10 + 5 sn
    /// payın çok altında.
    /// </summary>
    public static long OutputByteCeiling(long expectedDurationUs) =>
        FfmpegRunner.OutputTimeCeilingUs(expectedDurationUs)
        * (PcmSampleRate * PcmBytesPerSample) / 1_000_000;

    /// <param name="inputPath">Kaynak medya (yerel dosya).</param>
    /// <param name="outputJsonPath">Üretilecek peaks JSON yolu.</param>
    /// <param name="expectedDurationUs">
    /// Beklenen ses süresi (µs) — verilirse çıktı saati tavanı kurulur. AÇIKÇA İSTENİR,
    /// kaynaktan sessizce türetilmez (FfmpegRunner.RunAsync'in outputTimeCeilingUs sözleşmesi
    /// ile aynı gerekçe). null ise yalnız okuma zaman aşımı korur (süresi bilinmeyen kaynak).
    /// </param>
    /// <param name="ct">İptal — süreç ağacı öldürülür.</param>
    public async Task GenerateAsync(
        string inputPath, string outputJsonPath,
        long? expectedDurationUs = null, CancellationToken ct = default)
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
                     "-vn", "-ac", "1",
                     "-ar", PcmSampleRate.ToString(CultureInfo.InvariantCulture),
                     "-f", "s16le", "pipe:1",
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
        var overran = false;
        var byteCeiling = expectedDurationUs is { } expectedUs ? OutputByteCeiling(expectedUs) : (long?)null;
        long totalBytes = 0;

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

            totalBytes += read;

            // ÇIKTI SAATİ TAVANI — okuma zaman aşımının göremediği hal: kaçak süreç durmadan
            // PCM bastığı için hiç "sessiz" kalmaz. Bayt saati tavanı aşınca süreç ağacı
            // öldürülür; pipe geri-basıncı sayesinde yazan taraf bu anda hâlâ canlıdır
            // (tavanın ötesinde en fazla pipe tamponu kadar ilerlemiş olabilir).
            if (byteCeiling is { } ceiling && totalBytes > ceiling)
            {
                overran = true;
                TryKill(process);
                break;
            }

            builder.AddPcmBytes(buffer.AsSpan(0, read));
        }

        await process.WaitForExitAsync(CancellationToken.None);
        await stderrTask;
        ct.ThrowIfCancellationRequested();

        var tail = stderrTail.ToString();
        if (overran)
        {
            throw new FfmpegFailedException(
                "ffmpeg kept producing PCM past the expected audio duration "
                + $"(expected {expectedDurationUs} us; ceiling {byteCeiling} bytes) and was stopped.",
                exitCode: -1, tail, overran: true);
        }

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
