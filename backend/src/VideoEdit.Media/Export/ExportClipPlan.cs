using VideoEdit.Contracts.Timeline;

namespace VideoEdit.Media.Export;

/// <summary>
/// Compiler'ın gördüğü klip türleri. Şemadaki dört klip sınıfının (MediaClip + Text/Shape/Sticker)
/// TEK düzleştirilmiş ekseni: <see cref="MediaClipKind"/>'in üç değeri + üç overlay türü.
/// </summary>
public enum ExportClipKind
{
    Video,
    Audio,
    Image,
    Text,
    Shape,
    Sticker,
}

/// <summary>
/// Normalize edilmiş klip: tür-bağımsız ortak alanlar (zaman, transform, opaklık) + türe özel
/// kaynak bilgisi + geçişten türeyen D/2 payları. Compiler bundan sonra şema sınıflarını
/// (MediaClip/TextClip/ShapeClip/StickerClip) TANIMAZ — tek düzleştirilmiş görünüm budur.
/// <para>
/// <see cref="HeadInUs"/>/<see cref="HeadOutUs"/> (rendering-semantics §5.2): klipler timeline'da
/// BİTİŞİK kalır, geçiş bir metadata'dır; compiler kesim noktasının iki yanındaki kaynak
/// aralıklarını D/2 uzatır. Paylar FRAME cinsinden türetilir (<see cref="HeadInFrames"/>)
/// — µs-farkı aritmetiği NTSC'de ±1 frame kayma üretirdi (§1.4).
/// </para>
/// </summary>
public sealed record ExportClipPlan
{
    /// <summary>Dokümandaki özgün klip (şema sınıfı) — teşhis mesajları ve ses semantiği için.</summary>
    public required Clip Source { get; init; }

    public required ExportClipKind Kind { get; init; }

    public required Guid Id { get; init; }

    public required long TimelineStartUs { get; init; }

    public required long TimelineDurationUs { get; init; }

    public required Transform Transform { get; init; }

    public required double Opacity { get; init; }

    /// <summary>Medya ve ÇIKARTMA kliplerinde asset kimliği; metin/şekilde null (asset yok).</summary>
    public Guid? AssetId { get; init; }

    /// <summary>MediaClip ise kendisi (ses/hız/geçiş semantiği ona aittir), değilse null.</summary>
    public MediaClip? Media { get; init; }

    /// <summary>Kaynak aralığı — yalnız zaman eksenli kliplerde (video/ses) anlamlıdır.</summary>
    public long SourceInUs { get; init; }

    public long SourceOutUs { get; init; }

    /// <summary>
    /// Sabit hız çarpanı (<c>speed.rate</c>); zaman ekseni olmayan kliplerde daima 1.
    /// Süre sözleşmesi <c>timelineDurationUs = roundHalfUp((sourceOut-sourceIn)/rate)</c>
    /// (rendering-semantics §1.3) BURADAKİ değerle doğrulanır.
    /// </summary>
    public double Rate { get; init; } = 1d;

    /// <summary>DOĞRULANMIŞ efektler (§4) — kapalı/etkisiz olanlar ayıklanmıştır.</summary>
    public ClipEffects Effects { get; init; } = ClipEffects.None;

    /// <summary>DOĞRULANMIŞ keyframe defteri (§3) — boş kanal null'dır.</summary>
    public ClipAnimation Animation { get; init; } = ClipAnimation.None;

    /// <summary>DOĞRULANMIŞ geçişler (simetri + bitişiklik + D kuralları geçmiş olanlar).</summary>
    public Transition? TransitionIn { get; init; }

    public Transition? TransitionOut { get; init; }

    /// <summary>
    /// D/2 payının TIMELINE-domain karşılığı (µs) — frame defterinden türetilir, sıfırsa
    /// geçiş yok. Video zinciri ve ses penceresi bu eksende çalışır.
    /// </summary>
    public long HeadInUs { get; init; }

    public long HeadOutUs { get; init; }

    /// <summary>
    /// Aynı payın KAYNAK-domain karşılığı: <c>roundHalfUp((D/2) * rate)</c>
    /// (rendering-semantics §5.2). Input-level <c>-ss/-t</c> ve kaynak-aralığı defteri
    /// bu eksende çalışır; <c>rate = 1</c> iken <see cref="HeadInUs"/> ile AYNIDIR.
    /// </summary>
    public long HeadInSourceUs { get; init; }

    public long HeadOutSourceUs { get; init; }

    public long HeadInFrames { get; init; }

    public long HeadOutFrames { get; init; }

    public long TimelineEndUs => TimelineStartUs + TimelineDurationUs;

    /// <summary>
    /// Sunucu rasterine (SkiaSharp PNG) ihtiyaç duyan klipler: metin ve şekil. Çıkartma
    /// rasterlenmez — kendi asset dosyası zaten bir PNG'dir (tasarım 04 §3).
    /// </summary>
    public bool NeedsServerRaster => Kind is ExportClipKind.Text or ExportClipKind.Shape;

    /// <summary>
    /// Dosyada ZAMAN EKSENİ olmayan giriş: görsel + tüm overlay rasterleri. Bunlar
    /// <c>-loop 1 -t</c> ile açılır (seek anlamsızdır), kare sayısını zincirdeki
    /// <c>trim</c> sabitler.
    /// </summary>
    public bool IsStillInput => Kind is not (ExportClipKind.Video or ExportClipKind.Audio);

    /// <summary>Kullanıcıya gösterilecek Türkçe tür adı (422 mesajları).</summary>
    public string KindTr => Kind switch
    {
        ExportClipKind.Video => "video",
        ExportClipKind.Audio => "ses",
        ExportClipKind.Image => "görsel",
        ExportClipKind.Text => "metin",
        ExportClipKind.Shape => "şekil",
        ExportClipKind.Sticker => "çıkartma",
        _ => Kind.ToString(),
    };
}
