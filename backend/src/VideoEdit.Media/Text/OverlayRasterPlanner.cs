using VideoEdit.Contracts.Timeline;

namespace VideoEdit.Media.Text;

/// <summary>Rasterlenecek tek klip: doküman sırası + hedef dosya adı.</summary>
public sealed record OverlayRasterItem(Clip Clip, Guid ClipId, int TrackIndex, string FileName);

/// <summary>
/// Bir export işi için üretilmiş overlay PNG'lerinin defteri. Dosyalar ASSET DEĞİL, İŞ
/// ARTEFAKTIDIR: job temp dizininde yaşar, iş bitince silinir ve her export'ta deterministik
/// olarak yeniden üretilir (tasarım 04 §4.2 adım 3).
/// </summary>
public sealed record OverlayRasterSet(
    string Directory,
    IReadOnlyDictionary<Guid, RasterResult> Rasters)
{
    public static OverlayRasterSet Empty { get; } =
        new(string.Empty, new Dictionary<Guid, RasterResult>());

    public int Count => Rasters.Count;

    public long TotalBytes => Rasters.Values.Sum(r => r.ByteSize);

    /// <summary>Eksik glif taşıyan klipler (emoji vb.) — worker uyarı loglar, iş DÜŞMEZ.</summary>
    public IReadOnlyList<Guid> ClipsWithMissingGlyphs =>
        Rasters.Where(kv => kv.Value.HasMissingGlyphs).Select(kv => kv.Key).Order().ToList();

    /// <summary>
    /// SİSTEM fontuyla çizilen klipler (küratörlü TTF kurulu değildi). İş DÜŞMEZ ve çıktı
    /// GEÇERLİDİR, ama render belirlenimci değildir — worker uyarı loglar.
    /// </summary>
    public IReadOnlyList<Guid> ClipsUsingSystemFont =>
        Rasters.Where(kv => kv.Value.FontSource == FontSourceKind.System).Select(kv => kv.Key).Order().ToList();

    /// <summary>Tekilleştirilmiş sistem fontu uyarıları (log satırı başına bir kez).</summary>
    public IReadOnlyList<string> SystemFontWarnings =>
        Rasters.Values.Select(r => r.FontWarning).OfType<string>()
            .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();

    /// <summary>Bu defterdeki tüm rasterler her makinede aynı baytları üretir mi.</summary>
    public bool Deterministic => Rasters.Values.All(r => r.Deterministic);
}

/// <summary>
/// Export öncesi overlay hazırlığı: dokümandaki metin/şekil kliplerini bulur ve her biri için
/// job temp dizinine bir PNG üretir.
/// <para>
/// ATIL KLİP KURALI ExportCompiler ile AYNIDIR: <c>track.hidden</c> olan track'in klipleri
/// hiçbir ffmpeg girişi açmaz, dolayısıyla rasterleştirilmez de. (Aksi halde gizli bir
/// katmandaki eksik fontlu metin, görünmeyen bir klip yüzünden TÜM export'u düşürürdü —
/// çok-katman denetiminde ölçülen "atıl klip" hatasının aynısı.)
/// </para>
/// <para>
/// ÇIKARTMALAR DAHİL DEĞİLDİR: sticker klibi mevcut PNG/WebP asset'ini doğrudan kullanır.
/// </para>
/// </summary>
public static class OverlayRasterPlanner
{
    /// <summary>Job temp dizini altındaki alt dizin (tasarım 04 §4.2: <c>overlays/</c>).</summary>
    public const string DirectoryName = "overlays";

    /// <summary>
    /// Rasterlenecek klipleri doküman sırasında toplar. Dosya adı klip id'sinden türer →
    /// aynı doküman aynı dosya adlarını verir (belirlenimcilik + kolay hata ayıklama).
    /// </summary>
    public static IReadOnlyList<OverlayRasterItem> Collect(TimelineDoc doc)
    {
        ArgumentNullException.ThrowIfNull(doc);

        var items = new List<OverlayRasterItem>();
        for (var trackIndex = 0; trackIndex < doc.Tracks.Count; trackIndex++)
        {
            var track = doc.Tracks[trackIndex];
            if (track.Hidden)
            {
                continue; // atıl: hiçbir giriş açmaz (ExportCompiler ile aynı kural)
            }

            foreach (var clip in track.Clips)
            {
                var id = clip switch
                {
                    TextClip text => text.Id,
                    ShapeClip shape => shape.Id,
                    _ => (Guid?)null,
                };

                if (id is { } clipId)
                {
                    items.Add(new OverlayRasterItem(clip, clipId, trackIndex, $"{clipId:N}.png"));
                }
            }
        }

        return items;
    }

    /// <summary>
    /// Tüm overlay kliplerini <paramref name="jobDirectory"/>/overlays altına rasterleştirir.
    /// Hiç overlay klibi yoksa dizin OLUŞTURULMAZ ve <see cref="OverlayRasterSet.Empty"/> döner
    /// (metinsiz projelerin export'u font kurulumundan etkilenmez).
    /// </summary>
    public static async Task<OverlayRasterSet> RenderAllAsync(
        TimelineDoc doc,
        ITextRasterService service,
        string jobDirectory,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(service);
        ArgumentException.ThrowIfNullOrWhiteSpace(jobDirectory);

        var items = Collect(doc);
        if (items.Count == 0)
        {
            return OverlayRasterSet.Empty;
        }

        var directory = Path.Combine(jobDirectory, DirectoryName);
        Directory.CreateDirectory(directory);

        var rasters = new Dictionary<Guid, RasterResult>(items.Count);
        foreach (var item in items)
        {
            ct.ThrowIfCancellationRequested();

            // Aynı klip id'si iki kez gelirse (şema ihlali) sessizce üzerine yazmak yerine
            // deterministik hata: hangi PNG'nin kazandığı belirsiz kalmamalı.
            if (rasters.ContainsKey(item.ClipId))
            {
                throw new UnsupportedOverlayClipException(
                    $"Timeline'da yinelenen klip kimliği var: {item.ClipId} — overlay rasteri "
                    + "hangi klibe ait olacağı belirsiz kalırdı.");
            }

            var outputPath = Path.Combine(directory, item.FileName);
            rasters[item.ClipId] = await service.RenderAsync(item.Clip, doc.Settings, outputPath, ct)
                .ConfigureAwait(false);
        }

        return new OverlayRasterSet(directory, rasters);
    }
}
