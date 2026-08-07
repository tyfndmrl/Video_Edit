using System.Text.Json;
using VideoEdit.Contracts;
using VideoEdit.Domain.Entities;

namespace VideoEdit.Api.Endpoints;

/// <summary>
/// Ready bir asset'in mevcut türev key'lerinden media-urls yanıt öğesini üretir.
/// presign fonksiyon olarak enjekte edilir (birim testlerinde sahte presigner kullanılır).
/// </summary>
public static class AssetMediaUrlBuilder
{
    /// <summary>manifest.json makul sınırı — beklenen boyut &lt;2 KB, savunma amaçlı üst sınır.</summary>
    public const int MaxManifestBytes = 64 * 1024;

    /// <summary>
    /// Filmstrip sözleşmesi (tasarım 02 §3.4): sprite'lar + manifest.json aynı
    /// "filmstrip/" klasöründedir. Pipeline FilmstripKey'e manifest'i ya da tek sprite'ı
    /// yazabilir; iki durumda da kardeş key türetilir.
    /// </summary>
    public static AssetMediaUrlsDto Build(Asset asset, Func<string, string> presign)
    {
        string? filmstrip = null;
        string? filmstripManifest = null;

        if (TryGetManifestKey(asset.FilmstripKey, out var manifestKey))
        {
            var directory = GetDirectory(manifestKey);
            filmstripManifest = presign(manifestKey);
            filmstrip = asset.FilmstripKey!.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
                ? presign($"{directory}/sprite_1.jpg")
                : presign(asset.FilmstripKey);
        }

        return new AssetMediaUrlsDto(
            Original: presign(asset.StorageKey),
            Proxy: PresignIfPresent(asset.ProxyKey, presign),
            Filmstrip: filmstrip,
            FilmstripManifest: filmstripManifest,
            Waveform: PresignIfPresent(asset.WaveformKey, presign),
            Poster: PresignIfPresent(asset.ThumbnailKey, presign));
    }

    /// <summary>
    /// Build + çoklu-sprite çözümü: manifest.json storage'dan OKUNUR (tek küçük GetObject,
    /// &lt;2 KB) ve sprites[] içindeki her dosya adı için presigned GET üretilir — istemcinin
    /// URL kalıbı tahmin etmesi gerekmez (presign path-bazlı imzadır, kalıp türetme kırılgandır).
    /// readObjectOrNull: key için obje içeriği, yoksa/okunamazsa null (storage hatasını yutar).
    /// Manifest okunamaz ya da parse edilemezse sprites null kalır — geriye uyumlu.
    /// </summary>
    public static async Task<AssetMediaUrlsDto> BuildAsync(
        Asset asset,
        Func<string, string> presign,
        Func<string, CancellationToken, Task<byte[]?>> readObjectOrNull,
        CancellationToken ct = default)
    {
        var dto = Build(asset, presign);
        if (!TryGetManifestKey(asset.FilmstripKey, out var manifestKey))
        {
            return dto;
        }

        var bytes = await readObjectOrNull(manifestKey, ct);
        if (bytes is null || bytes.Length == 0 || bytes.Length > MaxManifestBytes)
        {
            return dto;
        }

        var spriteNames = ParseSpriteNamesOrNull(bytes);
        if (spriteNames is null || spriteNames.Count == 0)
        {
            return dto;
        }

        var directory = GetDirectory(manifestKey);
        var sprites = new Dictionary<string, string>(spriteNames.Count, StringComparer.Ordinal);
        foreach (var name in spriteNames)
        {
            sprites[name] = presign($"{directory}/{name}");
        }

        return dto with { Sprites = sprites };
    }

    /// <summary>FilmstripKey'den manifest key'i: key .json ise kendisi, değilse kardeş manifest.json.</summary>
    internal static bool TryGetManifestKey(string? filmstripKey, out string manifestKey)
    {
        manifestKey = "";
        if (filmstripKey is not { Length: > 0 })
        {
            return false;
        }

        manifestKey = filmstripKey.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
            ? filmstripKey
            : $"{GetDirectory(filmstripKey)}/manifest.json";
        return true;
    }

    /// <summary>
    /// manifest sprites[] alanını okur (FilmstripManifest şeması — VideoEdit.Media.Recipes).
    /// Bozuk/eksik manifest'te null: media-urls asla manifest yüzünden 500 dönmez.
    /// Path separator içeren adlar atlanır (key sadece dosya adı bekler — traversal önlemi).
    /// </summary>
    private static List<string>? ParseSpriteNamesOrNull(byte[] manifestJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(manifestJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("sprites", out var spritesEl)
                || spritesEl.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var names = new List<string>();
            foreach (var el in spritesEl.EnumerateArray())
            {
                if (el.ValueKind != JsonValueKind.String)
                {
                    return null;
                }

                var name = el.GetString()!;
                if (name.Length == 0 || name.Contains('/') || name.Contains('\\') || name.Contains(".."))
                {
                    continue;
                }

                names.Add(name);
            }

            return names;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? PresignIfPresent(string? key, Func<string, string> presign) =>
        string.IsNullOrEmpty(key) ? null : presign(key);

    private static string GetDirectory(string key)
    {
        var lastSlash = key.LastIndexOf('/');
        return lastSlash < 0 ? "" : key[..lastSlash];
    }
}
