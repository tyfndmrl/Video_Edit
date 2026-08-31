using System.Diagnostics;
using Hangfire;
using Hangfire.PostgreSql;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Jobs;
using VideoEdit.Infrastructure.Storage;
using VideoEdit.Media;
using VideoEdit.Media.Probing;
using VideoEdit.Media.Text;
using VideoEdit.Media.Waveform;
using VideoEdit.Worker.Jobs;

var builder = Host.CreateApplicationBuilder(args);

// --- Prod guard'ları (Api/Program.cs ile aynı desen): yanlış konfigurasyonla sessizce
// ayağa kalkma. DİKKAT: generic host ortamı DOTNET_ENVIRONMENT'tan okur (ASPNETCORE_ değil)
// — compose.yml worker servisi DOTNET_ENVIRONMENT'ı açıkça set eder (bkz. deploy/README.md).
if (!builder.Environment.IsDevelopment())
{
    if (string.IsNullOrWhiteSpace(builder.Configuration.GetConnectionString("Postgres")))
    {
        throw new InvalidOperationException(
            "Production'da ConnectionStrings:Postgres zorunludur (env: ConnectionStrings__Postgres).");
    }

    var r2Check = builder.Configuration.GetSection(R2Options.SectionName).Get<R2Options>() ?? new R2Options();
    if (string.IsNullOrWhiteSpace(r2Check.AccessKeyId)
        || string.IsNullOrWhiteSpace(r2Check.SecretAccessKey)
        || string.IsNullOrWhiteSpace(r2Check.Bucket)
        || (string.IsNullOrWhiteSpace(r2Check.ServiceUrl) && string.IsNullOrWhiteSpace(r2Check.AccountId)))
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

builder.Services.AddSingleton(TimeProvider.System);

// R2 istemcisi (reaper'ın abort'u ve M1 pipeline'ının indir/yükle adımları için).
builder.Services.Configure<R2Options>(builder.Configuration.GetSection(R2Options.SectionName));
builder.Services.AddSingleton<IStorageService, R2StorageService>();

// Medya araç katmanı (VideoEdit.Media) — ffmpeg/ffprobe PATH'ten (Ffmpeg section override eder).
builder.Services.Configure<FfmpegOptions>(builder.Configuration.GetSection(FfmpegOptions.SectionName));
builder.Services.AddSingleton(sp => sp.GetRequiredService<IOptions<FfmpegOptions>>().Value);
builder.Services.AddSingleton<FfprobeService>();
builder.Services.AddSingleton<FfmpegRunner>();
builder.Services.AddSingleton<WaveformGenerator>();

// Overlay raster hattı (metin/şekil PNG'leri — rendering-semantics §7). Singleton: typeface
// cache'i süreç ömrü boyunca yaşasın (her export'ta TTF yeniden parse edilmesin).
builder.Services.Configure<TextRasterOptions>(builder.Configuration.GetSection(TextRasterOptions.SectionName));
builder.Services.AddSingleton(sp => sp.GetRequiredService<IOptions<TextRasterOptions>>().Value);
builder.Services.AddSingleton<ITextRasterService>(sp =>
    new SkiaOverlayRasterService(sp.GetRequiredService<TextRasterOptions>()));

// İşleme sınırları (süre gate'i vb.).
builder.Services.Configure<ProcessingOptions>(builder.Configuration.GetSection(ProcessingOptions.SectionName));
builder.Services.AddSingleton(sp => sp.GetRequiredService<IOptions<ProcessingOptions>>().Value);

// Export tahmin sabitleri: varsayılanlar bu makinede ölçülmüş değerlerdir (ExportJob const'ları
// + ExportProfiles.EstimatedBitsPerSecond); farklı donanımdaki worker onları ExportEstimates
// section'ından (env: ExportEstimates__*) ezebilir. Formüller değişmez — yalnız sabitler.
builder.Services.Configure<ExportEstimateOptions>(
    builder.Configuration.GetSection(ExportEstimateOptions.SectionName));
builder.Services.AddSingleton(sp => sp.GetRequiredService<IOptions<ExportEstimateOptions>>().Value);

// İlerleme yayıncısı (SignalR dilimi — tasarım 03 §5): her progress DB yazımının YANINDA
// Redis 'job-progress' kanalına publish; API'nin forwarder'ı hub grubuna iletir. Redis
// ZORUNLU DEĞİLDİR: bağlantı dizisi yoksa/erişilemezse yayın sessizce düşer, DB yazımı ve
// istemcinin polling yedeği aynen çalışır (RedisJobProgressPublisher sözleşmesi). Dev
// fallback'i Postgres'inkiyle aynı desendir (yalnız Development'ta localhost).
var redisConnectionString = builder.Configuration.GetConnectionString("Redis")
    ?? (builder.Environment.IsDevelopment() ? "localhost:6379" : null);
builder.Services.AddSingleton<IJobProgressPublisher>(sp => new RedisJobProgressPublisher(
    redisConnectionString,
    sp.GetRequiredService<ILogger<RedisJobProgressPublisher>>(),
    sp.GetRequiredService<TimeProvider>()));

// ProjectRevisions retention sabitleri: varsayılanlar tasarım 03 tarifidir (son 50 auto +
// 24 saatten eskilerde saatte 1'e inceltme); farklı işletim RevisionRetention section'ından
// (env: RevisionRetention__*) ezebilir. Kural değişmez — yalnız sayılar.
builder.Services.Configure<RevisionRetentionOptions>(
    builder.Configuration.GetSection(RevisionRetentionOptions.SectionName));
builder.Services.AddSingleton(sp => sp.GetRequiredService<IOptions<RevisionRetentionOptions>>().Value);

// İş sınıfları — Hangfire DI (AspNetCoreJobActivator) scope başına çözer.
builder.Services.AddScoped<IProcessAssetJob, ProcessAssetJob>();
builder.Services.AddScoped<IExportJob, ExportJob>();
builder.Services.AddScoped<AssetReaperJob>();
builder.Services.AddScoped<ProjectRevisionRetentionJob>();

// Export orijinal LRU cache'i (tasarım 04 §4.2) — süreç başına tek instance.
builder.Services.AddSingleton<OriginalCache>();

// Koşan render'ların iptal kancaları — SÜREÇ BAŞINA tek sözlük olmalı: reaper (scoped) ile
// ExportJob (scoped) AYNI defteri görmezse reaper öldürecek süreci bulamaz.
builder.Services.AddSingleton<RunningRenderRegistry>();

// Hangfire SERVER (mimar kararı 1.d: tek kuyruk mekanizması Hangfire; api yalnız client).
// InvisibilityTimeout 2 saat: uzun transcode'lar "kayboldu" sanılıp ikinci worker'a verilmez;
// gerçek çökmede iş en geç 2 saat sonra yeniden koşar. İş aslında bittiyse ikinci teslim
// ProcessAssetJob'ın başındaki idempotency kısa devresine takılır (Ready+Succeeded → no-op);
// yarı kalmışsa yeniden işlemek güvenlidir (çıktı key'lerinin üzerine yazılır) ve yarışan iki
// koşu jobId+Guid suffix'li AYRI temp dizinleri kullandığından birbirinin dosyasını bozamaz.
// JobFailureStateFilter: nihai FailedState'te Jobs satırı + asset durumu DB'de senkronlanır.
builder.Services.AddHangfire((sp, cfg) => cfg
    .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
    .UseSimpleAssemblyNameTypeSerializer()
    .UseRecommendedSerializerSettings()
    .UseFilter(new JobFailureStateFilter(
        sp.GetRequiredService<IServiceScopeFactory>(),
        sp.GetRequiredService<TimeProvider>(),
        sp.GetRequiredService<ILogger<JobFailureStateFilter>>(),
        sp.GetRequiredService<IJobProgressPublisher>()))
    .UsePostgreSqlStorage(
        o => o.UseNpgsqlConnection(connectionString),
        new PostgreSqlStorageOptions
        {
            InvisibilityTimeout = TimeSpan.FromHours(2),
            QueuePollInterval = TimeSpan.FromSeconds(5),
        }));

builder.Services.AddHangfireServer(options =>
{
    options.ServerName = $"videoedit-worker-{Environment.MachineName}";
    options.Queues = ["transcode"];
    // Eşzamanlı transcode sayısı = worker thread sayısı (tasarım 02 §3.1: ffmpeg'e -threads
    // sınırı konmaz, eşzamanlılık worker sayısıyla yönetilir). 2: bir transcode + bir hafif iş.
    options.WorkerCount = 2;
});

// Export kuyruğu AYRI server, WorkerCount=1: ffmpeg render'ı zaten tüm çekirdekleri kullanır;
// paralel iki export disk/CPU'yu ikiye böler ve rezervasyon matematiğini bozar (tasarım 04 §4.3).
builder.Services.AddHangfireServer(options =>
{
    options.ServerName = $"videoedit-export-{Environment.MachineName}";
    options.Queues = ["export"];
    options.WorkerCount = 1;
});

var host = builder.Build();

// Boot doğrulaması: ffmpeg/ffprobe gerçekten çalışıyor mu ('-version') — yoksa worker işe
// yaramaz; ilk transcode'da değil AÇILIŞTA, açıklayıcı mesajla düş.
var ffmpegOptions = host.Services.GetRequiredService<FfmpegOptions>();
EnsureMediaToolAvailable(ffmpegOptions.FfmpegPath, "ffmpeg");
EnsureMediaToolAvailable(ffmpegOptions.FfprobePath, "ffprobe");

// Font manifesti açılışta DOĞRULANIR ama eksikliği ÖLÜMCÜL DEĞİLDİR: metin klibi olmayan
// projeler fontsuz da export edilir. Yalnız metin klibi içeren bir iş geldiğinde
// 'font-missing' ile deterministik olarak düşer (bkz. fonts/README.md).
{
    var textOptions = host.Services.GetRequiredService<TextRasterOptions>();
    var fontRoot = FontRootLocator.Locate(textOptions.FontRoot);
    var bootLogger = host.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Fonts");
    try
    {
        var loaded = FontManifest.Load(Path.Combine(fontRoot, TextRasterOptions.ManifestFileName));
        // Parmak izi API `GET /health` cevabındaki `fonts.fingerprint` ile AYNI türetimdir
        // (FontRootHealth): iki değer birebir aynı değilse API ile worker FARKLI kök ya da
        // pin seti görüyordur — karşılaştırma adımı deploy/README.md §5.2 (4. adım).
        var health = FontRootHealth.Describe(loaded);
        bootLogger.LogInformation(
            "Font manifesti yüklendi ({Count} fontId, {Present}/{Declared} dosya, parmak izi {Fingerprint}): "
            + "{Fonts} — kök: {Root}",
            loaded.Fonts.Count, health.FilesPresent, health.FilesDeclared, health.Fingerprint,
            string.Join(", ", loaded.Fonts.Keys.Order()), fontRoot);
    }
    catch (OverlayRasterException ex)
    {
        bootLogger.LogWarning(
            "Font manifesti okunamadı ({Root}): {Message} Metin klibi içeren export'lar "
            + "'font-missing' ile başarısız olacaktır — kurulum için fonts/README.md.",
            fontRoot, ex.Message);
    }
}

// Export tahmin sabitleri AÇILIŞTA görünür kılınır (FontRootHealth görünürlük deseninin log
// yarısı): kapı kararları bu sayılardan doğar ve farklı donanımdaki bir worker'ın hangi
// sabitlerle koştuğu ancak buradan okunur. Pozitif olmayan override açılışta düşürür —
// bozuk sabit ilk export'ta sessiz yanlış karar verdirmemeli.
{
    var estimates = host.Services.GetRequiredService<ExportEstimateOptions>();
    estimates.Validate();
    host.Services.GetRequiredService<ILoggerFactory>().CreateLogger("ExportEstimates")
        .LogInformation("Export tahmin sabitleri (etkin): {Effective}", estimates.DescribeEffective());
}

// Revision retention sabitleri de AÇILIŞTA doğrulanır + görünür kılınır (ExportEstimates
// deseni): bozuk override ilk koşumda kullanıcının versiyon geçmişini sessizce süpürmemeli.
{
    var retention = host.Services.GetRequiredService<RevisionRetentionOptions>();
    retention.Validate();
    host.Services.GetRequiredService<ILoggerFactory>().CreateLogger("RevisionRetention")
        .LogInformation("Revision retention sabitleri (etkin): {Effective}", retention.DescribeEffective());
}

// Reaper: 15 dk'da bir; revision retention: saatte bir (inceltme kovası da saatliktir — daha
// sık koşum yalnız no-op üretir). Kuyruk seçimi iş sınıflarındaki [Queue] attribute'undan.
using (var scope = host.Services.CreateScope())
{
    var recurring = scope.ServiceProvider.GetRequiredService<IRecurringJobManager>();
    recurring.AddOrUpdate<AssetReaperJob>(
        "asset-reaper",
        job => job.Run(CancellationToken.None),
        "*/15 * * * *");
    recurring.AddOrUpdate<ProjectRevisionRetentionJob>(
        "revision-retention",
        job => job.Run(CancellationToken.None),
        "0 * * * *");
}

host.Run();

static void EnsureMediaToolAvailable(string path, string toolName)
{
    try
    {
        var psi = new ProcessStartInfo
        {
            FileName = path,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("-version");
        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("process could not be started");
        if (!process.WaitForExit(10_000))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch
            {
                // best-effort
            }

            throw new InvalidOperationException("'-version' did not exit within 10s");
        }

        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"'-version' exited with code {process.ExitCode}");
        }
    }
    catch (Exception ex)
    {
        throw new InvalidOperationException(
            $"Worker boot check failed: {toolName} could not be executed ('{path}'). "
            + "ffmpeg/ffprobe worker için zorunludur — PATH'e kur (Debian/Ubuntu ya da Docker "
            + "imajında: apt-get install -y ffmpeg) veya Ffmpeg__FfmpegPath / Ffmpeg__FfprobePath "
            + "ile tam yol ver.", ex);
    }
}
