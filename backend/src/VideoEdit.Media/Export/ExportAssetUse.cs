namespace VideoEdit.Media.Export;

/// <summary>
/// Bir klibin kaynak dosyadan GERÇEKTEN okuduğu şey. "Klip türü" ile aynı şey DEĞİLDİR:
/// gizli track'teki bir video klibi görüntü OKUMAZ (yalnız sesi mikse girer), susturulmuş
/// track'teki bir ses klibi hiçbir şey okumaz. Defter bu yüzden klip türünden değil,
/// derleyicinin O KLİP İÇİN kuracağı zincirden türetilir.
/// </summary>
public enum ExportSourceNeed
{
    /// <summary>Görüntü akışı + ZAMAN EKSENİ: video klibi kaynaktan bir ARALIK okur (-ss/-t).</summary>
    Motion,

    /// <summary>
    /// Görüntü akışı, zaman ekseni OLMADAN: görsel/çıkartma klibi tek kareyi <c>-loop 1</c> ile
    /// açar. Zaman eksenli bir dosya bu girişte ffmpeg'i anlamsız bir çıkış koduyla düşürür.
    /// </summary>
    Still,

    /// <summary>Ses akışı: ses klibinin TEK varlık sebebi.</summary>
    Audio,
}

/// <summary>
/// DEFTER SATIRI: hangi klip, hangi varlıktan, NEYİ okuyor. <see cref="ExportPlan.AssetUses"/>
/// bunları taşır ve İKİ KAPI da yalnız bundan beslenir:
/// <list type="bullet">
///   <item>senkron kapı (<c>asset-clip-type</c>) — olgular DB'den (<see cref="ExportAssetFacts"/>);</item>
///   <item>worker kapısı (<c>unsupported-media</c>) — olgular indirilen dosyanın ffprobe'undan.</item>
/// </list>
/// Kural TEK YERDE (<see cref="ExportCompiler.NeedOf"/>) tanımlıdır; iki kapı aynı defteri iki
/// farklı veri kaynağıyla sorar, dolayısıyla farklı klibi suçlayamazlar.
/// </summary>
/// <param name="ClipId">Kullanıcıya gösterilecek klip kimliği.</param>
/// <param name="ClipKindTr">Klip türünün Türkçe adı (mesajlar için).</param>
/// <param name="AssetId">Klibin gösterdiği varlık.</param>
/// <param name="Need">O klibin kaynaktan okuduğu şey.</param>
public sealed record ExportAssetUse(Guid ClipId, string ClipKindTr, Guid AssetId, ExportSourceNeed Need)
{
    /// <summary>
    /// DURAĞAN kaynağın üst süre sınırı (µs). Aynı eşik yükleme hattında da kullanılır
    /// (<c>ProcessAssetJob.ImageMaxDurationUs</c> bu sabite bağlıdır): "Image beyanlı ama
    /// aslında video olan dosya" oradan Ready ÇIKAMAZ, dolayısıyla gerçek bir görsel varlık
    /// bu kapıdan asla düşmez.
    /// </summary>
    public const long StillSourceMaxDurationUs = 1_000_000;

    /// <summary>
    /// İndirilen dosyanın ffprobe olguları bu kullanımı KARŞILIYOR mu? Karşılamıyorsa eksikliği
    /// anlatan Türkçe cümle parçası döner (worker mesajına gömülür), karşılıyorsa null.
    /// <para>
    /// <see cref="ExportSourceNeed.Motion"/> için YALNIZ görüntü akışı sorulur, "zaman ekseni
    /// var mı" SORULMAZ: kısa (bir saniyenin altında) gerçek videolar vardır ve onları
    /// durağan sayıp reddetmek yanlış ret olurdu. Ters yön (durağan giriş) güvenle sorulabilir —
    /// yukarıdaki <see cref="StillSourceMaxDurationUs"/> gerekçesine bakınız.
    /// </para>
    /// </summary>
    public string? UnmetBy(bool hasVideo, bool hasAudio, long? durationUs) => Need switch
    {
        ExportSourceNeed.Motion when !hasVideo => "dosyada görüntü akışı yok",
        ExportSourceNeed.Still when !hasVideo => "dosyada görüntü akışı yok",
        ExportSourceNeed.Still when hasAudio || durationUs > StillSourceMaxDurationUs =>
            "dosya durağan görsel değil (zaman ekseni var), oysa bu klip onu tek kare olarak açar",
        ExportSourceNeed.Audio when !hasAudio => "dosyada ses akışı yok",
        _ => null,
    };
}
