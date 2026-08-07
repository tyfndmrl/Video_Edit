using System.Globalization;
using VideoEdit.Media.Probing;

namespace VideoEdit.Media.Recipes;

/// <summary>
/// Poster/thumbnail reçetesi: t = min(1 sn, duration×0.1) noktasından 1 kare, kaynak aspect
/// korunur, genişlik en fazla 1280 (küçük kaynak upscale EDİLMEZ), JPEG q=4.
/// HDR kaynakta ColorChain uygulanır — poster proxy/export ile aynı SDR görünümünde olsun.
/// Image asset'te -ss kullanılmaz (tek karelik girişte seek kareyi kaçırabilir).
/// </summary>
public static class PosterRecipe
{
    public const int MaxWidth = 1280;

    /// <summary>t = min(1_000_000 µs, durationUs/10); duration bilinmiyorsa 0.</summary>
    public static long PosterTimeUs(long? durationUs) =>
        durationUs is { } d ? Math.Min(1_000_000L, d / 10) : 0;

    /// <summary>Filtre zinciri; SDR + genişlik ≤ 1280 ise null (filtre gerekmez).</summary>
    public static string? BuildFilter(MediaProbe probe)
    {
        var filters = new List<string>();
        if (probe.IsHdr)
        {
            filters.Add(ColorChain.ForSource(probe.ColorTransfer));
        }

        if (probe.Width > MaxWidth)
        {
            filters.Add($"scale={MaxWidth.ToString(CultureInfo.InvariantCulture)}:-2:flags=bicubic");
        }

        return filters.Count > 0 ? string.Join(',', filters) : null;
    }

    /// <summary>Video asset posteri (t noktasından hızlı seek — -ss girişten önce).</summary>
    public static IReadOnlyList<string> BuildVideoArgs(MediaProbe probe, string inputPath, string outputPath)
    {
        var args = new List<string> { "-y" };
        var t = PosterTimeUs(probe.DurationUs);
        if (t > 0)
        {
            args.AddRange(["-ss", TimeFormat.Sec(t)]);
        }

        args.AddRange(["-i", inputPath]);
        if (probe.VideoStreamIndex >= 0)
        {
            args.Add("-map");
            args.Add($"0:{probe.VideoStreamIndex.ToString(CultureInfo.InvariantCulture)}");
        }

        args.AddRange(["-frames:v", "1"]);
        if (BuildFilter(probe) is { } filter)
        {
            args.AddRange(["-vf", filter]);
        }

        args.AddRange(["-q:v", "4", outputPath]);
        return args;
    }

    /// <summary>Image asset posteri/thumb'ı — seek yok, tek kare zaten girişin kendisi.</summary>
    public static IReadOnlyList<string> BuildImageArgs(MediaProbe probe, string inputPath, string outputPath)
    {
        var args = new List<string> { "-y", "-i", inputPath, "-frames:v", "1" };
        if (BuildFilter(probe) is { } filter)
        {
            args.AddRange(["-vf", filter]);
        }

        args.AddRange(["-q:v", "4", outputPath]);
        return args;
    }
}
