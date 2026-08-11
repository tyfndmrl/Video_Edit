using VideoEdit.Media.Text;

namespace VideoEdit.Api.Endpoints;

/// <summary>
/// Font kataloğu API'si — M4 dalga-2 denetimi, KRİTİK bulgu #1 ve #3(a).
/// <list type="bullet">
///   <item><c>GET /api/fonts</c> — <c>fonts/manifest.json</c>'ın izdüşümü: fontId, aile,
///     ağırlıklar, stiller, sürüm/lisans + sha256 pin durumu. Editörün font listesi ARTIK
///     BURADAN gelir; sabit kodlu liste ile manifestin ayrışması (her metin klibinin
///     <c>font-missing</c> ile düşmesi) böylece imkânsızlaşır.</item>
///   <item><c>GET /api/fonts/{fontId}/{styleKey}.ttf</c> — KÜRATÖRLÜ TTF'nin kendisi.
///     Tarayıcı bu dosyayı <c>@font-face</c> ile yükler, yani önizleme SkiaSharp'ın
///     rasterlediği DOSYANIN AYNISIYLA ölçer (cssStack'teki "benzer sistem fontu" değil).</item>
/// </list>
/// <para>
/// KİMLİK DOĞRULAMA YOK (bilinçli): katalog ve font dosyaları kullanıcıya özel veri
/// içermez, lisansları (OFL/Apache-2.0) yeniden dağıtıma izin verir ve editör bunları
/// oturum açılmadan ÖNCE — uygulama açılışında — yükler. Kullanıcı verisi taşıyan hiçbir
/// uç bu gruba eklenmemelidir.
/// </para>
/// </summary>
public static class FontEndpoints
{
    /// <summary>Font dosyalarının tarayıcı önbelleğinde kalma süresi (saniye).</summary>
    public const int FontFileCacheSeconds = 60 * 60 * 24 * 365;

    /// <summary>Katalog cevabının önbellek süresi — manifest deploy ile değişir.</summary>
    public const int CatalogueCacheSeconds = 300;

    public static IEndpointRouteBuilder MapFontEndpoints(this IEndpointRouteBuilder app)
    {
        var fonts = app.MapGroup("/api/fonts").WithTags("Fonts").AllowAnonymous();
        fonts.MapGet("/", GetCatalogue);
        fonts.MapGet("/{fontId}/{styleKey}.ttf", GetFontFile);
        return app;
    }

    // ---------- Handlers (internal: birim testleri doğrudan çağırır) ----------

    internal static IResult GetCatalogue(FontManifestProvider provider, HttpContext http)
    {
        if (provider.Manifest is not { } manifest)
        {
            // Manifest okunamıyor: istemci SON BİLİNEN listesine (localStorage) ya da derlenmiş
            // 4 küratörlü id'ye düşer — 500 yerine konuşan bir cevap veriyoruz.
            return Results.Problem(
                statusCode: StatusCodes.Status503ServiceUnavailable,
                title: "Font manifest is not available on the server.",
                detail: $"{provider.LoadError} (beklenen yol: {provider.Path}; kurulum: fonts/README.md)");
        }

        var entries = FontCatalogue.Project(manifest);
        var response = new FontCatalogueResponse(
            ManifestVersion: manifest.ManifestVersion,
            // Lock dosyası yoksa 0: istemci "pinli değil" durumunu görebilsin.
            LockVersion: manifest.LockedHashes.Count > 0 ? 1 : 0,
            // Her stil ya manifest içi sha256 ya lock pini taşıyorsa katalog PİNLİDİR
            // (= aynı girdi her makinede aynı raster; §7 belirlenimcilik şartı).
            Pinned: entries.Count > 0 && entries.All(e => AllStylesPinned(manifest, e)),
            Fonts: [.. entries.Select(e => new FontCatalogueItem(
                Id: e.Id,
                Family: e.Family,
                Version: e.Version,
                License: e.License,
                Weights: e.Weights,
                Styles: e.Styles,
                Italic: e.Italic,
                Deprecated: e.Deprecated,
                Files: e.Styles.ToDictionary(
                    s => s,
                    s => $"/api/fonts/{Uri.EscapeDataString(e.Id)}/{Uri.EscapeDataString(s)}.ttf",
                    StringComparer.Ordinal)))]);

        http.Response.Headers.CacheControl = $"public, max-age={CatalogueCacheSeconds}";
        return Results.Ok(response);
    }

    internal static IResult GetFontFile(
        string fontId, string styleKey, FontManifestProvider provider, HttpContext http)
    {
        if (provider.Manifest is not { } manifest
            || !FontCatalogue.TryResolveFilePath(manifest, fontId, styleKey, out var path))
        {
            // Manifestte olmayan id/stil ile diskte olmayan dosya AYNI cevabı alır:
            // istek yolu üzerinden dosya sistemi yoklanamasın.
            return Results.NotFound();
        }

        // Sürüm pinli dosya (§7: bir fontId'nin dosyası ASLA değişmez, güncelleme YENİ id
        // açar) → immutable önbellek güvenlidir.
        http.Response.Headers.CacheControl = $"public, max-age={FontFileCacheSeconds}, immutable";
        return Results.File(path, "font/ttf", enableRangeProcessing: true);
    }

    private static bool AllStylesPinned(FontManifest manifest, FontCatalogueEntry entry)
    {
        if (!manifest.Fonts.TryGetValue(entry.Id, out var font))
        {
            return false;
        }

        return entry.Styles.All(style =>
            (font.Sha256.TryGetValue(style, out var inline) && !string.IsNullOrWhiteSpace(inline))
            || manifest.LockedHashes.ContainsKey($"{entry.Id}/{style}"));
    }
}

/// <summary><c>GET /api/fonts</c> gövdesi (istemci karşılığı: fontCatalogue.ts).</summary>
public sealed record FontCatalogueResponse(
    int ManifestVersion,
    int LockVersion,
    bool Pinned,
    IReadOnlyList<FontCatalogueItem> Fonts);

/// <summary>Katalogdaki tek font + tarayıcının <c>@font-face</c>'te kullanacağı adresler.</summary>
public sealed record FontCatalogueItem(
    string Id,
    string Family,
    string Version,
    string License,
    IReadOnlyList<int> Weights,
    IReadOnlyList<string> Styles,
    bool Italic,
    bool Deprecated,
    IReadOnlyDictionary<string, string> Files);
