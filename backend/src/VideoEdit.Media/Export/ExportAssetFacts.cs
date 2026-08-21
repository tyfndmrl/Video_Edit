namespace VideoEdit.Media.Export;

/// <summary>
/// Asset satırının MEDYA TÜRÜ — kütüphaneye yüklenirken content-type'tan seçilir, işleme
/// sonunda ffprobe ile TUTARLILIK kapısından geçer (worker: <c>ProcessAssetJob.GateByKind</c>).
/// <para>
/// Domain'in <c>AssetKind</c> enum'ının bu katmandaki karşılığıdır: VideoEdit.Media,
/// VideoEdit.Domain'e referans VERMEZ (bkz. .csproj) — çeviriyi API yapar.
/// </para>
/// </summary>
public enum ExportAssetMediaKind
{
    /// <summary>Defter bu olguyu taşımıyor (worker yolu / eski çağrı) — tür kapıları ATLANIR.</summary>
    Unknown = 0,

    /// <summary>Zaman eksenli görüntü kaynağı (Ready ise ffprobe'da video stream'i VARDIR).</summary>
    Video = 1,

    /// <summary>Ses kaynağı (Ready ise ffprobe'da ses stream'i VARDIR).</summary>
    Audio = 2,

    /// <summary>Durağan görsel (Ready ise video stream'i vardır, sesi ve zaman ekseni YOKTUR).</summary>
    Image = 3,

    /// <summary>
    /// 3D LUT (.cube) — medya DEĞİLDİR: hiçbir klip türünün akış ihtiyacını karşılayamaz
    /// (görüntü de ses de içermez), yalnız <c>lut</c> efektinin <c>assetId</c>'si olarak
    /// anlamlıdır. Bir klibin kaynağı olarak gösterilirse <c>asset-clip-type</c> senkron
    /// reddi üretir; LUT efekti kapısı ise türe değil dosya adına bakar
    /// (<c>lut-asset-type</c> — .cube olmayan HER dosyayı reddeder, türü ne olursa olsun).
    /// </summary>
    Lut = 4,
}

/// <summary>
/// Asset satırının işleme durumunun senkron kapıyı ilgilendiren ÜÇ hali. Domain'de dört durum
/// vardır (Uploading/Uploaded/Processing/Failed/Ready); ilk üçü kapı açısından AYNIDIR — hepsi
/// GEÇİCİDİR ve iş kuyruktan alınana kadar Ready'ye dönebilirler.
/// </summary>
public enum ExportAssetReadiness
{
    /// <summary>
    /// GEÇİCİ (yükleniyor / yüklendi / işleniyor). Kapı bu durumda HİÇBİR ret üretmez: satır
    /// worker işi başlamadan Ready olabilir, senkron ret YANLIŞ RET olurdu.
    /// </summary>
    Pending = 0,

    /// <summary>İşleme tamamlandı — ffprobe olguları (kind, süre, boyut, ses) KESİNDİR.</summary>
    Ready = 1,

    /// <summary>
    /// TERMİNAL başarısızlık. Domain'in durum makinesinde Failed'dan Ready'ye DOĞRUDAN geçiş
    /// yoktur (yalnız Failed → Processing yeniden deneme geçişi vardır) ve yeniden deneme
    /// kullanıcı tarafından başlatılır: bu asset "birazdan hazır olur" değildir, dolayısıyla
    /// senkron ret güvenlidir.
    /// </summary>
    Failed = 2,
}

/// <summary>
/// SENKRON export kapısının bir asset hakkında bildiği OLGULAR — hepsi DB satırından okunur,
/// hiçbiri dosyaya dokunmaz. Defter <see cref="ExportCompiler.Validate"/>'e verilir ve
/// üretilen filtergraph'a ASLA girmez: yalnız kapı sorularını yanıtlar.
/// <para>
/// TEK DEFTER olması bilinçlidir. Kapılar (dejenerelik, kaynak aralığı, LUT dosya türü, varlık
/// mevcudiyeti, ses keyframe bütçesi, KLİP-VARLIK TÜR EŞLEŞMESİ, TERMİNAL BAŞARISIZLIK) aynı
/// asset satırlarını sorar; ayrı ayrı sorulsalardı API aynı sorguyu tekrarlar ve iki kapı farklı
/// anların verisiyle karar verebilirdi.
/// </para>
/// <para>
/// SÖZLEŞME — "ölçüm yokluğu yanlış ret üretmez": defterin KENDİSİ null ise (worker yolu) asset
/// kapılarının tamamı atlanır; defter varsa bir id'nin BULUNMAMASI "kullanıcının kütüphanesinde
/// böyle bir varlık yok" demektir ve tipli bir rettir (bkz. <c>asset-missing</c>). Satır varken
/// tek tek alanların null/varsayılan olması (asset hâlâ işleniyor) yalnız o alanın kapısını
/// atlatır.
/// </para>
/// </summary>
/// <param name="Width">ffprobe genişliği (asset hâlâ işleniyorsa null) — dejenerelik kapısı.</param>
/// <param name="Height">ffprobe yüksekliği (asset hâlâ işleniyorsa null) — dejenerelik kapısı.</param>
/// <param name="DurationMicros">
/// ffprobe süresi (µs). Worker'ın <c>source-out-of-range</c> kapısıyla AYNI sayıdır:
/// <c>ProcessAssetJob</c> onu <c>MediaProbe.DurationUs</c>'ten yazar, export de aynı orijinali
/// aynı ffprobe yolundan geçirir → iki kapı asla farklı karar veremez.
/// </param>
/// <param name="FileName">
/// Yüklemedeki özgün dosya adı — LUT efektinin gösterdiği varlığın gerçekten <c>.cube</c> olup
/// olmadığı buradan anlaşılır. Domain'de artık <see cref="ExportAssetMediaKind.Lut"/>'a çevrilen
/// bir <c>AssetKind.Lut</c> VARDIR (yükleme whitelist'i <c>application/x-cube-lut</c>); kapı yine
/// de dosya adına bakar çünkü ham API'yle medya türü beyan edilip .cube olmayan bir dosya
/// gösteren eski sınıf belgeler de aynı retten geçmek zorundadır.
/// </param>
/// <param name="HasAudio">
/// Kaynakta ses stream'i var mı (ffprobe). İki kapı okur:
/// (a) ses keyframe'lerinin ÖRNEKLEME BÜTÇESİNDEN düşülüp düşülmeyeceği — stream yoksa derleyici
/// o zinciri hiç kurmaz, bütçeden de harcamaz;
/// (b) SES KLİBİNİN kaynağında gerçekten ses olup olmadığı (<c>asset-clip-type</c>).
/// Kolon YALNIZ <see cref="ExportAssetReadiness.Ready"/> satırda anlamlıdır (worker onu probe
/// sonrasında yazar) — o yüzden (b) kapısı bunu yalnız Ready satırda sorar, aksi halde
/// varsayılan <c>false</c> YANLIŞ RET üretirdi.
/// </param>
/// <param name="MediaKind">
/// Satırın medya türü. <see cref="ExportAssetMediaKind.Unknown"/> ise TÜR kapıları atlanır.
/// GEÇİCİ durumdaki satırda bile sorulabilir ve bu YANLIŞ RET ÜRETMEZ: tür yükleme anında
/// beyan edilir, worker işleme sonunda beyanı ffprobe ile karşılaştırır
/// (<c>ProcessAssetJob.GateByKind</c>) ve TUTMUYORSA asset'i Ready yapmaz. Yani "beyan edilen
/// türle çelişen bir belge" ya bu kapıdan ya da asset'in kendi başarısızlığından döner —
/// başarıya giden bir yol YOKTUR.
/// </param>
/// <param name="Readiness">
/// Satırın işleme durumu. <see cref="ExportAssetReadiness.Failed"/> TERMİNALDİR ve senkron
/// reddedilir (<c>asset-failed</c>); <see cref="ExportAssetReadiness.Pending"/> geçicidir ve
/// worker'ın <c>asset-not-ready</c> kapısına bırakılır.
/// </param>
public sealed record ExportAssetFacts(
    int? Width = null,
    int? Height = null,
    long? DurationMicros = null,
    string? FileName = null,
    bool HasAudio = false,
    ExportAssetMediaKind MediaKind = ExportAssetMediaKind.Unknown,
    ExportAssetReadiness Readiness = ExportAssetReadiness.Pending);
