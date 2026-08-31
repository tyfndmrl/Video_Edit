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
///   <item>exposure → temperature → tint → contrast+brightness → kanal başına TEK
///     <c>lutrgb</c> bileşik ifadesi (aşama sırası ve aşama başına clamp ifadede korunur —
///     <see cref="FusedStagesFilter"/>);</item>
///   <item>saturation → <c>colorchannelmixer</c> ile BT.709 luma etrafında lineer karışım
///     (matris biçimi <c>mix(luma, rgb, 1+v)</c>'nin birebir açılımıdır).</item>
/// </list>
/// Bu iki üretici artık dokümanın NORMATİF hücresidir: değişmeleri §4.1'in de değişmesini
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
    /// HAM tarama: efekt listesindeki LUT varlık id'leri, DOĞRULAMADAN ÖNCE. API asset
    /// defterini tek sorguda doldurabilsin diye vardır (<see cref="ExportCompiler.ReferencedAssetIds"/>).
    /// <para>
    /// BİLEREK TOLERANSLIDIR: kapalı efekt, eksik/bozuk <c>assetId</c>, tanınmayan efekt tipi —
    /// hiçbiri burada hata üretmez, çünkü bu tarama bir KAPI DEĞİLDİR. Aynı ihlalleri
    /// <see cref="Parse"/> kendi tipli Türkçe mesajıyla raporlar; tarama yalnız "hangi satırları
    /// sorayım" sorusunu yanıtlar ve fazladan/eksik bir id yalnız kapının gördüğü kümeyi
    /// etkiler. Kapalı efekt de DAHİLDİR: liste ÜST KÜME olmalıdır, aksi halde kullanıcı
    /// efekti açtığında defterde satır bulunmaz ve kapı yanlışlıkla "asset yok" derdi.
    /// </para>
    /// </summary>
    public static IEnumerable<Guid> RawLutAssetIds(IReadOnlyList<Effect>? effects)
    {
        if (effects is not { Count: > 0 })
        {
            yield break;
        }

        foreach (var effect in effects)
        {
            if (effect.Type != EffectType.Lut || effect.Params is not { } p
                || !p.TryGetValue("assetId", out var raw)
                || AsString(raw) is not { } text
                || !Guid.TryParse(text, out var assetId)
                || assetId == Guid.Empty)
            {
                continue;
            }

            yield return assetId;
        }
    }

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
    /// §4.1 zinciri (aşama sırası NORMATİF). Sıfır olan parametre için filtre/aşama ÜRETİLMEZ.
    /// Zincirin RGB'de çalışması şarttır — çağıran <c>format=rgba</c>'yı önüne koyar.
    /// <para>
    /// <b>YAZILIŞ (2026-09-01 perf turu — formüller ve aşama sırası DEĞİŞMEDİ).</b> Kanal-başına
    /// aşamalar (exposure → temperature → tint → contrast+brightness) artık TEK <c>lutrgb</c>
    /// bileşik ifadesinde uygulanır; saturation'ın <c>colorchannelmixer</c> matrisi AYNEN ayrı
    /// kalır (kanallar-arası karışım tablo filtresiyle İFADE EDİLEMEZ). Eski zincir aşama başına
    /// ayrı filtre kuruyordu ve <c>exposure</c> float filtresi rgba↔gbrpf32 dönüşü + iki ek tablo
    /// geçişiyle 60 sn'lik gerçekçi 1080p bileşimde ölçülür maliyet taşıyordu (çıkar-koş-ölç rig'i,
    /// 3 koşum p50: 40,4 → 33,3 s). Bileşik ifade DOUBLE'da değerlendirilir (lutrgb tabloyu 256
    /// girdi için bir kez kurar), aşama BAŞINA <c>clip(…,0,255)</c> ifadede KORUNUR ve ara 8-bit
    /// niceleme kalkar — tek nihai niceleme kalır. Bu yön normatif matematik sütununa (= GLSL,
    /// aşama-başına float clamp) YAKINSAMADIR; eski zincire göre fark ölçülen zarfla sınırlıdır
    /// ve <c>ExportM5GoldenTests.ColorAdjustFusion_…</c> golden'ı taranan kümede çiviler
    /// (rendering-semantics §4.1 yazılış kutusu).
    /// </para>
    /// </summary>
    public static IReadOnlyList<string> ColorAdjustFilters(ColorAdjustParams p)
    {
        ArgumentNullException.ThrowIfNull(p);
        var filters = new List<string>(2);

        // 1-4) exposure → temperature → tint → contrast+brightness: kanal başına TEK lutrgb.
        if (FusedStagesFilter(p) is { } fused)
        {
            filters.Add(fused);
        }

        // 5) saturation: BT.709 luma etrafında lineer karışım.
        if (p.Saturation != 0)
        {
            filters.Add(SaturationFilter(p.Saturation));
        }

        return filters;
    }

    /// <summary>
    /// §4.1 aşama 1-4'ün kanal-başına bileşik <c>lutrgb</c> ifadesi; dört aşama da kapalıysa
    /// <c>null</c> (filtre üretilmez). Kanal ifadesi yalnız o kanala dokunan aşamaları içerir —
    /// tek-aşamalı belgelerde üretilen filtre metni eski zincirin ilgili filtresiyle birebir
    /// aynıdır (temperature/tint/contrast+brightness); yalnız-exposure'da float filtre yerine
    /// aynı <c>in·2^v</c> çarpanının tablo hali yazılır. İfadeye dokunmayan kanal lutrgb'nin
    /// kendi varsayılanında (kimlik) kalır; alfa kanalına hiçbir aşama dokunmaz.
    /// </summary>
    public static string? FusedStagesFilter(ColorAdjustParams p)
    {
        ArgumentNullException.ThrowIfNull(p);
        if (p.Exposure == 0 && p.Temperature == 0 && p.Tint == 0
            && p.Contrast == 0 && p.Brightness == 0)
        {
            return null;
        }

        var r = ChannelExpression(p, '+', KTemp * p.Temperature);
        var g = ChannelExpression(p, '-', KTint * p.Tint);
        var b = ChannelExpression(p, '-', KTemp * p.Temperature);
        var parts = new List<string>(3);
        if (r is not null)
        {
            parts.Add($"r='{r}'");
        }

        if (g is not null)
        {
            parts.Add($"g='{g}'");
        }

        if (b is not null)
        {
            parts.Add($"b='{b}'");
        }

        return "lutrgb=" + string.Join(':', parts);
    }

    /// <summary>
    /// Tek kanalın §4.1 aşama 1-4 bileşik ifadesi; kanala hiçbir aşama dokunmuyorsa
    /// <c>null</c> (kanal lutrgb'ye hiç yazılmaz — kimlikte kalır). Aşama sırası ve aşama
    /// başına <c>clip(…,0,255)</c> normatif tabloyla birebir; kapalı aşama ifadeye hiç girmez
    /// (kimlik aşamasının clamp'i [0,255] girdide no-op'tur — eliderek yazmak kayıpsızdır).
    /// <c>2^v</c> derleme anında hesaplanır (<c>exposure</c> filtresi de siyah=0'da tam
    /// <c>in·2^ev</c> uygular — ölçüm ColorAdjust_MatchesTheNormativeStageFormulas'ta).
    /// <para>
    /// EN DIŞTAKİ <c>round(…)</c> TEK NİHAİ NİCELEMEDİR ve ÖLÇÜMLE SEÇİLDİ: lutrgb tablo
    /// sonucunu <c>(int)</c> ile SIFIRA DOĞRU kırpar; çıplak ifade normatif double referansın
    /// yanına ±1 LSB bırakıyordu, <c>round</c> (yarım sıfırdan uzağa — referans Byte() ve GPU
    /// UNORM nicelemesiyle aynı kural) taranan kümenin 33 vakasının HEPSİNDE 256 girişte
    /// referansla FARKSIZ tablo verdi (ExportM5GoldenTests füzyon golden'ı bunu çiviler).
    /// </para>
    /// </summary>
    private static string? ChannelExpression(ColorAdjustParams p, char offsetSign, double offset)
    {
        var expr = "val";
        if (p.Exposure != 0)
        {
            expr = $"clip({expr}*{Lit(Math.Pow(2d, p.Exposure))},0,255)";
        }

        if (offset != 0)
        {
            expr = $"clip({expr}{offsetSign}255*{Lit(offset)},0,255)";
        }

        if (p.Contrast != 0 || p.Brightness != 0)
        {
            expr = $"clip(({expr}-127.5)*{Lit(1 + p.Contrast)}+127.5+{Lit(255 * p.Brightness)},0,255)";
        }

        return expr == "val" ? null : $"round({expr})";
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
    /// §4.2 karışımı: <c>out = A*(1-intensity) + B*intensity</c> (A = orijinal, B = LUT'lanmış).
    /// intensity = 1 iken split/blend HİÇ üretilmez, düz lut3d uygulanır.
    /// <para>
    /// <b>BİÇİM KARARI (2026-08-24 maliyet profili; sınır 2026-08-25'te ölçüldü).</b> Aynı
    /// matematik eskiden <c>blend=all_expr='A*(1-i)+B*i'</c> ile yazılıyordu; <c>all_expr</c>
    /// her piksel × kanal için AVExpr YORUMLAYICISINI çalıştırır ve tek başına 60 sn'lik
    /// referans bileşimin %46'sını yiyordu (1080p tam kodlama 68,7 → 37,4 s;
    /// docs/performans-raporu.md §9.1). ffmpeg'in YERLİ <c>normal</c> modu ÜST katmanı
    /// (blend'in İLK girişi = A) ağırlıklar: <c>out = A*opacity + B*(1-opacity)</c> — yani
    /// <c>all_opacity = 1-intensity</c> AYNI mix formülüdür. Formül aynı, iki yazılışın 8-bit
    /// TAMSAYI YUVARLAMASI ise İÇERİĞE BAĞLI ayrışır (tam (A,B) taramasıyla ölçüldü):
    /// intensity DYADİKSE (0.25/0.5/0.75) çıktı bayt-aynı; değilse tam-mix'in tamsayıya denk
    /// geldiği çiftlerde tam ±1 LSB fark kalır — i=0.8'de 65.536 çiftin 1201'i (%1,8),
    /// i=0.6'da 208'i (%0,3); ör. A=1,B=6,i=0.6 → mix=4.0, expr 3, yerli 4. Zarf, deponun
    /// zaten beyan ettiği tolerans sınıfındadır (RGB↔YUV420 gidiş-dönüşü ±1; rendering-semantics
    /// §9.3 parite eşikleri) ve normatif §4.2 mix formülü DEĞİŞMEDİ — karar: yazılış kalır,
    /// sınır <c>ExportM5GoldenTests.LutBlend_NativeVsExpr_BoundedByOneLsb_AndByteExactAtDyadicIntensities</c>
    /// golden'ıyla sabitlenir. Referans bileşim fixture'ında framemd5/sha256 bayt-aynı çıkmıştı;
    /// o TEKİL içeriğin ölçümüdür (uyuşmazlık çifti barındırmıyor), genelleme değildir.
    /// </para>
    /// </summary>
    public static string LutBlendFilter(double intensity) =>
        $"blend=all_mode=normal:all_opacity={Num(1 - intensity)}";

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
