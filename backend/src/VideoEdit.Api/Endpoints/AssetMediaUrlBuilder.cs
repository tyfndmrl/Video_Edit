using VideoEdit.Contracts;
using VideoEdit.Domain.Entities;

namespace VideoEdit.Api.Endpoints;

/// <summary>
/// Ready bir asset'in mevcut türev key'lerinden media-urls yanıt öğesini üretir.
/// presign fonksiyon olarak enjekte edilir (birim testlerinde sahte presigner kullanılır).
/// </summary>
public static class AssetMediaUrlBuilder
{
    /// <summary>
    /// Filmstrip sözleşmesi (tasarım 02 §3.4): sprite'lar + manifest.json aynı
    /// "filmstrip/" klasöründedir. Pipeline FilmstripKey'e manifest'i ya da tek sprite'ı
    /// yazabilir; iki durumda da kardeş key türetilir. Çoklu-sprite URL çözümü
    /// (sprite_n) manifest tüketimiyle birlikte M2'de ele alınır.
    /// </summary>
    public static AssetMediaUrlsDto Build(Asset asset, Func<string, string> presign)
    {
        string? filmstrip = null;
        string? filmstripManifest = null;

        if (asset.FilmstripKey is { Length: > 0 } filmstripKey)
        {
            var directory = GetDirectory(filmstripKey);
            if (filmstripKey.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
            {
                filmstripManifest = presign(filmstripKey);
                filmstrip = presign($"{directory}/sprite_1.jpg");
            }
            else
            {
                filmstrip = presign(filmstripKey);
                filmstripManifest = presign($"{directory}/manifest.json");
            }
        }

        return new AssetMediaUrlsDto(
            Original: presign(asset.StorageKey),
            Proxy: PresignIfPresent(asset.ProxyKey, presign),
            Filmstrip: filmstrip,
            FilmstripManifest: filmstripManifest,
            Waveform: PresignIfPresent(asset.WaveformKey, presign),
            Poster: PresignIfPresent(asset.ThumbnailKey, presign));
    }

    private static string? PresignIfPresent(string? key, Func<string, string> presign) =>
        string.IsNullOrEmpty(key) ? null : presign(key);

    private static string GetDirectory(string key)
    {
        var lastSlash = key.LastIndexOf('/');
        return lastSlash < 0 ? "" : key[..lastSlash];
    }
}
