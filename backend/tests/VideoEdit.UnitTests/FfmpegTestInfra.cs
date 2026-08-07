using System.Diagnostics;
using System.Text.Json;

namespace VideoEdit.UnitTests;

/// <summary>
/// ffmpeg/ffprobe PATH'te yoksa atlanır (CI'da medya araçları kurulmamışsa testler
/// kırmızıya düşmez, Skip olur). Lokalde ffmpeg 8 PATH'te — testler koşar.
/// </summary>
public sealed class FfmpegFactAttribute : FactAttribute
{
    internal static readonly bool Available = CheckAvailable();

    public FfmpegFactAttribute()
    {
        if (!Available)
        {
            Skip = "ffmpeg/ffprobe not found on PATH — install ffmpeg to run.";
        }
    }

    private static bool CheckAvailable()
    {
        try
        {
            return RunsOk("ffmpeg") && RunsOk("ffprobe");
        }
        catch
        {
            return false;
        }

        static bool RunsOk(string exe)
        {
            var psi = new ProcessStartInfo
            {
                FileName = exe,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add("-version");
            using var process = Process.Start(psi);
            if (process is null)
            {
                return false;
            }

            return process.WaitForExit(10_000) && process.ExitCode == 0;
        }
    }
}

/// <summary>Uçtan uca pipeline testi: hem MinIO hem ffmpeg gerekir.</summary>
public sealed class MinioAndFfmpegFactAttribute : FactAttribute
{
    public MinioAndFfmpegFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MINIO_AVAILABLE")))
        {
            Skip = "MINIO_AVAILABLE is not set — start MinIO (compose.dev.yml) and set MINIO_AVAILABLE=1 to run.";
        }
        else if (!FfmpegFactAttribute.Available)
        {
            Skip = "ffmpeg/ffprobe not found on PATH — install ffmpeg to run.";
        }
    }
}

/// <summary>
/// Sentetik test medyası (lavfi testsrc/sine) — tembel üretilir, collection boyunca cache'lenir.
/// </summary>
public sealed class FfmpegTestMediaFixture : IDisposable
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, string> _cache = [];

    public string Dir { get; } = Directory.CreateTempSubdirectory("videoedit-media-tests-").FullName;

    /// <summary>
    /// 3 sn, 320×240 @30fps H.264 + 440 Hz sinüs AAC 48 kHz.
    /// lavfi sine'ın varsayılan genliği düşüktür (~0.13 FS) — waveform peak testinin anlamlı
    /// eşik kullanabilmesi için volume=5 ile ~0.65 FS'e yükseltilir.
    /// </summary>
    public string Video320x240WithAudio() => GetOrCreate("v320.mp4",
    [
        "-y",
        "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-af", "volume=5",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000",
        "-shortest",
    ]);

    /// <summary>3 sn, 1280×720 @30fps H.264, SESSİZ.</summary>
    public string Video1280x720NoAudio() => GetOrCreate("v720.mp4",
    [
        "-y",
        "-f", "lavfi", "-i", "testsrc=duration=3:size=1280x720:rate=30",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]);

    /// <summary>3 sn 440 Hz sinüs WAV (audio-only asset senaryosu).</summary>
    public string AudioWav() => GetOrCreate("tone.wav",
    [
        "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=44100",
        "-c:a", "pcm_s16le",
    ]);

    private string GetOrCreate(string fileName, string[] argsWithoutOutput)
    {
        lock (_lock)
        {
            if (_cache.TryGetValue(fileName, out var cached))
            {
                return cached;
            }

            var path = Path.Combine(Dir, fileName);
            var psi = new ProcessStartInfo
            {
                FileName = "ffmpeg",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            foreach (var arg in argsWithoutOutput)
            {
                psi.ArgumentList.Add(arg);
            }

            psi.ArgumentList.Add(path);

            using var process = Process.Start(psi)
                ?? throw new InvalidOperationException("could not start ffmpeg");
            var stderr = process.StandardError.ReadToEnd();
            if (!process.WaitForExit(60_000) || process.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    $"test media generation failed ({fileName}): {stderr}");
            }

            _cache[fileName] = path;
            return path;
        }
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(Dir, recursive: true);
        }
        catch
        {
            // best-effort temp temizliği
        }
    }
}

[CollectionDefinition("ffmpeg-media")]
public sealed class FfmpegMediaCollection : ICollectionFixture<FfmpegTestMediaFixture>;

/// <summary>Testlerin ffprobe JSON çekmesi için ortak yardımcı.</summary>
public static class FfprobeJson
{
    public static JsonDocument Run(params string[] args)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "ffprobe",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("-v");
        psi.ArgumentList.Add("quiet");
        psi.ArgumentList.Add("-print_format");
        psi.ArgumentList.Add("json");
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start ffprobe");
        var stdout = process.StandardOutput.ReadToEnd();
        process.WaitForExit(30_000);
        return JsonDocument.Parse(stdout);
    }
}
