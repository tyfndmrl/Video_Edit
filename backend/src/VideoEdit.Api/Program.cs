using System.Text;
using System.Threading.RateLimiting;
using Hangfire;
using Hangfire.PostgreSql;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Serilog;
using VideoEdit.Api;
using VideoEdit.Api.Assets;
using VideoEdit.Api.Auth;
using VideoEdit.Api.Endpoints;
using VideoEdit.Domain.Entities;
using VideoEdit.Domain.Services;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Auth;
using VideoEdit.Infrastructure.Storage;

Log.Logger = new LoggerConfiguration()
    .WriteTo.Console()
    .CreateBootstrapLogger();

try
{
    var builder = WebApplication.CreateBuilder(args);

    builder.Host.UseSerilog((context, services, configuration) => configuration
        .ReadFrom.Configuration(context.Configuration)
        .Enrich.FromLogContext()
        .WriteTo.Console());

    // --- Prod guard'ları: yanlış konfigurasyonla sessizce ayağa kalkma ---
    if (builder.Environment.IsProduction())
    {
        var prodJwtSecret = builder.Configuration["Jwt:Secret"];
        if (string.IsNullOrWhiteSpace(prodJwtSecret)
            || prodJwtSecret.StartsWith("dev-only-", StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Production'da Jwt:Secret zorunludur ve dev default ('dev-only-' prefix) KULLANILAMAZ (env: Jwt__Secret).");
        }

        if (string.IsNullOrWhiteSpace(builder.Configuration.GetConnectionString("Postgres")))
        {
            throw new InvalidOperationException(
                "Production'da ConnectionStrings:Postgres zorunludur (env: ConnectionStrings__Postgres).");
        }

        var r2 = builder.Configuration.GetSection(R2Options.SectionName).Get<R2Options>() ?? new R2Options();
        if (string.IsNullOrWhiteSpace(r2.AccessKeyId)
            || string.IsNullOrWhiteSpace(r2.SecretAccessKey)
            || string.IsNullOrWhiteSpace(r2.Bucket)
            || (string.IsNullOrWhiteSpace(r2.ServiceUrl) && string.IsNullOrWhiteSpace(r2.AccountId)))
        {
            throw new InvalidOperationException(
                "Production'da R2 konfigürasyonu zorunludur: R2__AccessKeyId, R2__SecretAccessKey, "
                + "R2__Bucket ve R2__AccountId (veya R2__ServiceUrl).");
        }
    }

    // --- Veritabanı (localhost fallback SADECE Development) ---
    var connectionString = builder.Configuration.GetConnectionString("Postgres")
        ?? (builder.Environment.IsDevelopment()
            ? "Host=localhost;Port=5432;Database=videoedit;Username=app;Password=devpassword"
            : throw new InvalidOperationException(
                "ConnectionStrings:Postgres yapılandırılmamış (env: ConnectionStrings__Postgres)."));
    builder.Services.AddDbContext<AppDbContext>(o => o.UseNpgsql(connectionString));

    // --- Identity (MapIdentityApi KULLANILMAZ — endpoint'ler elle yazılır) ---
    builder.Services
        .AddIdentityCore<AppUser>(options =>
        {
            options.User.RequireUniqueEmail = true;
            // Şifre politikası: 8+ karakter, rakam + küçük harf yeterli. Özel karakter ve
            // büyük harf zorunluluğu KALDIRILDI — kayıt akışını opaklaştırıyordu; kalan
            // kurallar LoginGate'teki ipucu satırıyla ('En az 8 karakter, harf ve rakam
            // içermeli') birebir eşleşir. RequireDigit/RequireLowercase varsayılanı (true) kalır.
            options.Password.RequiredLength = 8;
            options.Password.RequireNonAlphanumeric = false;
            options.Password.RequireUppercase = false;
            // Brute-force koruması: 5 başarısız denemede 15 dk kilit (AuthEndpoints.AuthenticateAsync).
            options.Lockout.AllowedForNewUsers = true;
            options.Lockout.MaxFailedAccessAttempts = 5;
            options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
        })
        .AddEntityFrameworkStores<AppDbContext>();

    // --- JWT auth ---
    builder.Services.Configure<JwtOptions>(builder.Configuration.GetSection(JwtOptions.SectionName));

    builder.Services
        .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
        .AddJwtBearer(options =>
        {
            var jwt = builder.Configuration.GetSection(JwtOptions.SectionName).Get<JwtOptions>() ?? new JwtOptions();
            if (string.IsNullOrWhiteSpace(jwt.Secret) || jwt.Secret.Length < 32)
            {
                throw new InvalidOperationException(
                    "Jwt:Secret yapılandırılmamış veya 32 karakterden kısa (prod'da env: Jwt__Secret).");
            }

            options.MapInboundClaims = false;
            options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidateIssuer = true,
                ValidIssuer = jwt.Issuer,
                ValidateAudience = true,
                ValidAudience = jwt.Audience,
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.Secret)),
                ValidateLifetime = true,
                ClockSkew = TimeSpan.FromSeconds(30),
                NameClaimType = "name",
            };
        });
    builder.Services.AddAuthorization();

    // --- CORS (dev: Vite http://localhost:5173, credentials'lı) ---
    const string corsPolicy = "frontend";
    var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
        ?? ["http://localhost:5173"];
    builder.Services.AddCors(o => o.AddPolicy(corsPolicy, p => p
        .WithOrigins(allowedOrigins)
        .AllowAnyHeader()
        .AllowAnyMethod()
        .AllowCredentials()));

    // --- ProblemDetails + global exception handler ---
    builder.Services.AddProblemDetails();
    builder.Services.AddExceptionHandler<GlobalExceptionHandler>();

    // --- OpenAPI (dev'de map edilir) ---
    builder.Services.AddOpenApi();

    // --- R2 depolama + kotalar ---
    builder.Services.Configure<R2Options>(builder.Configuration.GetSection(R2Options.SectionName));
    builder.Services.Configure<QuotasOptions>(builder.Configuration.GetSection(QuotasOptions.SectionName));
    // AmazonS3Client thread-safe — tek instance yeterli.
    builder.Services.AddSingleton<IStorageService, R2StorageService>();

    // --- Hangfire (API tarafı YALNIZ client: enqueue eder, server koşmaz — worker koşar) ---
    builder.Services.AddHangfire(cfg => cfg
        .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
        .UseSimpleAssemblyNameTypeSerializer()
        .UseRecommendedSerializerSettings()
        .UsePostgreSqlStorage(o => o.UseNpgsqlConnection(connectionString)));

    // --- Rate limiting (denetim #5/#19: auth ve upload-init uçları) ---
    builder.Services.AddRateLimiter(o =>
    {
        o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
        o.OnRejected = (context, _) =>
        {
            context.HttpContext.Response.Headers.RetryAfter = "60";
            return ValueTask.CompletedTask;
        };

        // login/register: IP başına 10/dk (brute-force + hesap-enumeration frenlemesi).
        o.AddPolicy("auth", context => RateLimitPartition.GetFixedWindowLimiter(
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 10,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            }));

        // upload init + presign: kullanıcı başına 30/dk (Class A operasyon ve DB satırı
        // şişirme saldırısına karşı; anonim istek zaten 401 alır ama IP fallback'i korur).
        o.AddPolicy("upload-init", context => RateLimitPartition.GetFixedWindowLimiter(
            context.User.Identity?.IsAuthenticated == true
                ? context.User.GetUserId().ToString("D")
                : context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 30,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            }));

        // complete/abort/upload-status: kullanıcı başına 60/dk — her istek S3 çağrısı tetikler
        // (Complete/ListParts/Abort); init'ten ayrı bütçe ki resume polling'i init kotasını yemesin.
        o.AddPolicy("upload-ops", context => RateLimitPartition.GetFixedWindowLimiter(
            context.User.Identity?.IsAuthenticated == true
                ? context.User.GetUserId().ToString("D")
                : context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 60,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            }));
    });

    // --- Uygulama servisleri ---
    builder.Services.AddSingleton(TimeProvider.System);
    // Font kataloğu (GET /api/fonts) + export'un "bilinmeyen fontId" ön kontrolü. Manifest
    // BİR KEZ okunur; okunamazsa sağlayıcı hatayı TAŞIR (API açılışta patlamaz, yalnız font
    // uçları 503 döner — bkz. FontManifestProvider).
    builder.Services.Configure<VideoEdit.Media.Text.TextRasterOptions>(
        builder.Configuration.GetSection(VideoEdit.Media.Text.TextRasterOptions.SectionName));
    builder.Services.AddSingleton(sp => new VideoEdit.Media.Text.FontManifestProvider(
        sp.GetService<Microsoft.Extensions.Options.IOptions<VideoEdit.Media.Text.TextRasterOptions>>()?.Value));
    // ÖLÇÜM-İÇİN raster servisi (POST /exports ön kapısı — hiçbir yerde RenderAsync ÇAĞRILMAZ):
    // metin katmanının bbox'ı ölçülemezse "8192 px katman" kuralı yalnız worker'da görünür,
    // iş kuyruğa girer ve dakikalar sonra düşer (canlı ölçülen denetim bulgusu). Servis TEMBELDİR:
    // manifest/typeface ilk ölçümde yüklenir, fontlar kurulu değilse doğrulama alt sınıra düşer.
    builder.Services.AddSingleton<VideoEdit.Media.Text.ITextRasterService>(sp =>
        new VideoEdit.Media.Text.SkiaOverlayRasterService(
            sp.GetService<Microsoft.Extensions.Options.IOptions<VideoEdit.Media.Text.TextRasterOptions>>()?.Value));
    builder.Services.AddSingleton<ISnapshotPolicy, SnapshotPolicy>();
    builder.Services.AddScoped<IRefreshTokenService, RefreshTokenService>();
    builder.Services.AddScoped<JwtTokenService>();

    var app = builder.Build();

    // Compose'taki one-shot migrator servisi: migrate et ve çık.
    if (args.Contains("--migrate-only"))
    {
        Log.Information("Applying database migrations (--migrate-only)...");
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await db.Database.MigrateAsync();
        Log.Information("Migrations applied successfully. Exiting.");
        return 0;
    }

    // Development: MinIO'da bucket'lar yoksa oluştur (YALNIZ Development — prod bucket'ları
    // Cloudflare panelinden CORS/lifecycle kurallarıyla birlikte kurulur, bkz. deploy/README).
    if (app.Environment.IsDevelopment())
    {
        try
        {
            await app.Services.GetRequiredService<IStorageService>().EnsureBucketsExistAsync();
        }
        catch (Exception ex)
        {
            Log.Warning(ex,
                "MinIO bucket kontrolü başarısız — MinIO ayakta mı? (compose.dev.yml, http://localhost:9000). "
                + "Upload uçları MinIO olmadan çalışmaz; API yine de başlatılıyor.");
        }
    }

    // Caddy arkasında gerçek istemci IP'si: X-Forwarded-For/Proto başlıklarını uygula
    // (IP-bazlı rate limit bölümleri ve loglar aksi halde hep Caddy'nin IP'sini görür).
    // KnownProxies/KnownNetworks TEMİZLENİR: Caddy compose ağında dinamik IP alır, sabit
    // proxy listesi tutulamaz. RİSK: API'ye Caddy atlanıp DOĞRUDAN erişilebilirse istemci
    // X-Forwarded-For sahteleyerek IP-bazlı rate limit'i (auth policy) atlatabilir —
    // deploy'da 5000 portu yalnız compose iç ağına açık tutulmalı, host'a publish edilmemeli.
    var forwardedOptions = new ForwardedHeadersOptions
    {
        ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
    };
    forwardedOptions.KnownIPNetworks.Clear();
    forwardedOptions.KnownProxies.Clear();
    app.UseForwardedHeaders(forwardedOptions);

    app.UseExceptionHandler();
    app.UseSerilogRequestLogging();
    app.UseCors(corsPolicy);
    app.UseAuthentication();
    app.UseAuthorization();
    // UseAuthentication'dan SONRA: upload-init policy'si kullanıcı kimliğiyle bölümlenir.
    app.UseRateLimiter();

    // Endpoint bazlı istek gövdesi limiti (MaxRequestBodySizeMetadata taşıyan endpoint'ler,
    // örn. PUT /timeline ~2 MB). Gövde okunmadan ÖNCE uygulanmalı — bu yüzden endpoint
    // filter değil middleware (minimal API filter'ları argüman binding'inden sonra çalışır).
    app.Use(async (context, next) =>
    {
        var limit = context.GetEndpoint()?.Metadata
            .GetMetadata<VideoEdit.Api.Endpoints.MaxRequestBodySizeMetadata>();
        if (limit is not null)
        {
            var feature = context.Features
                .Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
            if (feature is { IsReadOnly: false })
            {
                feature.MaxRequestBodySize = limit.Bytes;
            }
        }

        await next(context);
    });

    if (app.Environment.IsDevelopment())
    {
        app.MapOpenApi();
    }

    app.MapHealthEndpoints();
    app.MapAuthEndpoints();
    app.MapProjectEndpoints();
    app.MapAssetEndpoints();
    app.MapExportEndpoints();
    app.MapFontEndpoints();

    app.Run();
    return 0;
}
catch (Exception ex)
{
    Log.Fatal(ex, "Host terminated unexpectedly");
    return 1;
}
finally
{
    Log.CloseAndFlush();
}
