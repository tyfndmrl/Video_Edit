using System.Globalization;
using VideoEdit.Media.Export;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// Export kabul kapılarının TAHMİN SABİTLERİ ("ExportEstimates" config section'ı — env:
/// <c>ExportEstimates__MemoryEncoderBytesPerTargetPixel</c> vb.). FORMÜLLER DEĞİŞMEZ
/// (<see cref="ExportJob.EstimateRequiredMemoryBytes"/> /
/// <see cref="ExportJob.EffectiveOutputBitsPerSecond"/>); yalnız içlerindeki sabitler worker
/// donanımına göre ezilebilir hale gelir.
/// <para>
/// <c>null</c> = ölçülen varsayılan kullanılır. Varsayılanların TEK kaynağı
/// <see cref="ExportJob"/>'daki <c>Memory*</c> const'ları ile
/// <see cref="ExportProfiles.EstimatedBitsPerSecond"/>'dır — sayılar bu makinede
/// (i9-10850K, 20 mantıksal çekirdek, 32 GB; 2026-08-24 ölçüm turu) ölçülmüştür ve farklı
/// worker donanımında yeniden ölçüm notu o sabitlerin xmldoc'undadır. Bu sınıf o değerleri
/// KOPYALAMAZ: kopya, ölçüm güncellenince sessizce ayrışırdı.
/// </para>
/// <para>
/// Etkin değerler worker açılışında loglanır (FontRootHealth görünürlük deseninin log yarısı):
/// "bu worker hangi sabitlerle koşuyor" sorusu açılış satırından okunur, ezilen anahtarlar
/// ayrıca listelenir (<see cref="DescribeEffective"/>).
/// </para>
/// </summary>
public sealed class ExportEstimateOptions
{
    public const string SectionName = "ExportEstimates";

    /// <summary>Bellek tahmini tabanı (bayt) — <see cref="ExportJob.MemoryBaseBytes"/> yerine.</summary>
    public long? MemoryBaseBytes { get; set; }

    /// <summary>Kodlayıcı terimi (bayt/çıktı pikseli) — <see cref="ExportJob.MemoryEncoderBytesPerTargetPixel"/> yerine.</summary>
    public long? MemoryEncoderBytesPerTargetPixel { get; set; }

    /// <summary>Giriş başına sabit pay (bayt) — <see cref="ExportJob.MemoryDemuxBytesPerInput"/> yerine.</summary>
    public long? MemoryDemuxBytesPerInput { get; set; }

    /// <summary>Çözücü terimi (bayt/eşzamanlı kaynak pikseli) — <see cref="ExportJob.MemoryDecodeBytesPerSourcePixel"/> yerine.</summary>
    public long? MemoryDecodeBytesPerSourcePixel { get; set; }

    /// <summary>Karışım terimi (bayt/tuval pikseli) — <see cref="ExportJob.MemoryMixBytesPerCanvasPixel"/> yerine.</summary>
    public long? MemoryMixBytesPerCanvasPixel { get; set; }

    /// <summary>1080p profil çıktı bit hızı TABANI (b/s) — disk rezervasyonunun max(taban, kaynak) terimi.</summary>
    public long? OutputBitsPerSecond1080p { get; set; }

    /// <summary>720p profil çıktı bit hızı tabanı (b/s).</summary>
    public long? OutputBitsPerSecond720p { get; set; }

    /// <summary>2160p profil çıktı bit hızı tabanı (b/s).</summary>
    public long? OutputBitsPerSecond2160p { get; set; }

    /// <summary>Dikey 1080x1920 profil çıktı bit hızı tabanı (b/s).</summary>
    public long? OutputBitsPerSecondVertical { get; set; }

    // ── Etkin değerler (override ?? ölçülen varsayılan) ──

    public long EffectiveMemoryBaseBytes => MemoryBaseBytes ?? ExportJob.MemoryBaseBytes;

    public long EffectiveMemoryEncoderBytesPerTargetPixel =>
        MemoryEncoderBytesPerTargetPixel ?? ExportJob.MemoryEncoderBytesPerTargetPixel;

    public long EffectiveMemoryDemuxBytesPerInput =>
        MemoryDemuxBytesPerInput ?? ExportJob.MemoryDemuxBytesPerInput;

    public long EffectiveMemoryDecodeBytesPerSourcePixel =>
        MemoryDecodeBytesPerSourcePixel ?? ExportJob.MemoryDecodeBytesPerSourcePixel;

    public long EffectiveMemoryMixBytesPerCanvasPixel =>
        MemoryMixBytesPerCanvasPixel ?? ExportJob.MemoryMixBytesPerCanvasPixel;

    /// <summary>
    /// Profilin etkin çıktı bit hızı tabanı: override yoksa
    /// <see cref="ExportProfiles.EstimatedBitsPerSecond"/> (bilinmeyen profil orada olduğu
    /// gibi fırlatır — hata yüzeyi değişmez).
    /// </summary>
    public long EffectiveOutputBitsPerSecondFloor(ExportProfile profile) => (profile switch
    {
        ExportProfile.Hd1080p => OutputBitsPerSecond1080p,
        ExportProfile.Hd720p => OutputBitsPerSecond720p,
        ExportProfile.Uhd2160p => OutputBitsPerSecond2160p,
        ExportProfile.Vertical1080p => OutputBitsPerSecondVertical,
        _ => null,
    }) ?? ExportProfiles.EstimatedBitsPerSecond(profile);

    /// <summary>
    /// Pozitif olmayan override worker'ı AÇILIŞTA düşürür (Program.cs'in prod-guard deseni):
    /// 0/negatif bir sabit kapıları sessizce anlamsızlaştırır — ilk export'ta değil ilk
    /// saniyede, hangi anahtarın bozuk olduğu söylenerek durmak gerekir.
    /// </summary>
    public void Validate()
    {
        var broken = OverridePairs()
            .Where(p => p.Value is <= 0)
            .Select(p => $"{SectionName}__{p.Name}={p.Value!.Value.ToString(CultureInfo.InvariantCulture)}")
            .ToList();
        if (broken.Count > 0)
        {
            throw new InvalidOperationException(
                "Export tahmin sabiti override'ları pozitif olmalı: " + string.Join(", ", broken));
        }
    }

    /// <summary>
    /// Açılış logu için tek satırlık etkin durum: dokuz sabitin etkin değeri + hangi
    /// anahtarların config'le ezildiği ("yok" = ölçülen varsayılanlarla koşuyor).
    /// </summary>
    public string DescribeEffective()
    {
        var overridden = OverridePairs().Where(p => p.Value is not null).Select(p => p.Name).ToList();
        return string.Create(CultureInfo.InvariantCulture,
            $"bellek taban={EffectiveMemoryBaseBytes} B, kodlayıcı={EffectiveMemoryEncoderBytesPerTargetPixel} B/hedef-px, "
            + $"demux={EffectiveMemoryDemuxBytesPerInput} B/giriş, çözücü={EffectiveMemoryDecodeBytesPerSourcePixel} B/kaynak-px, "
            + $"karışım={EffectiveMemoryMixBytesPerCanvasPixel} B/tuval-px; çıktı bit hızı tabanı "
            + $"1080p={EffectiveOutputBitsPerSecondFloor(ExportProfile.Hd1080p)}, "
            + $"720p={EffectiveOutputBitsPerSecondFloor(ExportProfile.Hd720p)}, "
            + $"2160p={EffectiveOutputBitsPerSecondFloor(ExportProfile.Uhd2160p)}, "
            + $"dikey={EffectiveOutputBitsPerSecondFloor(ExportProfile.Vertical1080p)} b/s; "
            + $"ezilen: {(overridden.Count > 0 ? string.Join(", ", overridden) : "yok (ölçülen varsayılanlar)")}");
    }

    /// <summary>Tüm ayar anahtarları tek listeden sayılır — Validate/Describe ayrışamaz.</summary>
    private IEnumerable<(string Name, long? Value)> OverridePairs() =>
    [
        (nameof(MemoryBaseBytes), MemoryBaseBytes),
        (nameof(MemoryEncoderBytesPerTargetPixel), MemoryEncoderBytesPerTargetPixel),
        (nameof(MemoryDemuxBytesPerInput), MemoryDemuxBytesPerInput),
        (nameof(MemoryDecodeBytesPerSourcePixel), MemoryDecodeBytesPerSourcePixel),
        (nameof(MemoryMixBytesPerCanvasPixel), MemoryMixBytesPerCanvasPixel),
        (nameof(OutputBitsPerSecond1080p), OutputBitsPerSecond1080p),
        (nameof(OutputBitsPerSecond720p), OutputBitsPerSecond720p),
        (nameof(OutputBitsPerSecond2160p), OutputBitsPerSecond2160p),
        (nameof(OutputBitsPerSecondVertical), OutputBitsPerSecondVertical),
    ];
}
