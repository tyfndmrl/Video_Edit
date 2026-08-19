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

/// <summary><see cref="FfmpegFactAttribute"/>'ın Theory karşılığı (aynı Skip kuralı).</summary>
public sealed class FfmpegTheoryAttribute : TheoryAttribute
{
    public FfmpegTheoryAttribute()
    {
        if (!FfmpegFactAttribute.Available)
        {
            Skip = "ffmpeg/ffprobe not found on PATH — install ffmpeg to run.";
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

    /// <summary>
    /// 2 sn, 320×240 @30fps HAREKETLİ sentetik kaynak + 440 Hz sinüs — GOLDEN FRAME kaynağı.
    /// testsrc2 deterministiktir (sistem fontu/freetype KULLANMAZ — desenler gömülüdür) ve her
    /// karesi farklıdır; statik smptebars'ın aksine kesim sınırındaki ±1 frame kaymaları golden
    /// karşılaştırmasında GÖRÜNÜR (rendering-semantics §9.2 n_cut-1/n_cut örneklemesi bunun
    /// üstüne kuruludur).
    /// </summary>
    public string Video320x240Moving2sWithAudio() => GetOrCreate("moving2s.mp4",
    [
        "-y",
        "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x240:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-af", "volume=5",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000",
        "-shortest",
    ]);

    /// <summary>
    /// 2 sn, 320×240 @30fps DÜZ RENK (0x804020 — testsrc2 paletinde bulunmayan kahverengi),
    /// SESSİZ. Çok katman golden testlerinin "üst katman" kaynağı: düz renk olduğu için
    /// bindirilen dikdörtgenin sınırları piksel-kesin ölçülebilir.
    /// </summary>
    public string VideoSolid320x240NoAudio() => GetOrCreate("solid2s.mp4",
    [
        "-y",
        "-f", "lavfi", "-i", "color=c=0x804020:size=320x240:rate=30:duration=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]);

    /// <summary>
    /// 2 sn, 240×240 @30fps DÜZ RENK (0x804020), SESSİZ — KARE kaynak. Kutuya normalize eden
    /// pad'in İKİ EKSENDE birden çalıştığı tek aspect budur: 16:9 kaynak 16:9 kutuda yatayda
    /// no-op, 4:3 kaynak 4:3 kutuda tamamen no-op'tur; kare kaynak dikdörtgen kutuda hem sol/sağ
    /// hem üst/alt payı üretir. Pad ofsetinin tam bölünüp bölünmediği ancak burada görünür.
    /// </summary>
    public string VideoSolid240x240NoAudio() => GetOrCreate("solid-square.mp4",
    [
        "-y",
        "-f", "lavfi", "-i", "color=c=0x804020:size=240x240:rate=30:duration=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]);

    /// <summary>
    /// 2 sn, 180×320 @30fps DÜZ RENK (0x804020), SESSİZ — DİKEY (9:16) kaynak.
    /// <para>
    /// Kutuya normalize eden pad'in YATAY payı ancak burada BÜYÜKTÜR: 4:3 tuvalde 16:9 ve 4:3
    /// kaynak kutuyu yatayda doldurur (pay 0), kare kaynak dar bir pay bırakır, dikey kaynak ise
    /// kutunun yarısından fazlasını paya çevirir. Pad'li ve pad'siz yolun AYNI pikselleri boyayıp
    /// boyamadığı (rendering-semantics §5.2) bu yüzden dikey kaynakta en geniş pencerede sınanır —
    /// mevcut üç aspect ölçek > 1'de bu pencereyi hiç açmıyordu.
    /// </para>
    /// </summary>
    public string VideoSolid180x320NoAudio() => GetOrCreate("solid-vertical.mp4",
    [
        "-y",
        "-f", "lavfi", "-i", "color=c=0x804020:size=180x320:rate=30:duration=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]);

    /// <summary>
    /// 2 sn, 320×16 @30fps DÜZ RENK (0x804020), SESSİZ — AFİŞ/PANORAMA kaynağı (en-boy 20:1).
    /// DEJENERELİK rejiminin tek gerçek tetikleyicisi budur: 320×240 tuvalde ölçek 0.060 iken
    /// kutu 19×14 olur ve sığdırılan yükseklik 0.95 px'e düşer → ffmpeg o ekseni 0 hesaplar,
    /// 0'ı "girdi boyutunu koru" diye yorumlar ve katmanı 18×16 çizer (gerçek ffmpeg 8.0 ile
    /// ölçüldü: 16.7 KAT yüksek). Normal oranlı medya (16:9, 4:3, kare) hiçbir ölçekte bu
    /// rejime giremez — bu yüzden dejenerelik testleri AYRI bir kaynak ister.
    /// </summary>
    public string VideoBanner320x16NoAudio() => GetOrCreate("banner-320x16.mp4",
    [
        "-y",
        "-f", "lavfi", "-i", "color=c=0x804020:size=320x16:rate=30:duration=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]);

    /// <summary>
    /// 2 sn, 320×240 @30fps SMPTE renk çubukları, SESSİZ. DOYGUN renkler + SERT dikey kenarlar
    /// taşır: kompozisyon zincirinde RGB↔YUV gidiş-dönüşü olursa (M4 denetim #1) hata burada
    /// en büyük genliğe ulaşır — düz renk kaynak bu sınıf hatayı zayıf gösterir.
    /// </summary>
    public string VideoBars320x240NoAudio() => GetOrCreate("bars2s.mp4",
    [
        "-y",
        "-f", "lavfi", "-i", "smptebars=size=320x240:rate=30:duration=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]);

    /// <summary>
    /// 320×240 DÜZ RENK PNG (0x2080C0 — testsrc2/smptebars paletlerinde bulunmayan bir mavi),
    /// GÖRSEL KLİP senaryosunun kaynağı. Still image'in süresi ve ses stream'i YOKTUR: export
    /// hattı bu girişi -loop 1 -t ile açar, bu yüzden "kaynak bitti" davranışı video kaynaktan
    /// farklıdır ve gerçek render'la doğrulanması ŞARTTIR (snapshot testi göremez).
    /// </summary>
    public string ImageSolid320x240Png() => GetOrCreate("photo.png",
    [
        "-y",
        "-f", "lavfi", "-i", "color=c=0x2080C0:size=320x240",
        "-frames:v", "1",
    ]);

    /// <summary>3 sn 440 Hz sinüs WAV (audio-only asset senaryosu).</summary>
    public string AudioWav() => GetOrCreate("tone.wav",
    [
        "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=44100",
        "-c:a", "pcm_s16le",
    ]);

    /// <summary>
    /// 3 sn 440 Hz sinüs AAC/M4A — KULLANICININ "müzik ekle" yolunun birebir dosyası
    /// (yükleme whitelist'inde <c>audio/mp4</c>). Genlik bilerek yükseltilir (volume=5): çıktıda
    /// "ses var mı" sorusu ancak ÖLÇÜLEBİLİR bir seviyeyle yanıtlanır — dijital sessizlik de bir
    /// ses stream'idir ve stream sayısına bakan bir test onu YEŞİL geçirirdi.
    /// </summary>
    public string AudioM4a() => GetOrCreate("music.m4a",
    [
        "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-af", "volume=5",
        "-c:a", "aac", "-ar", "48000",
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
