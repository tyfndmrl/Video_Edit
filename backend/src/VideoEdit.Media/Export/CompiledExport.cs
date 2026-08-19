using VideoEdit.Media.Recipes;

namespace VideoEdit.Media.Export;

/// <summary>
/// Compiler'ın klip başına asset kaynağı hakkında bilmesi gerekenler. Path worker'ın LRU
/// cache'indeki yerel orijinal dosyadır; renk alanları indirilen dosyanın ffprobe'undan gelir
/// (HDR tespiti + ColorChain.ForSource için — rendering-semantics §6.2).
/// </summary>
/// <param name="Path">Worker'ın LRU cache'indeki YEREL dosya yolu (indirilmiş orijinal).</param>
/// <param name="HasAudio">Kaynakta ses akışı var mı — ses zincirinin kurulup kurulmayacağını belirler.</param>
/// <param name="ColorTransfer">ffprobe <c>color_trc</c>; HDR tespiti ve <c>ColorChain.ForSource</c> girdisi.</param>
/// <param name="ColorPrimaries">ffprobe <c>color_primaries</c>; aynı iki kararın ikinci girdisi.</param>
/// <param name="SourceWidth">
/// Kaynağın ROTATION UYGULANMIŞ genişliği (ffprobe; <c>MediaProbe.Width</c>). OPSİYONELDİR:
/// yalnız DEJENERELİK kapısını (<see cref="LayerGeometry.IsDegenerate"/>) besler, üretilen
/// filtergraph'ı HİÇBİR biçimde etkilemez — geometri kaynaktan bağımsız kalır (§2.5). Bilinmiyorsa
/// (null/0) kapı ATLANIR; "ölçüm yokluğu yanlış ret üretmez" presedanı metin ölçümündekiyle aynıdır.
/// </param>
/// <param name="SourceHeight"><inheritdoc cref="SourceWidth" path="/node()"/></param>
public sealed record ExportAssetSource(
    string Path,
    bool HasAudio,
    string? ColorTransfer,
    string? ColorPrimaries,
    int? SourceWidth = null,
    int? SourceHeight = null)
{
    public bool IsHdr => ColorChain.IsHdr(ColorTransfer, ColorPrimaries);
}

/// <summary>
/// Metin/şekil klibi için sunucuda üretilmiş overlay rasteri (SkiaSharp PNG — tasarım 04 §3,
/// rendering-semantics §7). Compiler bunu GÖRSEL klip gibi <c>-loop 1 -t</c> ile açar.
/// <para>
/// <see cref="NaturalWidthPx"/>/<see cref="NaturalHeightPx"/> = rasterin PROJE ÇIKTI
/// PİKSELİNDEKİ boyutu, yani <c>scale = 1</c> iken kaç piksel yer kaplayacağı. Raster hattının
/// bildirdiği bbox'tır (<c>VideoEdit.Media.Text.RasterResult.BboxWidthPx/BboxHeightPx</c>);
/// PNG dosyasının kendisi §7'nin @Nx kuralı gereği bunun <c>RasterScale</c> katıdır ve bu
/// çarpan compiler'ı İLGİLENDİRMEZ — tek doğruluk kaynağı bbox'tır (raster hattı tavan
/// nedeniyle çarpanı düşürebilir; sabit bir 2 varsayımı o durumda katmanı yanlış boyutlandırırdı).
/// Yerleşim kuralının normatif tanımı <c>VideoEdit.Media.Text.OverlayRasterPlacement</c>'tadır:
/// <c>w_d = bboxWidthPx * transform.scale</c>.
/// </para>
/// <para>
/// Bu boyut ölçek kutusunun TABANIDIR (LayerGeometry'nin fit parametresi): metin katmanı tuvale
/// fit=contain ile sığdırılSAYDI <c>fontSizePx</c> anlamsızlaşırdı — her punto aynı ekran
/// boyutunu verirdi. Değerler KESİRLİDİR: kutu <c>roundHalfUp(bbox * scale)</c> ile TEK
/// yuvarlamada üretilir (önce bbox'ı yuvarlamak raster hattının DrawBox'ıyla 1 px ayrışırdı).
/// </para>
/// </summary>
/// <param name="Path">Sunucuda üretilmiş overlay PNG'sinin yerel dosya yolu.</param>
/// <param name="NaturalWidthPx">
/// Rasterin PROJE ÇIKTI PİKSELİNDEKİ genişliği (bbox), yani <c>scale = 1</c> iken kapladığı yer.
/// Ölçek kutusunun tabanıdır; PNG dosyasının kendi piksel genişliği DEĞİLDİR.
/// </param>
/// <param name="NaturalHeightPx"><inheritdoc cref="NaturalWidthPx" path="/node()"/></param>
/// <param name="SourceWidth">
/// PNG DOSYASININ gerçek piksel genişliği (<c>RasterResult.Width</c> = bbox × rasterScale) —
/// <paramref name="NaturalWidthPx"/> ile karıştırılmamalıdır, o PROJE pikselindeki bbox'tır.
/// Yalnız dejenerelik kapısını besler; bilinmiyorsa kapı atlanır (bkz. <see cref="ExportAssetSource"/>).
/// </param>
/// <param name="SourceHeight"><inheritdoc cref="SourceWidth" path="/node()"/></param>
public sealed record ExportRasterSource(
    string Path,
    double NaturalWidthPx,
    double NaturalHeightPx,
    int? SourceWidth = null,
    int? SourceHeight = null);

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
