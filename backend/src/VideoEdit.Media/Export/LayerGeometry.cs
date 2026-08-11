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
    /// scale hedef kutusu: <c>roundHalfUp(W * scale) × roundHalfUp(H * scale)</c>.
    /// force_original_aspect_ratio=decrease ile birlikte sonuç tam olarak
    /// <c>w_fit*scale × h_fit*scale</c>'dir (§2.2 fit=contain + §2.3 adım 1-2).
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

    /// <summary>overlay_x = AnchorTargetX - OverlayAnchorFactorX * overlay_w (§2.5 adım 3).</summary>
    public required double OverlayAnchorFactorX { get; init; }

    public required double OverlayAnchorFactorY { get; init; }

    /// <summary>
    /// Zincirin ÜRETTİĞİ EN BÜYÜK ara tuvalin genişliği (piksel) — overlay'e giren frame'in
    /// boyutu. Sıra: scale kutusu → [çapa pad'i ×PadWidthFactor] → [rotate ow=oh=Dg].
    /// Dönme varsa <c>Dg = ceil(hypot(padW, padH))</c> (kare tuval), yoksa scale kutusudur.
    /// Bellek tavanı BU değerden doğrulanır: rgba ara tuval = W*H*4 bayt/kare
    /// (kutudan doğrulamak pad'in 2x'ini ve rotate'in ~1.41x'ini GÖRMEZ — M4 denetim #2).
    /// </summary>
    public required long IntermediateWidth { get; init; }

    public required long IntermediateHeight { get; init; }

    public bool Rotates => RotationRad != 0;

    /// <summary>Çapa merkezde ise pad no-op'tur ve üretilmez (kx=ky=1, dx=dy=0).</summary>
    public bool NeedsAnchorPad =>
        Rotates && (PadWidthFactor != 1 || PadHeightFactor != 1);
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

    public static LayerPlacement Compute(Transform transform, int width, int height)
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

        var boxWidth = RoundHalfUp(width * transform.Scale);
        var boxHeight = RoundHalfUp(height * transform.Scale);

        // Ara tuval defteri (bellek tavanının doğrulandığı yer): pad yalnız DÖNEN + çapası
        // merkezde OLMAYAN katmanda üretilir; rotate ise ow=oh=hypot(iw,ih) ile kare tuval verir.
        // scale force_original_aspect_ratio=decrease kullandığı için gerçek w×h kutuyu AŞAMAZ →
        // kutudan türetilen bu değer üst sınırdır (güvenli taraf).
        var needsPad = rotationRad != 0 && (mx != 0.5d || my != 0.5d);
        var padWidth = needsPad ? Ceil(boxWidth * 2d * mx) : boxWidth;
        var padHeight = needsPad ? Ceil(boxHeight * 2d * my) : boxHeight;
        var diagonal = rotationRad != 0
            ? Ceil(Math.Sqrt(((double)padWidth * padWidth) + ((double)padHeight * padHeight)))
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
    /// rendering-semantics §1.2 half-up (banker's rounding YASAK).
    /// Aşırı ölçekte (ör. scale=1e30) sonuç long aralığını taşar; .NET Core 3.0'dan beri
    /// float→int dönüşümü SPEC GEREĞİ doyurur (long.MaxValue) — yani taşma ölçek tavanını
    /// sessizce geçemez. Bu varsayım Validate_AbsurdScale_CannotOverflowPastTheCeiling ve
    /// IntermediateCanvas_SaturatesInsteadOfOverflowing testleriyle sabitlenmiştir.
    /// </summary>
    internal static long RoundHalfUp(double x) => (long)Math.Floor(x + 0.5);

    /// <summary>Ara tuval defteri için yukarı yuvarlama (§2.5 Dg = ceil(hypot(...))).</summary>
    internal static long Ceil(double x) => (long)Math.Ceiling(x);
}
