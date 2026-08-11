using System.Text;
using SkiaSharp;

namespace VideoEdit.Media.Text;

/// <summary>
/// Bir <c>fontId</c>'nin hangi kaynaktan çözümlendiği.
/// <list type="bullet">
///   <item><see cref="Curated"/> — depodaki küratörlü TTF (sha256 pinli). BELİRLENİMCİ:
///     aynı proje her makinede bayt bayt aynı PNG'yi üretir. Golden testlerin tek geçerli
///     kaynağı budur.</item>
///   <item><see cref="System"/> — yerel makinedeki sistem fontu (kopyalanmaz, yalnız
///     çalışma zamanında yolla/aile adıyla açılır). BELİRLENİMCİ DEĞİLDİR: aynı proje başka
///     makinede farklı piksel üretir. POC/geliştirme kolaylığıdır, üretim dağıtımı için
///     küratörlü set şarttır (lisans: sistem fontları yeniden dağıtılamaz).</item>
/// </list>
/// </summary>
public enum FontSourceKind
{
    Curated = 0,
    System = 1,
}

/// <summary>Sistem fontunun hangi mekanizmayla bulunduğu (tanılama/log).</summary>
public enum SystemFontOrigin
{
    /// <summary>Yapılandırmada doğrudan MUTLAK dosya yolu verilmişti.</summary>
    ConfiguredPath = 0,

    /// <summary>Sistem font dizinlerinde dosya adı taramasıyla bulundu (yol biliniyor).</summary>
    FileProbe = 1,

    /// <summary>
    /// <c>SKFontManager.Default.MatchFamily</c> ile aile adından çözüldü (dosya yolu YOK —
    /// typeface font yöneticisinden açılır).
    /// </summary>
    FontManager = 2,
}

/// <summary>
/// Sistem fontu eşleşmesi. <see cref="FilePath"/> null ise typeface
/// <see cref="SKFontManager"/> üzerinden açılır (yol bilinmez).
/// </summary>
public sealed record SystemFontMatch(
    string RequestedFamily,
    string Family,
    string? FilePath,
    int Weight,
    bool Italic,
    SystemFontOrigin Origin);

/// <summary>
/// Yerel makinedeki fontları arayan kaynak. Testler sahte gerçekleme geçirir; üretimde
/// <see cref="SkiaSystemFontSource"/> kullanılır.
/// </summary>
public interface ISystemFontSource
{
    /// <summary>
    /// Aile adlarını SIRAYLA dener; ilk eşleşme kazanır. Hiçbiri yoksa null (çağıran
    /// <c>font-missing</c> hatasına düşer — SESSİZ ÜÇÜNCÜ BİR FALLBACK YOKTUR).
    /// </summary>
    SystemFontMatch? Match(IReadOnlyList<string> families, int weight, bool italic);

    /// <summary>Hata mesajlarına giren kısa kaynak tanımı (hangi dizinlere bakıldı vb.).</summary>
    string Describe();
}

/// <summary>
/// <see cref="ISystemFontSource"/>'un gerçek gerçeklemesi. Sıra (aile başına):
/// <list type="number">
///   <item>Aday zaten MUTLAK bir dosya yoluysa ve dosya varsa → o dosya
///     (<see cref="SystemFontOrigin.ConfiguredPath"/>).</item>
///   <item>Sistem font dizinlerinde dosya adı taraması: <c>arialbd.ttf</c>,
///     <c>LiberationSans-Bold.ttf</c> gibi yaygın adlandırmalar normalize edilerek eşleştirilir
///     ve bulunan dosya AÇILARAK aile adı doğrulanır (<see cref="SystemFontOrigin.FileProbe"/>).
///     Dosya yolunu bilmek tercih edilir: log'a yazılır ve typeface cache'i dosya yoluyla
///     çalışır.</item>
///   <item><c>SKFontManager.Default.MatchFamily</c> (<see cref="SystemFontOrigin.FontManager"/>).
///     Windows'ta DirectWrite tüm kurulu aileleri görür. Worker'ın Linux imajı
///     <c>SkiaSharp.NativeAssets.Linux.NoDependencies</c> kullandığı için orada font
///     yöneticisi BOŞTUR — Linux'ta çalışan yol (2)'dir.</item>
/// </list>
/// Hiçbir dosya DEPOYA KOPYALANMAZ; yalnız çalışma zamanında okunur (lisans kuralı).
/// </summary>
public sealed class SkiaSystemFontSource : ISystemFontSource
{
    /// <summary>Ek/alternatif sistem font dizinleri (yol ayracıyla ayrılmış liste) — testler ve kapsayıcılar için.</summary>
    public const string DirectoriesEnvVar = "VIDEOEDIT_SYSTEM_FONT_DIRS";

    private static readonly string[] Extensions = [".ttf", ".otf", ".ttc", ".TTF", ".OTF", ".TTC"];

    /// <summary>Süreç ömrü boyunca tek örnek — dizin taraması bir kez yapılır.</summary>
    public static SkiaSystemFontSource Shared { get; } = new();

    private readonly IReadOnlyList<string> directories;
    private readonly bool useFontManager;
    private readonly Lazy<IReadOnlyList<ProbeEntry>> files;

    public SkiaSystemFontSource(IEnumerable<string>? directories = null, bool useFontManager = true)
    {
        this.directories = (directories ?? SystemFontDirectories.Default())
            .Where(d => !string.IsNullOrWhiteSpace(d))
            .Select(Path.GetFullPath)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        this.useFontManager = useFontManager;
        files = new Lazy<IReadOnlyList<ProbeEntry>>(ScanDirectories, LazyThreadSafetyMode.ExecutionAndPublication);
    }

    public string Describe()
    {
        var dirs = directories.Count == 0 ? "(dizin yok)" : string.Join(", ", directories);
        return useFontManager
            ? $"sistem font dizinleri [{dirs}] + SKFontManager"
            : $"sistem font dizinleri [{dirs}]";
    }

    public SystemFontMatch? Match(IReadOnlyList<string> families, int weight, bool italic)
    {
        ArgumentNullException.ThrowIfNull(families);

        foreach (var family in families)
        {
            if (string.IsNullOrWhiteSpace(family))
            {
                continue;
            }

            var candidate = family.Trim();
            if (MatchConfiguredPath(candidate) is { } direct)
            {
                return direct;
            }

            if (Probe(candidate, weight, italic) is { } probed)
            {
                return probed;
            }

            if (useFontManager && ViaFontManager(candidate, weight, italic) is { } managed)
            {
                return managed;
            }
        }

        return null;
    }

    // ───────────────────────── (1) doğrudan yol ─────────────────────────

    private static SystemFontMatch? MatchConfiguredPath(string candidate)
    {
        if (candidate.IndexOfAny([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar]) < 0
            || !File.Exists(candidate))
        {
            return null;
        }

        var full = Path.GetFullPath(candidate);
        using var typeface = SafeOpen(full);
        if (typeface is null)
        {
            return null;
        }

        return new SystemFontMatch(
            candidate,
            typeface.FamilyName,
            full,
            typeface.FontStyle.Weight,
            typeface.FontStyle.Slant != SKFontStyleSlant.Upright,
            SystemFontOrigin.ConfiguredPath);
    }

    // ───────────────────────── (2) dosya taraması ─────────────────────────

    /// <summary>
    /// Stil sıralaması: istenen stilin ekleri önce, sonra eğim korunarak ağırlık gevşetilir,
    /// en sonda düz Regular (italik istenmişse sentetik oblik çağıranda işaretlenir).
    /// </summary>
    private static IReadOnlyList<string[]> SuffixCascade(int weight, bool italic)
    {
        string[] regular = ["", "regular", "book", "roman"];
        string[] bold = ["bold", "bd", "b", "semibold", "demibold"];
        string[] italicSuffixes = ["italic", "i", "it", "oblique"];
        string[] boldItalic = ["bolditalic", "bi", "z", "boldoblique", "bdi"];

        var wantBold = weight >= 600;
        return (wantBold, italic) switch
        {
            (true, true) => [boldItalic, bold, italicSuffixes, regular],
            (true, false) => [bold, regular],
            (false, true) => [italicSuffixes, regular, boldItalic],
            (false, false) => [regular, bold],
        };
    }

    private SystemFontMatch? Probe(string family, int weight, bool italic)
    {
        var target = Normalize(family);
        if (target.Length == 0 || files.Value.Count == 0)
        {
            return null;
        }

        foreach (var suffixes in SuffixCascade(weight, italic))
        {
            foreach (var suffix in suffixes)
            {
                var wanted = target + suffix;
                foreach (var entry in files.Value)
                {
                    if (!string.Equals(entry.NormalizedBase, wanted, StringComparison.Ordinal))
                    {
                        continue;
                    }

                    using var typeface = SafeOpen(entry.Path);
                    if (typeface is null)
                    {
                        continue;
                    }

                    // Dosya adı yalan söyleyebilir: aile adı TTF'in kendisinden doğrulanır.
                    var actual = Normalize(typeface.FamilyName);
                    if (!actual.StartsWith(target, StringComparison.Ordinal)
                        && !target.StartsWith(actual, StringComparison.Ordinal))
                    {
                        continue;
                    }

                    return new SystemFontMatch(
                        family,
                        typeface.FamilyName,
                        entry.Path,
                        typeface.FontStyle.Weight,
                        typeface.FontStyle.Slant != SKFontStyleSlant.Upright,
                        SystemFontOrigin.FileProbe);
                }
            }
        }

        return null;
    }

    // ───────────────────────── (3) SKFontManager ─────────────────────────

    private static SystemFontMatch? ViaFontManager(string family, int weight, bool italic)
    {
        var manager = SKFontManager.Default;
        if (manager is null)
        {
            return null;
        }

        // MatchFamily bazı platformlarda "iyi eşleşme yok" yerine VARSAYILAN aileyi döndürür;
        // sessizce yanlış font çizmemek için aile listesinde gerçekten var mı diye bakılır.
        string[] known;
        try
        {
            known = manager.FontFamilies?.ToArray() ?? [];
        }
        catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException)
        {
            known = [];
        }

        if (!known.Any(f => string.Equals(f, family, StringComparison.OrdinalIgnoreCase)))
        {
            return null;
        }

        var style = new SKFontStyle(
            weight,
            (int)SKFontStyleWidth.Normal,
            italic ? SKFontStyleSlant.Italic : SKFontStyleSlant.Upright);
        using var typeface = manager.MatchFamily(family, style);
        if (typeface is null)
        {
            return null;
        }

        return new SystemFontMatch(
            family,
            typeface.FamilyName,
            null,
            typeface.FontStyle.Weight,
            typeface.FontStyle.Slant != SKFontStyleSlant.Upright,
            SystemFontOrigin.FontManager);
    }

    // ───────────────────────── yardımcılar ─────────────────────────

    /// <summary>Karşılaştırma için ad normalizasyonu: yalnız küçük harf + rakam.</summary>
    internal static string Normalize(string value)
    {
        var sb = new StringBuilder(value.Length);
        foreach (var ch in value)
        {
            if (char.IsAsciiLetterOrDigit(ch))
            {
                sb.Append(char.ToLowerInvariant(ch));
            }
        }

        return sb.ToString();
    }

    private static SKTypeface? SafeOpen(string path)
    {
        try
        {
            return SKTypeface.FromFile(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return null;
        }
    }

    private IReadOnlyList<ProbeEntry> ScanDirectories()
    {
        var found = new List<ProbeEntry>();
        foreach (var dir in directories)
        {
            if (!Directory.Exists(dir))
            {
                continue;
            }

            IEnumerable<string> paths;
            try
            {
                paths = Directory.EnumerateFiles(dir, "*", new EnumerationOptions
                {
                    RecurseSubdirectories = true,
                    MaxRecursionDepth = 4,
                    IgnoreInaccessible = true,
                    AttributesToSkip = FileAttributes.ReparsePoint,
                });
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                continue;
            }

            try
            {
                foreach (var path in paths)
                {
                    if (!Extensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    found.Add(new ProbeEntry(Normalize(Path.GetFileNameWithoutExtension(path)), path));
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // kısmi tarama yeter — bulunanlarla devam
            }
        }

        // BELİRLENİMCİ SIRA: aynı ada sahip iki dosyada hangisinin kazandığı makineye göre
        // değişmesin (dizin sıralaması işletim sistemine bağlıdır).
        found.Sort(static (a, b) =>
        {
            var byName = string.CompareOrdinal(a.NormalizedBase, b.NormalizedBase);
            return byName != 0 ? byName : string.CompareOrdinal(a.Path, b.Path);
        });
        return found;
    }

    private readonly record struct ProbeEntry(string NormalizedBase, string Path);
}

/// <summary>İşletim sistemine göre sistem font dizinleri.</summary>
public static class SystemFontDirectories
{
    /// <summary>
    /// Sıra: <see cref="SkiaSystemFontSource.DirectoriesEnvVar"/> (varsa YALNIZ o), sonra
    /// platform varsayılanları.
    /// </summary>
    public static IReadOnlyList<string> Default()
    {
        var fromEnv = Environment.GetEnvironmentVariable(SkiaSystemFontSource.DirectoriesEnvVar);
        if (!string.IsNullOrWhiteSpace(fromEnv))
        {
            return fromEnv
                .Split([Path.PathSeparator, ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToList();
        }

        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (OperatingSystem.IsWindows())
        {
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return
            [
                Environment.GetFolderPath(Environment.SpecialFolder.Fonts),
                Path.Combine(localAppData, "Microsoft", "Windows", "Fonts"),
            ];
        }

        if (OperatingSystem.IsMacOS())
        {
            return
            [
                "/System/Library/Fonts",
                "/Library/Fonts",
                Path.Combine(home, "Library", "Fonts"),
            ];
        }

        return
        [
            "/usr/share/fonts",
            "/usr/local/share/fonts",
            Path.Combine(home, ".local", "share", "fonts"),
            Path.Combine(home, ".fonts"),
        ];
    }
}
