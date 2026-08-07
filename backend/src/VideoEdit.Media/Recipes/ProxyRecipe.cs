using VideoEdit.Media.Probing;

namespace VideoEdit.Media.Recipes;

/// <summary>
/// Scrubbing-dostu proxy reçetesi (tasarım 02 §3.3 — NORMATİF) + M1 eklemeleri:
///  - 540p hedef, ama ASLA UPSCALE edilmez: kaynağın kısa kenarı ≤ 540 ise scale atlanır
///    (240p kaynağa scale=-2:540 uygulamak upscale ederdi — reçete kuralı);
///  - VFR kaynak nominal CFR'a sabitlenir (fps filtresi ZORUNLU; CFR kaynağa fps eklenmez);
///  - HDR kaynakta scale'den ÖNCE ColorChain.HdrToSdr (normatif sabit — M3 export aynısını kullanır);
///  - dikey videoda kısa kenar (genişlik) 540'a hedeflenir;
///  - `-g 15 -keyint_min 15 -sc_threshold 0 -bf 0`: yarım saniyede IDR + B-frame yok —
///    tarayıcı scrubbing'inin kritik parametresi (tasarım 02 tuzak #11, entegrasyon testli);
///  - ses yoksa ses argümanları hiç üretilmez; audio-only asset için ayrı AAC/m4a reçetesi.
/// Bütün metotlar SAF'tır (process yok) — komut satırı snapshot testleriyle sabitlenir.
/// </summary>
public static class ProxyRecipe
{
    /// <summary>Proxy kısa-kenar hedefi (tasarım 02 §3.3 gerekçesi: önizleme penceresi ~800-1000 px).</summary>
    public const int TargetShortSide = 540;

    /// <summary>-vf zinciri; filtre gerekmiyorsa (SDR + küçük + CFR + çift boyut) boş string.</summary>
    public static string BuildVideoFilter(MediaProbe probe)
    {
        var filters = new List<string>();

        if (probe.IsHdr)
        {
            filters.Add(ColorChain.ForSource(probe.ColorTransfer));
        }

        var shortSide = Math.Min(probe.Width, probe.Height);
        if (shortSide > TargetShortSide)
        {
            // Dikey: 540 kısa kenara (genişliğe) uygulanır — tasarım 02 §3.3 varyantı birebir.
            filters.Add(probe.Height > probe.Width
                ? "scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)':flags=bicubic"
                : "scale=-2:540:flags=bicubic");
        }
        else if (probe.Width % 2 != 0 || probe.Height % 2 != 0)
        {
            // Upscale yok ama yuv420p/libx264 çift boyut ister — tek satır aşağı hizala.
            filters.Add("scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=bicubic");
        }

        if (probe.IsVfr)
        {
            var (num, den) = NominalCfr.FromAvg(probe.AvgFpsNum, probe.AvgFpsDen);
            filters.Add($"fps={TimeFormat.Fps(num, den)}");
        }

        return string.Join(',', filters);
    }

    /// <summary>Video asset proxy'si: H.264 540p mp4 (+faststart).</summary>
    public static IReadOnlyList<string> BuildVideoArgs(MediaProbe probe, string inputPath, string outputPath)
    {
        var args = new List<string> { "-y", "-i", inputPath };

        // Deterministik stream seçimi: probe'un seçtiği video (attached_pic değil) + ilk ses.
        if (probe.VideoStreamIndex >= 0)
        {
            args.Add("-map");
            args.Add($"0:{probe.VideoStreamIndex.ToString(System.Globalization.CultureInfo.InvariantCulture)}");
        }

        if (probe.HasAudio && probe.AudioStreamIndex >= 0)
        {
            args.Add("-map");
            args.Add($"0:{probe.AudioStreamIndex.ToString(System.Globalization.CultureInfo.InvariantCulture)}");
        }

        var filter = BuildVideoFilter(probe);
        if (filter.Length > 0)
        {
            args.Add("-vf");
            args.Add(filter);
        }

        args.AddRange([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "main",
            "-pix_fmt", "yuv420p",
            "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-bf", "0",
        ]);

        if (probe.HasAudio)
        {
            args.AddRange(["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"]);
        }

        args.AddRange(["-movflags", "+faststart", outputPath]);
        return args;
    }

    /// <summary>
    /// Audio-only asset proxy'si: AAC 128k stereo 48 kHz m4a (video zinciri yok; -vn kapak
    /// resmini de dışarıda bırakır). Image asset için proxy ÜRETİLMEZ.
    /// </summary>
    public static IReadOnlyList<string> BuildAudioArgs(string inputPath, string outputPath) =>
    [
        "-y", "-i", inputPath, "-vn",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
        "-movflags", "+faststart",
        outputPath,
    ];
}
