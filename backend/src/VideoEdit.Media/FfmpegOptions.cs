namespace VideoEdit.Media;

/// <summary>
/// ffmpeg/ffprobe binary konumları. Varsayılan PATH'ten çözülür; Docker imajında da
/// PATH'te oldukları için override gerekmez. Worker config'inden ("Ffmpeg" section)
/// bind edilir — Media projesi saf kalsın diye Options-altyapısız düz POCO'dur.
/// </summary>
public sealed class FfmpegOptions
{
    public const string SectionName = "Ffmpeg";

    public string FfmpegPath { get; set; } = "ffmpeg";
    public string FfprobePath { get; set; } = "ffprobe";
}
