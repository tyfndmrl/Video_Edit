using System.Collections;
using System.Collections.Concurrent;

namespace VideoEdit.Media.Text;

/// <summary>
/// Font kaynağı politikası ayarları — config section'ı <c>Fonts</c>
/// (env karşılığı: <c>Fonts__AllowSystemFallback</c>, <c>Fonts__SystemFallback__&lt;fontId&gt;</c>).
/// <para>
/// DİKKAT — <see cref="FontManifest.AllowSystemFallback"/> ile KARIŞTIRILMAMALIDIR: o alan
/// GLİF düzeyindeki Skia fallback zinciridir (metnin içindeki emoji için başka bir fonta
/// atlamak) ve KAPALI kalır. Buradaki ayar ise FONT DOSYASI düzeyindedir: küratörlü TTF hiç
/// kurulmamışsa o <c>fontId</c>'nin TAMAMI yerel bir sistem fontuyla çizilir.
/// </para>
/// </summary>
public sealed class FontOptions
{
    public const string SectionName = "Fonts";

    /// <summary>Env değişkeni öneki (ASP.NET config'in <c>Fonts:SystemFallback:x</c> karşılığı).</summary>
    public const string SystemFallbackEnvPrefix = "Fonts__SystemFallback__";

    /// <summary>Env değişkeni: <c>Fonts:AllowSystemFallback</c>.</summary>
    public const string AllowSystemFallbackEnvVar = "Fonts__AllowSystemFallback";

    /// <summary>
    /// Küratörlü TTF yokken sistem fontuna düşülsün mü. VARSAYILAN AÇIK: aksi halde font
    /// indirilmemiş bir kurulumda metin içeren her export <c>font-missing</c> ile düşerdi.
    /// Belirlenimcilik şart olan kurulumlarda (CI golden'ları, üretim render çiftliği)
    /// <c>false</c> yapın — o zaman eksik font yine deterministik hata verir.
    /// </summary>
    public bool AllowSystemFallback { get; set; } = true;

    /// <summary>
    /// <c>fontId</c> → sistem aile adları (ya da MUTLAK dosya yolları), virgül/noktalı virgül
    /// ile ayrılmış öncelik sırası. Ör: <c>"roboto": "Arial, Liberation Sans"</c>.
    /// Anahtar büyük/küçük harfe duyarsızdır.
    /// </summary>
    public Dictionary<string, string> SystemFallback { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Yapılandırılmış aile listesi (boşsa yapılandırma yok demektir).</summary>
    public IReadOnlyList<string> ConfiguredFamilies(string fontId)
    {
        if (string.IsNullOrWhiteSpace(fontId)
            || !SystemFallback.TryGetValue(fontId, out var raw)
            || string.IsNullOrWhiteSpace(raw))
        {
            return [];
        }

        return Split(raw);
    }

    internal static IReadOnlyList<string> Split(string raw) =>
        raw.Split([',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

    /// <summary>
    /// Ortam değişkenlerinden okur. Host <c>Configure&lt;FontOptions&gt;("Fonts")</c> ile
    /// bağlamadığında da <c>Fonts__SystemFallback__roboto=Arial</c> biçimi çalışsın diye vardır
    /// (appsettings ile birebir aynı anahtar, .NET'in <c>:</c> → <c>__</c> eşlemesi).
    /// </summary>
    public static FontOptions FromEnvironment(IDictionary? environment = null)
    {
        var options = new FontOptions();
        var entries = environment ?? Environment.GetEnvironmentVariables();
        foreach (DictionaryEntry entry in entries)
        {
            if (entry.Key is not string key || entry.Value is not string value)
            {
                continue;
            }

            if (key.StartsWith(SystemFallbackEnvPrefix, StringComparison.OrdinalIgnoreCase))
            {
                var fontId = key[SystemFallbackEnvPrefix.Length..];
                if (fontId.Length > 0)
                {
                    options.SystemFallback[fontId] = value;
                }
            }
            else if (key.Equals(AllowSystemFallbackEnvVar, StringComparison.OrdinalIgnoreCase)
                && bool.TryParse(value, out var allow))
            {
                options.AllowSystemFallback = allow;
            }
        }

        return options;
    }
}

/// <summary>
/// Küratörlü <c>fontId</c>'ler için makul sistem karşılıkları. Her listede ÖNCE fontun kendi
/// ailesi denenir (sistemde kuruluysa görsel olarak en yakın sonuç), sonra Windows ve
/// Linux'ta yaygın metrik/karakter olarak benzer aileler.
/// </summary>
public static class SystemFontDefaults
{
    private static readonly Dictionary<string, string[]> Map = new(StringComparer.OrdinalIgnoreCase)
    {
        ["roboto"] = ["Roboto", "Arial", "Liberation Sans", "DejaVu Sans", "Segoe UI"],
        ["open-sans"] = ["Open Sans", "Segoe UI", "DejaVu Sans", "Liberation Sans", "Arial"],
        ["noto-sans"] = ["Noto Sans", "Segoe UI", "DejaVu Sans", "Liberation Sans", "Arial"],
        ["noto-serif"] = ["Noto Serif", "Times New Roman", "Liberation Serif", "DejaVu Serif"],
    };

    /// <summary>Tanımlı fontId'ler (doküman/test için).</summary>
    public static IReadOnlyCollection<string> KnownFontIds => Map.Keys;

    public static IReadOnlyList<string> For(string fontId) =>
        !string.IsNullOrWhiteSpace(fontId) && Map.TryGetValue(fontId, out var families) ? families : [];
}

/// <summary>
/// Bir <c>fontId</c> için sistem aile adaylarının ÖNCELİK SIRASI (saf kural — birim testleri
/// bunu sabitler):
/// <list type="number">
///   <item><see cref="FontOptions.SystemFallback"/> (appsettings <c>Fonts:SystemFallback:&lt;fontId&gt;</c>
///     ya da env <c>Fonts__SystemFallback__&lt;fontId&gt;</c>) — VARSA tek başına kazanır (ezme);</item>
///   <item>manifest kaydındaki <c>systemFallback</c> dizisi;</item>
///   <item><see cref="SystemFontDefaults"/> tablosu;</item>
///   <item>hiçbiri yoksa manifest kaydının kendi <c>family</c> adı (aynı aile sistemde kuruluysa).</item>
/// </list>
/// </summary>
public static class FontFallbackPolicy
{
    public static IReadOnlyList<string> Candidates(string fontId, FontOptions? options, FontEntry? entry)
    {
        var configured = options?.ConfiguredFamilies(fontId) ?? [];
        if (configured.Count > 0)
        {
            return configured;
        }

        if (entry?.SystemFallback is { Length: > 0 } fromManifest)
        {
            return fromManifest.Where(f => !string.IsNullOrWhiteSpace(f)).Select(f => f.Trim()).ToList();
        }

        var defaults = SystemFontDefaults.For(fontId);
        if (defaults.Count > 0)
        {
            return defaults;
        }

        return string.IsNullOrWhiteSpace(entry?.Family) ? [] : [entry!.Family.Trim()];
    }
}

/// <summary>
/// <c>fontId</c> → açılacak font dosyası/ailesi. ÜÇ MODLU politika (fonts/README.md):
/// <list type="number">
///   <item><b>Küratörlü:</b> manifest'in gösterdiği TTF diskte varsa O kullanılır (sha256 pinli,
///     belirlenimci). Bugünkü davranış — değişmedi.</item>
///   <item><b>Sistem:</b> dosya yoksa yapılandırılmış sistem eşlemesi denenir; bulunursa
///     <see cref="FontSourceKind.System"/> işaretli bir <see cref="FontFile"/> döner ve
///     <c>onWarning</c> ile BİR KEZ uyarı yayılır (render BELİRLENİMCİ DEĞİLDİR).</item>
///   <item><b>Yok:</b> o da yoksa mevcut <c>font-missing</c> hatası (deterministik; worker
///     retry etmez).</item>
/// </list>
/// <c>fontId</c> manifest'te HİÇ yoksa sistem yoluna DÜŞÜLMEZ: bu bir şema/sözleşme ihlalidir,
/// eksik kurulum değil.
/// </summary>
public sealed class FontResolver
{
    private readonly FontManifest manifest;
    private readonly FontOptions options;
    private readonly ISystemFontSource? systemFonts;
    private readonly Action<string>? onWarning;
    private readonly ConcurrentDictionary<string, byte> warned = new(StringComparer.Ordinal);

    /// <summary>
    /// Yalnız SİSTEM çözümleri cache'lenir (dizin taraması + typeface açma klip başına
    /// tekrarlanmasın). Küratörlü yol cache'lenmez: sha256 pini her çözümde doğrulanmalıdır.
    /// </summary>
    private readonly ConcurrentDictionary<string, FontFile> systemCache = new(StringComparer.Ordinal);

    public FontResolver(
        FontManifest manifest,
        FontOptions? options = null,
        ISystemFontSource? systemFonts = null,
        Action<string>? onWarning = null)
    {
        this.manifest = manifest ?? throw new ArgumentNullException(nameof(manifest));
        this.options = options ?? FontOptions.FromEnvironment();
        this.systemFonts = systemFonts ?? SkiaSystemFontSource.Shared;
        this.onWarning = onWarning ?? FontWarnings.DefaultSink;
    }

    public FontManifest Manifest => manifest;

    public FontFile Resolve(string fontId, int weight, bool italic)
    {
        try
        {
            return manifest.Resolve(fontId, weight, italic);
        }
        catch (FontNotFoundException missing) when (missing.ExpectedPath is not null)
        {
            // Küratörlü dosya YOK (indirilmemiş). sha256 pin ihlali (FontLoadException) buraya
            // DÜŞMEZ: bozuk/değiştirilmiş dosya sessizce sistem fontuyla örtülmemelidir.
            return ResolveSystem(fontId, weight, italic, missing);
        }
    }

    private FontFile ResolveSystem(string fontId, int weight, bool italic, FontNotFoundException missing)
    {
        var cacheKey = $"{fontId}|{weight}|{(italic ? "i" : "n")}";
        if (systemCache.TryGetValue(cacheKey, out var cached))
        {
            return cached;
        }

        manifest.Fonts.TryGetValue(fontId, out var entry);
        var families = FontFallbackPolicy.Candidates(fontId, options, entry);

        if (!options.AllowSystemFallback)
        {
            throw new FontNotFoundException(fontId,
                missing.Message + " (Sistem fontuna düşme KAPALI: Fonts:AllowSystemFallback=false.)",
                missing.ExpectedPath);
        }

        var match = families.Count == 0 || systemFonts is null
            ? null
            : systemFonts.Match(families, weight <= 0 ? 400 : weight, italic);

        if (match is null)
        {
            throw new FontNotFoundException(fontId,
                missing.Message
                + $" Sistem fontu da bulunamadı — denenen aileler: {string.Join(", ", families.DefaultIfEmpty("(yapılandırılmamış)"))}"
                + $"; kaynak: {systemFonts?.Describe() ?? "(sistem kaynağı yok)"}. "
                + $"Kendi eşlemenizi vermek için: Fonts:SystemFallback:{fontId} = \"<Aile Adı>\" "
                + $"(env: {FontOptions.SystemFallbackEnvPrefix}{fontId}).",
                missing.ExpectedPath);
        }

        var file = new FontFile(
            FontId: fontId,
            Family: match.Family,
            Version: "system",
            Path: match.FilePath ?? string.Empty,
            RequestedWeight: weight,
            ResolvedWeight: match.Weight,
            RequestedItalic: italic,
            SyntheticItalic: italic && !match.Italic,
            Variations: FontFile.NoVariations,
            Source: FontSourceKind.System,
            SystemOrigin: match.Origin);

        systemCache[cacheKey] = file;
        Warn(FontWarnings.SystemFontUsed(file));
        return file;
    }

    private void Warn(string message)
    {
        if (onWarning is not null && warned.TryAdd(message, 0))
        {
            onWarning(message);
        }
    }
}

/// <summary>Sistem fontu uyarı metinleri + varsayılan uyarı kanalı.</summary>
public static class FontWarnings
{
    /// <summary>
    /// Uyarı kanalı verilmediğinde kullanılan varsayılan: <c>stderr</c>. Worker'ın konteyner
    /// log'una düşer. Host bunu <c>ILogger</c>'a bağlamak için
    /// <c>new SkiaOverlayRasterService(opts, onWarning: m =&gt; logger.LogWarning("{Msg}", m))</c>
    /// geçirebilir.
    /// </summary>
    public static Action<string> DefaultSink { get; } = static message =>
        Console.Error.WriteLine($"[warn] Fonts: {message}");

    public static string SystemFontUsed(FontFile file)
    {
        ArgumentNullException.ThrowIfNull(file);
        var where = file.Path.Length > 0 ? file.Path : $"SKFontManager/{file.Family}";
        return $"fontId '{file.FontId}' için küratörlü TTF kurulu değil; SİSTEM FONTU kullanılıyor: "
            + $"'{file.Family}' ({file.SystemOrigin}) → {where}. "
            + "Bu render BELİRLENİMCİ DEĞİLDİR: aynı proje başka bir makinede farklı piksel üretir "
            + "ve sistem fontları yeniden dağıtılamaz. Üretim dağıtımı öncesi küratörlü seti kurun "
            + "(fonts/fetch-fonts.ps1 — fonts/README.md).";
    }
}
