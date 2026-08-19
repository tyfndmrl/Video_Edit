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
            "Çalışma zamanı: render süre tavanını aştı. İstek anında bilinemez — süre kaynak "
            + "karmaşıklığına ve makine yüküne bağlıdır."),
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
    /// alıyor, iş dakikalar sonra <c>overlay-unsupported-clip</c> ile düşüyordu. Bu defter o
    /// SINIFI kapatır: raster hattına eklenen her "bu klibi çizemem" gerekçesi, senkron kapıda
    /// karşılığı olduğunu KANITLAMAK ya da neden olamayacağını YAZMAK zorundadır.
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

    /// <summary>
    /// Fırlatma SAYILARI. Kodsuz <c>InvalidTimelineException</c>'ın kimliği yoktur; sayı
    /// sabitlemek "yeni fırlatma eklendi ama defter güncellenmedi" halini kırmızıya çevirir.
    /// </summary>
    private static readonly (string RepoPath, int Unsupported, int Invalid)[] ThrowSiteCounts =
    [
        // 20 → 22: 'asset-failed' ve 'asset-clip-type' (M6 denetimi, N1-N3). İkisi de SAF DB
        // aritmetiğidir (Asset.Status / Asset.Kind), ikisi de Validate'te yaşar ve ikisinin de
        // CompilerGates defterinde SyncGate satırı vardır.
        ("backend/src/VideoEdit.Media/Export/ExportCompiler.cs", 22, 33),
        ("backend/src/VideoEdit.Media/Export/ClipAnimation.cs", 1, 7),
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
