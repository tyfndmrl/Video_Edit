using System.Security.Cryptography;
using System.Text;

namespace VideoEdit.Media.Text;

/// <summary>
/// Font kökünün TEK BAKIŞTA doğrulanabilir durumu. Senkron 503 metin kapısı "API ile worker
/// AYNI font kökünü görür" varsayımına dayanır (docs/poc-bilinen-sinirlar.md §3.3) ama bu
/// varsayımı hiçbir şey doğrulamıyordu: kurulum ayrışınca API kapı kararını yanlış temelden
/// verir ve belirti dakikalar sonra worker'da çıkar. Bu tip aynı bilgiyi iki uçta da AYNI
/// türetimle raporlar — API <c>GET /health</c> cevabının <c>fonts</c> bölümü ile worker
/// açılış logunun "Font manifesti yüklendi" satırı. İki taraf aynı <see cref="Fingerprint"/>
/// değerini yazıyorsa aynı manifest + pin setini görüyordur; yazmıyorsa kurulum ayrışmıştır
/// (biri eski lock dosyası görüyor, birinde kök hiç yok...). Süreçler arasında RPC ya da
/// senkronizasyon YOKTUR — karşılaştırmayı işletmeci yapar (deploy/README.md §5.2, 4. adım).
/// </summary>
public sealed record FontRootHealth(
    bool Found,
    string Root,
    int FontIds,
    int FilesDeclared,
    int FilesPresent,
    string? Fingerprint,
    string? Error)
{
    /// <summary>
    /// Yüklenmiş manifestten rapor üretir. Dosya varlığı ANLIK sayılır (manifest bir kez
    /// okunur ama TTF'ler sonradan indirilebilir); parmak izi manifestle donuktur.
    /// </summary>
    public static FontRootHealth Describe(FontManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);

        var declared = 0;
        var present = 0;
        foreach (var entry in manifest.Fonts.Values)
        {
            foreach (var relative in entry.Files.Values)
            {
                declared++;
                // Resolve ile AYNI yol çözümü — rapor, raster hattının bakacağı dosyayı sayar.
                if (File.Exists(Path.GetFullPath(Path.Combine(manifest.RootDirectory, relative))))
                {
                    present++;
                }
            }
        }

        return new FontRootHealth(
            Found: true,
            Root: manifest.RootDirectory,
            FontIds: manifest.Fonts.Count,
            FilesDeclared: declared,
            FilesPresent: present,
            Fingerprint: FingerprintOf(manifest),
            Error: null);
    }

    /// <summary>Manifest yüklenemedi: dürüst "bulunamadı" raporu (bakılan kök + sebep).</summary>
    public static FontRootHealth Missing(string expectedManifestPath, string? error) =>
        new(Found: false,
            Root: Path.GetDirectoryName(expectedManifestPath) is { Length: > 0 } dir
                ? dir
                : expectedManifestPath,
            FontIds: 0,
            FilesDeclared: 0,
            FilesPresent: 0,
            Fingerprint: null,
            Error: error ?? "(sebep bilinmiyor)");

    /// <summary>
    /// Manifest + pin setinin BELİRLENİMCİ parmak izi: her tanımlı stil için
    /// <c>"&lt;fontId&gt;/&lt;stil&gt;=&lt;sha256 pini&gt;"</c> satırı (pin önceliği
    /// <see cref="FontManifest.Resolve"/> ile AYNI — manifest içi <c>sha256</c> önce, yoksa
    /// <c>manifest.lock.json</c>; ikisi de yoksa boş), satırlar ordinal sıralanıp
    /// <c>'\n'</c> ile birleştirilir ve UTF-8 baytlarının sha256'sı (küçük harf hex) alınır.
    /// Sözlük sırası SONUCU DEĞİŞTİRMEZ; pin, stil kümesi ya da fontId kümesi değişirse
    /// parmak izi değişir. Bu türetim testle sabittir
    /// (HealthEndpointsTests.Fingerprint_MatchesTheRepoManifestLock) — değiştirilmesi iki
    /// tarafta AYNI anda yapılmalıdır, yoksa sağlıklı kurulum "ayrışmış" görünür.
    /// </summary>
    public static string FingerprintOf(FontManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);

        var lines = new List<string>();
        foreach (var (fontId, entry) in manifest.Fonts)
        {
            foreach (var key in entry.Files.Keys)
            {
                if (!entry.Sha256.TryGetValue(key, out var pin) || string.IsNullOrWhiteSpace(pin))
                {
                    manifest.LockedHashes.TryGetValue($"{fontId}/{key}", out pin);
                }

                lines.Add($"{fontId}/{key}={pin?.Trim().ToLowerInvariant()}");
            }
        }

        lines.Sort(StringComparer.Ordinal);
        return Convert.ToHexStringLower(
            SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', lines))));
    }
}
