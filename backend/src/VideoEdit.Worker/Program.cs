using Hangfire;
using Hangfire.PostgreSql;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Jobs;
using VideoEdit.Infrastructure.Storage;
using VideoEdit.Worker.Jobs;

var builder = Host.CreateApplicationBuilder(args);

var connectionString = builder.Configuration.GetConnectionString("Postgres")
    ?? "Host=localhost;Port=5432;Database=videoedit;Username=app;Password=devpassword";
builder.Services.AddDbContext<AppDbContext>(o => o.UseNpgsql(connectionString));

builder.Services.AddSingleton(TimeProvider.System);

// R2 istemcisi (reaper'ın abort'u ve M1 pipeline'ının indir/yükle adımları için).
builder.Services.Configure<R2Options>(builder.Configuration.GetSection(R2Options.SectionName));
builder.Services.AddSingleton<IStorageService, R2StorageService>();

// İş sınıfları — Hangfire DI (AspNetCoreJobActivator) scope başına çözer.
builder.Services.AddScoped<IProcessAssetJob, ProcessAssetJob>();
builder.Services.AddScoped<AssetReaperJob>();

// Hangfire SERVER (mimar kararı 1.d: tek kuyruk mekanizması Hangfire; api yalnız client).
// InvisibilityTimeout 2 saat: uzun transcode'lar "kayboldu" sanılıp ikinci worker'a verilmez;
// gerçek çökmede iş en geç 2 saat sonra yeniden koşar (işleme idempotent — üzerine yazmak güvenli).
builder.Services.AddHangfire(cfg => cfg
    .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
    .UseSimpleAssemblyNameTypeSerializer()
    .UseRecommendedSerializerSettings()
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

var host = builder.Build();

// Reaper: 15 dk'da bir (kuyruk seçimi AssetReaperJob.Run üzerindeki [Queue] attribute'undan).
using (var scope = host.Services.CreateScope())
{
    scope.ServiceProvider.GetRequiredService<IRecurringJobManager>().AddOrUpdate<AssetReaperJob>(
        "asset-reaper",
        job => job.Run(CancellationToken.None),
        "*/15 * * * *");
}

host.Run();
