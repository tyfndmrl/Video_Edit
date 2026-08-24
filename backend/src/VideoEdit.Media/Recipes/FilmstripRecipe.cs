using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using VideoEdit.Media.Probing;

namespace VideoEdit.Media.Recipes;

/// <summary>filmstrip/manifest.json şeması — frontend CSS background-position ile çizer.</summary>
public sealed record FilmstripManifest
{
    [JsonPropertyName("intervalUs")] public required long IntervalUs { get; init; }
    [JsonPropertyName("tileW")] public required int TileW { get; init; }
    [JsonPropertyName("tileH")] public required int TileH { get; init; }
    [JsonPropertyName("cols")] public required int Cols { get; init; }
    [JsonPropertyName("rows")] public required int Rows { get; init; }
    [JsonPropertyName("frameCount")] public required long FrameCount { get; init; }
    [JsonPropertyName("sprites")] public required IReadOnlyList<string> Sprites { get; init; }
}

/// <summary>
/// Filmstrip sprite reçetesi (tasarım 02 §3.4): `fps=1/&lt;interval&gt;,scale=160:-2,tile=30x10`
/// → sprite başına 300 kare, çoklu sprite `sprite_%d.jpg` (1 tabanlı) + manifest.json.
/// Uzun videoda adaptif aralık: interval = max(1, ceil(durationSec/3000)) — sprite sayısı sınırlı.
/// HDR kaynakta ColorChain fps'ten SONRA, scale'den ÖNCE eklenir (görsel tutarlılık — proxy
/// ile aynı sabit; fps önce geldiği için tonemap yalnız seçilen karelere uygulanır).
/// </summary>
public static class FilmstripRecipe
{
    public const int TileWidth = 160;
    public const int Cols = 30;
    public const int Rows = 10;
    public const int FramesPerSprite = Cols * Rows; // 300

    /// <summary>interval = max(1, ceil(durationSec / 3000)) saniye.</summary>
    public static int IntervalSec(long durationUs)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(durationUs);
        var intervalSec = (long)Math.Ceiling(durationUs / 1_000_000m / 3000m);
        return (int)Math.Max(1, intervalSec);
    }

    /// <summary>Beklenen kare sayısı: ceil(duration / interval), en az 1 (t=0 karesi hep var).</summary>
    public static long FrameCount(long durationUs)
    {
        var intervalUs = IntervalSec(durationUs) * 1_000_000L;
        return Math.Max(1, (long)Math.Ceiling(durationUs / (decimal)intervalUs));
    }

    /// <summary>
    /// Tile yüksekliği: 160 genişlikte kaynak aspect'i, ÇİFT sayıya half-up yuvarlanmış
    /// (scale=160:-2'nin ürettiğiyle eşleşir; 1920×1080 → 90, 320×240 → 120).
    /// </summary>
    public static int TileHeight(int width, int height)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(width);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(height);
        var raw = (double)TileWidth * height / width;
        return (int)Math.Floor((raw / 2) + 0.5) * 2;
    }

    /// <summary>
    /// Filmstrip reçetesinin <c>-progress out_time</c> SAATİNDE beklenen azami değer (µs) —
    /// çıktı-saati tavanının (<see cref="FfmpegRunner.OutputTimeCeilingUs"/>) bu reçetedeki
    /// "beklenen süre" girdisi.
    /// <para>
    /// KAYNAK SÜRESİ DEĞİLDİR ve olamaz — ÖLÇÜLDÜ (ffmpeg 8.0, gerçek reçete argümanları):
    /// <c>tile=30x10</c> 300 kareyi tek çıktı karesine toplar ve image2 muxer'ının out_time'ı
    /// sprite başına 300×interval saniye ilerler; 2,93 sn'lik kaynakta bile out_time
    /// 300,000000 sn bildirir. Kaynak süresine bağlanan bir tavan (2,93 sn için 8,2 sn) HER
    /// filmstrip koşusunu yanlış öldürürdü. Ölçülen model dört noktada TAM eşleşti:
    /// 2,93 sn → 300 sn (1 sprite), 350 sn → 600 sn (2 sprite), 650 sn → 900 sn (3 sprite),
    /// 3010 sn (interval=2) → 3600 sn (6 sprite) — hepsi spriteSayısı × 300 × interval.
    /// </para>
    /// <para>
    /// Kaçak (durmadan kare üreten) bir koşu bu saatte de görünür: beklenenin ötesindeki her
    /// fazladan sprite out_time'ı 300×interval sn sıçratır ve tavanı (%10 + 5 sn payla) en geç
    /// ikinci fazladan sprite'ta aşar.
    /// </para>
    /// </summary>
    public static long ExpectedOutputClockUs(long durationUs)
    {
        var spriteCount = (FrameCount(durationUs) + FramesPerSprite - 1) / FramesPerSprite;
        return spriteCount * FramesPerSprite * IntervalSec(durationUs) * 1_000_000L;
    }

    public static string BuildFilter(MediaProbe probe, long durationUs)
    {
        var interval = IntervalSec(durationUs).ToString(CultureInfo.InvariantCulture);
        var pick = $"fps=1/{interval}";
        var scaleTile = $"scale={TileWidth}:-2,tile={Cols}x{Rows}";
        // Sıra bilinçli: fps ÖNCE — HDR tonemap (ColorChain) yalnız SEÇİLEN karelere uygulanır
        // (her kaynak kareye tonemap ~30× daha pahalıydı); sonra scale/tile.
        return probe.IsHdr
            ? $"{pick},{ColorChain.ForSource(probe.ColorTransfer)},{scaleTile}"
            : $"{pick},{scaleTile}";
    }

    /// <summary>outputPattern örn. "&lt;temp&gt;/sprite_%d.jpg" — ffmpeg 1'den numaralandırır.</summary>
    public static IReadOnlyList<string> BuildArgs(
        MediaProbe probe, long durationUs, string inputPath, string outputPattern)
    {
        var args = new List<string> { "-y", "-i", inputPath };
        if (probe.VideoStreamIndex >= 0)
        {
            args.Add("-map");
            args.Add($"0:{probe.VideoStreamIndex.ToString(CultureInfo.InvariantCulture)}");
        }

        args.AddRange(["-vf", BuildFilter(probe, durationUs), "-q:v", "5", outputPattern]);
        return args;
    }

    public static FilmstripManifest BuildManifest(
        MediaProbe probe, long durationUs, IReadOnlyList<string> spriteFileNames) => new()
    {
        IntervalUs = IntervalSec(durationUs) * 1_000_000L,
        TileW = TileWidth,
        TileH = TileHeight(probe.Width, probe.Height),
        Cols = Cols,
        Rows = Rows,
        FrameCount = FrameCount(durationUs),
        Sprites = spriteFileNames,
    };

    public static string SerializeManifest(FilmstripManifest manifest) =>
        JsonSerializer.Serialize(manifest);
}
