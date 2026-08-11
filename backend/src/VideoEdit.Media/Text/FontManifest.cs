using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace VideoEdit.Media.Text;

/// <summary>
/// Küratörlü font manifesti (rendering-semantics §7 — <c>fontId</c> SÖZLEŞMESİ). Şemada
/// serbest <c>fontFamily</c> YOKTUR; <c>TextClip.text.fontId</c> bu manifestin anahtarıdır.
/// AYNI TTF dosyası hem tarayıcı <c>@font-face</c>'ine hem SkiaSharp'a gider.
/// <para>
/// SÜRÜM PİNLİDİR (§7): bir fontId'nin <c>files</c> haritası ASLA değiştirilmez. Font
/// güncellemesi YENİ fontId üretir (ör. <c>inter</c> → <c>inter-5</c>) ve eski projeler eski
/// dosyayı kullanmaya devam eder — eski projelerin layout'u değişmez. Bu kural
/// <see cref="FontEntry.Deprecated"/> ile işaretlenir, silinerek DEĞİL.
/// </para>
/// </summary>
public sealed class FontManifest
{
    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        PropertyNameCaseInsensitive = false,
    };

    [JsonPropertyName("manifestVersion")]
    public int ManifestVersion { get; set; } = 1;

    /// <summary>fontId → font kaydı. Anahtar büyük/küçük harfe DUYARLIDIR (şema string'i aynen).</summary>
    [JsonPropertyName("fonts")]
    public Dictionary<string, FontEntry> Fonts { get; set; } = new(StringComparer.Ordinal);

    /// <summary>
    /// Sistem fontlarına düşme (emoji/eksik glif için <c>SKFontManager</c> fallback'i).
    /// VARSAYILAN KAPALI ve öyle kalmalıdır: sistem fontu makineden makineye değişir, açılırsa
    /// export deterministik olmaktan çıkar (aynı proje farklı worker'da farklı piksel üretir).
    /// </summary>
    [JsonPropertyName("allowSystemFallback")]
    public bool AllowSystemFallback { get; set; }

    /// <summary>OpenType ağırlık ekseni etiketi (değişken fontlarda ağırlığın kaynağı).</summary>
    public const string WeightAxisTag = "wght";

    /// <summary>Manifestin okunduğu mutlak dosya yolu (hata mesajları için; JSON'da yoktur).</summary>
    [JsonIgnore]
    public string SourcePath { get; set; } = "(bellek)";

    /// <summary>Font dosyalarının kökü (manifest dosyasının bulunduğu dizin).</summary>
    [JsonIgnore]
    public string RootDirectory { get; set; } = ".";

    /// <summary><c>"&lt;fontId&gt;/&lt;stil&gt;"</c> → sha256 (lock dosyasından; boş olabilir).</summary>
    [JsonIgnore]
    public IReadOnlyDictionary<string, string> LockedHashes { get; private set; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public const string LockFileName = "manifest.lock.json";

    public static FontManifest Load(string manifestPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(manifestPath);
        var full = Path.GetFullPath(manifestPath);
        if (!File.Exists(full))
        {
            throw new FontManifestException(
                $"Font manifesti bulunamadı: {full}. fonts/README.md'ye bakın "
                + "(manifest depoda vardır; eksikse VIDEOEDIT_FONT_ROOT yanlış olabilir).");
        }

        FontManifest? manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<FontManifest>(File.ReadAllText(full), JsonOptions);
        }
        catch (JsonException ex)
        {
            throw new FontManifestException($"Font manifesti bozuk ({full}): {ex.Message}", ex);
        }

        if (manifest is null)
        {
            throw new FontManifestException($"Font manifesti boş ({full}).");
        }

        if (manifest.ManifestVersion != 1)
        {
            throw new FontManifestException(
                $"Font manifesti sürümü desteklenmiyor: {manifest.ManifestVersion} (beklenen 1) — {full}.");
        }

        manifest.SourcePath = full;
        manifest.RootDirectory = Path.GetDirectoryName(full) ?? ".";
        manifest.LoadLockFile();
        manifest.Validate();
        return manifest;
    }

    /// <summary>
    /// <c>manifest.lock.json</c> (fetch scriptinin ürettiği sha256 pinleri). YOKSA sessizce
    /// atlanır — pin isteğe bağlıdır; VARSA ihlali <see cref="Resolve"/> hata olarak bildirir.
    /// </summary>
    internal void LoadLockFile()
    {
        var lockPath = Path.Combine(RootDirectory, LockFileName);
        if (!File.Exists(lockPath))
        {
            return;
        }

        try
        {
            var parsed = JsonSerializer.Deserialize<FontManifestLock>(File.ReadAllText(lockPath), JsonOptions);
            if (parsed?.Files is { Count: > 0 })
            {
                LockedHashes = new Dictionary<string, string>(parsed.Files, StringComparer.Ordinal);
            }
        }
        catch (JsonException ex)
        {
            throw new FontManifestException($"Font lock dosyası bozuk ({lockPath}): {ex.Message}", ex);
        }
    }

    /// <summary>Yapısal doğrulama — bozuk manifest AÇILIŞTA patlasın, ilk export'ta değil.</summary>
    public void Validate()
    {
        foreach (var (fontId, entry) in Fonts)
        {
            if (string.IsNullOrWhiteSpace(fontId))
            {
                throw new FontManifestException($"Font manifestinde boş fontId var ({SourcePath}).");
            }

            if (entry.Files.Count == 0)
            {
                throw new FontManifestException(
                    $"fontId '{fontId}' için hiç dosya tanımlı değil ({SourcePath}).");
            }

            foreach (var key in entry.Files.Keys)
            {
                if (!FontStyleKey.TryParse(key, out _))
                {
                    throw new FontManifestException(
                        $"fontId '{fontId}' geçersiz stil anahtarı taşıyor: '{key}'. "
                        + "Beklenen biçim: '<ağırlık>' ya da '<ağırlık>i' (ör. '400', '700i').");
                }
            }

            foreach (var key in entry.Sha256.Keys)
            {
                if (!entry.Files.ContainsKey(key))
                {
                    throw new FontManifestException(
                        $"fontId '{fontId}' için '{key}' sha256 pini var ama dosya tanımı yok ({SourcePath}).");
                }
            }
        }
    }

    /// <summary>
    /// <c>fontId</c> + ağırlık + italik → diskteki dosya. Eşleşme kuralı DETERMİNİSTİKTİR:
    /// <list type="number">
    ///   <item>tam anahtar (<c>700i</c>) varsa o;</item>
    ///   <item>italik istendi ama italik dosya yoksa → aynı ağırlığın DİK dosyası + sentetik
    ///         oblik (skewX = -0.25, <see cref="FontFile.SyntheticItalic"/> işaretli);</item>
    ///   <item>ağırlık yoksa → |Δağırlık| en küçük olan; eşitlikte DÜŞÜK ağırlık kazanır
    ///         (belirlenimci tie-break).</item>
    /// </list>
    /// Bulunamayan fontId ya da diskte olmayan dosya <see cref="FontNotFoundException"/> atar —
    /// SESSİZ FALLBACK YOKTUR (yanlış fontla export etmek, hata vermekten daha kötüdür).
    /// </summary>
    public FontFile Resolve(string fontId, int weight, bool italic)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(fontId);
        if (!Fonts.TryGetValue(fontId, out var entry))
        {
            throw FontNotFoundException.UnknownId(fontId, SourcePath, Fonts.Keys.Order(StringComparer.Ordinal));
        }

        var wanted = new FontStyleKey(weight, italic);
        var available = entry.Files.Keys
            .Select(k => FontStyleKey.TryParse(k, out var parsed) ? parsed : default)
            .Where(k => k.Weight > 0)
            .ToList();

        var match = PickStyle(wanted, available);
        var key = match.ToKey();
        var relative = entry.Files[key];
        var path = Path.GetFullPath(Path.Combine(RootDirectory, relative));
        if (!File.Exists(path))
        {
            throw FontNotFoundException.FileMissing(fontId, key, path);
        }

        // DEĞİŞKEN (variable) FONT: ağırlık dosya seçimiyle DEĞİL, 'wght' ekseniyle gelir —
        // şemadaki fontWeight ∈ [1..1000] sürekli olarak karşılanır (en yakın statik dosyaya
        // yuvarlama YOK). Google Fonts artık yalnız değişken TTF yayınladığı için küratörlü
        // set de böyledir; statik dosyalar da desteklenmeye devam eder (variableAxes yoksa).
        var variations = new Dictionary<string, float>(StringComparer.Ordinal);
        var resolvedWeight = match.Weight;
        if (entry.VariableAxes is { } axes && axes.TryGetValue(WeightAxisTag, out var weightAxis))
        {
            resolvedWeight = (int)Math.Round(Math.Clamp(weight, weightAxis.Min, weightAxis.Max),
                MidpointRounding.AwayFromZero);
            variations[WeightAxisTag] = resolvedWeight;
        }

        // Sürüm pini (§7): manifest içi sha256 önce, yoksa fetch scriptinin yazdığı lock.
        if (!entry.Sha256.TryGetValue(key, out var expected) || string.IsNullOrWhiteSpace(expected))
        {
            LockedHashes.TryGetValue($"{fontId}/{key}", out expected);
        }

        if (!string.IsNullOrWhiteSpace(expected))
        {
            var actual = Sha256File(path);
            if (!string.Equals(actual, expected.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                throw new FontLoadException(fontId,
                    $"fontId '{fontId}' ({key}) dosyası sha256 pinine uymuyor: beklenen {expected}, "
                    + $"bulunan {actual} ({path}). Sürüm pini ihlali — dosyayı yeniden indirin "
                    + "(fonts/fetch-fonts.ps1 -Force).");
            }
        }

        return new FontFile(
            FontId: fontId,
            Family: entry.Family,
            Version: entry.Version,
            Path: path,
            RequestedWeight: weight,
            ResolvedWeight: resolvedWeight,
            RequestedItalic: italic,
            SyntheticItalic: italic && !match.Italic,
            Variations: variations);
    }

    /// <summary>Saf eşleşme kuralı (dosya sistemine dokunmaz) — birim testleri bunu sabitler.</summary>
    internal static FontStyleKey PickStyle(FontStyleKey wanted, IReadOnlyList<FontStyleKey> available)
    {
        if (available.Count == 0)
        {
            throw new FontManifestException("Font kaydında hiç stil yok.");
        }

        if (available.Contains(wanted))
        {
            return wanted;
        }

        // İstenen italik durumunu KORUYAN adaylar önce; yoksa dik dosyalar (sentetik oblik).
        var sameStyle = available.Where(k => k.Italic == wanted.Italic).ToList();
        var pool = sameStyle.Count > 0 ? sameStyle : available.Where(k => !k.Italic).ToList();
        if (pool.Count == 0)
        {
            pool = available.ToList();
        }

        return pool
            .OrderBy(k => Math.Abs(k.Weight - wanted.Weight))
            .ThenBy(k => k.Weight)
            .First();
    }

    internal static string Sha256File(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }
}

/// <summary>Manifestteki tek font kaydı.</summary>
public sealed class FontEntry
{
    [JsonPropertyName("family")]
    public string Family { get; set; } = string.Empty;

    /// <summary>Yayıncının sürümü (pinleme kaydı; değişirse YENİ fontId açılır).</summary>
    [JsonPropertyName("version")]
    public string Version { get; set; } = string.Empty;

    /// <summary>SPDX lisans kimliği — küratörlü set OFL/Apache olmak zorundadır (§7).</summary>
    [JsonPropertyName("license")]
    public string License { get; set; } = string.Empty;

    /// <summary>Dosyanın resmî kaynağı (indirme scripti ve denetim izi için).</summary>
    [JsonPropertyName("source")]
    public string Source { get; set; } = string.Empty;

    /// <summary>Stil anahtarı ('400', '700i') → manifest dizinine GÖRECELİ dosya yolu.</summary>
    [JsonPropertyName("files")]
    public Dictionary<string, string> Files { get; set; } = new(StringComparer.Ordinal);

    /// <summary>Stil anahtarı → sha256 (küçük harf hex). Boş bırakılabilir; doluysa DOĞRULANIR.</summary>
    [JsonPropertyName("sha256")]
    public Dictionary<string, string> Sha256 { get; set; } = new(StringComparer.Ordinal);

    /// <summary>
    /// Stil anahtarı → resmî indirme adresi. YALNIZ fetch scripti kullanır; raster servisi
    /// ağa ÇIKMAZ (dosya yoksa hata verir, indirmeye kalkışmaz).
    /// </summary>
    [JsonPropertyName("urls")]
    public Dictionary<string, string> Urls { get; set; } = new(StringComparer.Ordinal);

    /// <summary>
    /// Değişken font eksenleri (varsa). <c>wght</c> tanımlıysa ağırlık DOSYA SEÇİMİYLE değil
    /// eksen değeriyle gelir: <c>fontWeight</c> aralığa kırpılır ve tam o değer kullanılır.
    /// </summary>
    [JsonPropertyName("variableAxes")]
    public Dictionary<string, AxisRange>? VariableAxes { get; set; }

    /// <summary>Yeni projelerde önerilmez ama ESKİ projeler için yaşamaya devam eder (§7 pinleme).</summary>
    [JsonPropertyName("deprecated")]
    public bool Deprecated { get; set; }
}

/// <summary>Manifest stil anahtarı: ağırlık + italik ('400', '700i').</summary>
public readonly record struct FontStyleKey(int Weight, bool Italic)
{
    public string ToKey() => Italic ? $"{Weight}i" : Weight.ToString(System.Globalization.CultureInfo.InvariantCulture);

    public static bool TryParse(string? key, out FontStyleKey parsed)
    {
        parsed = default;
        if (string.IsNullOrWhiteSpace(key))
        {
            return false;
        }

        var italic = key.EndsWith('i');
        var digits = italic ? key[..^1] : key;
        if (!int.TryParse(digits, System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture, out var weight)
            || weight is < 1 or > 1000)
        {
            return false;
        }

        parsed = new FontStyleKey(weight, italic);
        return true;
    }
}

/// <summary><c>manifest.lock.json</c> gövdesi — fetch scriptinin yazdığı sha256 pinleri.</summary>
internal sealed class FontManifestLock
{
    [JsonPropertyName("lockVersion")]
    public int LockVersion { get; set; } = 1;

    [JsonPropertyName("files")]
    public Dictionary<string, string> Files { get; set; } = new(StringComparer.Ordinal);
}

/// <summary>Değişken font ekseninin kapsadığı aralık.</summary>
public sealed class AxisRange
{
    [JsonPropertyName("min")]
    public double Min { get; set; }

    [JsonPropertyName("max")]
    public double Max { get; set; }
}

/// <summary>Çözümlenmiş font dosyası (henüz Skia'ya açılmadı).</summary>
public sealed record FontFile(
    string FontId,
    string Family,
    string Version,
    string Path,
    int RequestedWeight,
    int ResolvedWeight,
    bool RequestedItalic,
    bool SyntheticItalic,
    IReadOnlyDictionary<string, float> Variations)
{
    /// <summary>Değişken eksen kimliği — typeface cache anahtarının parçası.</summary>
    public string CacheKey => Variations.Count == 0
        ? Path
        : Path + "|" + string.Join(',', Variations.OrderBy(v => v.Key, StringComparer.Ordinal)
            .Select(v => $"{v.Key}={v.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)}"));

    /// <summary>İstenen ağırlık bulunamadı, en yakını kullanıldı (rapora/uyarıya girer).</summary>
    public bool SubstitutedWeight => RequestedWeight != ResolvedWeight;
}
