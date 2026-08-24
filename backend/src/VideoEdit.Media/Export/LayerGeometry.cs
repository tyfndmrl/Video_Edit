using VideoEdit.Contracts.Timeline;

namespace VideoEdit.Media.Export;

/// <summary>
/// Bir katman klibinin ffmpeg geometri planı (rendering-semantics §2.5 karşılığı).
/// Saf veri: dosya/ffmpeg bilgisi yok, kaynak çözünürlüğüne BAĞLI DEĞİL — ölçek hedefi
/// proje tuvalinin katı, çapa telafisi ve overlay konumu ise ffmpeg'in kendi
/// <c>iw/ih</c> (pad) ve <c>w/h</c> (overlay) değişkenleriyle ifade edilir. Böylece
/// compiler kaynak boyutunu bilmeden §2'nin normatif matrisini birebir kurar.
/// </summary>
public sealed record LayerPlacement
{
    /// <summary>
    /// scale HEDEF kutusu: <c>roundHalfUp(W * scale) × roundHalfUp(H * scale)</c>
    /// (§2.2 fit=contain + §2.3 adım 1-2). Bu bir ÜST SINIRDIR, gerçek çıktı değil:
    /// <c>force_original_aspect_ratio=decrease:force_divisible_by=2</c> aspect'i korur ve
    /// sonucu ÇİFTE indirir, farkı SAR'a taşır (ölç.: kutu 962x541 + 16:9 kaynak → 962x540
    /// sar 480/481; kare kaynak → 542x540 sar 270/271). Kutuya normalize eden pad bu yüzden
    /// ham kutuyu değil <see cref="NormalizeBoxWidth"/>/<see cref="NormalizeBoxHeight"/>'ı hedefler.
    /// </summary>
    public required long BoxWidth { get; init; }

    public required long BoxHeight { get; init; }

    /// <summary>Normalize edilmiş dönme (radyan, saat yönü +). 0 ise rotate üretilmez.</summary>
    public required double RotationRad { get; init; }

    /// <summary>
    /// Çapa telafisi pad'i (§2.5 adım 3'ün eşdeğeri): görüntü, ÇAPASI padded tuvalin
    /// merkezine gelecek şekilde şeffaf tuvale yerleştirilir; böylece merkez etrafında
    /// dönen ffmpeg <c>rotate</c> filtresi fiilen ÇAPA etrafında döner ve overlay
    /// telafisi <c>w/2, h/2</c>'ye sadeleşir. Çarpanlar iw/ih ile çarpılır.
    /// </summary>
    public required double PadWidthFactor { get; init; }

    public required double PadHeightFactor { get; init; }

    public required double PadXFactor { get; init; }

    public required double PadYFactor { get; init; }

    /// <summary>P = (W/2 + x*W, H/2 + y*H) — çapanın kompozisyondaki hedefi (§2.3 adım 4).</summary>
    public required double AnchorTargetX { get; init; }

    public required double AnchorTargetY { get; init; }

    /// <summary>
    /// overlay_x = <c>floor</c>(AnchorTargetX − OverlayAnchorFactorX * overlay_w) — §2.5 adım 4.
    /// <c>overlay_w</c> ffmpeg'in kendi <c>w</c>'sidir (ÇİZİLEN ara tuval), defterdeki
    /// <see cref="IntermediateWidth"/> değil.
    /// </summary>
    public required double OverlayAnchorFactorX { get; init; }

    public required double OverlayAnchorFactorY { get; init; }

    /// <summary>
    /// Ara tuval genişliğinin ÜST SINIRI (piksel) — KUTUDAN hesaplanır, gerçek çıktıdan değil.
    /// Sıra: scale kutusu → [çapa pad'i ×PadWidthFactor] → [rotate, kare tuval].
    /// Dönme varsa değer köşegeni kapsayan en küçük ÇİFT tamsayıdır
    /// (<see cref="LayerGeometry.CeilEven"/>), yoksa scale kutusudur.
    /// <para>
    /// ÇİZİLEN tuval bundan KÜÇÜK olabilir: filtergraph aynı fonksiyonu ffmpeg'in gerçek
    /// <c>iw/ih</c>'siyle değerlendirir. Fark KASITLIDIR — üst sınır güvenli taraftır.
    /// </para>
    /// <para>
    /// DÖNEN + ÇAPASI MERKEZDE katmanda fark artık YALNIZ çifte indirmeden doğar: rotate'in
    /// girişi <see cref="NormalizeBoxWidth"/>/<see cref="NormalizeBoxHeight"/>'a sabitlenir
    /// (ExportCompiler.BuildPlacementChain — geçiş eklemek katmanı oynatmasın diye), yani
    /// çizilen tuval kaynağın aspect'inden BAĞIMSIZDIR. Ölçüldü (gerçek ffmpeg 8.0, kutu
    /// <c>1066x599</c>): eski yolda rotate girişi 16:9 kaynağın gerçek çıktısı <c>1064x598</c>
    /// olduğu için tuval <c>1222</c> çiziliyordu; normalize edilmiş <c>1066x598</c> girişiyle
    /// tuval <c>1224</c>, yani bu defterin söylediği sayının kendisi.
    /// </para>
    /// <para>
    /// Bellek tavanı BU değerden doğrulanır: rgba ara tuval = W*H*4 bayt/kare
    /// (kutudan doğrulamak pad'in 2x'ini ve rotate'in ~1.41x'ini GÖRMEZ — M4 denetim #2).
    /// KONUM aritmetiğinde KULLANILMAZ: overlay ifadesi ffmpeg'in kendi <c>w/h</c>'sini okur.
    /// </para>
    /// </summary>
    public required long IntermediateWidth { get; init; }

    public required long IntermediateHeight { get; init; }

    public bool Rotates => RotationRad != 0;

    /// <summary>Çapa merkezde ise pad no-op'tur ve üretilmez (kx=ky=1, dx=dy=0).</summary>
    public bool NeedsAnchorPad =>
        Rotates && (PadWidthFactor != 1 || PadHeightFactor != 1);

    /// <summary>
    /// Kutuya normalize eden pad'in HEDEFİ = kutunun ÇİFTE İNDİRİLMİŞ hali. Ölçek hedefi
    /// (<see cref="BoxWidth"/>) ham kutu kalır — yalnız pad hedefi indirilir.
    /// <para>
    /// GEREKÇE (gerçek ffmpeg 8.0 ölçümü): <c>scale=...:force_original_aspect_ratio=decrease:
    /// force_divisible_by=2</c> çıktısı ÇİFT ve kutudan küçük/eşittir. Çift bir sayı TEK N'den
    /// küçük/eşitse N-1'den de küçük/eşittir → bu hedef kırpmaz. Ve çift hedef + çift içerik
    /// ⇒ <c>(ow-iw)/2</c> TAM bölünür; ham TEK kutuya pad'lemek ise yarım pikseli kırpar ve
    /// overlay'in kendi kırpmasıyla (<c>540-0.5*541</c>) AYNI YÖNE toplanıp katmanı 1 TAM
    /// piksel kaydırırdı (ölçüldü: 962x541 kutuda içerik y[269..808], doğrusu y[270..809]).
    /// </para>
    /// <para>
    /// ÖNKOŞUL: ffmpeg'in "≤ kutu" sözleşmesi ancak sığdırılan boyut ≥ 1 px iken geçerlidir —
    /// yani yerleşim DEJENERE OLMAMALIDIR (<see cref="LayerGeometry.IsDegenerate"/>). Dejenere
    /// rejimde scale o ekseni 0 hesaplar ve 0'ı "girdi boyutunu koru" diye yorumlar; çıktı
    /// kutudan BÜYÜK olur ve bu hedef anlamını yitirir. O rejim artık derlemeye hiç GİRMEZ:
    /// <c>degenerate-layer</c> tipli hatasıyla reddedilir (Validate'te 422, Compile'da tipli
    /// hata). Kapı olmasaydı iki farklı sonuç doğardı ve İKİSİ DE yanlıştı — ölçüldü:
    /// kaynak 1920x100 + kutu 19x11 → çıktı 18x100 (pad hedefi 18x10 → "Padded dimensions
    /// cannot be smaller", ffmpeg -22), kaynak 200x10 + kutu 19x11 → çıktı 18x10 (pad'e SIĞAR,
    /// hiçbir hata vermez, katman SESSİZCE 10 kat yanlış yükseklikte çizilir).
    /// </para>
    /// <para>
    /// <c>Math.Max(2, ...)</c>: Box ≥ 2 kapının garantisidir (<c>ExportCompiler.EnsureLayerFloor</c>),
    /// ama o kapı ölçek TABANINDAN sorulur ve bu yerleşim ölçek TAVANINDAN kurulur; ayrıca
    /// Compile'ı Validate'siz çağıran bir yol açılırsa hiç koşmaz. Kelepçe pad=0'ı
    /// (ffmpeg'de "girdi boyutu" demek) her hâlükârda imkânsız kılar.
    /// </para>
    /// </summary>
    public long NormalizeBoxWidth => Math.Max(2, BoxWidth & ~1L);

    /// <inheritdoc cref="NormalizeBoxWidth"/>
    public long NormalizeBoxHeight => Math.Max(2, BoxHeight & ~1L);
}

/// <summary>
/// Transform → ffmpeg geometrisi (rendering-semantics §2, NORMATİF). Sıra değiştirilemez:
/// fit=contain → scale → çapa etrafında rotate → çapayı P'ye taşı.
/// </summary>
public static class LayerGeometry
{
    /// <summary>
    /// Tek katmanın ARA TUVALİ için üst sınır (piksel) — <see cref="LayerPlacement.IntermediateWidth"/>
    /// / <see cref="LayerPlacement.IntermediateHeight"/> üzerinden doğrulanır, scale kutusundan
    /// DEĞİL: çapa pad'i kutuyu 2x'e, rotate hypot'u ~1.41x'e kadar büyütür; kutudan doğrulamak
    /// gerçek tavanı 8192*2*√2 ≈ 23170'e (rgba'da ~2.1 GB/kare) taşırdı (M4 denetim #2).
    /// 8192² rgba = 256 MB/kare — worker'ın taşıyabileceği üst sınır.
    /// </summary>
    public const long MaxLayerDimension = 8192;

    /// <summary>
    /// Katman ölçek kutusu PROJE TUVALİNDEN türer (fit=contain, §2.2): medya/görsel/çıkartma
    /// klipleri kompozisyona sığdırılır, <c>scale = 1</c> "fit boyutu" demektir.
    /// </summary>
    public static LayerPlacement Compute(Transform transform, int width, int height) =>
        Compute(transform, width, height, width, height);

    /// <summary>
    /// Genel biçim: <paramref name="fitWidth"/>/<paramref name="fitHeight"/> katmanın
    /// <c>scale = 1</c> boyutudur (ölçek kutusu bunun <c>scale</c> katıdır), tuval boyutu ise
    /// yalnız hedef noktayı (<c>P = (W/2 + x*W, H/2 + y*H)</c>, §2.3 adım 4) belirler.
    /// <para>
    /// İkisinin AYRILMASI metin/şekil rasterleri içindir (rendering-semantics §7): metin PNG'si
    /// elemanın KENDİ bbox'ıdır ve @2x rasterize edilir; doğal boyutu (rasterPx/2) proje
    /// pikselindeki gerçek boyutudur. Bu katmanı fit=contain ile tuvale sığdırmak
    /// <c>fontSizePx</c>'i tamamen anlamsızlaştırırdı (her punto aynı ekran boyutunu verirdi).
    /// Medya/görsel/çıkartma kliplerinde iki boyut aynıdır → §2.2 davranışı BİREBİR korunur.
    /// </para>
    /// </summary>
    public static LayerPlacement Compute(
        Transform transform, int width, int height, double fitWidth, double fitHeight)
    {
        ArgumentNullException.ThrowIfNull(transform);

        // §2.3 adım 3: dönme saat yönünde pozitiftir (CSS/Canvas ve ffmpeg rotate uyumlu).
        // 360'ın katları rotate üretmez — filtre atlanır (aynı görüntü, daha ucuz + alpha'sız).
        var rotationDeg = transform.RotationDeg % 360d;
        if (rotationDeg < 0)
        {
            rotationDeg += 360d;
        }

        var rotationRad = rotationDeg == 0 ? 0d : rotationDeg * Math.PI / 180d;

        // §2.5 adım 3: çapa telafisi. Çapayı padded tuvalin merkezine getiren simetrik pad:
        //   padW = iw * 2*max(ax, 1-ax);  offsetX = iw * (max(ax, 1-ax) - ax)
        // (ax = anchorX ∈ [0..1]). Çapa 0.5 iken kx=1, dx=0 → pad üretilmez.
        var mx = Math.Max(transform.AnchorX, 1d - transform.AnchorX);
        var my = Math.Max(transform.AnchorY, 1d - transform.AnchorY);

        var boxWidth = RoundHalfUp(fitWidth * transform.Scale);
        var boxHeight = RoundHalfUp(fitHeight * transform.Scale);

        // Ara tuval defteri (bellek tavanının doğrulandığı yer): pad yalnız DÖNEN + çapası
        // merkezde OLMAYAN katmanda üretilir; rotate ise köşegeni kapsayan en küçük ÇİFT kenarla
        // kare tuval verir (bkz. CeilEven — filtergraph'taki 2*ceil(hypot(iw,ih)/2)'nin ikizi).
        // scale force_original_aspect_ratio=decrease kullandığı için gerçek w×h kutuyu AŞAMAZ →
        // kutudan türetilen bu değer üst sınırdır (güvenli taraf); çifte tamamlama monoton
        // olduğu için üst sınır olma özelliğini BOZMAZ.
        //
        // "AŞAMAZ" KOŞULLUDUR: yalnız yerleşim dejenere DEĞİLKEN doğrudur (bkz. IsDegenerate).
        // Dejenere rejimde gerçek çıktı kaynağın kendi boyutuna sıçrar ve defter küçük gösterir
        // (ölçüldü: kutu 19x11, gerçek 18x100 → dönmede ara tuval hypot(18,100)=101.6 iken
        // defter hypot(19,11)=22 der; 4.6x doğrusal / 21x alan). Bu yüzden dejenere
        // yerleşim derlemeye hiç GİRMEZ — ExportCompiler kapısı onu tipli hatayla reddeder.
        var needsPad = rotationRad != 0 && (mx != 0.5d || my != 0.5d);
        var padWidth = needsPad ? Ceil(boxWidth * 2d * mx) : boxWidth;
        var padHeight = needsPad ? Ceil(boxHeight * 2d * my) : boxHeight;
        var diagonal = rotationRad != 0
            ? CeilEven(Math.Sqrt(((double)padWidth * padWidth) + ((double)padHeight * padHeight)))
            : 0;

        return new LayerPlacement
        {
            BoxWidth = boxWidth,
            BoxHeight = boxHeight,
            IntermediateWidth = rotationRad != 0 ? diagonal : padWidth,
            IntermediateHeight = rotationRad != 0 ? diagonal : padHeight,
            RotationRad = rotationRad,
            PadWidthFactor = 2d * mx,
            PadHeightFactor = 2d * my,
            PadXFactor = mx - transform.AnchorX,
            PadYFactor = my - transform.AnchorY,
            AnchorTargetX = width / 2d + transform.X * width,
            AnchorTargetY = height / 2d + transform.Y * height,
            // Dönen katmanda çapa, pad sayesinde rotate tuvalinin TAM ORTASINDADIR;
            // dönmeyen katmanda çapa görüntünün kendi kutusundaki oranındadır.
            OverlayAnchorFactorX = rotationRad == 0 ? transform.AnchorX : 0.5d,
            OverlayAnchorFactorY = rotationRad == 0 ? transform.AnchorY : 0.5d,
        };
    }

    /// <summary>
    /// Ölçek kutusu (§2.3 adım 1-2) — yerleşimin geri kalanı gerekmediğinde.
    /// <c>roundHalfUp(fit * scale)</c>, <see cref="Compute(Transform, int, int, double, double)"/>
    /// ile BİREBİR aynı aritmetik.
    /// <para>
    /// YALNIZ STATİK ölçek yolunun modelidir: orada kutu burada hesaplanır ve filtergraph'a
    /// SABİT tamsayı olarak yazılır (<c>scale=962:541</c>). Ölçek ANİMASYONLU olduğunda kutuyu
    /// compiler değil ffmpeg üretir → <see cref="ScaleBoxTruncated"/>.
    /// </para>
    /// </summary>
    public static (long Width, long Height) ScaleBox(double fitWidth, double fitHeight, double scale) =>
        (RoundHalfUp(fitWidth * scale), RoundHalfUp(fitHeight * scale));

    /// <summary>
    /// ANİMASYONLU ölçek yolunun kutusu: <c>floor(fit * scale)</c>.
    /// <para>
    /// Animasyonlu yolda filtergraph'a HAM ÇARPIM İFADESİ yazılır
    /// (<c>scale=w='...223*s(t)...':eval=frame</c>, bkz. <c>ExportCompiler.ScaleFilter</c>) ve
    /// tamsayıya çeviren ffmpeg'dir — YUVARLAYARAK değil, KIRPARAK. Fark tek pikselliktir ama
    /// tabanda belirleyicidir: <c>force_divisible_by=2</c> tek bir pikseli 0'a indirir.
    /// </para>
    /// <para>
    /// GERÇEK ffmpeg 8.0 ölçümü (kaynak 223x104, <c>ScaleBoxTruncated_MatchesRealFfmpeg</c>
    /// canlı ffmpeg'e karşı yeniden koşar): <c>w='3.9' h='2.9'</c> → çıkış 2x2 (kutu 3x2),
    /// <c>w='4.0' h='3.0'</c> → 4x2. Yuvarlama olsaydı ilki de 4x2 verirdi.
    /// <c>w='3.345' h='1.56'</c> → 2x104, yani kutu 3x1 ve YÜKSEKLİK ÇÖKÜYOR — bu tam olarak
    /// denetimde kapıdan geçip ffmpeg'i öldürdüğü canlı ölçülen belgedir.
    /// </para>
    /// </summary>
    public static (long Width, long Height) ScaleBoxTruncated(
        double fitWidth, double fitHeight, double scale) =>
        (Truncate(fitWidth * scale), Truncate(fitHeight * scale));

    /// <summary>
    /// <c>scale=BW:BH:force_original_aspect_ratio=decrease:force_divisible_by=2</c> filtresinin
    /// GERÇEK çıktı boyutu. ffmpeg 8.0'ın <c>ff_scale_adjust_dimensions</c> davranışının birebir
    /// tamsayı modelidir.
    /// <para>
    /// CI'DA KORUNAN KÜME (sayı testin kendisinden): modelin canlı ffmpeg ile BİREBİR eşitliği
    /// <c>GoldenFrameTests.ScaleOutput_MatchesRealFfmpeg</c>'de <c>MeasuredScaleOutputs</c>
    /// tablosunun 20 (kaynak, kutu) çiftinde koşulur; ayrıca <c>ScaleOutput_IsAlwaysEven_</c>
    /// <c>AndFitsTheEvenBox</c> 7 çiftte "çıktı ÇİFT ve çifte indirilmiş kutunun içinde"
    /// sözleşmesini canlı ffmpeg'e sorar. Bu ikisinin dışındaki taramalar (kapalı formun tam
    /// modelle uyuşması) MODEL↔MODEL'dir, ffmpeg'e sorulmaz.
    /// </para>
    /// <para>
    /// Kayan nokta KULLANILMAZ: yuvarlama ffmpeg'in <c>av_rescale</c>'i gibi "yarım, sıfırdan
    /// uzağa"dır ve tamsayı aritmetiğiyle ifade edilir — kayan noktalı bir replika ffmpeg
    /// sürümleri arasında sessizce ayrışırdı.
    /// </para>
    /// <para>
    /// TAŞMA: çağrı sırası gereği kutu <see cref="MaxLayerDimension"/> ile sınırlıdır
    /// (EnsureLayerCeiling ÖNCE koşar) ve kaynak boyutu ffprobe'un int'idir → çarpım
    /// 8192·2³¹ ≈ 1.8e13, long aralığının çok altında.
    /// </para>
    /// </summary>
    public static (long Width, long Height) ScaleOutput(
        long boxWidth, long boxHeight, long srcWidth, long srcHeight)
    {
        var (width, height) = RawScaleOutput(boxWidth, boxHeight, srcWidth, srcHeight);

        // DEJENERE DAL: 0, ffmpeg'de "girdi boyutunu koru" demektir (scale.c'nin sözleşmesi).
        return (width == 0 ? srcWidth : width, height == 0 ? srcHeight : height);
    }

    /// <summary>
    /// <see cref="ScaleOutput"/>'un 0 İKAMESİ YAPILMAMIŞ hali. 0, "ffmpeg bu ekseni
    /// hesaplayamadı" demektir ve dejenereliğin TANIMIDIR — ikame edilmiş değere bakarak
    /// (ör. "çıktı kutudan büyük mü") sormak 1x1 gibi uç kaynaklarda yanlış cevap verirdi.
    /// </summary>
    private static (long Width, long Height) RawScaleOutput(
        long boxWidth, long boxHeight, long srcWidth, long srcHeight)
    {
        const long d = 2; // force_divisible_by

        // aspect'i koruyan iki aday; her biri D'nin katına yuvarlanır (yarım → yukarı).
        var tmpWidth = Rescale(boxHeight * srcWidth, srcHeight * d) * d;
        var tmpHeight = Rescale(boxWidth * srcHeight, srcWidth * d) * d;

        // decrease: kutuyu AŞAN aday kutuya kırpılır, sonra D'nin katına AŞAĞI indirilir.
        return (Math.Min(tmpWidth, boxWidth) / d * d, Math.Min(tmpHeight, boxHeight) / d * d);
    }

    /// <summary>
    /// Yerleşim DEJENERE mi: <c>scale</c> bir ekseni 0 hesaplayıp "girdi boyutunu koru" diye
    /// yorumluyor mu. Böyle bir katman İKİ yoldan biriyle bozulur ve ikisi de kabul edilemez:
    /// çıktı normalize pad hedefini aşarsa ffmpeg <c>-22</c> ile ölür (kuyruk-sonrası ölüm),
    /// aşmazsa katman SESSİZCE yanlış boyutta çizilir (ölç.: 200x10 kaynak, kutu 19x11 →
    /// 18x10, önizleme 20x1 çizerken export 10 KAT yüksek).
    /// <para>
    /// Kutu ≥ 2 iken kapalı formu <c>BW·srcH &lt; srcW || BH·srcW &lt; srcH</c>'dir
    /// (<see cref="MinScaleFor"/> bunu tersine çözer); kutu &lt; 2 iken <c>min</c> kırpması da
    /// 0 üretebildiği için burada TAM MODEL kullanılır — yaklaşık bir yüklem yanlış kabul
    /// (ya da yanlış ret) üretirdi.
    /// </para>
    /// <para>
    /// KUTU 0 (yalnız ölçek animasyonunun tabanında ulaşılabilir: kutu ham çarpımla sürülür,
    /// <c>bbox × scale(t)</c>) dejenereliğin EN AĞIR halidir, "bilinmiyor" değil: ffmpeg 0'ı
    /// hiç hesaplamaz, doğrudan girdi boyutuna sıçrar. Ölçüldü (metin bbox 6x20, ölçek 0.010):
    /// <c>scale=w='...*0.06':h='...*0.2'</c> → ffmpeg 99 kare yazdıktan sonra render ORTASINDA
    /// <c>Picture size 0x4 is invalid</c> ile ölüyor (exit -12). Bu yüzden kutu ≤ 0 KAYNAK
    /// BİLİNİYORken dejeneredir; kaynak bilinmiyorsa (defterde yok) kapı hâlâ atlanır.
    /// </para>
    /// </summary>
    public static bool IsDegenerate(long boxWidth, long boxHeight, long srcWidth, long srcHeight)
    {
        if (srcWidth <= 0 || srcHeight <= 0)
        {
            return false; // kaynak BİLİNMİYOR → kapı ÇALIŞMAZ (yanlış ret üretmemeli)
        }

        if (boxWidth <= 0 || boxHeight <= 0)
        {
            return true;
        }

        var (rawWidth, rawHeight) = RawScaleOutput(boxWidth, boxHeight, srcWidth, srcHeight);
        return rawWidth == 0 || rawHeight == 0;
    }

    /// <summary>
    /// Dejenereliğin KAYNAKTAN BAĞIMSIZ yarısı: kutunun bir ekseni 2'nin altındaysa
    /// <c>force_divisible_by=2</c> onu <c>min(aday, kutu) / 2 * 2 = 0</c>'a indirir ve ffmpeg
    /// 0'ı "girdi boyutunu koru" diye yorumlar — kaynağın ne olduğundan BAĞIMSIZ olarak.
    /// Kaynak boyutu bilinmediğinde (asset hâlâ işleniyor, ya da raster PNG'si Validate
    /// aşamasında henüz üretilmemiş) kapının sorabildiği tek soru budur.
    /// <para>
    /// <see cref="IsDegenerate"/> ile ÇELİŞMEZ, onun bir ALT KÜMESİDİR: kaynak biliniyorken
    /// kutu &lt; 2 daima dejenere çıkar (<c>ScaleFloor_ImpliesDegeneracy_OverTheSweptSources</c>
    /// bunu tarayarak sabitler), yani iki yüklem aynı rejimi işaret eder.
    /// </para>
    /// </summary>
    public static bool IsBelowScaleFloor(long boxWidth, long boxHeight) =>
        boxWidth < 2 || boxHeight < 2;

    /// <summary>
    /// Verilen kaynak için dejenere OLMAYAN en küçük ölçek, editörün ölçek ızgarasına
    /// (3 ondalık) YUKARI yuvarlanmış. Kullanıcıya "ölçeği en az şu yapın" derken kullanılır.
    /// <para>
    /// Kapalı form: kutu her iki eksende <c>max(2, ceil(src/diğer))</c> olmalıdır. Eşiğin
    /// tersi KUTU ARİTMETİĞİNE bağlıdır ve iki yol farklıdır:
    /// <c>roundHalfUp(fit·s) ≥ N ⟺ s ≥ (N−0.5)/fit</c> (statik),
    /// <c>floor(fit·s) ≥ N ⟺ s ≥ N/fit</c> (<paramref name="truncated"/> — animasyonlu).
    /// Kutu ölçekte monoton olduğundan bu eşik KESİNDİR (üstündeki her ölçek de geçerlidir).
    /// Sonuç yine de kapının KENDİ yüklemiyle DOĞRULANIR: kullanıcı bu sayıyı birebir
    /// yazacak, kayan nokta yuvarlaması onu bir ızgara adımı eksik önermemeli.
    /// </para>
    /// <para>
    /// KAYNAK BİLİNMİYORken (<paramref name="srcWidth"/>/<paramref name="srcHeight"/> ≤ 0)
    /// sorulabilecek tek şey kaynaktan bağımsız yarıdır (<see cref="IsBelowScaleFloor"/>):
    /// kutu her iki eksende ≥ 2 olmalı. Metin/şekil rasterinin PNG boyutu Validate aşamasında
    /// henüz yoktur; kapı orada bu yarıyı sorar ve önerdiği sayı da bu yarıya ait olmalıdır.
    /// </para>
    /// </summary>
    public static double MinScaleFor(
        double fitWidth, double fitHeight, long srcWidth, long srcHeight, bool truncated = false)
    {
        if (fitWidth <= 0 || fitHeight <= 0 || !double.IsFinite(fitWidth) || !double.IsFinite(fitHeight))
        {
            return 0;
        }

        var known = srcWidth > 0 && srcHeight > 0;
        var minBoxWidth = known ? Math.Max(2, CeilDiv(srcWidth, srcHeight)) : 2;
        var minBoxHeight = known ? Math.Max(2, CeilDiv(srcHeight, srcWidth)) : 2;
        var slack = truncated ? 0d : 0.5d;
        var exact = Math.Max(
            (minBoxWidth - slack) / fitWidth,
            (minBoxHeight - slack) / fitHeight);

        var candidate = Math.Ceiling(exact * ScaleGrid) / ScaleGrid;
        for (var guard = 0; guard < 4; guard++)
        {
            var (boxWidth, boxHeight) = truncated
                ? ScaleBoxTruncated(fitWidth, fitHeight, candidate)
                : ScaleBox(fitWidth, fitHeight, candidate);
            var rejected = known
                ? IsDegenerate(boxWidth, boxHeight, srcWidth, srcHeight)
                : IsBelowScaleFloor(boxWidth, boxHeight);
            if (!rejected)
            {
                return candidate;
            }

            candidate = Math.Round(candidate + (1d / ScaleGrid), 3, MidpointRounding.AwayFromZero);
        }

        return candidate;
    }

    /// <summary>
    /// Editörün ölçek ızgarası: 3 ondalık (<c>TRANSFORM_SCALE_DECIMALS</c>,
    /// <c>packages/timeline-schema/src/invariants.ts</c>). Önerilen ölçek bu ızgarada
    /// OLMALIDIR — kullanıcı alana yazdığında değer değişmesin.
    /// </summary>
    private const double ScaleGrid = 1000d;

    /// <summary>Pozitif tamsayılarda yukarı bölme.</summary>
    private static long CeilDiv(long a, long b) => (a + b - 1) / b;

    /// <summary>ffmpeg <c>av_rescale</c>: yarım SIFIRDAN UZAĞA (pozitif girdide yukarı).</summary>
    private static long Rescale(long value, long divisor) => (value + (divisor / 2)) / divisor;

    /// <summary>
    /// rendering-semantics §1.2 half-up (banker's rounding YASAK).
    /// Aşırı ölçekte (ör. scale=1e30) sonuç long aralığını taşar; .NET Core 3.0'dan beri
    /// float→int dönüşümü SPEC GEREĞİ doyurur (long.MaxValue) — yani taşma ölçek tavanını
    /// sessizce geçemez. Bu varsayım Validate_AbsurdScale_CannotOverflowPastTheCeiling ve
    /// IntermediateCanvas_SaturatesInsteadOfOverflowing testleriyle sabitlenmiştir.
    /// </summary>
    internal static long RoundHalfUp(double x) => (long)Math.Floor(x + 0.5);

    /// <summary>Ara tuval defteri için yukarı yuvarlama.</summary>
    internal static long Ceil(double x) => (long)Math.Ceiling(x);

    /// <summary>
    /// §2.5'in ara tuval kenarı: köşegeni kapsayan EN KÜÇÜK ÇİFT tamsayı. Filtergraph'a yazılan
    /// <c>2*ceil(hypot(iw\,ih)/2)</c> ifadesinin birebir aritmetik ikizi — AYNI FONKSİYON, ama
    /// burada FARKLI GİRDİYLE: defter (üst sınır olan) kutudan, filtergraph gerçek
    /// <c>w_px/h_px</c>'ten hesaplar. Dönüşüm monoton olduğu için defter ÜST SINIR kalır;
    /// iki sayının EŞİT olması beklenmez (ölç.: kutu <c>1066x599</c> → defter <c>1224</c>,
    /// çizilen <c>1222</c>).
    /// <para>
    /// Tuvalin ÇİFT olması bir optimizasyon değil GEOMETRİ ŞARTIDIR: tek tuvalde içerik tuvalin
    /// ortasına oturamaz ve overlay telafisi <c>0.5*w</c> yarım tamsayı olur (ölçümler
    /// <c>ExportCompiler</c>'ın rotate satırındaki yorumda).
    /// </para>
    /// <para>
    /// TAŞMA: <c>Ceil</c> aşırı ölçekte <c>long.MaxValue</c>'ya doyar (§ RoundHalfUp); orada
    /// çifte tamamlama YAPILMAZ — <c>+1</c> negatife sarardı ve tavan kapısı sessizce geçilirdi.
    /// Doymuş değer zaten <see cref="MaxLayerDimension"/>'ın çok üstündedir, kapı onu reddeder.
    /// </para>
    /// </summary>
    internal static long CeilEven(double x)
    {
        var raw = Ceil(x);
        return raw >= long.MaxValue - 1 ? raw : (raw + 1) & ~1L;
    }

    /// <summary>
    /// ffmpeg'in ifade → tamsayı çevrimi: SIFIRA DOĞRU kırpma. Negatif girdi bu hatta
    /// ulaşamaz (ölçek pozitif doğrulanır), yani <c>Math.Floor</c> ile ayrışmaz.
    /// </summary>
    internal static long Truncate(double x) => (long)Math.Truncate(x);
}
