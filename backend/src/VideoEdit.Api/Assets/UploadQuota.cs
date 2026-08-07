namespace VideoEdit.Api.Assets;

public enum QuotaViolation
{
    None = 0,

    /// <summary>Toplam depolama kotası aşılır — 403.</summary>
    TotalBytesExceeded = 1,

    /// <summary>Eşzamanlı upload sınırı dolu — 429.</summary>
    TooManyConcurrentUploads = 2,
}

/// <summary>
/// Upload init anındaki kota kararı — saf fonksiyon, birim testleri doğrudan çağırır.
/// (Not: kontrol init anındadır; yarışan iki init teorik olarak kotayı kıl payı aşabilir —
/// MVP kabulü, kesin çözüm DB kısıtı değil periyodik mutabakat olur.)
/// </summary>
public static class UploadQuota
{
    /// <param name="requestedBytes">Yeni dosyanın beyan edilen boyutu.</param>
    /// <param name="usedBytes">Kullanıcının silinmemiş, Failed olmayan asset'lerinin toplamı.</param>
    /// <param name="activeUploads">Kullanıcının hâlen Uploading durumundaki asset sayısı.</param>
    public static QuotaViolation Evaluate(
        long requestedBytes, long usedBytes, int activeUploads, QuotasOptions options)
    {
        if (activeUploads >= options.MaxConcurrentUploads)
        {
            return QuotaViolation.TooManyConcurrentUploads;
        }

        if (usedBytes + requestedBytes > options.MaxTotalBytesPerUser)
        {
            return QuotaViolation.TotalBytesExceeded;
        }

        return QuotaViolation.None;
    }
}
