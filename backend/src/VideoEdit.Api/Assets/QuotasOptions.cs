namespace VideoEdit.Api.Assets;

/// <summary>
/// Kullanıcı başına depolama/upload kotaları (mimar denetimi "kota yok" bulgusunun M1 karşılığı).
/// Değerler appsettings "Quotas" bölümünden ezilebilir; default'lar üretim varsayımlarıdır.
/// </summary>
public sealed class QuotasOptions
{
    public const string SectionName = "Quotas";

    /// <summary>Kullanıcının silinmemiş tüm asset'lerinin toplam üst sınırı (default 20 GiB).</summary>
    public long MaxTotalBytesPerUser { get; set; } = 20L * 1024 * 1024 * 1024;

    /// <summary>Tek dosya üst sınırı (default 4 GiB).</summary>
    public long MaxFileSizeBytes { get; set; } = 4L * 1024 * 1024 * 1024;

    /// <summary>Aynı anda Uploading durumunda olabilecek asset sayısı (default 5).</summary>
    public int MaxConcurrentUploads { get; set; } = 5;
}
