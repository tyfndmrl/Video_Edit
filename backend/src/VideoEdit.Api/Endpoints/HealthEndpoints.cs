using VideoEdit.Media.Text;

namespace VideoEdit.Api.Endpoints;

/// <summary>
/// <c>GET /health</c> — süreç ayakta mı (compose healthcheck'i 200'e bakar) + font kökünün
/// dürüst durumu. Metin kapılarının senkron 503 kararı "API ile worker AYNI font kökünü
/// görür" varsayımına dayanır (docs/poc-bilinen-sinirlar.md §3.3); <c>fonts</c> bölümü bu
/// varsayımın API yarısını görünür kılar. Worker aynı raporu açılışta loglar — işletmeci iki
/// parmak izini karşılaştırarak varsayımı TEK bakışta doğrular (deploy/README.md §5.2, 4. adım).
/// <para>
/// Font eksikliği süreci UNHEALTHY YAPMAZ (<c>status</c> "ok" kalır, HTTP 200): metin klibi
/// olmayan projeler fontsuz da çalışır ve API'nin tamamının sağlıksız sayılması kabul edilemez
/// (FontManifestProvider'daki kararın aynısı) — rapor yalnız DÜRÜSTTÜR, kapı değildir.
/// </para>
/// <para>
/// KİMLİK DOĞRULAMA YOK (bilinçli): healthcheck curl'ü ve işletmeci teşhisi oturumsuz
/// çalışmalıdır; cevap kullanıcı verisi içermez (kök yolu + sayılar + pin seti hash'i).
/// </para>
/// </summary>
public static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/health", GetHealth).WithTags("Health").AllowAnonymous();
        return app;
    }

    // internal: birim testleri doğrudan çağırır (FontEndpoints deseni).
    internal static IResult GetHealth(FontManifestProvider fonts)
    {
        // Dosya varlığı her istekte YENİDEN sayılır: fontlar API açıkken indirilirse
        // filesPresent canlı yükselir; manifest/parmak izi ise süreç ömrü boyunca donuktur
        // (provider bir kez okur — durum ancak restart'la değişir, rapor bunu yansıtır).
        var report = fonts.Manifest is { } manifest
            ? FontRootHealth.Describe(manifest)
            : FontRootHealth.Missing(fonts.Path, fonts.LoadError);

        return Results.Ok(new HealthResponse("ok", report));
    }
}

/// <summary><c>GET /health</c> gövdesi: süreç durumu + font kökü raporu.</summary>
public sealed record HealthResponse(string Status, FontRootHealth Fonts);
