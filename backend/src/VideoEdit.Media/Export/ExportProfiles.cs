using System.Globalization;

namespace VideoEdit.Media.Export;

/// <summary>
/// Çıktı profilleri (tasarım 04 §5). M3'te yalnız 1080p vardı; bu dilimde 720p, 2160p (4K)
/// ve dikey 1080x1920 eklendi. Codec parametreleri VE HEDEF ÇÖZÜNÜRLÜK profile aittir;
/// tuval (kompozisyon) çözünürlüğü ve fps DAİMA proje ayarlarından gelir — profil, BİTMİŞ
/// tuval görüntüsünü kendi hedef kutusuna ölçekler (<see cref="ExportProfiles.SpecFor"/>).
/// </summary>
public enum ExportProfile
{
    /// <summary>1080p Standart (default): 1920x1080, libx264 veryfast CRF18 + AAC 192k.</summary>
    Hd1080p = 0,

    /// <summary>720p: 1280x720, aynı codec zinciri (tasarım 04 §5 codec satırının küçük kutusu).</summary>
    Hd720p = 1,

    /// <summary>2160p (4K): 3840x2160, libx264 veryfast CRF19 (tasarım 04 §5 "4K H.264" satırı).</summary>
    Uhd2160p = 2,

    /// <summary>Dikey 1080p: 1080x1920 (9:16, Shorts/Reels). Codec zinciri 1080p ile aynı.</summary>
    Vertical1080p = 3,
}

/// <summary>
/// DERLENECEK çıktı geometrisi: profil (codec argümanları için) + hedef kutu. Üretim yolu
/// bunu YALNIZ <see cref="ExportProfiles.SpecFor"/> üzerinden kurar (en-boy kapısı orada);
/// doğrudan kurucu, golden testlerin küçük tuvalli fixture'ları İÇİN açık bırakılmıştır —
/// tuvalle aynı kutu verildiğinde ölçek aşaması hiç üretilmez ve script bugünkü çıktıyla
/// bayt bayt aynı kalır.
/// </summary>
public sealed record ExportOutputSpec(ExportProfile Profile, int Width, int Height);

public static class ExportProfiles
{
    /// <summary>API'nin kabul ettiği profil adları → enum. Bilinmeyen ad → false (400).</summary>
    public static bool TryParse(string? value, out ExportProfile profile)
    {
        switch (value?.Trim().ToLowerInvariant())
        {
            case "1080p":
                profile = ExportProfile.Hd1080p;
                return true;
            case "720p":
                profile = ExportProfile.Hd720p;
                return true;
            case "2160p":
            case "4k":
                profile = ExportProfile.Uhd2160p;
                return true;
            case "dikey":
                profile = ExportProfile.Vertical1080p;
                return true;
            default:
                profile = default;
                return false;
        }
    }

    public static string Name(ExportProfile profile) => profile switch
    {
        ExportProfile.Hd1080p => "1080p",
        ExportProfile.Hd720p => "720p",
        ExportProfile.Uhd2160p => "2160p",
        ExportProfile.Vertical1080p => "dikey",
        _ => throw new ArgumentOutOfRangeException(nameof(profile), profile, null),
    };

    /// <summary>Tüm profiller (400 mesajı ve istemci listesi tek kaynaktan sayılabilsin).</summary>
    public static IReadOnlyList<ExportProfile> All { get; } =
        [ExportProfile.Hd1080p, ExportProfile.Hd720p, ExportProfile.Uhd2160p, ExportProfile.Vertical1080p];

    /// <summary>Profilin hedef kutusu (çıktı dosyasının piksel boyutu).</summary>
    public static (int Width, int Height) Target(ExportProfile profile) => profile switch
    {
        ExportProfile.Hd1080p => (1920, 1080),
        ExportProfile.Hd720p => (1280, 720),
        ExportProfile.Uhd2160p => (3840, 2160),
        ExportProfile.Vertical1080p => (1080, 1920),
        _ => throw new ArgumentOutOfRangeException(nameof(profile), profile, null),
    };

    /// <summary>
    /// Profil + proje tuvali → çıktı geometrisi. EN-BOY KAPISI BURADADIR ve kural bilerek
    /// KISITLAMADIR, letterbox değil: profil tuvali hedefe ancak İKİSİNİN EN-BOY ORANI
    /// TAM (rasyonel çapraz çarpım) eşitse ölçekler; eşit değilse tipli 422/hata.
    /// <para>
    /// KARAR ÖLÇEREK VERİLDİ (2026-08-21, ffmpeg 8.0):
    ///  - Letterbox alternatifi ölçüldü: 1920x1080 içerik 1080x1920 kutuya sığdırılınca tam
    ///    ölçek 1080x607,5 pikseldir — YARIM PİKSEL. ffmpeg 608'e yuvarlar (ölçülen içerik
    ///    satırları 656..1263 = 608 satır), yani içerik ya yarım piksel kayar ya da binde
    ///    0,8 oranında esner; karenin %68,3'ü de siyah banttır. Kullanıcının önizlemede HİÇ
    ///    görmediği, çoğunluğu bant bir kare "anlaşılır çıktı" değildir.
    ///  - Önizleme↔export parite doktrini (rendering-semantics §9.3): önizleme DAİMA proje
    ///    tuvalini gösterir. Farklı en-boyu letterbox'lamak, önizlemesi OLMAYAN kareler
    ///    üretir ve golden parite protokolünün dışına düşer. Kısıt ise ters yönde güvenlidir:
    ///    ileride letterbox EKLEMEK 422'leri başarıya çevirir, kimseyi kırmaz.
    ///  - Editör bugün yalnız 1920x1080 tuval kurar → ürün İÇİNDEN ulaşılabilen her proje
    ///    1080p/720p/2160p ile birebir uyumludur; "dikey" bu projelerde açıklayıcı 422 verir.
    ///    16:9/9:16 DIŞI tuval yalnız ham API'den kurulabilir ve davranış değişikliği
    ///    docs/poc-bilinen-sinirlar.md'de beyan edilmiştir.
    /// </para>
    /// <para>
    /// Aynı oranın İKİ profili arasında ölçek serbesttir (küçültme de büyütme de): 1920x1080
    /// tuvalden 2160p istemek 2x büyütmedir — yumuşak ama anlaşılır bir 4K çıktısı.
    /// Tuval hedefle AYNI ise ölçek aşaması hiç üretilmez (bugünkü davranış bit-bit korunur).
    /// </para>
    /// </summary>
    public static ExportOutputSpec SpecFor(ExportProfile profile, int canvasWidth, int canvasHeight)
    {
        var (targetWidth, targetHeight) = Target(profile);

        // Rasyonel en-boy eşitliği: w1/h1 == w2/h2 ⇔ w1*h2 == w2*h1. Tuval kapıdan geçmiş
        // pozitif int'tir (ExportCompiler.Validate), long çarpım taşmaz.
        if ((long)canvasWidth * targetHeight != (long)targetWidth * canvasHeight)
        {
            var compatible = All
                .Where(p =>
                {
                    var (w, h) = Target(p);
                    return (long)canvasWidth * h == (long)w * canvasHeight;
                })
                .Select(Name)
                .ToList();
            var suggestion = compatible.Count > 0
                ? $"Bu tuvale uyan profil(ler): {string.Join(", ", compatible)}."
                : "Bu tuvalin oranına uyan profil yok — proje tuvalini 16:9 (ör. 1920x1080) "
                  + "ya da 9:16 (ör. 1080x1920) yapın.";
            throw new UnsupportedFeatureException("export-profile-aspect",
                $"'{Name(profile)}' profili {targetWidth.ToString(CultureInfo.InvariantCulture)}x"
                + $"{targetHeight.ToString(CultureInfo.InvariantCulture)} üretir; proje tuvali "
                + $"{canvasWidth.ToString(CultureInfo.InvariantCulture)}x"
                + $"{canvasHeight.ToString(CultureInfo.InvariantCulture)} ise farklı bir en-boy "
                + "oranında. Dışa aktarıcı farklı oranı bant ekleyerek (letterbox) DEĞİŞTİRMEZ — "
                + "önizlemede görülmeyen kare üretmemek için profil tuval oranına kısıtlıdır. "
                + suggestion);
        }

        return new ExportOutputSpec(profile, targetWidth, targetHeight);
    }

    /// <summary>
    /// Disk rezervasyonu için kaba çıktı bit hızı TABANI (tasarım 04 §4.2). CRF çıktısı içerik
    /// bağımlıdır — 1080p CRF18 veryfast için ~10 Mbps güvenli üst banttır (12. tur ölçümü);
    /// diğer profiller o ölçülü bandın PİKSEL ALANI oranıyla türetilir (720p ≈ 0,44x → 5 Mbps'e
    /// yukarı yuvarlanır; 2160p = 4x → 40 Mbps; dikey = 1080p ile aynı alan → 10 Mbps).
    /// Taban tek başına kullanılmaz: worker max(taban, kaynağın ölçülmüş bit hızı) alır
    /// (<c>ExportJob.EffectiveOutputBitsPerSecond</c>), yani grenli içerik kaynak teriminden yakalanır.
    /// </summary>
    public static long EstimatedBitsPerSecond(ExportProfile profile) => profile switch
    {
        ExportProfile.Hd1080p => 10_000_000,
        ExportProfile.Hd720p => 5_000_000,
        ExportProfile.Uhd2160p => 40_000_000,
        ExportProfile.Vertical1080p => 10_000_000,
        _ => throw new ArgumentOutOfRangeException(nameof(profile), profile, null),
    };

    /// <summary>
    /// Çıktı argümanları (map + codec + renk tag'leri + ses + faststart). Çıktı DOSYA YOLU
    /// içermez — çağıran sona ekler. Renk tag'leri rendering-semantics §6.1: çıktı daima
    /// açıkça BT.709/tv olarak işaretlenir.
    /// <para>
    /// 2160p CRF 19 kullanır (tasarım 04 §5 "4K H.264" satırı); tasarımın önerdiği sabit
    /// <c>-level 5.1</c> BİLEREK YOKTUR: proje fps penceresi 1–240'tır ve 4K@60+ karede 5.1
    /// beyanı bitstream'e YANLIŞ uyumluluk yazar — x264'ün otomatik seviye seçimi her
    /// çözünürlük/fps için doğru beyanı üretir.
    /// </para>
    /// </summary>
    public static IReadOnlyList<string> BuildOutputArgs(ExportProfile profile, int fpsNum, int fpsDen)
    {
        var crf = profile == ExportProfile.Uhd2160p ? "19" : "18";
        return
        [
            "-map", "[vout]",
            "-map", "[aout]",
            "-r", TimeFormat.Fps(fpsNum, fpsDen),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", crf,
            "-profile:v", "high", "-g", "150",
            "-pix_fmt", "yuv420p",
            "-color_primaries", "bt709", "-color_trc", "bt709",
            "-colorspace", "bt709", "-color_range", "tv",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-movflags", "+faststart",
        ];
    }
}
