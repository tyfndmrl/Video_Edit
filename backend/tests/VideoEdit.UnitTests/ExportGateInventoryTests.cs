using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using Hangfire;
using Hangfire.States;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Api.Endpoints;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;
using VideoEdit.Media.Export;
using VideoEdit.Media.Probing;
using VideoEdit.Media.Text;
using VideoEdit.Worker.Jobs;

namespace VideoEdit.UnitTests;

/// <summary>
/// YAPISAL MUHAFIZ — "kural yalnız Compile'da yaşıyor" sınıfının bir daha doğmasını engeller.
/// <para>
/// Bu sınıf üç şeyi birden zorunlu kılar ve KAÇAK YOLU YOKTUR:
/// </para>
/// <list type="number">
///   <item><b>Tamlık.</b> Derleyicinin kaynak dosyaları TARANIR: her
///     <c>UnsupportedFeatureException("kod")</c> ve worker'ın her <c>FailAsync</c> gerekçesi
///     aşağıdaki defterde bir satıra sahip OLMALIDIR. Yeni bir kod eklenip defter
///     güncellenmezse test KIRMIZI olur.</item>
///   <item><b>Fırlatma sayısı.</b> Kodsuz olan <c>InvalidTimelineException</c> için kimlik
///     yoktur; onun yerine dosya başına fırlatma SAYISI sabitlenir. Yeni bir fırlatma eklemek
///     — kod taşısın taşımasın — defteri güncellemeye ZORLAR.</item>
///   <item><b>Ulaşılabilirlik KANITI.</b> Defterde <see cref="GateOwner.SyncGate"/> yazan her
///     satır GERÇEKTEN koşturulur: belge kurulur, <c>ExportEndpoints.StartExport</c> çağrılır
///     ve 422 + doğru <c>feature</c> kodu + <b>iş satırı oluşmadığı</b> doğrulanır. Yani
///     "senkron kapıdan ulaşılabilir" bir iddia değil, ölçümdür.
///     <see cref="GateOwner.Unreachable"/> satırlar da koşturulur ve isteğin derleyiciye
///     GELMEDEN öldüğü (JSON ayrıştırma 422'si) gösterilir.
///     <see cref="GateOwner.WorkerOnly"/> satırlar koşturulmaz ama YAZILI gerekçe zorunludur.</item>
/// </list>
/// </summary>
public sealed class ExportGateInventoryTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly CountingJobClient _jobs = new();
    private readonly Guid _userId = Guid.CreateVersion7();
    private static readonly FontManifestProvider Fonts = new();

    public ExportGateInventoryTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }

    // ───────────────────────────── DEFTER ─────────────────────────────

    private enum GateOwner
    {
        /// <summary>API'nin POST /exports ön kapısından 422 olarak ULAŞILABİLİR (kanıtlanır).</summary>
        SyncGate,

        /// <summary>Bilerek worker'da bırakıldı — gerekçe <c>Note</c>'ta YAZILI.</summary>
        WorkerOnly,

        /// <summary>Hiçbir JSON belgesiyle tetiklenemez (savunma dalı) — kanıtlanır.</summary>
        Unreachable,
    }

    /// <param name="Measurer">
    /// Satırın kapıya ulaşmak için ihtiyaç duyduğu metin ölçeri. Varsayılan <c>null</c>'dır
    /// (kurulu font İSTEMEYEN yol); yalnız ölçüm hattında yaşayan kurallar kendi sahtesini
    /// verir — böylece defter, fontların kurulu olup olmadığından BAĞIMSIZ koşar.
    /// </param>
    private sealed record Gate(
        string Code,
        GateOwner Owner,
        string Note,
        Func<ExportGateInventoryTests, Task<Guid>>? Arrange = null,
        Func<ITextRasterService>? Measurer = null);

    /// <summary>
    /// <c>UnsupportedFeatureException</c> kodlarının TAM defteri. Kaynak taraması bu listeyle
    /// birebir eşleşmek zorundadır.
    /// </summary>
    private static readonly Gate[] CompilerGates =
    [
        new("asset-missing", GateOwner.SyncGate,
            "Saf DB aritmetiği: satır yoksa (silinmiş/başkasının/hiç olmamış) kalıcı bir durumdur.",
            t => t.SeedAsync(
                ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
                    ExportTestDocs.AssetA, 0, 0, 1_000_000)),
                seedAssets: false)),

        new("source-out-of-range", GateOwner.SyncGate,
            "Saf DB aritmetiği: Asset.DurationMicros worker'ın ffprobe süresiyle aynı sayıdır.",
            async t =>
            {
                await t.SeedAssetAsync(ExportTestDocs.AssetA, durationMicros: 10_000_000);
                return await t.SeedAsync(
                    ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
                        ExportTestDocs.AssetA, 0, 12_000_000, 20_000_000)),
                    seedAssets: false);
            }),

        new("asset-failed", GateOwner.SyncGate,
            "Saf DB aritmetiği: Asset.Status = Failed TERMİNALDİR (durum makinesinde Failed → "
            + "Ready geçişi YOKTUR), yani 'birazdan hazır olur' ihtimali yok — senkron ret "
            + "güvenlidir. Geçici durumlar (Uploading/Uploaded/Processing) BİLEREK worker'da "
            + "kalır; kapsamın tamamı AssetStatusOwners defterinde durum durum koşturulur.",
            async t =>
            {
                await t.SeedAssetAsync(ExportTestDocs.AssetA, status: AssetStatus.Failed);
                return await t.SeedAsync(
                    ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
                        ExportTestDocs.AssetA, 0, 0, 1_000_000)),
                    seedAssets: false);
            }),

        new("asset-clip-type", GateOwner.SyncGate,
            "Saf DB aritmetiği: klip türünün istediği akış (defter: ExportPlan.AssetUses) ile "
            + "varlığın Kind'i çelişiyor. Tam matris AssetClipTypeMatrix defterinde uçtan uca "
            + "koşturulur.",
            async t =>
            {
                // Çıkartma klibi bir VİDEO varlığını gösteriyor (N3'ün ölçülen vakası).
                await t.SeedAssetAsync(ExportTestDocs.AssetA);
                await t.SeedAssetAsync(ExportTestDocs.AssetB, fileName: "holiday.mp4");
                return await t.SeedAsync(
                    ExportTestDocs.MultiTrackDoc(
                    [
                        ExportTestDocs.OverlayTrack(clips:
                            [ExportTestDocs.StickerClip(ExportTestDocs.AssetB, 0, 1_000_000)]),
                        ExportTestDocs.VideoTrack(clips:
                            [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000)]),
                    ]),
                    seedAssets: false);
            }),

        new("lut-asset-type", GateOwner.SyncGate,
            "Saf DB aritmetiği: LUT varlığının dosya adı .cube değilse lut3d onu okuyamaz.",
            async t =>
            {
                await t.SeedAssetAsync(ExportTestDocs.AssetA);
                await t.SeedAssetAsync(ExportTestDocs.AssetC, fileName: "holiday.mp4");
                var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
                clip.Effects = [ExportTestDocs.Lut(ExportTestDocs.AssetC)];
                return await t.SeedAsync(ExportTestDocs.Doc(clips: clip), seedAssets: false);
            }),

        new("degenerate-layer", GateOwner.SyncGate,
            "Saf DB aritmetiği: kaynak en-boy oranı (Asset.Width/Height) + doküman ölçeği.",
            async t =>
            {
                await t.SeedAssetAsync(ExportTestDocs.AssetA, width: 1920, height: 100);
                return await t.SeedAsync(
                    ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
                        ExportTestDocs.AssetA, 0, 0, 1_000_000,
                        transform: ExportTestDocs.Transform(scale: 0.010))),
                    seedAssets: false);
            }),

        new("keyframe-sample-budget", GateOwner.SyncGate,
            "Saf doküman aritmetiği: örnek sayısı yalnız keyframe/frame aralığı/fps'e bağlı.",
            t => t.SeedAsync(ExportTestDocs.CurvedScaleDoc(clipCount: 17))),

        new("transition-rotated-anchor", GateOwner.SyncGate,
            "Saf doküman aritmetiği: LayerGeometry.Compute yalnız transform + tuval okur.",
            t =>
            {
                var rotated = ExportTestDocs.Transform(scale: 0.5, rotationDeg: 30, anchorX: 0.25);
                var a = ExportTestDocs.VideoClip(
                    ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000, transform: rotated);
                var b = ExportTestDocs.VideoClip(
                    ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000, transform: rotated);
                ExportTestDocs.Link(a, b, 400_000);
                return t.SeedAsync(ExportTestDocs.Doc(clips: [a, b]));
            }),

        new("transition-keyframes", GateOwner.SyncGate,
            "Saf doküman aritmetiği (ResolveTransitions).",
            t =>
            {
                var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000);
                var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000);
                b.Keyframes = new KeyframeTracks
                {
                    X = [ExportTestDocs.Kf(0, 0), ExportTestDocs.Kf(1_000_000, 0.25)],
                };
                ExportTestDocs.Link(a, b, 400_000);
                return t.SeedAsync(ExportTestDocs.Doc(clips: [a, b]));
            }),

        new("transition-handle", GateOwner.SyncGate,
            "Saf doküman aritmetiği: B'nin sourceIn'i D/2 payını karşılıyor mu.",
            t =>
            {
                var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000);
                var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 0, 2_000_000);
                ExportTestDocs.Link(a, b, 400_000);
                return t.SeedAsync(ExportTestDocs.Doc(clips: [a, b]));
            }),

        new("scale-keyframes-with-rotation", GateOwner.SyncGate,
            "Saf doküman aritmetiği (ValidateGeometry).",
            t =>
            {
                var clip = ExportTestDocs.VideoClip(
                    ExportTestDocs.AssetA, 0, 0, 1_000_000,
                    transform: ExportTestDocs.Transform(rotationDeg: 30));
                clip.Keyframes = new KeyframeTracks
                {
                    Scale = [ExportTestDocs.Kf(0, 1), ExportTestDocs.Kf(1_000_000, 0.5)],
                };
                return t.SeedAsync(ExportTestDocs.Doc(clips: clip));
            }),

        new("keyframes-audio-clip", GateOwner.SyncGate,
            "Saf doküman aritmetiği (ValidateClip).",
            t =>
            {
                var clip = ExportTestDocs.AudioClip(ExportTestDocs.AssetB, 0, 0, 1_000_000);
                clip.Keyframes = new KeyframeTracks
                {
                    Opacity = [ExportTestDocs.Kf(0, 1), ExportTestDocs.Kf(500_000, 0)],
                };
                return t.SeedAsync(ExportTestDocs.MultiTrackDoc(
                [
                    ExportTestDocs.VideoTrack(clips:
                        [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000)]),
                    ExportTestDocs.AudioTrack(clips: [clip]),
                ]));
            }),

        new("effects-audio-clip", GateOwner.SyncGate,
            "Saf doküman aritmetiği (ValidateClip).",
            t =>
            {
                var clip = ExportTestDocs.AudioClip(ExportTestDocs.AssetB, 0, 0, 1_000_000);
                clip.Effects = [ExportTestDocs.ColorAdjust(saturation: 0.5)];
                return t.SeedAsync(ExportTestDocs.MultiTrackDoc(
                [
                    ExportTestDocs.VideoTrack(clips:
                        [ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000)]),
                    ExportTestDocs.AudioTrack(clips: [clip]),
                ]));
            }),

        new("transform-scale", GateOwner.SyncGate,
            "Saf doküman aritmetiği: ara tuval boyutu transform + tuvalden çıkar.",
            t => t.SeedAsync(ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
                ExportTestDocs.AssetA, 0, 0, 1_000_000,
                transform: ExportTestDocs.Transform(scale: 8))))),

        new("overlay-too-large", GateOwner.SyncGate,
            "Saf doküman aritmetiği: metin kutusunun font-BAĞIMSIZ alt sınırı bile tavanı aşar.",
            t =>
            {
                var clip = ExportTestDocs.TextClip(
                    0, 1_000_000, content: new string('A', 400));
                clip.Text!.FontSizePx = 9000;
                return t.SeedAsync(ExportTestDocs.Doc(clips: clip));
            }),

        new("overlay-unsupported-clip", GateOwner.SyncGate,
            "Raster hattının reddettiği ama SAF DOKÜMAN aritmetiğiyle karar verilebilen kurallar "
            + "(geçersiz renk alanı, gövdesiz şekil, yinelenen raster klip kimliği). Kod bilerek "
            + "raster hattının koduyla AYNIDIR — aynı kusur, aynı makine kodu. Üç fırlatmanın "
            + "HER BİRİ ayrı ayrı RasterRefusals defterinde koşturulur.",
            t =>
            {
                var clip = ExportTestDocs.TextClip(0, 1_000_000);
                clip.Text!.Fill = "rgb(1,2,3)";
                return t.SeedAsync(ExportTestDocs.Doc(clips: clip));
            }),

        new("project-background-color", GateOwner.SyncGate,
            "Saf doküman aritmetiği: proje arkaplan rengi ffmpeg grafiğine DOĞRUDAN gömülen tek "
            + "doküman dizesidir (color=c=…, pad=…:color=…). İki fırlatma noktası aynı kodu "
            + "taşır — Validate'teki kapı (aşağıda kanıtlanır) ve FfmpegColor'ın sözleşme "
            + "muhafızı. Klip kapsamlı 'overlay-unsupported-clip' DEĞİLDİR: bu bir proje "
            + "ayarıdır, kullanıcı düzeltmek için klip aramamalıdır.",
            t => t.SeedAsync(ExportTestDocs.Doc(
                backgroundColor: "#GGGGGG",
                clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000)))),

        new("project-fps-out-of-range", GateOwner.SyncGate,
            "Saf doküman aritmetiği: settings.fps YALNIZ iki tam sayıdır — ne dosya ne asset ne "
            + "font gerekir. Eski kapı 'pozitif rasyonel' istiyordu ve ÜST SINIR YOKTU: ham API "
            + "ile ölçüldü, fps=100000/1 + tek 0,5 sn'lik klip POST 202 alıp dakikalarca render "
            + "ediliyordu. Kabul penceresi (1–240 fps) yayın hızlarının tamamını ve tüketici "
            + "yüksek-kare-hızı çekimlerini kapsar; pencerenin İÇİ FpsWindowBoundaries "
            + "defterinde hız hız koşturulur, yani kapı yanlış RET üretmiyor da ölçülür.",
            t => t.SeedAsync(ExportTestDocs.Doc(
                fpsNum: 100_000, fpsDen: 1,
                clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000)))),

        new("timeline-too-long", GateOwner.SyncGate,
            "Saf doküman aritmetiği: toplam süre klip kenarlarından çıkar. Worker'ın disk "
            + "rezervasyonunu (EstimateRequiredDiskBytes) SÜRE domine eder; tavan yokken ~3,17 "
            + "yıllık bir çizelge POST 202 alıyor, 150 TB isteyip 'disk-full' ile düşüyordu — "
            + "yani BELGE kusuru kullanıcıya SUNUCUNUN DİSKİ bitmiş gibi gösteriliyordu. "
            + "GERÇEK disk darlığı bu kapıya KARIŞMAZ: 'disk-full' yolu yerinde durur ve tavanın "
            + "ALTINDAKİ bir belge için tetiklenebilir (ExportJobTests'te ikisi ayrı ayrı koşar).",
            t => t.SeedAsync(ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
                ExportTestDocs.AssetA,
                // Tavanın 1 saniye ÖTESİ: kenar ızgarada (30 fps), kaynak aralığı geçerli.
                ExportCompiler.MaxTimelineDurationUs, 0, 1_000_000)))),

        new("font-missing", GateOwner.SyncGate,
            "Saf manifest aritmetiği: 'bu fontId hiçbir manifestte yok' kurulumdan BAĞIMSIZ ve "
            + "KALICI bir olgudur (font kökü düzeltilse bile aynı belge aynı hatayı verir). "
            + "Normalde API'nin manifest ön kontrolü daha erken yakalar; bu dal iki manifest "
            + "okuyucusu ayrıştığında cevabın 503'e kaymasını engeller.",
            t => t.SeedAsync(ExportTestDocs.Doc(clips: ExportTestDocs.TextClip(0, 1_000_000))),
            () => new UnknownFontMeasurer()),

        new("lut-asset", GateOwner.SyncGate,
            "İki fırlatma noktası aynı kodu taşır: (a) LUT efektinde assetId YOK — Validate'te, "
            + "aşağıda kanıtlanır; (b) worker'ın sources defterinde .cube yolu yok — o dal artık "
            + "API'de 'asset-missing' ile ÖNCE yakalanır, Compile'daki hali sigortadır.",
            t =>
            {
                var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
                var effect = new Effect
                {
                    Id = Guid.CreateVersion7(),
                    Type = EffectType.Lut,
                    Enabled = true,
                };
                effect.Params["intensity"] = 1d; // assetId BİLEREK yok
                clip.Effects = [effect];
                return t.SeedAsync(ExportTestDocs.Doc(clips: clip));
            }),

        new("unknown-clip", GateOwner.Unreachable,
            "Şema union'ı: tanınmayan 'kind' ayrıştırma sırasında JsonException'a düşer, "
            + "istek derleyiciye HİÇ ULAŞMAZ (aşağıda ölçülür).",
            t => t.SeedRawAsync(BogusDiscriminatorJson("\"kind\":\"video\"", "\"kind\":\"hologram\""))),

        new("easing-type", GateOwner.Unreachable,
            "Şema union'ı: tanınmayan easing 'type'ı ayrıştırma sırasında JsonException'a düşer.",
            t => t.SeedRawAsync(KeyframedDocJson(easingType: "sproing"))),

        new("effect-type", GateOwner.Unreachable,
            "EffectType bir ENUM'dur: tanınmayan değer JsonStringEnumConverter'da JsonException.",
            t => t.SeedRawAsync(EffectDocJson(effectType: "kaleidoscope"))),

        new("transition-type", GateOwner.Unreachable,
            "TransitionType bir ENUM'dur: tanınmayan değer JsonStringEnumConverter'da JsonException.",
            t => t.SeedRawAsync(TransitionDocJson(transitionType: "starwipe"))),
    ];

    /// <summary>
    /// Worker'ın <c>FailAsync</c> gerekçelerinin TAM defteri. Buradaki her satır ya senkron
    /// kapıda KARŞILIĞI olduğunu ya da neden orada olamayacağını söyler.
    /// </summary>
    private static readonly (string Reason, GateOwner Owner, string Note)[] WorkerFailures =
    [
        ("invalid-timeline", GateOwner.SyncGate,
            "API aynı Validate'i çağırır; InvalidTimelineException 422'ye map'lenir."),
        ("invalid-profile", GateOwner.SyncGate,
            "API ExportProfiles.TryParse ile 400 döner."),
        ("asset-missing", GateOwner.SyncGate,
            "Bu turda senkron kapıya taşındı (ExportCompiler.EnsureAssetFacts)."),
        ("source-out-of-range", GateOwner.SyncGate,
            "Bu turda senkron kapıya taşındı; kural tek yerde (ExportCompiler.FindSourceOutOfRange)."),
        ("asset-not-ready", GateOwner.WorkerOnly,
            "YALNIZ GEÇİCİ durumlar için worker'da: işlenmekte olan bir asset, iş kuyruktan "
            + "alınana kadar Ready olabilir; senkron ret YANLIŞ RET olurdu. TERMİNAL durum "
            + "(Failed) buraya AİT DEĞİLDİR ve senkron kapıya taşındı ('asset-failed') — "
            + "gerekçenin durum durum kapsaması AssetStatusOwners defterinde koşturulur."),
        ("original-missing", GateOwner.WorkerOnly,
            "Depo (S3/MinIO) gerçeği; DB satırı varken objenin yokluğu ancak indirmede anlaşılır."),
        ("storage-denied", GateOwner.WorkerOnly,
            "Depo yetki/erişim hatası — istek anında bilinemez."),
        ("disk-full", GateOwner.WorkerOnly,
            "Worker diskinin o andaki boş alanı; API sürecinin bilgisi değil."),
        ("unsupported-media", GateOwner.WorkerOnly,
            "İndirilen DOSYANIN ffprobe sonucu: çözülebiliyor mu ve klibin istediği akışı "
            + "taşıyor mu. Senkron karşılığı 'asset-clip-type'tır (aynı defter, DB olgularıyla); "
            + "burada kalan yarı DB satırı ile dosyanın çelişmesine karşı emniyet kemeridir."),
        ("overlay-raster-unavailable", GateOwner.WorkerOnly,
            "Worker'ın DI kurulumu (ITextRasterService kayıtlı mı) — API'nin kendi kurulumu "
            + "farklı olabilir. API tarafındaki KARŞILIĞI bu turda eklendi: ölçüm yolu kapalıysa "
            + "POST /exports 503 'text-measure-unavailable' döner."),
        ("output-invalid", GateOwner.WorkerOnly,
            "Render SONRASI çıktı doğrulaması (dosya boyu, süre, stream'ler)."),
        ("ffmpeg-timeout", GateOwner.WorkerOnly,
            "Çalışma zamanı: ffmpeg SESSİZ kaldı (120 sn hiç progress/stderr yok) ve bekçi "
            + "süreci öldürdü. İstek anında bilinemez — süre kaynak karmaşıklığına ve makine "
            + "yüküne bağlıdır."),
        ("render-overrun", GateOwner.WorkerOnly,
            "Çalışma zamanı: ffmpeg ÇIKTI SAATİ beklenen süreyi tavanı aşacak kadar geçti ve "
            + "süreç öldürüldü. 'ffmpeg-timeout'tan AYRI bir haldir ve ayrı kalmalıdır: o "
            + "'hiç çıktı üretmiyor', bu 'durmadan üretiyor ama asla bitmeyecek' demektir — "
            + "kaçak grafik sessiz kalmadığı için sessizlik bekçisini HİÇ tetiklemiyordu. "
            + "İstek anında bilinemez: çıktı saatinin nasıl ilerlediği ancak koşarken görülür."),
        ("ffmpeg-failed", GateOwner.WorkerOnly,
            "Çalışma zamanı: ffmpeg sıfırdan farklı çıkış kodu. Grafiğin ÇALIŞMA anındaki "
            + "davranışıdır; belgeden türetilebilen dalları bu turda senkron kapıya taşındı "
            + "(LUT dosya türü, kaynak aralığı, varlık mevcudiyeti)."),
        ("unsupported-feature:*", GateOwner.SyncGate,
            "Dinamik gerekçe: ex.Feature. Kodların tamamı CompilerGates defterindedir."),
        ("overlay-raster:*", GateOwner.WorkerOnly,
            "Dinamik gerekçe: OverlayRasterException.Code (font-missing, raster-too-large ...). "
            + "Raster hattı yalnız worker'da koşar; font-missing'in API karşılığı FontCatalogue "
            + "ön kontrolüdür."),
    ];

    // ───────── DURUM DEFTERİ (yeni: "gerekçe TÜM durumları kapsıyor mu" sınıfı) ─────────

    /// <summary>
    /// <c>asset-not-ready</c> gerekçesine ULAŞAN HER asset durumunun sahibi.
    /// <para>
    /// NEDEN EKLENDİ: eski muhafız (<see cref="EveryWorkerFailureReasonHasAnInventoryRow"/>)
    /// yalnız "her gerekçenin bir SATIRI var mı" diye soruyordu — satırdaki gerekçenin o
    /// gerekçeye ulaşan TÜM DURUMLARI kapsayıp kapsamadığını sormuyordu. <c>asset-not-ready</c>
    /// satırının yazılı gerekçesi ("işlenmekte olan asset iş kuyruktan alınana kadar Ready
    /// olabilir") dört durumdan yalnız üçünü kapsıyordu: <c>Failed</c> TERMİNALDİR, o asset
    /// asla Ready olmaz — ve ölçüldü ki böyle bir belge 202 alıp dakikalar sonra ölüyordu
    /// (M6 denetimi, N2). Bu defter o SINIFI kapatır: durum enum'ı REFLEKSİYONLA taranır,
    /// her değer bir satır ister ve <see cref="StateOwner.SyncGate"/> satırlar GERÇEKTEN
    /// koşturulur.
    /// </para>
    /// </summary>
    private enum StateOwner
    {
        /// <summary>Bu durumdaki bir varlığa atıf yapan belge POST /exports'ta 422 alır (kanıtlanır).</summary>
        SyncGate,

        /// <summary>Bu durum GEÇİCİDİR: belge 202 alır, karar worker'a bırakılır (kanıtlanır).</summary>
        WorkerOnly,

        /// <summary>Bu durum bir başarısızlık değildir: belge kuyruğa girer (kanıtlanır).</summary>
        NotAFailure,
    }

    private sealed record AssetStateRow(AssetStatus Status, StateOwner Owner, string Note, string? Feature = null);

    private static readonly AssetStateRow[] AssetStatusOwners =
    [
        new(AssetStatus.Uploading, StateOwner.WorkerOnly,
            "GEÇİCİ: yükleme sürüyor; iş kuyruktan alınana kadar Ready olabilir. Senkron ret "
            + "yanlış ret olurdu. (E2E seed'lerinin placeholder satırı da bu durumdadır — "
            + "docs/poc-bilinen-sinirlar.md'de yazılı bilinen sınır.)"),
        new(AssetStatus.Uploaded, StateOwner.WorkerOnly,
            "GEÇİCİ: işleme kuyruğunda; iş başlayana kadar Ready olabilir."),
        new(AssetStatus.Processing, StateOwner.WorkerOnly,
            "GEÇİCİ: ffprobe/türev üretimi sürüyor; iş başlayana kadar Ready olabilir."),
        new(AssetStatus.Failed, StateOwner.SyncGate,
            "TERMİNAL: durum makinesinde Failed → Ready geçişi yoktur (yalnız kullanıcının "
            + "başlattığı Failed → Processing yeniden denemesi vardır), yani bu belge "
            + "BUGÜN de dakikalar sonra da render EDİLEMEZ.",
            Feature: "asset-failed"),
        new(AssetStatus.Ready, StateOwner.NotAFailure,
            "Kapı açıktır: satır hazır, olguları (süre/boyut/tür/ses) KESİNDİR."),
    ];

    // ───────── TÜR MATRİSİ (yeni: klip türü ↔ varlık türü uyuşmazlığının TAMAMI) ─────────

    /// <param name="Expected">
    /// <c>null</c> = kabul (202); doluysa beklenen 422 <c>feature</c> kodu.
    /// </param>
    private sealed record TypeCase(
        string Name, MediaClipKindOrSticker ClipKind, AssetKind AssetKind, string? Expected,
        bool AssetHasAudio = true);

    private enum MediaClipKindOrSticker { Video, Audio, Image, Sticker }

    /// <summary>
    /// KLİP TÜRÜ × VARLIK TÜRÜ matrisinin TAMAMI (4 × 3) + "sessiz video" özel hali. Her satır
    /// GERÇEKTEN koşturulur: belge kurulur, uç nokta çağrılır, kabul/ret ÖLÇÜLÜR.
    /// <para>
    /// Editör bu uyuşmazlıkların hiçbirini üretemez (klip türü varlığın türünden doğar:
    /// <c>timelineOps.buildClipFromAsset</c>, <c>addStickerClip</c>) — ama sunucu istemciye
    /// GÜVENEMEZ ve ölçülen iki vaka (N1 ses, N3 çıkartma) tam olarak bu matrisin içindedir.
    /// </para>
    /// </summary>
    private static readonly TypeCase[] AssetClipTypeMatrix =
    [
        new("video klibi + video varlığı", MediaClipKindOrSticker.Video, AssetKind.Video, null),
        new("video klibi + ses varlığı", MediaClipKindOrSticker.Video, AssetKind.Audio, "asset-clip-type"),
        new("video klibi + görsel varlığı", MediaClipKindOrSticker.Video, AssetKind.Image, "asset-clip-type"),

        new("ses klibi + ses varlığı", MediaClipKindOrSticker.Audio, AssetKind.Audio, null),
        new("ses klibi + SESLİ video varlığı", MediaClipKindOrSticker.Audio, AssetKind.Video, null),
        new("ses klibi + SESSİZ video varlığı", MediaClipKindOrSticker.Audio, AssetKind.Video,
            "asset-clip-type", AssetHasAudio: false),
        new("ses klibi + görsel varlığı", MediaClipKindOrSticker.Audio, AssetKind.Image, "asset-clip-type"),

        new("görsel klibi + görsel varlığı", MediaClipKindOrSticker.Image, AssetKind.Image, null),
        new("görsel klibi + video varlığı", MediaClipKindOrSticker.Image, AssetKind.Video, "asset-clip-type"),
        new("görsel klibi + ses varlığı", MediaClipKindOrSticker.Image, AssetKind.Audio, "asset-clip-type"),

        new("çıkartma + görsel varlığı", MediaClipKindOrSticker.Sticker, AssetKind.Image, null),
        new("çıkartma + video varlığı", MediaClipKindOrSticker.Sticker, AssetKind.Video, "asset-clip-type"),
        new("çıkartma + ses varlığı", MediaClipKindOrSticker.Sticker, AssetKind.Audio, "asset-clip-type"),
    ];

    // ─────────────────── RASTER HATTI DEFTERİ (yeni: M3 kaçağının sınıfı) ───────────────────

    /// <summary>
    /// Raster hattının bir klibi REDDETME gerekçesinin sahibi.
    /// </summary>
    private enum RasterOwner
    {
        /// <summary>
        /// Bu reddi tetikleyecek belge POST /exports tarafından ZATEN 422 ile geri çevrilir —
        /// aşağıda GERÇEKTEN koşturularak kanıtlanır.
        /// </summary>
        SyncGate,

        /// <summary>
        /// Derleyici böyle bir klibi raster hattına HİÇ YÖNLENDİRMEZ (ör. çıkartma kendi
        /// PNG'siyle girer). Raster API'sinin kendi sözleşmesini koruyan savunma dalıdır.
        /// </summary>
        NotRoutedHere,

        /// <summary>Hiçbir geçerli JSON belgesiyle üretilemez (şema enum'ı/union'ı).</summary>
        Unreachable,
    }

    /// <param name="Fragment">
    /// Fırlatma noktasını TEKİL olarak tanımlayan mesaj parçası. Kimlik SAYI DEĞİL METİNDİR:
    /// sayı sabitlemek "iki fırlatma eklendi, biri silindi" halini görmez, kimlik görür.
    /// </param>
    /// <param name="Feature">
    /// SyncGate satırının beklediği 422 <c>feature</c> kodu; <c>null</c> ise kapı KODSUZ
    /// <c>InvalidTimelineException</c> ile reddediyor demektir (o da doğrulanır).
    /// </param>
    private sealed record RasterRefusal(
        string Fragment,
        RasterOwner Owner,
        string Note,
        string? Feature = null,
        Func<ExportGateInventoryTests, Task<Guid>>? Arrange = null);

    /// <summary>
    /// Raster hattının (<c>backend/src/VideoEdit.Media/Text</c>) TÜM
    /// <c>UnsupportedOverlayClipException</c> fırlatmalarının defteri.
    /// <para>
    /// NEDEN EKLENDİ: eski muhafız yalnız <c>VideoEdit.Media/Export</c> altını tarıyordu ve
    /// raster hattını HİÇ görmüyordu. <c>text.fill</c> kaçağı tam olarak oradaydı — saf
    /// doküman kuralı (geçersiz renk), ama kural yalnız çizim anında yaşadığı için belge 202
    /// alıyor, iş dakikalar sonra <c>overlay-unsupported-clip</c> ile düşüyordu.
    /// </para>
    /// <para>
    /// KAPSAM (dar okuyun): bu defter <b>RASTER HATTINDA FIRLATILAN</b> reddi kapsar — yani
    /// "kural yalnız çizim anında yaşıyor" sınıfını. Raster hattına eklenen her "bu klibi
    /// çizemem" gerekçesi, senkron kapıda karşılığı olduğunu KANITLAMAK ya da neden
    /// olamayacağını YAZMAK zorundadır. <b>Kapsamadığı sınıf:</b> hiç fırlatmayan, doküman
    /// değerini sessizce düzelten/gömen yollar — <c>ExportCompiler.FfmpegColor</c>'ın eski
    /// <c>_ =&gt; "000000"</c> dalı tam olarak öyleydi ve fırlatma sayan hiçbir muhafız onu
    /// göremezdi. O sınıfın defteri ayrıdır: <see cref="DocumentStrings"/>.
    /// </para>
    /// </summary>
    private static readonly RasterRefusal[] RasterRefusals =
    [
        new("geçersiz renk değeri taşıyor", RasterOwner.SyncGate,
            "Saf doküman aritmetiği: renk dilbilgisi yalnız dizeye bakar.",
            Feature: "overlay-unsupported-clip",
            Arrange: t =>
            {
                var clip = ExportTestDocs.TextClip(0, 1_000_000);
                clip.Text!.Fill = "rgb(1,2,3)";
                return t.SeedAsync(ExportTestDocs.Doc(clips: clip));
            }),

        new("yinelenen klip kimliği var", RasterOwner.SyncGate,
            "Saf doküman aritmetiği: aynı id iki kez rasterlenirse PNG dosya adı çakışır.",
            Feature: "overlay-unsupported-clip",
            Arrange: t =>
            {
                var first = ExportTestDocs.TextClip(0, 1_000_000);
                var second = ExportTestDocs.TextClip(1_000_000, 1_000_000);
                second.Id = first.Id; // aynı kimlik → iki raster, tek dosya adı
                return t.SeedAsync(ExportTestDocs.Doc(clips: [first, second]));
            }),

        // NOT — bu iki satır HAM JSON kurar: DTO'da 'text'/'shape' alanları property
        // başlatıcısı taşır ve TimelineJson.Options null yazmaz (WhenWritingNull), yani
        // nesneye null atayıp serialize etmek alanı SİLER ve karşı tarafta VARSAYILAN gövde
        // doğar. Gövdesizliğin tek gerçek taşıyıcısı AÇIK "null" değeridir.
        new("boş 'shape' alanı taşıyor", RasterOwner.SyncGate,
            "Saf doküman aritmetiği: 'shape' gövdesi yoksa çizilecek bir şey tanımlanmamıştır.",
            Feature: "overlay-unsupported-clip",
            Arrange: t => t.SeedRawAsync(NulledMemberJson(
                ExportTestDocs.Doc(clips: ExportTestDocs.ShapeClip(0, 1_000_000)), "shape"))),

        new("boş 'text' alanı taşıyor", RasterOwner.SyncGate,
            "Saf doküman aritmetiği. Senkron karşılığı KODSUZ reddeder (kutu sorulurken, "
            + "ExportCompiler.RasterBoxOf) — kod eşitliği aranmaz, RET eşitliği aranır.",
            Arrange: t => t.SeedRawAsync(NulledMemberJson(
                ExportTestDocs.Doc(clips: ExportTestDocs.TextClip(0, 1_000_000)), "text"))),

        new("geçersiz ölçü taşıyor", RasterOwner.SyncGate,
            "Saf doküman aritmetiği: fontSizePx/lineHeight pozitif olmalı (kodsuz ret).",
            Arrange: t =>
            {
                var clip = ExportTestDocs.TextClip(0, 1_000_000);
                clip.Text!.FontSizePx = 0;
                return t.SeedAsync(ExportTestDocs.Doc(clips: clip));
            }),

        new("geçersiz proje çözünürlüğü", RasterOwner.SyncGate,
            "Saf doküman aritmetiği: tuval boyutu settings'ten okunur (kodsuz ret).",
            Arrange: t => t.SeedAsync(ExportTestDocs.Doc(
                width: 0, clips: ExportTestDocs.ShapeClip(0, 1_000_000)))),

        new("Çıkartma (sticker) klibi rasterleştirilmez", RasterOwner.NotRoutedHere,
            "Çıkartma kendi PNG/WebP asset'iyle doğrudan ffmpeg girişidir; derleyici onu "
            + "RasterClips defterine HİÇ koymaz (NeedsServerRaster false). Raster API'sinin "
            + "kendi sözleşmesini koruyan savunma dalıdır — belgeyle tetiklenemez."),

        new("overlay raster hattında desteklenmiyor", RasterOwner.NotRoutedHere,
            "Medya/ses klipleri raster hattına gönderilmez; tanınmayan bir klip türü ise JSON "
            + "ayrıştırmada ölür (bkz. 'unknown-clip' satırı). Savunma dalı."),

        new("Bilinmeyen şekil türü", RasterOwner.Unreachable,
            "ShapeClipShapeType bir ENUM'dur: tanınmayan değer JsonStringEnumConverter'da "
            + "JsonException'a düşer, belge derleyiciye de raster hattına da HİÇ ULAŞMAZ."),
    ];

    // ───────── DOKÜMAN DİZELERİ DEFTERİ (yeni: FfmpegColor kaçağının SINIFI) ─────────

    /// <summary>Bir doküman dizesinin nereye aktığı.</summary>
    private enum DocStringSink
    {
        /// <summary>
        /// Bu yüzeyden OKUNAN değer ffmpeg komut satırına / filtergraph'ına GÖMÜLÜR — dizenin
        /// kendisi aynen gömülsün (<c>settings.backgroundColor</c> → <c>color=c=…</c>) ya da
        /// önce tipli bir değere çevrilsin (<c>fx.*</c> → sayı → <c>exposure=…</c>). Ayrım
        /// KAÇIŞ riskini değiştirir ama KAPI sorusunu değiştirmez: iki hâlde de Skia bu değeri
        /// HİÇ görmez, grafiğe giden şey buradan gelir, dolayısıyla "sessiz varsayılan"
        /// yasaktır ve dilbilgisi + senkron ret KANITLANIR.
        /// </summary>
        FfmpegGraph,

        /// <summary>Değer yalnız Skia raster hattına (PNG üretimi) gider.</summary>
        Raster,

        /// <summary>
        /// Union ayırt edicisi: tanınmayan değer JSON ayrıştırmada ölür, hiçbir render
        /// hattına ULAŞMAZ.
        /// </summary>
        Discriminator,

        /// <summary>Ne derleyici ne raster hattı bu alanı OKUR (editör metadatası).</summary>
        NotRendered,
    }

    /// <param name="Grammar">
    /// Dizenin dilbilgisini soran doğrulayıcı. <c>null</c> = dilbilgisi TAM: her dize
    /// geçerlidir, dolayısıyla reddedilecek bir değer YOKTUR (kanıt istenmez).
    /// </param>
    /// <param name="Feature">
    /// <paramref name="Grammar"/> varsa ihlalin beklenen 422 kodu; <c>null</c> ise ret
    /// KODSUZ (<c>InvalidTimelineException</c>) demektir.
    /// </param>
    private sealed record DocString(
        Type Owner,
        string Property,
        DocStringSink Sink,
        string Note,
        string? Grammar = null,
        string? Feature = null,
        Func<ExportGateInventoryTests, Task<Guid>>? Arrange = null);

    /// <summary>
    /// Şemadaki HER doküman dizesinin nereye aktığı ve onu neyin kapıya tuttuğu.
    /// <para>
    /// NEDEN EKLENDİ — <c>ExportGateInventoryTests</c>'in eski muhafızlarının tamamı
    /// FIRLATILAN istisnaları sayıyordu. <c>ExportCompiler.FfmpegColor</c> hiç fırlatmıyordu:
    /// ayrıştıramadığı her değeri sessizce <c>000000</c>'a düşürüyor, geçersiz değeri ise
    /// grafiğe aynen yazıyordu. Dolayısıyla "istisna sayan" hiçbir defter bu sınıfı
    /// GÖREMEZDİ. Ham API ile ölçülen sonuç: <c>settings.backgroundColor</c> = '#12345' /
    /// 'mavi' / '' → POST 202, iş BAŞARILI, arkaplan SESSİZCE SİYAH; '#GGGGGG' → POST 202,
    /// iş dakikalar sonra <c>ffmpeg exited with code -22</c>.
    /// </para>
    /// <para>
    /// TAMLIK REFLEKSİYONLADIR, kaçak yolu yoktur: <c>VideoEdit.Contracts.Timeline</c>
    /// altındaki her <c>string</c> özelliği (ve her serbest biçimli
    /// <c>Dictionary&lt;string, object&gt;</c> torbası) burada BİR satıra sahip olmalıdır.
    /// Şemaya yeni bir dize alanı eklenirse bu test KIRMIZI olur ve soru cevapsız kalamaz:
    /// bu değer ffmpeg dizesine mi gidiyor, ve onu ne kapıya tutuyor?
    /// </para>
    /// </summary>
    private static readonly DocString[] DocumentStrings =
    [
        new(typeof(ProjectSettings), nameof(ProjectSettings.BackgroundColor),
            DocStringSink.FfmpegGraph,
            "Taban tuvalin rengi: 'color=c=…' ve 'pad=…:color=…' argümanlarına GÖMÜLÜR. "
            + "Dilbilgisi klip renkleriyle AYNI kaynaktan sorulur; FfmpegColor'ın eski sessiz "
            + "varsayılanı kaldırıldı, artık aynı kodla fırlatıyor.",
            Grammar: "HexColor.TryParse", Feature: "project-background-color",
            Arrange: t => t.SeedAsync(ExportTestDocs.Doc(
                backgroundColor: "#GGGGGG",
                clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000)))),

        new(typeof(TextClipText), nameof(TextClipText.Fill), DocStringSink.Raster,
            "Metin dolgusu Skia'ya gider, ffmpeg'e DEĞİL — raster PNG'si üzerinden çizilir. "
            + "Senkron kapısı EnsureRasterContract'tadır.",
            Grammar: "HexColor.TryParse", Feature: "overlay-unsupported-clip",
            Arrange: t =>
            {
                var clip = ExportTestDocs.TextClip(0, 1_000_000);
                clip.Text!.Fill = "rgb(1,2,3)";
                return t.SeedAsync(ExportTestDocs.Doc(clips: clip));
            }),

        new(typeof(Stroke), nameof(Stroke.Color), DocStringSink.Raster,
            "Metin konturu rengi — yalnız widthPx > 0 iken OKUNUR (kapı raster hattının "
            + "koşulunun aynadaki eşidir; daha genişi yanlış 422 üretirdi).",
            Grammar: "HexColor.TryParse", Feature: "overlay-unsupported-clip",
            Arrange: t =>
            {
                var clip = ExportTestDocs.TextClip(0, 1_000_000);
                clip.Text!.Stroke = new Stroke { Color = "beyaz", WidthPx = 2 };
                return t.SeedAsync(ExportTestDocs.Doc(clips: clip));
            }),

        new(typeof(Background), nameof(Background.Color), DocStringSink.Raster,
            "Metin klibinin KENDİ arka planı (proje arkaplanı DEĞİL — ayrı alan). Raster "
            + "hattında çizilir; kapısı EnsureRasterContract'tadır.",
            Grammar: "HexColor.TryParse", Feature: "overlay-unsupported-clip",
            Arrange: t =>
            {
                var clip = ExportTestDocs.TextClip(0, 1_000_000);
                clip.Text!.Background = new Background
                {
                    Color = "#GGG", PaddingPx = 4, RadiusPx = 0,
                };
                return t.SeedAsync(ExportTestDocs.Doc(clips: clip));
            }),

        new(typeof(ShapeClipShape), nameof(ShapeClipShape.Fill), DocStringSink.Raster,
            "Şekil dolgusu Skia'ya gider, ffmpeg'e DEĞİL. Senkron kapısı "
            + "EnsureRasterContract'tadır.",
            Grammar: "HexColor.TryParse", Feature: "overlay-unsupported-clip",
            Arrange: t =>
            {
                var clip = ExportTestDocs.ShapeClip(0, 1_000_000);
                clip.Shape!.Fill = "#00000000ff";
                return t.SeedAsync(ExportTestDocs.Doc(clips: clip));
            }),

        new(typeof(Stroke2), nameof(Stroke2.Color), DocStringSink.Raster,
            "Şekil konturu rengi — metin konturuyla aynı kural, yalnız widthPx > 0 iken "
            + "OKUNUR. (Stroke2 adı NJsonSchema'nın ürettiği ikinci Stroke tipidir.)",
            Grammar: "HexColor.TryParse", Feature: "overlay-unsupported-clip",
            Arrange: t =>
            {
                var clip = ExportTestDocs.ShapeClip(0, 1_000_000);
                clip.Shape!.Stroke = new Stroke2 { Color = "", WidthPx = 3 };
                return t.SeedAsync(ExportTestDocs.Doc(clips: clip));
            }),

        new(typeof(TextClipText), nameof(TextClipText.FontId), DocStringSink.Raster,
            "Font kimliği ffmpeg'e GİRMEZ: manifestten bir TTF yoluna çevrilir ve Skia'ya "
            + "verilir. Manifestte olmayan kimlik senkron 422'dir; kapı API'nin manifest ön "
            + "kontrolüdür (derleyicideki ikizi 503'e kaymayı engeller).",
            Grammar: "FontCatalogue.UnknownFontIds", Feature: "font-missing",
            Arrange: t =>
            {
                var clip = ExportTestDocs.TextClip(0, 1_000_000);
                clip.Text!.FontId = "boyle-bir-font-yok";
                return t.SeedAsync(ExportTestDocs.Doc(clips: clip));
            }),

        new(typeof(TextClipText), nameof(TextClipText.Content), DocStringSink.Raster,
            "Kullanıcının yazdığı metnin KENDİSİ. Dilbilgisi TAMDIR: her dize geçerli bir "
            + "içeriktir, reddedilecek değer yoktur. ffmpeg'e girmez — Skia PNG'sine çizilir, "
            + "dolayısıyla filtergraph kaçışı sorunu da doğmaz (şema uzunluğu sınırlar)."),

        new(typeof(Marker), nameof(Marker.Color), DocStringSink.NotRendered,
            "İşaretçiler EDİTÖR metadatasıdır: ne ExportCompiler ne raster hattı doc.Markers'ı "
            + "OKUR (kaynak taramasıyla doğrulanır). Bu yüzden geçersiz bir işaretçi rengi "
            + "export'u ne bozar ne de reddettirir — kapı EKLEMEK yanlış 422 olurdu."),

        new(typeof(Marker), nameof(Marker.Label), DocStringSink.NotRendered,
            "İşaretçi etiketi — yine yalnız editör metadatası; render hattına hiç ulaşmaz. "
            + "Dilbilgisi de TAMDIR (şema uzunluk dışında kısıt koymaz)."),

        new(typeof(Track), nameof(Track.Name), DocStringSink.NotRendered,
            "Track adı yalnız editör listesinde görünür; derleyici track'ten yalnız "
            + "type/muted/hidden/clips okur. Render çıktısına HİÇ girmez."),

        new(typeof(TextClip), nameof(TextClip.Kind), DocStringSink.Discriminator,
            "Klip union'ının ayırt edicisi. Tanınmayan bir 'kind' TimelineJson'ın union "
            + "okuyucusunda JsonException'a düşer — belge derleyiciye HİÇ ulaşmaz "
            + "(CompilerGates'teki 'unknown-clip' satırı bunu koşturarak kanıtlar)."),

        new(typeof(ShapeClip), nameof(ShapeClip.Kind), DocStringSink.Discriminator,
            "Klip union'ının ayırt edicisi — TextClip.Kind ile aynı gerekçe: tanınmayan değer "
            + "JSON ayrıştırmada ölür, hiçbir render hattına ulaşmaz."),

        new(typeof(StickerClip), nameof(StickerClip.Kind), DocStringSink.Discriminator,
            "Klip union'ının ayırt edicisi — TextClip.Kind ile aynı gerekçe: tanınmayan değer "
            + "JSON ayrıştırmada ölür, hiçbir render hattına ulaşmaz."),

        new(typeof(EasingLinear), nameof(EasingLinear.Type), DocStringSink.Discriminator,
            "Easing union'ının ayırt edicisi. Tanınmayan 'type' JSON okuyucusunda ölür; "
            + "tanınan ama derleyicide karşılığı olmayan bir dal 'easing-type' koduyla "
            + "reddedilir (CompilerGates'te satırı vardır)."),

        new(typeof(EasingEaseIn), nameof(EasingEaseIn.Type), DocStringSink.Discriminator,
            "Easing union'ının ayırt edicisi — EasingLinear.Type ile aynı gerekçe."),

        new(typeof(EasingEaseOut), nameof(EasingEaseOut.Type), DocStringSink.Discriminator,
            "Easing union'ının ayırt edicisi — EasingLinear.Type ile aynı gerekçe."),

        new(typeof(EasingEaseInOut), nameof(EasingEaseInOut.Type), DocStringSink.Discriminator,
            "Easing union'ının ayırt edicisi — EasingLinear.Type ile aynı gerekçe."),

        new(typeof(EasingCubicBezier), nameof(EasingCubicBezier.Type), DocStringSink.Discriminator,
            "Easing union'ının ayırt edicisi — EasingLinear.Type ile aynı gerekçe."),

        new(typeof(EffectParams), DictionaryBagProperty, DocStringSink.FfmpegGraph,
            "SERBEST BİÇİMLİ TORBA (Dictionary<string, object>) — şemadaki tek yapısız doküman "
            + "yüzeyi, o yüzden defterde ayrı bir satırı var. ETİKET DÜZELTİLDİ (10. tur, F3): "
            + "satır eskiden Raster yazıyordu, oysa Skia bu torbayı HİÇ görmez — okunan değerler "
            + "FİLTERGRAPH'a girer (ColorPipeline.ColorAdjustFilters → exposure=/lutrgb=/"
            + "colorchannelmixer=, Lut3dFilter/LutBlendFilter → lut3d=file=…/blend=all_expr=…). "
            + "Yanlış etiket satırı EveryStringThatReachesTheFfmpegGraphIsGatedAndProven'in "
            + "dışında bırakıyordu, yani muhafız kapattığını iddia ettiği sınıfın bir üyesini "
            + "atlıyordu. "
            + "DİZE GÖMÜLMEZ, DEĞER GÖMÜLÜR: colorAdjust parametreleri RequireNumber ile "
            + "double'a, lut'un assetId'si Guid'e çevrilir; grafiğe giren sayılar Num() ile "
            + "InvariantCulture yazılır. lut3d'ye giren .cube YOLU da doküman dizesi DEĞİLDİR: "
            + "worker LRU cache'inin indirdiği yerel yoldur (ExportJob → cache.GetOrDownloadAsync "
            + "→ sources[assetId].Path → LayerSegment.LutPath), belge yalnız Guid'i taşır. "
            + "Torbadan grafiğe uzanan yolda ham doküman dizesi YOKTUR. "
            + "KAPI: torbanın TÜM ihlal yüzeyi (tanınmayan anahtar, sayı olmayan değer, aralık "
            + "dışı değer, bozuk/eksik assetId, aralık dışı intensity) EffectParamViolations "
            + "defterinde tek tek KOŞTURULARAK senkron 422 + iş satırı oluşmaması ile kanıtlanır; "
            + "aşağıdaki Arrange onlardan biridir.",
            Grammar: "ClipEffects.ParseColorAdjust/ParseLut",
            Arrange: t =>
            {
                var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
                var effect = ExportTestDocs.ColorAdjust();
                effect.Params["parlaklik"] = 0.5;   // şemada olmayan anahtar
                clip.Effects = [effect];
                return t.SeedAsync(ExportTestDocs.Doc(clips: clip));
            }),
    ];

    /// <summary>Serbest biçimli sözlük torbasının defterdeki özellik adı.</summary>
    private const string DictionaryBagProperty = "*";

    // ───────── EFEKT PARAMETRE TORBASININ İHLAL YÜZEYİ (10. tur, F3) ─────────

    /// <summary>
    /// <c>Effect.params</c> torbasının kapıya takılan TÜM ihlal biçimleri.
    /// <para>
    /// NEDEN AYRI DEFTER: <see cref="DocumentStrings"/> alan başına TEK kanıt taşır, ama
    /// <c>EffectParams</c> bir ALAN değil YAPISIZ BİR TORBADIR — "bir anahtar reddediliyor"
    /// ölçümü torbanın kapalı olduğunu göstermez. Bu defter torbanın yüzeyini biçim biçim
    /// koşturur: tanınmayan anahtar, sayı olmayan değer, aralık dışı değer, eksik/bozuk/boş
    /// <c>assetId</c>, aralık dışı <c>intensity</c>.
    /// </para>
    /// <para>
    /// KAPSAM DIŞI: torbanın kendi ANAHTARLARININ ffmpeg'e kaçması. Kaçamazlar — <c>lut3d</c>
    /// ve renk filtreleri anahtar adını grafiğe HİÇ yazmaz, yalnız tanınan anahtarların
    /// DEĞERLERİ sayıya çevrilip yazılır; tanınmayan anahtar ise zaten burada reddedilir.
    /// </para>
    /// <para>
    /// KAPSAM DIŞI (2): SONLU OLMAYAN sayı (NaN / ±∞). Defterde satırı YOKTUR çünkü BELGEYLE
    /// İFADE EDİLEMEZ — JSON'da böyle bir literal yoktur; ölçümü
    /// <see cref="NonFiniteEffectParamCannotBeExpressedInJson"/>'dedir. <c>RequireNumber</c>'daki
    /// <c>double.IsFinite</c> dalı süreç-içi çağrılara karşı savunma dalıdır.
    /// </para>
    /// </summary>
    /// <param name="Label">Ölçüm çıktısında ihlali adlandıran etiket.</param>
    /// <param name="Feature">Beklenen 422 kodu; <c>null</c> ise ret KODSUZ.</param>
    /// <param name="Arrange">İhlali taşıyan belgeyi kuran tohumlayıcı.</param>
    private sealed record EffectParamViolation(
        string Label, string? Feature, Func<ExportGateInventoryTests, Task<Guid>> Arrange);

    private static readonly EffectParamViolation[] EffectParamViolations =
    [
        new("colorAdjust: tanınmayan anahtar", null,
            t => t.SeedEffectAsync(Bag(EffectType.ColorAdjust, ("parlaklik", 0.5)))),

        new("colorAdjust: değer sayı değil", null,
            t => t.SeedEffectAsync(Bag(EffectType.ColorAdjust, ("exposure", "cok")))),

        new("colorAdjust: sayı gibi görünen DİZE", null,
            t => t.SeedEffectAsync(Bag(EffectType.ColorAdjust, ("contrast", "0.5")))),

        new("colorAdjust: aralık dışı ([-1..1])", null,
            t => t.SeedEffectAsync(Bag(EffectType.ColorAdjust, ("exposure", 5d)))),

        new("lut: assetId yok", "lut-asset",
            t => t.SeedEffectAsync(Bag(EffectType.Lut, ("intensity", 1d)))),

        new("lut: assetId Guid değil", null,
            t => t.SeedEffectAsync(Bag(EffectType.Lut, ("assetId", "bu-guid-degil"), ("intensity", 1d)))),

        new("lut: assetId boş Guid", null,
            t => t.SeedEffectAsync(Bag(
                EffectType.Lut, ("assetId", Guid.Empty.ToString()), ("intensity", 1d)))),

        new("lut: intensity sayı değil", null,
            t => t.SeedEffectAsync(Bag(
                EffectType.Lut, ("assetId", ExportTestDocs.AssetC.ToString()), ("intensity", "yarim")))),

        new("lut: intensity aralık dışı ([0..1])", null,
            t => t.SeedEffectAsync(Bag(
                EffectType.Lut, ("assetId", ExportTestDocs.AssetC.ToString()), ("intensity", 5d)))),
    ];

    /// <summary>Serbest torbayı ham anahtar/değer çiftlerinden kurar (şema kısıtı YOK).</summary>
    private static Effect Bag(EffectType type, params (string Key, object Value)[] entries)
    {
        var effect = new Effect { Id = Guid.CreateVersion7(), Type = type, Enabled = true };
        foreach (var (key, value) in entries)
        {
            effect.Params[key] = value;
        }

        return effect;
    }

    /// <summary>Verilen efektleri TEK bir video klibine takıp belgeyi tohumlar.</summary>
    private Task<Guid> SeedEffectAsync(params Effect[] effects)
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Effects = [.. effects];
        return SeedAsync(ExportTestDocs.Doc(clips: clip));
    }

    // ───────── KAYNAK TAVANLARININ İKİ YANI (10. tur, F1 ve F2) ─────────

    /// <summary>
    /// <c>settings.fps</c> kabul penceresinin iki yanı.
    /// <para>
    /// NEDEN İKİ YAN: bir tavan yalnız "kötü belgeyi kesiyor mu" ile ölçülemez — asıl risk
    /// YANLIŞ RET'tir. Bu defter pencerenin İÇİNİ hız hız koşturur (yayın hızlarının tamamı +
    /// tüketici yüksek-kare-hızı) ve her birinin GERÇEKTEN kuyruğa girdiğini ölçer; dışını da
    /// aynı koşuda 422 + iş satırı oluşmaması ile ölçer.
    /// </para>
    /// <para>
    /// <c>ClipDurationUs</c> keyfi değildir: klip kenarları PROJE FRAME IZGARASINA oturmak
    /// zorundadır (§1.4), o yüzden NTSC hızlarında (n/1001) 1.001.000 µs, tam sayı hızlarında
    /// 1.000.000 µs kullanılır — ikisi de tam kare sayısı verir.
    /// </para>
    /// </summary>
    private sealed record FpsCase(long Num, long Den, long ClipDurationUs, bool Accepted, string Label);

    private static readonly FpsCase[] FpsWindowBoundaries =
    [
        // ── PENCERENİN İÇİ: yayın hızlarının tamamı + tüketici yüksek-kare-hızı ──
        new(24000, 1001, 1_001_000, true, "23.976 (24000/1001)"),
        new(24, 1, 1_000_000, true, "24"),
        new(25, 1, 1_000_000, true, "25 (PAL)"),
        new(30000, 1001, 1_001_000, true, "29.97 (30000/1001)"),
        new(30, 1, 1_000_000, true, "30 (editörün sabitlediği hız)"),
        new(50, 1, 1_000_000, true, "50"),
        new(60000, 1001, 1_001_000, true, "59.94 (60000/1001)"),
        new(60, 1, 1_000_000, true, "60"),
        new(120, 1, 1_000_000, true, "120 (yüksek kare hızı)"),
        new(240, 1, 1_000_000, true, "240 — TAM TAVAN"),
        new(1, 1, 1_000_000, true, "1 — TAM TABAN"),

        // ── PENCERENİN DIŞI ──
        new(241, 1, 1_000_000, false, "241 — tavanın 1 fps ötesi"),
        new(100_000, 1, 1_000_000, false, "100000 — ölçülen kaçak"),
        new(1, 2, 2_000_000, false, "0.5 (1/2) — tabanın altı"),
        new(999, 1000, 1_000_000, false, "0.999 (999/1000) — tabanın hemen altı"),
    ];

    /// <summary>
    /// Toplam süre tavanının iki yanı: tavanın TAM üstünde bir belge kuyruğa girer, bir kare
    /// ötesi 422 olur. Kenar tam sayı olduğu için ölçüm keskin — "yaklaşık" bir sınır değil.
    /// </summary>
    private static readonly (long TotalDurationUs, bool Accepted, string Label)[] DurationCeilingBoundaries =
    [
        (ExportCompiler.MaxTimelineDurationUs, true, "tam TAVAN (4 saat)"),
        (ExportCompiler.MaxTimelineDurationUs + 33_333, false, "tavanın 1 karesi ötesi"),
        (100_000_000_000_000L, false, "~3,17 yıl — ölçülen kaçak"),
    ];

    /// <summary>
    /// Fırlatma SAYILARI. Kodsuz <c>InvalidTimelineException</c>'ın kimliği yoktur; sayı
    /// sabitlemek "yeni fırlatma eklendi ama defter güncellenmedi" halini kırmızıya çevirir.
    /// </summary>
    private static readonly (string RepoPath, int Unsupported, int Invalid)[] ThrowSiteCounts =
    [
        // 20 → 22: 'asset-failed' ve 'asset-clip-type' (M6 denetimi, N1-N3). İkisi de SAF DB
        // aritmetiğidir (Asset.Status / Asset.Kind), ikisi de Validate'te yaşar ve ikisinin de
        // CompilerGates defterinde SyncGate satırı vardır.
        // 22 → 24: 'project-background-color' İKİ noktadan fırlar — Validate'teki kapı ve
        // FfmpegColor'ın sözleşme muhafızı (eskiden sessizce '000000'a düşen dal).
        // 24 → 26: 'project-fps-out-of-range' ve 'timeline-too-long' (10. tur, F2 ve F1). İkisi
        // de SAF DOKÜMAN aritmetiğidir ve ikisinin de CompilerGates'te SyncGate satırı vardır.
        ("backend/src/VideoEdit.Media/Export/ExportCompiler.cs", 26, 33),
        // 7 → 8 (13. tur, C1): keyframe timeUs üst sınırı — zod'un "outside [0,
        // timelineDurationUs]" invaryantının C# eşi. Saf doküman aritmetiğidir, Validate'te
        // (KeyframeCompiler.Parse → Track) yaşar; HTTP karşılığı ExportEndpointsTests'te,
        // zod paritesi KeyframeBoundsParityTests'te (paylaşılan vektör dosyasıyla) ölçülür.
        ("backend/src/VideoEdit.Media/Export/ClipAnimation.cs", 1, 8),
        ("backend/src/VideoEdit.Media/Export/ClipEffects.cs", 2, 7),
    ];

    // ───────────────────────────── TESTLER ─────────────────────────────

    [Fact]
    public void EveryCompilerFeatureCodeHasAnInventoryRow()
    {
        var declared = CompilerGates.Select(g => g.Code).ToHashSet(StringComparer.Ordinal);
        Assert.Equal(CompilerGates.Length, declared.Count); // defterde tekrar yok

        var found = new HashSet<string>(StringComparer.Ordinal);
        foreach (var file in ExportSourceFiles())
        {
            foreach (Match m in Regex.Matches(
                File.ReadAllText(file), @"new UnsupportedFeatureException\(\s*""([^""]+)"""))
            {
                found.Add(m.Groups[1].Value);
            }
        }

        Assert.NotEmpty(found);
        var missing = found.Except(declared).Order(StringComparer.Ordinal).ToList();
        Assert.True(missing.Count == 0,
            "Kaynakta DEFTERDE OLMAYAN özellik kodu var: " + string.Join(", ", missing)
            + ". ExportGateInventoryTests.CompilerGates'e satır ekleyin: kural senkron kapıdan "
            + "ulaşılabilir mi (SyncGate + belge kurucusu), yoksa neden değil (yazılı gerekçe)?");

        var stale = declared.Except(found).Order(StringComparer.Ordinal).ToList();
        Assert.True(stale.Count == 0,
            "Defterde artık kaynakta OLMAYAN kod var: " + string.Join(", ", stale));
    }

    [Fact]
    public void EveryWorkerFailureReasonHasAnInventoryRow()
    {
        var source = File.ReadAllText(
            TestVectorFiles.Resolve("backend/src/VideoEdit.Worker/Jobs/ExportJob.cs"));
        var declared = WorkerFailures.Select(w => w.Reason).ToHashSet(StringComparer.Ordinal);

        var literal = Regex.Matches(source, @"FailAsync\(job,\s*""([^""]+)""")
            .Select(m => m.Groups[1].Value)
            .ToHashSet(StringComparer.Ordinal);

        // RENDER DALI LİTERAL DEĞİLDİR: üç gerekçesi tek bir switch ifadesinden çıkıp
        // FailAsync'e DEĞİŞKEN olarak geçer, yani yukarıdaki literal taraması onları GÖREMEZ.
        // Blok ayrıca taranır; sınır deseni bayatlarsa Between KIRMIZI verir, yani muhafız
        // sessizce kapsam kaybedemez.
        literal.UnionWith(QuotedStrings(Between(source, "var (code, message) = result switch", "};")));

        var missing = literal.Except(declared).Order(StringComparer.Ordinal).ToList();
        Assert.True(missing.Count == 0,
            "Worker'da DEFTERDE OLMAYAN başarısızlık gerekçesi var: " + string.Join(", ", missing));

        // Dinamik gerekçeler (ex.Feature / ex.Code / ffmpeg) '*' ile defterdedir; toplam
        // FailAsync sayısını sabitlemek yeni bir dalın sessizce eklenmesini engeller.
        Assert.Equal(22, Regex.Matches(source, @"FailAsync\(job,").Count);
    }

    [Fact]
    public void ThrowSiteCountsAreUnchanged()
    {
        foreach (var (repoPath, unsupported, invalid) in ThrowSiteCounts)
        {
            var source = File.ReadAllText(TestVectorFiles.Resolve(repoPath));
            var actualUnsupported = Regex.Matches(source, @"new UnsupportedFeatureException\(").Count;
            var actualInvalid = Regex.Matches(source, @"new InvalidTimelineException\(").Count;
            Assert.True(
                actualUnsupported == unsupported && actualInvalid == invalid,
                $"{repoPath}: fırlatma sayısı değişti "
                + $"(UnsupportedFeature {unsupported} → {actualUnsupported}, "
                + $"InvalidTimeline {invalid} → {actualInvalid}).\n"
                + "BU TEST KASITLI OLARAK KIRMIZI: yeni bir ExportCompileException fırlatma "
                + "noktası eklediyseniz önce şu soruyu yanıtlayın — kural saf doküman ya da saf "
                + "DB aritmetiğiyle karar verilebiliyor mu? Evetse Validate'te yaşamalı ve "
                + "CompilerGates defterine SyncGate satırı (+ belge kurucusu) eklenmeli; hayırsa "
                + "gerekçesi YAZILI olmalı. Sonra buradaki sayıyı güncelleyin.\n"
                + "Tip adını gizlemeyin: hedef-tipli `new(...)` bu taramadan KAÇAR — fabrika "
                + "metotlarında bile `new UnsupportedFeatureException(...)` yazın.");
        }

        // Taranan dosya kümesi de sabitlenir: Export/ altına yeni bir dosya eklenip içine
        // fırlatma konulursa defter güncellenmeden geçemez.
        var scanned = ExportSourceFiles()
            .Where(f => File.ReadAllText(f).Contains("ExportCompileException", StringComparison.Ordinal)
                        || Regex.IsMatch(File.ReadAllText(f), @"new (Unsupported|Invalid)\w*Exception\("))
            .Select(Path.GetFileName)
            .Order(StringComparer.Ordinal)
            .ToList();
        Assert.Equal(
            new[] { "ClipAnimation.cs", "ClipEffects.cs", "ExportCompiler.cs", "ExportExceptions.cs" },
            scanned);
    }

    [Fact]
    public async Task EverySyncGateRowIsActuallyReachableFromTheEndpoint()
    {
        // KAÇAK YOLU YOK: "senkron kapıdan ulaşılabilir" satırların HEPSİ burada koşar.
        foreach (var gate in CompilerGates.Where(g => g.Owner == GateOwner.SyncGate))
        {
            Assert.True(gate.Arrange is not null, $"{gate.Code}: SyncGate satırı belge kurucusu ister.");
            using var scope = new ExportGateInventoryTests();
            var projectId = await gate.Arrange!(scope);

            var problem = Assert.IsType<ProblemHttpResult>(
                await scope.CallStartAsync(projectId, gate.Measurer?.Invoke()));
            Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
            Assert.Equal(gate.Code, problem.ProblemDetails.Extensions["feature"]);
            Assert.Empty(scope._db.Jobs.ToList());   // iş satırı OLUŞMADI
            Assert.Equal(0, scope._jobs.CreateCount); // kuyruğa çöp atılmadı
        }
    }

    [Fact]
    public async Task EveryUnreachableRowDiesBeforeTheCompiler()
    {
        // "Ulaşılamaz" bir iddia değil ÖLÇÜMDÜR: belge derleyiciye gelmeden JSON ayrıştırmada
        // ölür, dolayısıyla 422 gövdesinde 'feature' kodu HİÇ bulunmaz.
        foreach (var gate in CompilerGates.Where(g => g.Owner == GateOwner.Unreachable))
        {
            Assert.True(gate.Arrange is not null, $"{gate.Code}: Unreachable satırı kanıt ister.");
            using var scope = new ExportGateInventoryTests();
            var projectId = await gate.Arrange!(scope);

            var problem = Assert.IsType<ProblemHttpResult>(await scope.CallStartAsync(projectId));
            Assert.Equal(StatusCodes.Status422UnprocessableEntity, problem.StatusCode);
            Assert.False(problem.ProblemDetails.Extensions.ContainsKey("feature"),
                $"{gate.Code}: derleyici dalına ULAŞILDI — satır artık SyncGate olmalı.");
            Assert.Empty(scope._db.Jobs.ToList());
        }
    }

    [Fact]
    public void EveryAssetStatusHasAnOwnerRow()
    {
        // TAMLIK: durum enum'ı REFLEKSİYONLA taranır. Yeni bir AssetStatus eklenip defter
        // güncellenmezse test KIRMIZI olur — "gerekçe hangi durumları kapsıyor" sorusu bir
        // daha cevapsız kalamaz.
        var declared = AssetStatusOwners.Select(r => r.Status).ToHashSet();
        Assert.Equal(AssetStatusOwners.Length, declared.Count);
        var missing = Enum.GetValues<AssetStatus>().Except(declared).ToList();
        Assert.True(missing.Count == 0,
            "Defterde satırı OLMAYAN asset durumu var: " + string.Join(", ", missing)
            + ". Bu durumdaki bir varlığa atıf yapan belge ne olmalı — senkron 422 mı "
            + "(durum TERMİNAL ise), yoksa worker'a mı bırakılmalı (GEÇİCİ ise)?");

        foreach (var row in AssetStatusOwners)
        {
            Assert.True(row.Note.Length >= 40, $"{row.Status}: gerekçe yazılmamış.");
            Assert.Equal(row.Owner == StateOwner.SyncGate, row.Feature is not null);
        }
    }

    [Fact]
    public async Task EveryAssetStatusBehavesAsItsRowClaims()
    {
        // KAÇAK YOLU YOK: her durum için AYNI belge kurulur, yalnız Asset.Status değişir ve
        // uç nokta GERÇEKTEN çağrılır. SyncGate satırı 422 + kod + iş satırı OLMAMASI ister;
        // WorkerOnly/NotAFailure satırı 202 + iş satırı OLUŞMASI ister (yani "geçici durum
        // sessizce reddedilmiyor" da ölçülür).
        foreach (var row in AssetStatusOwners)
        {
            using var scope = new ExportGateInventoryTests();
            await scope.SeedAssetAsync(ExportTestDocs.AssetA, status: row.Status);
            var projectId = await scope.SeedAsync(
                ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(
                    ExportTestDocs.AssetA, 0, 0, 1_000_000)),
                seedAssets: false);

            var result = await scope.CallStartAsync(projectId);
            if (row.Owner == StateOwner.SyncGate)
            {
                var problem = Assert.IsType<ProblemHttpResult>(result);
                Assert.Equal(
                    (row.Status, StatusCodes.Status422UnprocessableEntity),
                    (row.Status, problem.StatusCode));
                Assert.Equal(
                    (row.Status, (object?)row.Feature),
                    (row.Status, problem.ProblemDetails.Extensions["feature"]));
                Assert.Empty(scope._db.Jobs.ToList());
                Assert.Equal(0, scope._jobs.CreateCount);
            }
            else
            {
                Assert.IsType<Accepted<ExportJobCreatedResponse>>(result);
                Assert.Single(scope._db.Jobs.ToList());
            }
        }
    }

    [Fact]
    public async Task TheWholeClipKindAssetKindMatrixBehavesAsTheLedgerClaims()
    {
        // 13 satırın HEPSİ koşar: kabul edilenler 202 + iş satırı, reddedilenler 422 +
        // 'asset-clip-type' + iş satırı YOK. Matrisin kendisi belgede DEĞİL, burada yaşar —
        // yeni bir klip/varlık türü eklenirse satır eklemek ZORUNLUDUR (aşağıdaki tamlık
        // kontrolü her kombinasyonu sayar).
        Assert.Equal(
            Enum.GetValues<MediaClipKindOrSticker>().Length * Enum.GetValues<AssetKind>().Length,
            AssetClipTypeMatrix.DistinctBy(c => (c.ClipKind, c.AssetKind)).Count());

        foreach (var testCase in AssetClipTypeMatrix)
        {
            using var scope = new ExportGateInventoryTests();
            await scope.SeedAssetAsync(
                ExportTestDocs.AssetB,
                width: testCase.AssetKind == AssetKind.Audio ? null : 1920,
                height: testCase.AssetKind == AssetKind.Audio ? null : 1080,
                durationMicros: testCase.AssetKind == AssetKind.Image ? null : 3_600_000_000,
                kind: testCase.AssetKind,
                hasAudio: testCase.AssetHasAudio);
            var projectId = await scope.SeedAsync(MatrixDoc(testCase.ClipKind), seedAssets: false);

            var result = await scope.CallStartAsync(projectId);
            if (testCase.Expected is null)
            {
                Assert.IsType<Accepted<ExportJobCreatedResponse>>(result);
                Assert.Single(scope._db.Jobs.ToList());
                continue;
            }

            var problem = Assert.IsType<ProblemHttpResult>(result);
            Assert.Equal(
                (testCase.Name, StatusCodes.Status422UnprocessableEntity),
                (testCase.Name, problem.StatusCode));
            Assert.Equal(
                (testCase.Name, (object?)testCase.Expected),
                (testCase.Name, problem.ProblemDetails.Extensions["feature"]));
            Assert.Empty(scope._db.Jobs.ToList());
            Assert.Equal(0, scope._jobs.CreateCount);
        }
    }

    /// <summary>
    /// SENKRON KAPININ DAYANDIĞI DIŞ SÖZLEŞME: "Ready bir varlığın Kind'i akışlarıyla
    /// TUTARLIDIR". Tür kapısı GEÇİCİ durumda da beyana bakar ve bunun yanlış ret üretmemesi
    /// tamamen buna bağlıdır — beyanla dosya çelişirse asset Ready ÇIKAMAZ, dolayısıyla o
    /// belgenin başarıya giden yolu zaten yoktur. Sözleşme başka bir dosyada (worker) yaşadığı
    /// için burada AÇIKÇA sabitlenir.
    /// </summary>
    [Fact]
    public void ReadyAssetKindImpliesItsStreams()
    {
        Assert.False(ProcessAssetJob.GateByKind(
            AssetKind.Video, Probe(hasVideo: false, hasAudio: true, durationUs: 5_000_000), out _, out _));
        Assert.False(ProcessAssetJob.GateByKind(
            AssetKind.Audio, Probe(hasVideo: true, hasAudio: false, durationUs: 5_000_000), out _, out _));
        Assert.False(ProcessAssetJob.GateByKind(
            AssetKind.Image, Probe(hasVideo: false, hasAudio: false, durationUs: null), out _, out _));

        // Görsel: ne sesi ne zaman ekseni olabilir — export'un durağan-giriş kapısı bunu varsayar.
        Assert.False(ProcessAssetJob.GateByKind(
            AssetKind.Image, Probe(hasVideo: true, hasAudio: true, durationUs: null), out _, out _));
        Assert.False(ProcessAssetJob.GateByKind(
            AssetKind.Image,
            Probe(hasVideo: true, hasAudio: false,
                durationUs: ExportAssetUse.StillSourceMaxDurationUs + 1), out _, out _));

        // Kontrol grubu: tutarlı üçlü GEÇER.
        Assert.True(ProcessAssetJob.GateByKind(
            AssetKind.Video, Probe(hasVideo: true, hasAudio: true, durationUs: 5_000_000), out _, out _));
        Assert.True(ProcessAssetJob.GateByKind(
            AssetKind.Audio, Probe(hasVideo: false, hasAudio: true, durationUs: 5_000_000), out _, out _));
        Assert.True(ProcessAssetJob.GateByKind(
            AssetKind.Image, Probe(hasVideo: true, hasAudio: false, durationUs: null), out _, out _));
    }

    private static MediaProbe Probe(bool hasVideo, bool hasAudio, long? durationUs) => new()
    {
        RawJson = "{}",
        HasVideo = hasVideo,
        HasAudio = hasAudio,
        DurationUs = durationUs,
    };

    /// <summary>Matris satırının belgesi: tek klip, AssetB'yi gösterir.</summary>
    private static TimelineDoc MatrixDoc(MediaClipKindOrSticker clipKind) => clipKind switch
    {
        MediaClipKindOrSticker.Video => ExportTestDocs.Doc(
            clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 0, 0, 1_000_000)),
        MediaClipKindOrSticker.Image => ExportTestDocs.Doc(
            clips: ExportTestDocs.ImageClip(ExportTestDocs.AssetB, 0, 1_000_000)),
        MediaClipKindOrSticker.Sticker => ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.OverlayTrack(clips:
                [ExportTestDocs.StickerClip(ExportTestDocs.AssetB, 0, 1_000_000)]),
        ]),
        _ => ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.AudioTrack(clips:
                [ExportTestDocs.AudioClip(ExportTestDocs.AssetB, 0, 0, 1_000_000)]),
        ]),
    };

    [Fact]
    public void TheClientAndServerAgreeOnWhichCodesMeanAnAssetProblem()
    {
        // İKİ DEFTER, TEK ANLAM: sunucu 422'nin BAŞLIĞINI, istemci de KULLANICIYA KURULAN
        // CÜMLEYİ bu listeden seçiyor. Ayrışma çökme üretmez — YANLIŞ CÜMLE üretir:
        // kullanıcı kendi kütüphanesindeki bir dosyayı düzeltmesi gerekirken "desteklenmeyen
        // özellik" arar. İki kaynak da TARANIR ve eşitlik ölçülür.
        var server = QuotedStrings(Between(
            File.ReadAllText(TestVectorFiles.Resolve(
                "backend/src/VideoEdit.Api/Endpoints/ExportEndpoints.cs")),
            "AssetFactFeatures", "};"));
        var client = QuotedStrings(Between(
            File.ReadAllText(TestVectorFiles.Resolve(
                "apps/editor/src/features/export/exportLogic.ts")),
            "const ASSET_FACT_CODES = new Set([", "]);"));

        Assert.NotEmpty(server);
        Assert.Equal(server, client);

        // Ve o kodların HEPSİ derleyicide gerçekten VAR (defterde satırı olan bir kod).
        var declared = CompilerGates.Select(g => g.Code).ToHashSet(StringComparer.Ordinal);
        Assert.Empty(server.Except(declared));
    }

    [Fact]
    public void TheClientAndServerAgreeOnWhichCodesMeanAResourceCeiling()
    {
        // AYNI DOKTRİN, İKİNCİ SINIF (10. tur, F1/F2): kaynak tavanı bir "desteklenmeyen
        // özellik" DEĞİLDİR. Belge geçerli, özellik destekli — proje yalnız pencerenin
        // dışında. Ayrışma çökme değil YANLIŞ CÜMLE üretir, o yüzden iki kaynak TARANIR.
        var server = QuotedStrings(Between(
            File.ReadAllText(TestVectorFiles.Resolve(
                "backend/src/VideoEdit.Api/Endpoints/ExportEndpoints.cs")),
            "CeilingFeatures = new(StringComparer.Ordinal)", "};"));
        var client = QuotedStrings(Between(
            File.ReadAllText(TestVectorFiles.Resolve(
                "apps/editor/src/features/export/exportLogic.ts")),
            "const CEILING_CODES = new Set([", "]);"));

        Assert.NotEmpty(server);
        Assert.Equal(server, client);

        // Kodların HEPSİ derleyicide gerçekten VAR ve İKİ KÜME AYRIKTIR — bir kod aynı anda
        // "dosyan bozuk" ve "proje pencerenin dışında" diyemez.
        var declared = CompilerGates.Select(g => g.Code).ToHashSet(StringComparer.Ordinal);
        Assert.Empty(server.Except(declared));

        var assetFacts = QuotedStrings(Between(
            File.ReadAllText(TestVectorFiles.Resolve(
                "backend/src/VideoEdit.Api/Endpoints/ExportEndpoints.cs")),
            "AssetFactFeatures = new(StringComparer.Ordinal)", "};"));
        Assert.Empty(server.Intersect(assetFacts));
    }

    [Fact]
    public void TheClientAndServerAgreeOnWhichCodesMeanABadValue()
    {
        // AYNI DOKTRİN, ÜÇÜNCÜ SINIF (B6): belge geçerli, özellik DESTEKLİ ve proje kaynak
        // penceresinin İÇİNDE — kusur bir ALANIN DEĞERİNDE. Bu iki kod bir dönem "henüz
        // desteklenmeyen özellik" cümlesini kuruyordu; kullanıcı, tek bir alanı düzelterek
        // çözülecek bir sorunda OLMAYAN bir özelliği aramaya gönderiliyordu.
        var server = QuotedStrings(Between(
            File.ReadAllText(TestVectorFiles.Resolve(
                "backend/src/VideoEdit.Api/Endpoints/ExportEndpoints.cs")),
            "DocumentValueFeatures = new(StringComparer.Ordinal)", "};"));
        var client = QuotedStrings(Between(
            File.ReadAllText(TestVectorFiles.Resolve(
                "apps/editor/src/features/export/exportLogic.ts")),
            "const VALUE_CODES = new Set([", "]);"));

        Assert.NotEmpty(server);
        Assert.Equal(server, client);

        // Kodların hepsi derleyicide gerçekten VAR.
        var declared = CompilerGates.Select(g => g.Code).ToHashSet(StringComparer.Ordinal);
        Assert.Empty(server.Except(declared));

        // ÜÇ KÜME BİRBİRİNDEN AYRIK: bir kod aynı anda "dosyan bozuk", "proje pencerenin
        // dışında" ve "değer hatalı" diyemez — üçü ayrı CÜMLE kurar, ayrı EYLEM ister.
        var endpoints = File.ReadAllText(TestVectorFiles.Resolve(
            "backend/src/VideoEdit.Api/Endpoints/ExportEndpoints.cs"));
        var assetFacts = QuotedStrings(Between(
            endpoints, "AssetFactFeatures = new(StringComparer.Ordinal)", "};"));
        var ceilings = QuotedStrings(Between(
            endpoints, "CeilingFeatures = new(StringComparer.Ordinal)", "};"));
        Assert.Empty(server.Intersect(assetFacts));
        Assert.Empty(server.Intersect(ceilings));
    }

    private static string Between(string source, string start, string end)
    {
        var from = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(from >= 0, $"'{start}' kaynakta bulunamadı — tarama deseni bayatladı.");
        var to = source.IndexOf(end, from, StringComparison.Ordinal);
        Assert.True(to > from, $"'{start}' bloğunun sonu ('{end}') bulunamadı.");
        return source[from..to];
    }

    private static SortedSet<string> QuotedStrings(string block) =>
        new(Regex.Matches(block, @"['""]([a-z][a-z0-9-]+)['""]").Select(m => m.Groups[1].Value),
            StringComparer.Ordinal);

    [Fact]
    public void EveryRasterRefusalHasAnInventoryRow()
    {
        // KİMLİK EŞLEŞMESİ (sayı değil): her fırlatma noktası TAM BİR satırla eşleşmeli ve her
        // satır TAM BİR fırlatma noktasıyla. Böylece "bir gerekçe eklendi, biri silindi" hali
        // de kırmızı olur — sayı sabitlemek onu göremezdi.
        var sites = RasterRefusalSites();
        Assert.NotEmpty(sites);

        var used = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (file, window) in sites)
        {
            var matched = RasterRefusals
                .Where(r => window.Contains(r.Fragment, StringComparison.Ordinal))
                .ToList();
            Assert.True(matched.Count == 1,
                $"{file}: bu UnsupportedOverlayClipException fırlatmasıyla {matched.Count} defter "
                + "satırı eşleşti (tam 1 olmalı). Yeni bir raster reddi eklediyseniz önce şu "
                + "soruyu yanıtlayın — kural saf doküman aritmetiğiyle karar verilebiliyor mu? "
                + "Evetse senkron kapıda YAŞAMALI ve buraya SyncGate satırı (+ belge kurucusu) "
                + "eklenmeli; hayırsa gerekçesi YAZILI olmalı.\nFırlatma:\n"
                + window[..Math.Min(240, window.Length)]);
            used[matched[0].Fragment] = used.GetValueOrDefault(matched[0].Fragment) + 1;
        }

        var unused = RasterRefusals
            .Where(r => !used.ContainsKey(r.Fragment))
            .Select(r => r.Fragment)
            .ToList();
        Assert.True(unused.Count == 0,
            "Defterde artık kaynakta OLMAYAN raster reddi var: " + string.Join(" | ", unused));

        var ambiguous = used.Where(u => u.Value > 1).Select(u => u.Key).ToList();
        Assert.True(ambiguous.Count == 0,
            "Bir defter satırı BİRDEN ÇOK fırlatmayla eşleşiyor (parça yeterince tekil değil): "
            + string.Join(" | ", ambiguous));
    }

    [Fact]
    public async Task EveryRasterSyncGateRowIsActuallyRejectedByTheEndpoint()
    {
        // KAÇAK YOLU YOK: "bu reddi tetikleyen belge senkron kapıda ölür" bir iddia değil
        // ÖLÇÜMDÜR. Kod eşitliği aranmaz (bazı kurallar KODSUZ InvalidTimelineException ile
        // reddedilir); aranan şey 422 + iş satırı OLUŞMAMASI, ve kod BEYAN EDİLMİŞSE eşitliği.
        foreach (var refusal in RasterRefusals.Where(r => r.Owner == RasterOwner.SyncGate))
        {
            Assert.True(refusal.Arrange is not null,
                $"{refusal.Fragment}: SyncGate satırı belge kurucusu ister.");
            using var scope = new ExportGateInventoryTests();
            var projectId = await refusal.Arrange!(scope);

            var problem = Assert.IsType<ProblemHttpResult>(await scope.CallStartAsync(projectId));
            Assert.Equal(
                (refusal.Fragment, StatusCodes.Status422UnprocessableEntity),
                (refusal.Fragment, problem.StatusCode));
            problem.ProblemDetails.Extensions.TryGetValue("feature", out var feature);
            Assert.Equal((refusal.Fragment, refusal.Feature), (refusal.Fragment, feature as string));
            Assert.Empty(scope._db.Jobs.ToList());
            Assert.Equal(0, scope._jobs.CreateCount);
        }
    }

    [Fact]
    public void EveryNonSyncRasterRowCarriesAWrittenReason()
    {
        foreach (var refusal in RasterRefusals.Where(r => r.Owner != RasterOwner.SyncGate))
        {
            Assert.True(refusal.Note.Length >= 40, $"{refusal.Fragment}: gerekçe yazılmamış.");
            Assert.Null(refusal.Arrange);
        }
    }

    [Fact]
    public void EveryDocumentStringFieldHasAnInventoryRow()
    {
        // TAMLIK REFLEKSİYONLADIR: şemadan üretilen DTO'ların her string özelliği (+ her
        // serbest biçimli sözlük torbası) defterde BİR satıra sahip olmalıdır.
        var declared = DocumentStrings.Select(d => (d.Owner, d.Property)).ToHashSet();
        Assert.Equal(DocumentStrings.Length, declared.Count); // defterde tekrar yok

        var found = ContractStringSurface();
        Assert.NotEmpty(found);

        var missing = found.Except(declared).Select(Describe).Order(StringComparer.Ordinal).ToList();
        Assert.True(missing.Count == 0,
            "Şemada DEFTERDE OLMAYAN doküman dizesi var: " + string.Join(", ", missing)
            + ". DocumentStrings'e satır ekleyin ve şu soruyu yanıtlayın: bu değer ffmpeg "
            + "dizesine mi giriyor (FfmpegGraph — dilbilgisi + senkron ret KANITI zorunlu), "
            + "raster hattına mı, yoksa hiç okunmuyor mu (yazılı gerekçe)?");

        var stale = declared.Except(found).Select(Describe).Order(StringComparer.Ordinal).ToList();
        Assert.True(stale.Count == 0,
            "Defterde artık şemada OLMAYAN dize alanı var: " + string.Join(", ", stale));

        static string Describe((Type Owner, string Property) f) => $"{f.Owner.Name}.{f.Property}";
    }

    [Fact]
    public void EveryStringThatReachesTheFfmpegGraphIsGatedAndProven()
    {
        // BU KURAL, FfmpegColor SINIFININ KENDİSİDİR: doküman dizesi ffmpeg argümanına
        // giriyorsa dilbilgisi TAM olamaz (aksi halde "her dize geçerli" demek, geçersiz
        // değeri grafiğe yazmak demektir) ve reddin senkron kapıda GERÇEKTEN koştuğu
        // kanıtlanmalıdır. Sessiz varsayılan (eski '_ => "000000"') bu iki şarttan da kaçardı.
        var graph = DocumentStrings.Where(d => d.Sink == DocStringSink.FfmpegGraph).ToList();
        Assert.NotEmpty(graph);

        foreach (var row in graph)
        {
            Assert.True(row.Grammar is not null,
                $"{row.Owner.Name}.{row.Property}: ffmpeg dizesine giren bir doküman değerinin "
                + "dilbilgisi TAM olamaz — onu hangi doğrulayıcının kapıya tuttuğunu yazın.");
            Assert.True(row.Arrange is not null,
                $"{row.Owner.Name}.{row.Property}: ffmpeg dizesine giren bir değerin reddi "
                + "İDDİA değil ÖLÇÜM olmalıdır — belge kurucusu ekleyin.");
        }
    }

    [Fact]
    public async Task EveryGatedDocumentStringIsRefusedSynchronously()
    {
        // KAÇAK YOLU YOK: dilbilgisi olan her satır GERÇEKTEN koşar — belge kurulur, uç nokta
        // çağrılır, 422 + (beyan edilmişse) kod + İŞ SATIRI OLUŞMAMASI ölçülür.
        foreach (var row in DocumentStrings.Where(d => d.Grammar is not null))
        {
            var label = $"{row.Owner.Name}.{row.Property}";
            Assert.True(row.Arrange is not null, $"{label}: dilbilgisi olan satır kanıt ister.");
            using var scope = new ExportGateInventoryTests();
            var projectId = await row.Arrange!(scope);

            var problem = Assert.IsType<ProblemHttpResult>(await scope.CallStartAsync(projectId));
            Assert.Equal(
                (label, StatusCodes.Status422UnprocessableEntity), (label, problem.StatusCode));
            problem.ProblemDetails.Extensions.TryGetValue("feature", out var feature);
            Assert.Equal((label, row.Feature), (label, feature as string));
            Assert.Empty(scope._db.Jobs.ToList());
            Assert.Equal(0, scope._jobs.CreateCount);
        }
    }

    [Fact]
    public async Task EveryEffectParamViolationIsRefusedSynchronously()
    {
        // F3'ÜN ÖLÇÜMÜ: EffectParams satırı artık FfmpegGraph etiketli, yani bu torbadan okunan
        // değerler filtergraph'a giriyor. Bir etiket iddia değil ölçüm olmalı — torbanın ihlal
        // yüzeyinin TAMAMI burada koşar: 422 + (beyan edilmişse) kod + İŞ SATIRI OLUŞMAMASI.
        Assert.NotEmpty(EffectParamViolations);
        foreach (var violation in EffectParamViolations)
        {
            using var scope = new ExportGateInventoryTests();
            var projectId = await violation.Arrange(scope);

            var problem = Assert.IsType<ProblemHttpResult>(await scope.CallStartAsync(projectId));
            Assert.Equal(
                (violation.Label, StatusCodes.Status422UnprocessableEntity),
                (violation.Label, problem.StatusCode));
            problem.ProblemDetails.Extensions.TryGetValue("feature", out var feature);
            Assert.Equal((violation.Label, violation.Feature), (violation.Label, feature as string));
            Assert.Empty(scope._db.Jobs.ToList());
            Assert.Equal(0, scope._jobs.CreateCount);
        }
    }

    [Fact]
    public async Task FpsWindowBothSidesBehaveAsTheLedgerClaims()
    {
        // F2'NİN ÖLÇÜMÜ — İKİ YANI BİRDEN. Pencerenin dışı 422 + iş satırı YOK; pencerenin
        // içindeki HER hız 202 ve iş satırı VAR. İkinci yarı olmadan bir tavan "kesiyor" der
        // ama neyi kestiğini söylemez.
        foreach (var (num, den, clipDurationUs, accepted, label) in FpsWindowBoundaries)
        {
            using var scope = new ExportGateInventoryTests();
            var projectId = await scope.SeedAsync(ExportTestDocs.Doc(
                fpsNum: (int)num, fpsDen: (int)den,
                clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, clipDurationUs)));

            var result = await scope.CallStartAsync(projectId);
            if (accepted)
            {
                Assert.IsType<Accepted<ExportJobCreatedResponse>>(result);
                Assert.Single(scope._db.Jobs.ToList());
                continue;
            }

            var problem = Assert.IsType<ProblemHttpResult>(result);
            Assert.Equal((label, StatusCodes.Status422UnprocessableEntity), (label, problem.StatusCode));
            problem.ProblemDetails.Extensions.TryGetValue("feature", out var feature);
            Assert.Equal((label, "project-fps-out-of-range"), (label, feature as string));
            Assert.Empty(scope._db.Jobs.ToList());
            Assert.Equal(0, scope._jobs.CreateCount);
        }
    }

    [Fact]
    public async Task TimelineDurationCeilingBothSidesBehaveAsTheLedgerClaims()
    {
        // F1'İN ÖLÇÜMÜ — İKİ YANI BİRDEN. Kenar TAM SAYIDIR: tavana tam oturan çizelge kuyruğa
        // girer, bir KARE ötesi 422 olur. (Klip kenarları proje ızgarasına oturur, §1.4.)
        foreach (var (totalDurationUs, accepted, label) in DurationCeilingBoundaries)
        {
            using var scope = new ExportGateInventoryTests();
            var projectId = await scope.SeedAsync(ExportTestDocs.Doc(
                clips: ExportTestDocs.VideoClip(
                    ExportTestDocs.AssetA, totalDurationUs - 1_000_000, 0, 1_000_000)));

            var result = await scope.CallStartAsync(projectId);
            if (accepted)
            {
                Assert.IsType<Accepted<ExportJobCreatedResponse>>(result);
                Assert.Single(scope._db.Jobs.ToList());
                continue;
            }

            var problem = Assert.IsType<ProblemHttpResult>(result);
            Assert.Equal((label, StatusCodes.Status422UnprocessableEntity), (label, problem.StatusCode));
            problem.ProblemDetails.Extensions.TryGetValue("feature", out var feature);
            Assert.Equal((label, "timeline-too-long"), (label, feature as string));
            Assert.Empty(scope._db.Jobs.ToList());
            Assert.Equal(0, scope._jobs.CreateCount);
        }
    }

    [Fact]
    public void EffectParamsBagIsLabelledByWhereItsValuesActuallyGo()
    {
        // F3'ÜN YAPISAL MUHAFIZI. Bulunan kusur şuydu: EffectParams satırı Raster etiketliydi,
        // etiket yanlış olduğu için EveryStringThatReachesTheFfmpegGraphIsGatedAndProven onu
        // ATLIYORDU — yani muhafaza edilmeyen bir üye, "muhafaza edildi" sayılıyordu. Yanlış
        // ETİKET HİÇBİR TESTİ KIRMIYORDU; aslİ kusur budur. Bu test etiketi ÖLÇÜME bağlar:
        // satırın Sink'i artık serbestçe değiştirilemez, kaynak taramasıyla çelişirse KIRMIZI olur.
        var row = Assert.Single(DocumentStrings, d => d.Owner == typeof(EffectParams));

        // (1) SKIA BU TORBAYI HİÇ OKUMAZ — raster hattının hiçbir dosyası efekt yüzeyine değmez.
        var rasterReaders = Directory
            .EnumerateFiles(TestVectorFiles.Resolve("backend/src/VideoEdit.Media/Text"), "*.cs")
            .Where(f => Regex.IsMatch(
                File.ReadAllText(f), @"\.Effects\b|\.Params\b|EffectParams|ColorAdjustParams|LutParams"))
            .Select(Path.GetFileName)
            .Order(StringComparer.Ordinal)
            .ToList();
        Assert.True(rasterReaders.Count == 0,
            "Raster hattı artık efekt yüzeyini okuyor: " + string.Join(", ", rasterReaders)
            + ". Defterdeki EffectParams satırının Sink'i yeniden düşünülmelidir.");

        // (2) TORBADAN OKUNAN DEĞERLER FFİLTREGRAPH'A GİRER — filtre üreten metotların hepsi
        // ClipEffects.cs'te ve hepsi bu torbadan gelen değerlerle beslenir.
        var effectSource = File.ReadAllText(
            TestVectorFiles.Resolve("backend/src/VideoEdit.Media/Export/ClipEffects.cs"));
        foreach (var token in new[]
                 { "exposure=", "lutrgb=", "colorchannelmixer=", "lut3d=file=", "blend=all_expr=" })
        {
            Assert.True(effectSource.Contains(token, StringComparison.Ordinal),
                $"ClipEffects.cs artık '{token}' üretmiyor — efekt yüzeyinin ffmpeg yolu değişmiş "
                + "olabilir; defterdeki EffectParams satırı yeniden ölçülmelidir.");
        }

        // (3) İki ölçümün ZORUNLU sonucu: etiket FfmpegGraph'tir.
        Assert.Equal(DocStringSink.FfmpegGraph, row.Sink);
    }

    [Fact]
    public void NonFiniteEffectParamCannotBeExpressedInJson()
    {
        // ÖLÇÜM, İDDİA DEĞİL: "NaN buraya hiç gelemez" cümlesini yazmak yetmez — iki yönü de
        // koşarak gösteririz. (1) YAZMA yönü: belge serileştirilemez; (2) OKUMA yönü: JSON
        // dilbilgisinde böyle bir literal yoktur, ayrıştırıcı reddeder. Dolayısıyla
        // ClipEffects.RequireNumber'daki double.IsFinite dalı BELGEYLE tetiklenemez.
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Effects = [Bag(EffectType.ColorAdjust, ("tint", double.NaN))];
        Assert.Throws<ArgumentException>(() => JsonSerializer.Serialize(
            new TimelineDoc { SchemaVersion = 1, Tracks = [ExportTestDocs.VideoTrack(clips: clip)] },
            TimelineJson.Options));

        Assert.ThrowsAny<JsonException>(() => JsonDocument.Parse("""{"params":{"tint":NaN}}"""));
    }

    [Fact]
    public async Task ValidEffectParamsStillReachTheQueue()
    {
        // YANLIŞ RET KONTROLÜ: kapı yalnız ihlalleri kesmeli. Geçerli bir colorAdjust torbası
        // (grafiğe exposure=/lutrgb=/colorchannelmixer= olarak giren değerler) 202 almalı.
        using var scope = new ExportGateInventoryTests();
        var projectId = await scope.SeedEffectAsync(
            Bag(EffectType.ColorAdjust, ("exposure", 0.25), ("saturation", -0.5), ("contrast", 1d)));

        Assert.IsType<Accepted<ExportJobCreatedResponse>>(await scope.CallStartAsync(projectId));
        Assert.Single(scope._db.Jobs.ToList());
    }

    [Fact]
    public void EveryUngatedDocumentStringRowCarriesAWrittenReason()
    {
        foreach (var row in DocumentStrings.Where(d => d.Grammar is null))
        {
            var label = $"{row.Owner.Name}.{row.Property}";
            Assert.True(row.Note.Length >= 40, $"{label}: gerekçe yazılmamış.");

            // Dilbilgisi TAMSA reddedilecek değer yoktur — kanıt istemek de anlamsızdır.
            Assert.True(row.Arrange is null,
                $"{label}: dilbilgisi TAM ilan edilmiş ama belge kurucusu verilmiş — ikisi çelişir.");
            Assert.True(row.Feature is null,
                $"{label}: dilbilgisi TAM ilan edilmiş ama 422 kodu beyan edilmiş — ikisi çelişir.");
        }
    }

    /// <summary>
    /// Şemadan üretilen sözleşme tiplerinin DİZE YÜZEYİ: her <c>string</c> özelliği, artı her
    /// serbest biçimli <c>Dictionary&lt;string, object&gt;</c> torbası (<c>"*"</c> adıyla).
    /// </summary>
    private static HashSet<(Type Owner, string Property)> ContractStringSurface()
    {
        var surface = new HashSet<(Type, string)>();
        foreach (var type in typeof(TimelineDoc).Assembly.GetTypes()
                     .Where(t => t is { IsClass: true, IsAbstract: false }
                                 && t.Namespace == typeof(TimelineDoc).Namespace))
        {
            if (typeof(IDictionary<string, object>).IsAssignableFrom(type))
            {
                surface.Add((type, DictionaryBagProperty));
                continue;
            }

            foreach (var property in type.GetProperties())
            {
                if (property.PropertyType == typeof(string) && property.DeclaringType == type)
                {
                    surface.Add((type, property.Name));
                }
            }
        }

        return surface;
    }

    [Fact]
    public void EveryWorkerOnlyRowCarriesAWrittenReason()
    {
        foreach (var gate in CompilerGates.Where(g => g.Owner != GateOwner.SyncGate))
        {
            Assert.True(gate.Note.Length >= 40, $"{gate.Code}: gerekçe yazılmamış.");
        }

        foreach (var (reason, owner, note) in WorkerFailures.Where(w => w.Owner == GateOwner.WorkerOnly))
        {
            Assert.True(note.Length >= 40, $"{reason}: gerekçe yazılmamış ({owner}).");
        }
    }

    // ───────────────────────────── Yardımcılar ─────────────────────────────

    private static IEnumerable<string> ExportSourceFiles() =>
        Directory.EnumerateFiles(
                TestVectorFiles.Resolve("backend/src/VideoEdit.Media/Export"), "*.cs")
            .Order(StringComparer.Ordinal);

    /// <summary>
    /// Raster hattındaki her <c>UnsupportedOverlayClipException</c> fırlatması ve mesajını
    /// kapsayan pencere. Pencere fırlatmadan başlar ve bir SONRAKİ fırlatmada (ya da 400
    /// karakterde) biter — iki fırlatmanın mesajı birbirine karışmasın.
    /// </summary>
    private static List<(string File, string Window)> RasterRefusalSites()
    {
        var sites = new List<(string, string)>();
        var files = Directory
            .EnumerateFiles(TestVectorFiles.Resolve("backend/src/VideoEdit.Media/Text"), "*.cs")
            .Order(StringComparer.Ordinal);

        foreach (var file in files)
        {
            var source = File.ReadAllText(file);
            var matches = Regex.Matches(source, @"new UnsupportedOverlayClipException\(");
            for (var i = 0; i < matches.Count; i++)
            {
                var start = matches[i].Index;
                var limit = i + 1 < matches.Count ? matches[i + 1].Index : source.Length;
                var end = Math.Min(limit, start + 400);
                sites.Add((Path.GetFileName(file), source[start..end]));
            }
        }

        return sites;
    }

    private Task<IResult> CallStartAsync(Guid projectId, ITextRasterService? measurer = null) =>
        ExportEndpoints.StartExport(
            projectId, new CreateExportRequest("1080p"),
            new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", _userId.ToString("D"))], "test")),
            _db, _jobs, TimeProvider.System, Fonts, measurer, CancellationToken.None);

    /// <summary>
    /// Ölçerin manifestinde belgedeki fontId YOK — BELGE hatası (kurulum değil). Gerçek
    /// <c>SkiaOverlayRasterService</c> yerine sahte kullanılır: defter kurulu font varlığına
    /// bağlı olmamalıdır. Canlı ölçerle koşan karşılığı
    /// <c>ExportEndpointsTests.StartExport_UnknownFontId_WithALiveMeasurer_StillReturns422_NotA503</c>.
    /// </summary>
    private sealed class UnknownFontMeasurer : ITextRasterService
    {
        public Task<RasterResult> RenderAsync(
            Clip clip, ProjectSettings settings, string outputPath, CancellationToken ct = default) =>
            throw new InvalidOperationException("Ön kapı raster ÜRETMEMELİ, yalnız ölçmeli.");

        public TextLayout Measure(TextClipText text, ProjectSettings settings) =>
            throw FontNotFoundException.UnknownId(text.FontId, "(ölçerin manifesti)", ["baska-font"]);
    }

    private Task<Guid> SeedAsync(TimelineDoc doc, bool seedAssets = true) =>
        SeedRawAsync(ExportTestDocs.ToJson(doc), seedAssets);

    private async Task<Guid> SeedRawAsync(string timelineJson, bool seedAssets = true)
    {
        var projectId = Guid.CreateVersion7();
        _db.Projects.Add(new Project
        {
            Id = projectId,
            OwnerId = _userId,
            Name = "gate-inventory",
            Timeline = JsonDocument.Parse(timelineJson),
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        });
        await _db.SaveChangesAsync();

        if (seedAssets)
        {
            // Satırın TÜRÜ belgedeki kullanımından gelir: ses klibi bir SES satırını, çıkartma
            // bir GÖRSEL satırını gösterir (gerçek kütüphanede başka türlüsü kurulamaz).
            // Belge ayrıştırılamıyorsa (bilerek bozuk JSON kuran "Unreachable" satırları)
            // varsayılan tür kullanılır — o istekler zaten derleyiciye ulaşmaz.
            var doc = TryParse(timelineJson);
            foreach (var id in new[] { ExportTestDocs.AssetA, ExportTestDocs.AssetB, ExportTestDocs.AssetC })
            {
                if (!_db.Assets.Any(a => a.Id == id))
                {
                    var kind = doc is null ? AssetKind.Video : ExportTestDocs.AssetKindFor(doc, id);
                    await SeedAssetAsync(
                        id,
                        // Görsel satırın süresi ve sesi YOKTUR (ProcessAssetJob.GateByKind bunu
                        // zaten şart koşar) — fixture gerçek kütüphaneden ayrışmamalı.
                        durationMicros: kind == AssetKind.Image ? null : 3_600_000_000,
                        kind: kind);
                }
            }
        }

        return projectId;
    }

    private static TimelineDoc? TryParse(string timelineJson)
    {
        try
        {
            return JsonSerializer.Deserialize<TimelineDoc>(timelineJson, TimelineJson.Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private async Task SeedAssetAsync(
        Guid id, int? width = 1920, int? height = 1080,
        long? durationMicros = 3_600_000_000, string fileName = "clip.mp4",
        AssetKind kind = AssetKind.Video, AssetStatus status = AssetStatus.Ready,
        bool? hasAudio = null)
    {
        _db.Assets.Add(new Asset
        {
            Id = id,
            OwnerId = _userId,
            Status = status,
            Kind = kind,
            OriginalFileName = fileName,
            StorageKey = $"u/{_userId}/a/{id}/original/source.mp4",
            ContentType = "video/mp4",
            SizeBytes = 1024,
            Width = width,
            Height = height,
            DurationMicros = durationMicros,
            HasAudio = hasAudio ?? kind != AssetKind.Image, // görselde ses OLAMAZ (GateByKind)
            CreatedAt = DateTimeOffset.UtcNow,
            ReadyAt = DateTimeOffset.UtcNow,
        });
        await _db.SaveChangesAsync();
    }

    // --- "Ulaşılamaz" satırların ham JSON kanıtları (şema union'ı / enum sınırları) ---

    /// <summary>
    /// Belgedeki <paramref name="member"/> nesnesini AÇIK <c>null</c> ile değiştirir (parantez
    /// dengeli tarama — iç içe nesne taşıyan gövdeler de doğru kesilir). "Alan yok" ile "alan
    /// null" AYNI ŞEY DEĞİLDİR: ilki DTO'nun varsayılan gövdesine düşer.
    /// </summary>
    private static string NulledMemberJson(TimelineDoc doc, string member)
    {
        var json = ExportTestDocs.ToJson(doc);
        var key = $"\"{member}\":";
        var start = json.IndexOf(key, StringComparison.Ordinal);
        Assert.True(start >= 0, $"belgede '{member}' alanı yok — kurucu artık bu kliple çalışmıyor.");

        var open = json.IndexOf('{', start + key.Length);
        Assert.True(open > 0, $"'{member}' bir nesne değil.");

        var depth = 0;
        var end = open;
        for (; end < json.Length; end++)
        {
            if (json[end] == '{')
            {
                depth++;
            }
            else if (json[end] == '}' && --depth == 0)
            {
                break;
            }
        }

        return json[..(start + key.Length)] + "null" + json[(end + 1)..];
    }

    private static string BogusDiscriminatorJson(string from, string to)
    {
        var json = ExportTestDocs.ToJson(ExportTestDocs.Doc(
            clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000)));
        Assert.Contains(from, json, StringComparison.Ordinal);
        return json.Replace(from, to, StringComparison.Ordinal);
    }

    private static string KeyframedDocJson(string easingType)
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Keyframes = new KeyframeTracks
        {
            X = [ExportTestDocs.Kf(0, 0), ExportTestDocs.Kf(500_000, 0.1)],
        };
        var json = ExportTestDocs.ToJson(ExportTestDocs.Doc(clips: clip));
        return json.Replace("\"type\": \"linear\"", $"\"type\": \"{easingType}\"", StringComparison.Ordinal)
            .Replace("\"type\":\"linear\"", $"\"type\":\"{easingType}\"", StringComparison.Ordinal);
    }

    private static string EffectDocJson(string effectType)
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Effects = [ExportTestDocs.ColorAdjust(saturation: 0.5)];
        var json = ExportTestDocs.ToJson(ExportTestDocs.Doc(clips: clip));
        return json.Replace("colorAdjust", effectType, StringComparison.Ordinal);
    }

    private static string TransitionDocJson(string transitionType)
    {
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 3_000_000);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetB, 2_000_000, 1_000_000, 3_000_000);
        ExportTestDocs.Link(a, b, 400_000);
        var json = ExportTestDocs.ToJson(ExportTestDocs.Doc(clips: [a, b]));
        return json.Replace("crossfade", transitionType, StringComparison.Ordinal);
    }

    /// <summary>Yalnız Create sayısını sayan Hangfire istemcisi.</summary>
    private sealed class CountingJobClient : IBackgroundJobClient
    {
        public int CreateCount { get; private set; }

        public string Create(Hangfire.Common.Job job, IState state)
        {
            CreateCount++;
            return Guid.NewGuid().ToString("N");
        }

        public bool ChangeState(string jobId, IState state, string expectedState) => true;
    }
}
