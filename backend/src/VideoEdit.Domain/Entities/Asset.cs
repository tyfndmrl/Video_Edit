using System.Text.Json;

namespace VideoEdit.Domain.Entities;

/// <summary>
/// KULLANICI-scoped medya varlığı (baş mimar kararı 1.d) — proje ilişkisi ProjectAsset
/// many-to-many join tablosunda tutulur; Asset üzerinde ProjectId YOKTUR.
/// R2 key düzeni: u/{ownerId}/a/{assetId}/...
/// </summary>
public class Asset
{
    public Guid Id { get; set; }
    public Guid OwnerId { get; set; }
    public AssetStatus Status { get; set; }
    public AssetKind Kind { get; set; }

    public string OriginalFileName { get; set; } = "";

    /// <summary>Orijinal dosyanın R2 key'i: u/{ownerId}/a/{assetId}/original/...</summary>
    public string StorageKey { get; set; } = "";

    public long SizeBytes { get; set; }

    /// <summary>
    /// İşleme hattının ürettiği türevlerin (proxy + filmstrip + waveform + poster) toplam
    /// boyutu — işleme Ready ile biterken yazılır ve kota sorguları depolamayı
    /// SizeBytes + DerivedBytes olarak sayar (ölçüldü: türevler orijinalin ~%7,7'siydi
    /// ve kotadan kaçıyordu). NULL = "bu asset türev defteri tutulmadan işlendi" (geriye
    /// dönük satırlar) ve kotada 0 sayılır — eski asset'ler geçmişe dönük şişirilmez.
    /// </summary>
    public long? DerivedBytes { get; set; }

    public string ContentType { get; set; } = "";

    /// <summary>R2 multipart upload id (Uploading iken dolu).</summary>
    public string? UploadId { get; set; }

    // Türev key'leri — işleme tamamlanınca (Ready) dolar.
    public string? ProxyKey { get; set; }
    public string? FilmstripKey { get; set; }
    public string? WaveformKey { get; set; }
    public string? ThumbnailKey { get; set; }

    /// <summary>Ham ffprobe JSON çıktısı (jsonb) — codec/rotate/HDR kararları için kaynak veri.</summary>
    public JsonDocument? Probe { get; set; }

    public long? DurationMicros { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }
    public int? FpsNum { get; set; }
    public int? FpsDen { get; set; }
    public bool HasAudio { get; set; }

    public string? FailureReason { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Processing'e son geçiş anı — reaper "stalled" tespiti bunun üstünden yapılır.</summary>
    public DateTimeOffset? ProcessingStartedAt { get; set; }

    public DateTimeOffset? ReadyAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }

    /// <summary>
    /// İzin verilen durum geçişleri. Failed → Processing retry içindir; Ready terminaldir.
    /// </summary>
    private static readonly Dictionary<AssetStatus, AssetStatus[]> AllowedTransitions = new()
    {
        [AssetStatus.Uploading] = [AssetStatus.Uploaded, AssetStatus.Failed],
        [AssetStatus.Uploaded] = [AssetStatus.Processing, AssetStatus.Failed],
        [AssetStatus.Processing] = [AssetStatus.Ready, AssetStatus.Failed],
        [AssetStatus.Failed] = [AssetStatus.Processing],
        [AssetStatus.Ready] = [],
    };

    /// <summary>
    /// Durum makinesini zorunlu kılan tek geçiş noktası. Geçersiz geçişte DomainException fırlatır.
    /// Processing'e geçişte ProcessingStartedAt, Ready'ye geçişte ReadyAt damgalanır;
    /// Failed dışına çıkışta FailureReason temizlenir.
    /// </summary>
    public void TransitionTo(AssetStatus next, DateTimeOffset? nowUtc = null)
    {
        if (!AllowedTransitions.TryGetValue(Status, out var allowed) || !allowed.Contains(next))
        {
            throw new DomainException($"Invalid asset status transition: {Status} -> {next}.");
        }

        if (Status == AssetStatus.Failed && next == AssetStatus.Processing)
        {
            FailureReason = null;
        }

        Status = next;

        if (next == AssetStatus.Processing)
        {
            ProcessingStartedAt = nowUtc ?? DateTimeOffset.UtcNow;
        }

        if (next == AssetStatus.Ready)
        {
            ReadyAt = nowUtc ?? DateTimeOffset.UtcNow;
        }
    }

    public void Fail(string reason, DateTimeOffset? nowUtc = null)
    {
        TransitionTo(AssetStatus.Failed, nowUtc);
        FailureReason = reason;
    }

    public static Asset Create(
        Guid ownerId, AssetKind kind, string originalFileName, string contentType,
        long sizeBytes, DateTimeOffset nowUtc)
    {
        var id = Guid.CreateVersion7();
        return new Asset
        {
            Id = id,
            OwnerId = ownerId,
            Kind = kind,
            Status = AssetStatus.Uploading,
            OriginalFileName = originalFileName,
            ContentType = contentType,
            SizeBytes = sizeBytes,
            StorageKey = $"u/{ownerId}/a/{id}/original/{SanitizeFileName(originalFileName)}",
            CreatedAt = nowUtc,
        };
    }

    /// <summary>
    /// R2 key'inde kullanılan güvenli dosya adı: her zaman "source" + yalnız-ASCII küçük harfli
    /// uzantı. Asıl fileName DB'de tutulur (OriginalFileName); key asla kullanıcı girdisi taşımaz.
    /// Public: endpoint doğrulaması ve birim testleri aynı kuralı kullanır.
    /// </summary>
    public static string SanitizeFileName(string fileName)
    {
        string ext;
        try
        {
            ext = Path.GetExtension(fileName);
        }
        catch (ArgumentException)
        {
            // Geçersiz path karakterleri (eski framework davranışı) — uzantısız devam.
            ext = "";
        }

        var safeExt = ext.Length > 1 && ext.All(c => char.IsAsciiLetterOrDigit(c) || c == '.')
            ? ext.ToLowerInvariant()
            : "";
        return $"source{safeExt}";
    }
}
