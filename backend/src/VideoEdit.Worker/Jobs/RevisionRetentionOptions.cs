using System.Globalization;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// ProjectRevisions retention parametreleri ("RevisionRetention" config section'ı — env:
/// <c>RevisionRetention__KeepLatestAuto</c> vb.; TimeSpan alanları .NET biçimiyle bağlanır,
/// örn. <c>RevisionRetention__ThinOlderThan=1.00:00:00</c>). Varsayılanlar tasarım 03 §"Snapshot
/// politikası" tarifidir: Auto snapshot'lardan proje başına SON 50 tutulur; 24 saatten
/// eskiler saat başına 1'e inceltilir; Checkpoint/PreRestore kayıtlarına HİÇ dokunulmaz
/// (kullanıcının adlandırılmış noktaları + restore'un tek kurtarma yolu). Kuralın kendisi
/// <see cref="ProjectRevisionRetentionJob"/>'dadır — burada yalnız sayılar yaşar
/// (ExportEstimateOptions config deseni; etkin değerler worker açılışında loglanır).
/// </summary>
public sealed class RevisionRetentionOptions
{
    public const string SectionName = "RevisionRetention";

    /// <summary>Proje başına her koşulda tutulan EN YENİ Auto snapshot sayısı.</summary>
    public int KeepLatestAuto { get; set; } = 50;

    /// <summary>
    /// Bu yaştan GENÇ Auto snapshot'lar (son-50 dışında kalsalar da) inceltilmez — yoğun bir
    /// düzenleme gününün geçmişi aynı gün silinmez; kayıt bu yaşı aşınca kova kuralına düşer.
    /// </summary>
    public TimeSpan ThinOlderThan { get; set; } = TimeSpan.FromHours(24);

    /// <summary>Eski kayıtların inceltme kovası: kova başına EN YENİ Auto kalır.</summary>
    public TimeSpan ThinBucket { get; set; } = TimeSpan.FromHours(1);

    /// <summary>
    /// Pozitif olmayan override açılışta düşürür (ExportEstimateOptions.Validate deseni) —
    /// bozuk sabit ilk koşumda kullanıcının versiyon geçmişini sessizce süpürmemeli.
    /// </summary>
    public void Validate()
    {
        if (KeepLatestAuto < 1)
        {
            throw new InvalidOperationException(
                $"RevisionRetention:KeepLatestAuto pozitif olmalı (şu an {KeepLatestAuto}).");
        }

        if (ThinOlderThan <= TimeSpan.Zero || ThinBucket <= TimeSpan.Zero)
        {
            throw new InvalidOperationException(
                "RevisionRetention:ThinOlderThan ve ThinBucket pozitif süre olmalı "
                + $"(şu an {ThinOlderThan} / {ThinBucket}).");
        }
    }

    /// <summary>Açılış logu için etkin değerler (görünürlük deseninin log yarısı).</summary>
    public string DescribeEffective() => string.Create(
        CultureInfo.InvariantCulture,
        $"KeepLatestAuto={KeepLatestAuto}, ThinOlderThan={ThinOlderThan}, ThinBucket={ThinBucket}");
}
