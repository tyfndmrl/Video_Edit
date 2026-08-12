using System.Globalization;
using System.Text.Json;
using VideoEdit.Contracts.Timeline;

namespace VideoEdit.Media.Export;

/// <summary>
/// <c>colorAdjust</c> parametreleri (rendering-semantics §4.1). Hepsi UI aralığında
/// <c>[-1..1]</c>, 0 = etkisiz. Şemada <c>Effect.params</c> serbest bir sözlüktür
/// (<c>Dictionary&lt;string, object&gt;</c>) — bu kayıt onun DOĞRULANMIŞ karşılığıdır.
/// </summary>
public sealed record ColorAdjustParams(
    double Exposure,
    double Temperature,
    double Tint,
    double Contrast,
    double Brightness,
    double Saturation)
{
    public static readonly ColorAdjustParams Identity = new(0, 0, 0, 0, 0, 0);

    /// <summary>
    /// Tüm parametreler 0 → §4.1 gereği compiler HİÇ filtre üretmez (shader da no-op'tur).
    /// </summary>
    public bool IsIdentity => this == Identity;
}

/// <summary>
/// <c>lut</c> efekti (rendering-semantics §4.2): <c>.cube</c> dosyası bir ASSET'tir,
/// <c>intensity ∈ [0..1]</c> karışım oranıdır (<c>out = mix(orig, LUT(orig), intensity)</c>).
/// </summary>
public sealed record LutParams(Guid AssetId, double Intensity);

/// <summary>
/// Bir klibin DOĞRULANMIŞ efekt kümesi. MVP seti tam olarak ikidir (§4) ve uygulama sırası
/// NORMATİFTİR: <c>colorAdjust</c> → <c>lut</c>. Klip başına her tipten EN FAZLA BİR tane
/// olabilir — iki colorAdjust'ın hangi sırayla uygulanacağı önizleme uber-shader'ında
/// temsil EDİLEMEZ (shader tek parametre kümesi alır), o yüzden çokluk tipli hatadır
/// (editör de zaten birleştirir: inspectorFeedback "duplicate colorAdjust effects merged").
/// </summary>
public sealed record ClipEffects(ColorAdjustParams? Color, LutParams? Lut)
{
    public static readonly ClipEffects None = new(null, null);

    public bool Any => Color is not null || Lut is not null;
}

/// <summary>
/// Efekt → ffmpeg filtre eşlemesi (rendering-semantics §4). Aşama sırası NORMATİFTİR ve
/// değiştirilemez: <c>exposure → temperature → tint → contrast+brightness (TEK afin op)
/// → saturation</c>, ardından <c>lut</c>. Her aşama sonucu [0..1]'e clamp edilir — 8-bit
/// RGB ara formatları (lutrgb/colorchannelmixer) bunu doğal olarak yapar, GLSL tarafı da
/// aşama başına clamp eder (apps/editor .../core/colorAdjustRef.ts).
/// <para>
/// <b>SÖZLEŞME KARARA BAĞLANDI (M5, baş mimar).</b> §4.1 tablosunun "ffmpeg formülü" hücresi
/// eskiden contrast+brightness için <c>eq=contrast=&lt;1+v&gt;:brightness=&lt;b&gt;</c>,
/// saturation için <c>eq=saturation=&lt;1+v&gt;</c> diyordu; gerekçesi ("luma-afin dönüşüm
/// RGB'de aynı afin dönüşüme denktir") YANLIŞTI ve <b>doküman koda göre düzeltildi</b>
/// (bkz. rendering-semantics §4.1.1, ölçüm kanıtı orada). Özet: <c>eq</c> contrast'ı yalnız
/// LUMA düzlemine uygular, kanal-başına afin op ile ancak R=G=B iken çakışır — ölçülen sapma
/// 34/255 kod değerine kadar çıkar ve §9.3 eşiklerini kat kat aşar; ayrıca <c>eq</c> rgba
/// zincirin ortasına <c>rgba→yuva444p→rgba</c> gidiş-dönüşü sokar (§6.3 yasağı).
/// Uygulama §4.1'in MATEMATİK sütununu (= GLSL sütunu = önizleme) birebir veren RGB-uzayı
/// eşlemesini üretir:
/// <list type="bullet">
///   <item>contrast+brightness → <c>lutrgb</c> ile kanal başına TEK afin op;</item>
///   <item>saturation → <c>colorchannelmixer</c> ile BT.709 luma etrafında lineer karışım
///     (matris biçimi <c>mix(luma, rgb, 1+v)</c>'nin birebir açılımıdır).</item>
/// </list>
/// Bu iki metot artık dokümanın NORMATİF hücresidir: değişmeleri §4.1'in de değişmesini
/// gerektirir (Ek: Sözleşme Değişiklik Kuralı).
/// </para>
/// </summary>
public static class ColorPipeline
{
    /// <summary>§4.1 temperature katsayısı (birim v başına lineer RGB ofseti).</summary>
    public const double KTemp = 0.10;

    /// <summary>§4.1 tint katsayısı (birim v başına lineer yeşil ofseti).</summary>
    public const double KTint = 0.10;

    /// <summary>§4.1 saturation luma katsayıları — BT.709.</summary>
    public const double LumaR = 0.2126;

    public const double LumaG = 0.7152;

    public const double LumaB = 0.0722;

    /// <summary>colorAdjust parametrelerinin şemadaki (ve UI'daki) anahtarları.</summary>
    private static readonly string[] ColorKeys =
        ["brightness", "contrast", "saturation", "temperature", "tint", "exposure"];

    /// <summary>
    /// Klibin ETKİN efektlerini doğrulayıp tipli görünüme çevirir. Kapalı (enabled=false)
    /// efekt YOK sayılır. İhlaller tipli Türkçe hatadır — sessiz düzeltme yok.
    /// </summary>
    public static ClipEffects Parse(Guid clipId, IReadOnlyList<Effect>? effects)
    {
        if (effects is not { Count: > 0 })
        {
            return ClipEffects.None;
        }

        ColorAdjustParams? color = null;
        LutParams? lut = null;
        foreach (var effect in effects)
        {
            if (!effect.Enabled)
            {
                continue;
            }

            switch (effect.Type)
            {
                case EffectType.ColorAdjust:
                    if (color is not null)
                    {
                        throw new InvalidTimelineException(
                            $"'{clipId}' klibinde birden fazla etkin colorAdjust efekti var — "
                            + "bir klipte yalnız BİR renk düzeltme efekti olabilir (önizleme "
                            + "shader'ı tek parametre kümesi uygular). Efektleri birleştirin.");
                    }

                    color = ParseColorAdjust(clipId, effect);
                    break;

                case EffectType.Lut:
                    if (lut is not null)
                    {
                        throw new InvalidTimelineException(
                            $"'{clipId}' klibinde birden fazla etkin LUT efekti var — "
                            + "bir klipte yalnız BİR LUT olabilir.");
                    }

                    lut = ParseLut(clipId, effect);
                    break;

                default:
                    throw new UnsupportedFeatureException("effect-type",
                        $"'{clipId}' klibinde tanınmayan efekt tipi ({effect.Type}) var — "
                        + "dışa aktarıcı yalnız colorAdjust ve LUT efektlerini destekler.");
            }
        }

        // intensity = 0 LUT tam no-op'tur (out = orig): filtre üretmemek export'u hızlandırır
        // ve şema açısından tamamen geçerli bir dokümandır.
        if (lut is { Intensity: <= 0 })
        {
            lut = null;
        }

        if (color is { IsIdentity: true })
        {
            color = null;
        }

        return color is null && lut is null ? ClipEffects.None : new ClipEffects(color, lut);
    }

    /// <summary>
    /// §4.1 zinciri (aşama sırası NORMATİF). Sıfır olan parametre için filtre ÜRETİLMEZ.
    /// Zincirin RGB'de çalışması şarttır — çağıran <c>format=rgba</c>'yı önüne koyar.
    /// </summary>
    public static IReadOnlyList<string> ColorAdjustFilters(ColorAdjustParams p)
    {
        ArgumentNullException.ThrowIfNull(p);
        var filters = new List<string>(5);

        // 1) exposure: çarpımsal 2^v gain (GAMMA DEĞİL). black=0 ile ffmpeg tam in*2^ev uygular.
        if (p.Exposure != 0)
        {
            filters.Add($"exposure=exposure={Num(p.Exposure)}:black=0");
        }

        // 2) temperature: lineer RGB kanal ofseti, K_TEMP = 0.10. Pozitif v = sıcak (+R, −B).
        if (p.Temperature != 0)
        {
            var k = Lit(KTemp * p.Temperature);
            filters.Add($"lutrgb=r='clip(val+255*{k},0,255)':b='clip(val-255*{k},0,255)'");
        }

        // 3) tint: lineer yeşil ofseti, K_TINT = 0.10. Pozitif v = magenta (−G).
        if (p.Tint != 0)
        {
            filters.Add($"lutrgb=g='clip(val-255*{Lit(KTint * p.Tint)},0,255)'");
        }

        // 4) contrast + brightness: TEK afin op (ayrı ayrı uygulamak YASAK — sıra farkı üretir).
        if (p.Contrast != 0 || p.Brightness != 0)
        {
            filters.Add(ContrastBrightnessFilter(p.Contrast, p.Brightness));
        }

        // 5) saturation: BT.709 luma etrafında lineer karışım.
        if (p.Saturation != 0)
        {
            filters.Add(SaturationFilter(p.Saturation));
        }

        return filters;
    }

    /// <summary>
    /// §4.1 adım 4 — <c>out = (in-0.5)*(1+contrast) + 0.5 + brightness</c>, KANAL BAŞINA,
    /// tek afin op. 8-bit ekseninde 0.5 → 127.5, brightness → 255*b. lutrgb tablosu 256
    /// girdiyi bir kez hesaplar (kare başına maliyet yok) ve sonucu [0,255]'e clamp eder.
    /// Sapma gerekçesi için sınıf yorumuna bakınız.
    /// </summary>
    public static string ContrastBrightnessFilter(double contrast, double brightness)
    {
        var expression =
            $"clip((val-127.5)*{Lit(1 + contrast)}+127.5+{Lit(255 * brightness)},0,255)";
        return $"lutrgb=r='{expression}':g='{expression}':b='{expression}'";
    }

    /// <summary>
    /// §4.1 adım 5 — <c>out = luma + (in-luma)*(1+v)</c>, luma BT.709. Bu karışım RGB'de
    /// LİNEER bir matristir, dolayısıyla colorchannelmixer ile BİREBİR ifade edilir:
    /// <c>out_r = r*(k + (1-k)*Lr) + g*((1-k)*Lg) + b*((1-k)*Lb)</c> (diğer kanallar simetrik).
    /// Katsayılar v ∈ [-1..1] için [-0.72 .. 1.79] aralığında kalır (filtre sınırı ±2).
    /// Alfa kanalına DOKUNMAZ (aa varsayılanı 1) — opaklık ayrı bir colorchannelmixer'dır.
    /// </summary>
    public static string SaturationFilter(double saturation)
    {
        var k = 1 + saturation;
        var m = 1 - k; // = -saturation
        return "colorchannelmixer="
               + $"rr={Num(k + (m * LumaR))}:rg={Num(m * LumaG)}:rb={Num(m * LumaB)}:"
               + $"gr={Num(m * LumaR)}:gg={Num(k + (m * LumaG))}:gb={Num(m * LumaB)}:"
               + $"br={Num(m * LumaR)}:bg={Num(m * LumaG)}:bb={Num(k + (m * LumaB))}";
    }

    /// <summary>
    /// §4.2 — tam güçte 3D LUT. <c>interp=trilinear</c> NORMATİFTİR (tetrahedral DEĞİL):
    /// WebGL tarafı 3D texture'ı LINEAR filtreyle örnekler, o da trilineerdir.
    /// </summary>
    public static string Lut3dFilter(string cubePath) =>
        $"lut3d=file={EscapeFilterArg(cubePath)}:interp=trilinear";

    /// <summary>
    /// §4.2 karışım ifadesi: <c>out = A*(1-intensity) + B*intensity</c> (A = orijinal,
    /// B = LUT'lanmış). intensity = 1 iken split/blend HİÇ üretilmez, düz lut3d uygulanır.
    /// </summary>
    public static string LutBlendFilter(double intensity) =>
        $"blend=all_expr='A*(1-{Num(intensity)})+B*{Num(intensity)}'";

    /// <summary>
    /// Dosya yolunu filtergraph argümanı olarak güvenli hale getirir. İki kaçış seviyesi
    /// vardır ve İKİSİ de gereklidir (ölçüldü — tek seviye Windows yolunda "No option name"
    /// ile patlar):
    ///  - seviye 2 (filtre seçenek ayrıştırıcısı, ayraç ':'): <c>\</c> → <c>\\</c>,
    ///    <c>:</c> → <c>\:</c>, <c>'</c> → <c>\'</c>;
    ///  - seviye 1 (filtergraph ayrıştırıcısı): sonuç tek tırnak İÇİNE alınır — tırnak içi
    ///    metin harfi harfine kopyalanır, dolayısıyla seviye 2 kaçışları seviye 1'de
    ///    ÇÖZÜLMEZ (av_get_token davranışı).
    /// Linux worker'da yol ':' ve '\' içermez → kaçış no-op'tur, tırnak zararsızdır.
    /// </summary>
    public static string EscapeFilterArg(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        var escaped = value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("'", "\\'", StringComparison.Ordinal)
            .Replace(":", "\\:", StringComparison.Ordinal);
        return "'" + escaped + "'";
    }

    private static ColorAdjustParams ParseColorAdjust(Guid clipId, Effect effect)
    {
        var p = effect.Params;
        if (p is not null)
        {
            foreach (var key in p.Keys)
            {
                if (!ColorKeys.Contains(key, StringComparer.Ordinal))
                {
                    throw new InvalidTimelineException(
                        $"'{clipId}' klibinin colorAdjust efektinde tanınmayan parametre '{key}' var "
                        + $"(geçerli olanlar: {string.Join(", ", ColorKeys)}).");
                }
            }
        }

        return new ColorAdjustParams(
            Number(clipId, p, "exposure"),
            Number(clipId, p, "temperature"),
            Number(clipId, p, "tint"),
            Number(clipId, p, "contrast"),
            Number(clipId, p, "brightness"),
            Number(clipId, p, "saturation"));
    }

    private static LutParams ParseLut(Guid clipId, Effect effect)
    {
        var p = effect.Params;
        if (p is null || !p.TryGetValue("assetId", out var raw) || AsString(raw) is not { } text)
        {
            throw new UnsupportedFeatureException("lut-asset",
                $"'{clipId}' klibindeki LUT efektinin assetId'si yok — LUT bir .cube "
                + "dosyası varlığıdır, önce yüklenmelidir.");
        }

        if (!Guid.TryParse(text, out var assetId) || assetId == Guid.Empty)
        {
            throw new InvalidTimelineException(
                $"'{clipId}' klibindeki LUT efektinin assetId'si geçerli bir kimlik değil ('{text}').");
        }

        // intensity yoksa tam güç (1) varsayılır — şemada zorunlu ama doküman eski sürümden
        // gelmiş olabilir; eksik alan sessiz sıfır DEĞİL, tam güç demektir.
        var intensity = p.TryGetValue("intensity", out var value)
            ? RequireNumber(clipId, "intensity", value)
            : 1d;
        if (intensity is < 0 or > 1 || double.IsNaN(intensity))
        {
            throw new InvalidTimelineException(
                $"'{clipId}' klibindeki LUT efektinin intensity değeri [0..1] aralığında olmalı "
                + $"(gelen değer {Num(intensity)}).");
        }

        return new LutParams(assetId, intensity);
    }

    private static double Number(Guid clipId, IDictionary<string, object>? p, string key)
    {
        if (p is null || !p.TryGetValue(key, out var raw))
        {
            return 0d; // eksik parametre = etkisiz (§4.1 default 0)
        }

        var value = RequireNumber(clipId, key, raw);
        if (value is < -1 or > 1 || double.IsNaN(value))
        {
            throw new InvalidTimelineException(
                $"'{clipId}' klibinin colorAdjust efektinde '{key}' parametresi [-1..1] "
                + $"aralığında olmalı (gelen değer {Num(value)}).");
        }

        return value;
    }

    private static double RequireNumber(Guid clipId, string key, object? raw)
    {
        var value = AsDouble(raw);
        if (value is null || !double.IsFinite(value.Value))
        {
            throw new InvalidTimelineException(
                $"'{clipId}' klibinin efekt parametresi '{key}' sayı olmalı.");
        }

        return value.Value;
    }

    /// <summary>
    /// Şema <c>params</c>'ı <c>Dictionary&lt;string, object&gt;</c>'tir; System.Text.Json
    /// değerleri <see cref="JsonElement"/> olarak taşır. Testlerde elle kurulan sözlükte
    /// ise ham <c>double</c>/<c>int</c> bulunabilir — iki yolu da kabul ederiz.
    /// </summary>
    private static double? AsDouble(object? raw) => raw switch
    {
        null => null,
        double d => d,
        float f => f,
        int i => i,
        long l => l,
        decimal m => (double)m,
        JsonElement { ValueKind: JsonValueKind.Number } element => element.GetDouble(),
        _ => null,
    };

    private static string? AsString(object? raw) => raw switch
    {
        null => null,
        string s => s,
        Guid g => g.ToString(),
        JsonElement { ValueKind: JsonValueKind.String } element => element.GetString(),
        _ => null,
    };

    /// <summary>Filtre literal'i — InvariantCulture, en fazla 6 kesir hanesi (TR locale sızmaz).</summary>
    private static string Num(double value) =>
        value.ToString("0.######", CultureInfo.InvariantCulture);

    /// <summary>
    /// İFADE içi literal: negatif değerler paranteze alınır. <c>255*-0.02</c> gibi çift işaretli
    /// diziler ffmpeg eval'de ayrıştırma tuzağıdır; <c>255*(-0.02)</c> her sürümde güvenlidir
    /// (§4.1'in örnek zinciri de parantezli <c>255*(0.10*v)</c> biçimini yazar).
    /// </summary>
    private static string Lit(double value) =>
        value < 0 ? "(" + Num(value) + ")" : Num(value);
}
