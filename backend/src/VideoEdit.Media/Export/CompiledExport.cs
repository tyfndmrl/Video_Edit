using VideoEdit.Media.Recipes;

namespace VideoEdit.Media.Export;

/// <summary>
/// Compiler'ın klip başına asset kaynağı hakkında bilmesi gerekenler. Path worker'ın LRU
/// cache'indeki yerel orijinal dosyadır; renk alanları indirilen dosyanın ffprobe'undan gelir
/// (HDR tespiti + ColorChain.ForSource için — rendering-semantics §6.2).
/// </summary>
public sealed record ExportAssetSource(
    string Path,
    bool HasAudio,
    string? ColorTransfer,
    string? ColorPrimaries)
{
    public bool IsHdr => ColorChain.IsHdr(ColorTransfer, ColorPrimaries);
}

/// <summary>
/// Tek ffmpeg girişi: input-level trim (tasarım 04 §2.1 — daima -ss + -t, ASLA -to;
/// aynı asset'ten N klip = N ayrı giriş). Saniye literal'leri TimeFormat.Sec ile
/// InvariantCulture üretilir.
/// <para>
/// <see cref="Loop"/> = GÖRSEL (still image) girişidir: dosyada zaman ekseni yoktur, tek kare
/// <c>-loop 1</c> ile çoğaltılır ve <c>-t</c> ile sınırlanır. Seek anlamsız olduğu için
/// <c>-ss</c> ÜRETİLMEZ (PosterRecipe'teki "tek karelik girişte seek kareyi kaçırır" kuralıyla
/// aynı gerekçe); kesin kare sayısını zincirdeki <c>trim=end_frame</c> garanti eder.
/// </para>
/// </summary>
public sealed record ExportInput(
    string Path, long SourceStartUs, long SourceDurationUs, bool Loop = false)
{
    public string StartSec => TimeFormat.Sec(SourceStartUs);
    public string DurationSec => TimeFormat.Sec(SourceDurationUs);

    public IEnumerable<string> ToArgs() => Loop
        ? ["-loop", "1", "-t", DurationSec, "-i", Path]
        : ["-ss", StartSec, "-t", DurationSec, "-i", Path];
}

/// <summary>
/// Deterministik derleme çıktısı: girişler + filtergraph script içeriği (worker dosyaya yazar
/// ve -filter_complex_script ile verir — tasarım 04 §1, komut satırı limiti) + çıktı
/// argümanları. Aynı doküman + aynı kaynaklar → bayt-bayt aynı çıktı (snapshot testleri).
/// </summary>
public sealed record CompiledExport(
    IReadOnlyList<ExportInput> Inputs,
    string FilterGraphScript,
    IReadOnlyList<string> OutputArgs,
    long ExpectedDurationUs)
{
    /// <summary>
    /// Tam ffmpeg argüman listesi (FfmpegRunner -hide_banner/-nostats/-progress'i kendisi ekler).
    /// scriptPath, FilterGraphScript'in yazıldığı dosyadır; outputPath son argümandır.
    /// </summary>
    public IReadOnlyList<string> ToFfmpegArgs(string scriptPath, string outputPath)
    {
        var args = new List<string> { "-y", "-nostdin" };
        foreach (var input in Inputs)
        {
            args.AddRange(input.ToArgs());
        }

        args.Add("-filter_complex_script");
        args.Add(scriptPath);
        args.AddRange(OutputArgs);
        args.Add(outputPath);
        return args;
    }
}
