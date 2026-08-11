using System.Globalization;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Recipes;

namespace VideoEdit.Media.Export;

/// <summary>
/// Tek track'in normalize planı. <see cref="DocIndex"/> dokümandaki sırasıdır
/// (0 = EN ÜST katman — docs/design/01 §1.2); <see cref="ExportPlan.Tracks"/> ise
/// RENDER sırasındadır (sondan başa: en alt katman önce).
/// </summary>
public sealed record ExportTrackPlan(Track Track, int DocIndex, IReadOnlyList<MediaClip> Clips);

/// <summary>
/// Doğrulama çıktısı: normalize plan. API ön-doğrulaması yalnız <see cref="ExportCompiler.Validate"/>
/// çağırır (asset yolu gerekmez); worker aynı planla kaynakları indirip Compile'a geçer.
/// TotalDurationUs TÜM track'lerin en geç klip bitişinin proje fps grid'ine snap edilmiş halidir.
/// <para>
/// <see cref="Clips"/> = worker'ın KAYNAK-ARALIĞI KAPISININ defteridir (render sırasında
/// düzleştirilmiş). İki sınıf klip bilerek DIŞARIDA bırakılır:
///  - GÖRSEL klipler: sourceIn/sourceOut'ları dosyada bir zaman aralığına karşılık GELMEZ
///    (still image'in süresi yoktur; editör 4 sn'lik sentetik aralık üretir) — kapıya
///    sokulurlarsa "reads source range beyond asset duration" ile export düşerdi;
///  - ATIL klipler (gizli track + şema gereği ses üretemeyen klip): hiçbir ffmpeg girişi
///    açmazlar, dolayısıyla hiçbir kaynak aralığı OKUMAZLAR — render edilmeyen bir klibin
///    TÜM export'u düşürmesi (M4 dalga 1 denetimi) böylece imkânsızlaşır.
/// <see cref="AssetIds"/> ise atıl klipleri dışlar (worker boşuna indirmesin) ama GÖRSELLERİ
/// İÇERİR — görsel dosyası indirilmeden render edilemez.
/// </para>
/// </summary>
public sealed record ExportPlan(
    TimelineDoc Doc,
    IReadOnlyList<ExportTrackPlan> Tracks,
    IReadOnlyList<MediaClip> Clips,
    IReadOnlyList<Guid> AssetIds,
    long TotalDurationUs,
    int FpsNum,
    int FpsDen,
    int Width,
    int Height);

/// <summary>
/// FilterGraph Compiler v2 (M4 dalga 1 = çok katman kompozisyonu + görsel klipler;
/// geçiş/keyframe/efekt/hız ve metin-şekil-çıkartma klipleri hâlâ tipli hata). TimelineDoc →
/// deterministik CompiledExport. Kurallar:
///  - trim INPUT seviyesinde -ss/-t (tasarım 04 §2.1; -to ASLA); aynı asset'ten N klip = N giriş;
///    GÖRSEL klipte zaman ekseni yoktur → -loop 1 -t &lt;süre&gt; (seek YOK, ExportInput.Loop);
///  - segment defteri FRAME SAYISIYLA tutulur: her klip proje fps grid'inde tam frame sayısına
///    çözülür ve zincire trim=end_frame=N eklenir — µs-farkı aritmetiğinin NTSC'de ürettiği
///    ±1 frame kaymaları biter (rendering-semantics §1.4);
///  - KATMAN RUN'LARI (M4 dalga 1 denetimi, performans regresyonu): aynı track'te ARDIŞIK
///    (frame-bitişik) ve AYNI yerleşime sahip klipler TEK concat zincirinde birleşir ve tuvale
///    TEK overlay ile biner. Klip başına overlay yalnız GERÇEK katmanlaşmada (farklı track,
///    zaman boşluğu ya da farklı yerleşim) üretilir. GERÇEK ÖLÇÜM (1080p, 12 klip, 12 sn, tek
///    track, ffmpeg 8.0, 3 koşumun en iyisi): klip başına overlay → run concat'i; filtre-only
///    3727 → 1519 ms (2.5x), uçtan uca (libx264 veryfast crf18) 4273 → 2001 ms (2.1x).
///    Kazanç klip sayısıyla büyür: eski hatta her klip, GÖRÜNMEDİĞİ karelerde bile grafikte
///    tam çözünürlüklü bir overlay katı olarak duruyordu;
///  - TEK KATMANLI HIZLI YOL: grafikte TEK run var, timeline'ı BAŞTAN SONA kaplıyor, yerleşim
///    birim (scale=1, merkez çapa, dönmesiz) ve opaklık 1 ise taban tuval + overlay TAMAMEN
///    atlanır: segmentler proje tuvaline letterbox pad'lenip doğrudan concat edilir (M3 hattı).
///    Kompozisyon yoksa blend de yoktur — RGB tuval maliyeti ödenmez. Bu yol aynı zamanda
///    RENK KAYBINI da kaldırır: tuval yolu yuv→rgba→kompozisyon→yuv420p gidiş-dönüşü yapıyordu
///    ve DOKUNULMAMIŞ tam-kare bir klipte bile kayıp ölçülebilirdi (kayıpsız ffv1 karşılaştırma,
///    aynı renk etiketleriyle: tuval yolu PSNR 35.87 dB — Y 38.6 / V 31.1; hızlı yol PSNR ∞,
///    yani kaynakla BİT BİT AYNI);
///  - KOMPOZİSYON (tasarım 04 §2.2 + rendering-semantics §2.2): hızlı yol dışında taban DAİMA
///    proje çözünürlüğünde settings.backgroundColor tuvalidir; her run bu tuvale overlay edilir.
///    Boşluklar (klipsiz aralıklar) ayrı segment gerektirmez — taban tuval görünür.
///    Render sırası tracks dizisinde SONDAN BAŞA'dır (tracks[0] en üst katman, şema §1.2);
///  - her video zinciri fps=&lt;projeFps&gt;,trim=end_frame=N,scale(fit=contain × transform.scale),
///    setsar=1,format,…,settb=AVTB,setpts=PTS-STARTPTS+&lt;start&gt;/TB ile normalize edilir;
///    overlay x/y rendering-semantics §2.5 formülüdür, enable=between(t,…) görünürlük
///    penceresini yarım frame geri çekilmiş bitişle sınırlar (tasarım 04 §8 tuzak 9);
///  - KOMPOZİSYON RENK MODU GRAFİK BAŞINADIR ve DAİMA RGB'dir (rendering-semantics §6.3):
///    her katman format=rgba ile girer, her overlay :format=rgb ile blend eder. Katman başına
///    seçim YASAK — alpha'lı katmanın üstüne opak katman gelince zincir ortasında RGB↔YUV
///    dönüşümü oluşur ve ALTTAKİ katmanların renkleri kayar (M4 denetim #1; gerçek render:
///    üstteki katmanın ÖRTMEDİĞİ bölgede MSE 89.07 — grafik başına modda 0.05);
///    4:2:0 kompozisyon ayrıca tek piksellik konumu TEMSİL EDEMEZ (ffmpeg overlay normalize_xy
///    x/y'yi chroma adımına kırpar) — opak katman çift piksele snap olurken alpha'lı katman
///    olmazdı; alt örneklemesiz tuval bu farkı kökten kaldırır (denetim #15);
///  - her katman zincirinin BAŞINDA setparams=bt709/tv vardır: §6.1 "untagged SDR = BT.709/tv"
///    varsayımı RGB dönüşümünden ÖNCE beyan edilmezse swscale kendi varsayılanını (SD'de BT.601)
///    kullanır ve kompozisyon renkleri kaydırır (ölçülen maxAbsDiff 68);
///  - HDR kaynakta ColorChain.ForSource (rendering-semantics §6.2 normatif sabiti) zincirin başındadır;
///  - kompozisyon SONRASI setparams frame'leri BT.709/tv olarak işaretler — ffmpeg 7+ çıktı CLI
///    tag'lerini filtergraph frame metadata'sıyla ezdiği için CLI bayrakları tek başına yetmez
///    (CLI bayrakları emniyet kemeri olarak kalır);
///  - ses: TÜM track'lerin klipleri mikslenir. hidden track SES ÜRETMEYE DEVAM EDER
///    (hidden = yalnız görsel gizleme — apps/editor resolve.ts semantiği), muted track ve
///    muted klip ses üretmez. Zincir: asetpts → aformat(48k fltp stereo) → volume(lineer)
///    → afade in/out (curve=tri, §8.2) → 5 ms micro-fade (§8.4) → adelay;
///    miks amix=normalize=0 + alimiter=limit=0.98 (§8.3); hiç ses yoksa anullsrc;
///  - tüm sayısal literal'ler InvariantCulture (TimeFormat) — TR locale'de virgül SIZAMAZ.
/// </summary>
public static class ExportCompiler
{
    /// <summary>§8.4: sert kesim sınırındaki micro-fade süresi — 5 ms (= 240 sample @48 kHz).</summary>
    public const long MicroFadeUs = 5_000;

    /// <summary>Çıktı frame'lerine damgalanan renk parametreleri (rendering-semantics §6.1).</summary>
    public const string OutputColorParams =
        "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";

    /// <summary>
    /// Kaynak frame'lerine damgalanan renk parametreleri (rendering-semantics §6.1: "untagged
    /// SDR kaynak BT.709/tv VARSAYILIR"). Zincirin BAŞINDA, ilk format dönüşümünden ÖNCE
    /// uygulanır — aksi halde RGB'ye geçişi swscale kendi varsayılanıyla (SD'de BT.601) yapar
    /// ve varsayım pikselleri etkilemez, yalnız etikette kalır.
    /// </summary>
    public const string SourceColorParams = OutputColorParams;

    /// <summary>
    /// Kompozisyon renk modu (rendering-semantics §6.3): TÜM overlay'ler RGB'de blend eder.
    /// Grafik başına tek moddur — katman başına seçim zincir ortasında RGB↔YUV dönüşümü
    /// yaratır (denetim #1) ve 4:2:0 tuval overlay konumunu çift piksele kırpar (denetim #15).
    /// </summary>
    public const string CompositeFormat = ":format=rgb";

    /// <summary>
    /// Şeffaf pad rengi — katman zincirlerinde kullanılan tek "boşluk" rengi (rgba tuval).
    /// </summary>
    public const string TransparentPad = "#00000000";

    /// <summary>M4 dalga 1 kapsam + sözleşme doğrulaması. İhlalde ExportCompileException türevi fırlatır.</summary>
    public static ExportPlan Validate(TimelineDoc doc)
    {
        ArgumentNullException.ThrowIfNull(doc);

        if (doc.SchemaVersion != 1)
        {
            throw new InvalidTimelineException(
                $"unsupported schemaVersion {doc.SchemaVersion.ToString(CultureInfo.InvariantCulture)} (expected 1).");
        }

        var settings = doc.Settings
            ?? throw new InvalidTimelineException("timeline has no settings.");
        if (settings.Fps is not { Num: > 0, Den: > 0 }
            || settings.Fps.Num > int.MaxValue || settings.Fps.Den > int.MaxValue)
        {
            throw new InvalidTimelineException("settings.fps must be a positive rational.");
        }

        if (settings.Width <= 0 || settings.Height <= 0
            || settings.Width > int.MaxValue || settings.Height > int.MaxValue)
        {
            throw new InvalidTimelineException("settings.width/height must be positive.");
        }

        if (settings.Width % 2 != 0 || settings.Height % 2 != 0)
        {
            // yuv420p/libx264 çift boyut ister — tek kaynak kural: proje çözünürlüğü çift olmalı.
            throw new InvalidTimelineException(
                $"output resolution {settings.Width}x{settings.Height} must have even dimensions.");
        }

        var tracks = doc.Tracks ?? [];
        if (tracks.Count == 0)
        {
            throw new InvalidTimelineException("timeline has no tracks — nothing to export.");
        }

        var fpsNum = (int)settings.Fps.Num;
        var fpsDen = (int)settings.Fps.Den;
        var width = (int)settings.Width;
        var height = (int)settings.Height;

        // Track'ler RENDER sırasında (sondan başa: en alt katman önce) planlanır — şema
        // sözleşmesi tracks[0]'ı EN ÜST katman sayar (docs/design/01 §1.2). BOŞ track'ler
        // (clips.length == 0, tipi ne olursa olsun) yok sayılır: editör +V/+A ile içeriksiz
        // track ekler — bunlar export kapsamını değiştirmez, 422'ye düşürmez.
        var trackPlans = new List<ExportTrackPlan>();
        var sourceRangeClips = new List<MediaClip>();
        var assetIds = new List<Guid>();
        long totalDurationUs = 0;
        for (var i = tracks.Count - 1; i >= 0; i--)
        {
            var track = tracks[i];
            if (track.Clips is not { Count: > 0 })
            {
                continue;
            }

            var clips = new List<MediaClip>(track.Clips.Count);
            foreach (var clip in track.Clips)
            {
                var media = ValidateClip(clip, width, height);

                // Frame-grid güvenlik ağı (rendering-semantics §1.4): editör klipleri zaten proje
                // fps grid'inde üretir; grid dışı değer frame defterini bozup ±1 frame kayma üretir —
                // sessiz snap yerine sözleşme ihlali görünür olur.
                if (SnapUs(media.TimelineStartUs, fpsNum, fpsDen) != media.TimelineStartUs
                    || SnapUs(media.TimelineDurationUs, fpsNum, fpsDen) != media.TimelineDurationUs)
                {
                    throw new InvalidTimelineException(
                        $"clip '{media.Id}' is not aligned to the project frame grid "
                        + $"({fpsNum.ToString(CultureInfo.InvariantCulture)}/{fpsDen.ToString(CultureInfo.InvariantCulture)} fps): "
                        + $"timelineStartUs={media.TimelineStartUs}, timelineDurationUs={media.TimelineDurationUs}.");
                }

                clips.Add(media);
            }

            // Sıralama + bitişiklik invariant'ı (schema.ts Track.clips yorumu): TRACK İÇİNDE
            // timelineStartUs artan, overlap YOK. Boşluk serbesttir — taban tuval görünür.
            // Track'ler ARASI çakışma normaldir; kompozisyonun bütün amacı odur.
            for (var c = 1; c < clips.Count; c++)
            {
                var prevEnd = clips[c - 1].TimelineStartUs + clips[c - 1].TimelineDurationUs;
                if (clips[c].TimelineStartUs < prevEnd)
                {
                    throw new InvalidTimelineException(
                        $"clips '{clips[c - 1].Id}' and '{clips[c].Id}' overlap or are out of order "
                        + $"(previous ends at {prevEnd} us, next starts at {clips[c].TimelineStartUs} us).");
                }
            }

            var last = clips[^1];
            totalDurationUs = Math.Max(
                totalDurationUs,
                SnapUs(last.TimelineStartUs + last.TimelineDurationUs, fpsNum, fpsDen));
            trackPlans.Add(new ExportTrackPlan(track, i, clips));

            // Defterler (ExportPlan yorumuna bakınız): atıl klip hiçbir giriş açmaz →
            // ne indirilir ne kaynak-aralığı kapısına girer; görsel klip indirilir ama
            // kaynak aralığı OKUMAZ (zaman ekseni yok).
            foreach (var clip in clips)
            {
                if (IsInert(clip, track))
                {
                    continue;
                }

                assetIds.Add(clip.AssetId);
                if (clip.Kind != MediaClipKind.Image)
                {
                    sourceRangeClips.Add(clip);
                }
            }
        }

        if (trackPlans.Count == 0)
        {
            throw new InvalidTimelineException("timeline has no clips — nothing to export.");
        }

        if (totalDurationUs <= 0)
        {
            throw new InvalidTimelineException("timeline duration is shorter than one output frame.");
        }

        return new ExportPlan(
            doc, trackPlans, sourceRangeClips, assetIds.Distinct().ToList(), totalDurationUs,
            fpsNum, fpsDen, width, height);
    }

    /// <summary>
    /// Derleme: plan + asset kaynak yolları + profil → deterministik CompiledExport.
    /// sources her plan.AssetIds öğesi için dolu olmalıdır (worker garanti eder).
    /// </summary>
    public static CompiledExport Compile(
        TimelineDoc doc,
        IReadOnlyDictionary<Guid, ExportAssetSource> sources,
        ExportProfile profile)
    {
        var plan = Validate(doc);
        foreach (var assetId in plan.AssetIds)
        {
            if (!sources.ContainsKey(assetId))
            {
                throw new ArgumentException(
                    $"no source provided for asset {assetId}.", nameof(sources));
            }
        }

        var fpsArg = TimeFormat.Fps(plan.FpsNum, plan.FpsDen);
        var background = FfmpegColor(plan.Doc.Settings.BackgroundColor);
        var inputs = new List<ExportInput>();
        var videoLines = new List<string>();
        var audioLines = new List<string>();
        var runs = new List<LayerRun>();
        var totalFrames = FrameOf(plan.TotalDurationUs, plan.FpsNum, plan.FpsDen);

        // ── 1) Girişleri aç + görsel klipleri KATMAN RUN'LARINA topla + ses zincirlerini kur.
        //      Giriş sırası render sırasıdır (plan.Tracks sondan başa: en alt katman önce).
        foreach (var trackPlan in plan.Tracks)
        {
            LayerRun? open = null;
            for (var i = 0; i < trackPlan.Clips.Count; i++)
            {
                var clip = trackPlan.Clips[i];

                // Atıl klip (gizli track + şema gereği sessiz): giriş bile açılmaz, asset'i
                // plan.AssetIds'te de yoktur — sources[] araması YAPILMAZ.
                if (IsInert(clip, trackPlan.Track))
                {
                    open = null;
                    continue;
                }

                var source = sources[clip.AssetId];

                // hidden = YALNIZ görsel gizleme (resolve.ts semantiği): ses üretilmeye devam eder.
                var isVisual = !trackPlan.Track.Hidden && clip.Kind != MediaClipKind.Audio;
                var audio = AudibleAudioOf(clip, trackPlan.Track, source);
                if (!isVisual && audio is null)
                {
                    open = null;
                    continue; // ne görüntü ne ses — giriş bile açılmaz
                }

                var startFrame = FrameOf(clip.TimelineStartUs, plan.FpsNum, plan.FpsDen);
                var endFrame = FrameOf(
                    clip.TimelineStartUs + clip.TimelineDurationUs, plan.FpsNum, plan.FpsDen);
                var startUs = UsOf(startFrame, plan.FpsNum, plan.FpsDen);

                var inputIndex = inputs.Count;
                inputs.Add(InputFor(clip, source, endFrame - startFrame, plan));

                if (isVisual)
                {
                    var placement = LayerGeometry.Compute(clip.Transform, plan.Width, plan.Height);

                    // Run'a katılma koşulu: ÖNCEKİ görsel klip frame-bitişik bitiyor, yerleşim
                    // BİREBİR aynı ve yerleşim concat'e uygun. Değilse yeni run (= bugünkü
                    // klip-başına overlay davranışı).
                    if (open is null || open.EndFrame != startFrame
                        || open.Placement != placement || !CanConcatRun(placement))
                    {
                        open = new LayerRun(placement, startFrame) { EndFrame = endFrame };
                        runs.Add(open);
                    }
                    else
                    {
                        open.EndFrame = endFrame;
                    }

                    open.Segments.Add(new LayerSegment(inputIndex, clip, source, endFrame - startFrame));
                }
                else
                {
                    open = null; // görsel süreklilik kırıldı (ses klibi / gizli track)
                }

                if (audio is not null)
                {
                    var prevClip = i > 0 ? trackPlan.Clips[i - 1] : null;
                    var nextClip = i + 1 < trackPlan.Clips.Count ? trackPlan.Clips[i + 1] : null;
                    audioLines.Add(BuildAudioChain(
                        clip, audio, prevClip, nextClip, inputIndex, startUs, audioLines.Count));
                }
            }
        }

        // ── 2) Video grafiği. Tek katmanlı hızlı yol: TEK run timeline'ı baştan sona kaplıyor,
        //      yerleşim birim, opaklık 1 → kompozisyon YOK, dolayısıyla taban tuval ve overlay
        //      de yok (M3 hattı: scale + letterbox pad + concat).
        var singleCover = runs.Count == 1
            && runs[0].StartFrame == 0
            && runs[0].EndFrame == totalFrames
            && CoversCanvas(runs[0].Placement, plan.Width, plan.Height)
            && runs[0].Segments.All(s => s.Clip.Opacity >= 1d);

        string composite;
        if (singleCover)
        {
            composite = EmitRun(videoLines, runs[0], plan, fpsArg, background, opaque: true, 0);
        }
        else
        {
            // ── Taban tuval: proje çözünürlüğünde, TAM toplam frame sayısı kadar (frame defteri).
            //    color d= bir frame CÖMERT verilir; trim=end_frame kesin sayıyı garanti eder
            //    (d'nin µs yuvarlaması kaynak frame sayısını belirleyemez).
            var canvasHeadroomUs = UsOf(totalFrames + 1, plan.FpsNum, plan.FpsDen);
            //    Tuval RGB'dir: kompozisyon RGB'de yapılır (§6.3) ve settings.backgroundColor zaten
            //    RGB hex'tir — araya yuv420p sokmak arka plan rengini gereksizce yuvarlardı.
            videoLines.Add(
                $"color=c={background}:s={plan.Width}x{plan.Height}:r={fpsArg}:d={TimeFormat.Sec(canvasHeadroomUs)},"
                + $"trim=end_frame={totalFrames.ToString(CultureInfo.InvariantCulture)},"
                + "format=rgba,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[base]");

            // enable penceresinin bitişi yarım frame geri çekilir: bitişik iki run'da aynı t
            // değeri iki overlay'i birden tetiklemesin (tasarım 04 §8 tuzak 9).
            var halfFrameUs = UsOf(1, plan.FpsNum, plan.FpsDen) / 2;

            composite = "base";
            for (var n = 0; n < runs.Count; n++)
            {
                var run = runs[n];
                var label = EmitRun(videoLines, run, plan, fpsArg, background, opaque: false, n);
                var next = $"c{n.ToString(CultureInfo.InvariantCulture)}";
                var placement = run.Placement;
                var startUs = UsOf(run.StartFrame, plan.FpsNum, plan.FpsDen);
                var endEnableUs = UsOf(run.EndFrame, plan.FpsNum, plan.FpsDen) - halfFrameUs;
                videoLines.Add(
                    $"[{composite}][{label}]overlay="
                    + $"x={OverlayCoordinate(placement.AnchorTargetX, placement.OverlayAnchorFactorX, "w")}"
                    + $":y={OverlayCoordinate(placement.AnchorTargetY, placement.OverlayAnchorFactorY, "h")}"
                    + $":enable='between(t,{TimeFormat.Sec(startUs)},{TimeFormat.Sec(endEnableUs)})'"
                    + ":eval=frame"
                    // §6.3: kompozisyon DAİMA RGB'de — grafik başına tek mod (denetim #1/#15).
                    + CompositeFormat
                    + $"[{next}]");
                composite = next;
            }
        }

        // Kompozisyon SONRASI setparams frame'leri BT.709/tv işaretler — ffmpeg 7+/8 çıktı renk
        // tag'lerini filtergraph frame metadata'sından alır; CLI -color_* bayrakları tek başına
        // EZİLİR (bayraklar emniyet kemeri olarak profilde durmaya devam eder).
        videoLines.Add($"[{composite}]" + OutputColorParams + "[vout]");

        var lines = new List<string>(videoLines.Count + audioLines.Count + 1);
        lines.AddRange(videoLines);
        lines.AddRange(audioLines);

        // Ses: parçalar amix=normalize=0 + alimiter (rendering-semantics §8.3); hiç ses yoksa
        // toplam süre kadar sessizlik (anullsrc sonsuzdur — atrim şart).
        if (audioLines.Count > 0)
        {
            lines.Add(
                string.Concat(Enumerable.Range(0, audioLines.Count).Select(i => $"[a{i}]"))
                + $"amix=inputs={audioLines.Count.ToString(CultureInfo.InvariantCulture)}"
                + ":duration=longest:normalize=0,alimiter=limit=0.98[aout]");
        }
        else
        {
            lines.Add(
                "anullsrc=channel_layout=stereo:sample_rate=48000,"
                + $"atrim=duration={TimeFormat.Sec(plan.TotalDurationUs)}[aout]");
        }

        return new CompiledExport(
            inputs,
            string.Join(";\n", lines),
            ExportProfiles.BuildOutputArgs(profile, plan.FpsNum, plan.FpsDen),
            plan.TotalDurationUs);
    }

    // ───────────────────────── Katman run'ları ─────────────────────────

    /// <summary>Run içindeki tek klip: hangi giriş, hangi kaynak, kaç frame.</summary>
    private sealed record LayerSegment(
        int InputIndex, MediaClip Clip, ExportAssetSource Source, long Frames);

    /// <summary>
    /// Aynı track'te ARDIŞIK (frame-bitişik) ve AYNI yerleşimli kliplerin oluşturduğu tek katman
    /// akışı. Segmentler tek concat zincirinde birleşir → tuvale TEK overlay biner. Klip başına
    /// overlay yalnız gerçek katmanlaşmada üretilir (M4 dalga 1 denetimi: performans regresyonu).
    /// </summary>
    private sealed record LayerRun(LayerPlacement Placement, long StartFrame)
    {
        public long EndFrame { get; set; }

        public List<LayerSegment> Segments { get; } = [];
    }

    /// <summary>
    /// Bir yerleşim concat'lenebilir mi? Run'daki segmentler concat için AYNI BOYUTTA olmalıdır;
    /// scale <c>force_original_aspect_ratio=decrease</c> kullandığı için gerçek boyut KAYNAĞIN
    /// aspect'ine bağlıdır (compiler kaynak boyutunu bilmez) → segmentler yerleşim kutusuna
    /// simetrik şeffaf pad ile normalize edilir. Bu pad'in geometriyi KAYDIRMAMASI iki şart ister:
    ///  - çapa MERKEZDE (overlay telafi çarpanı 0.5): simetrik pad merkezi korur, çapa
    ///    merkezdeyse §2.5'in <c>P - 0.5*w</c> formülü pad'li ve pad'siz halde AYNI pikseli verir;
    ///    merkez dışı çapada pad, çapayı görüntü içindeki oranından kaydırırdı;
    ///  - kutu ÇİFT boyutlu: pad ofseti <c>(ow-iw)/2</c> tamsayı bölmedir; kutu ve ölçek çıktısı
    ///    (force_divisible_by=2 sayesinde) çift olduğunda ofset TAM bölünür, aksi halde katman
    ///    yarım piksel kayardı.
    /// Şart sağlanmazsa run tek segmentte kalır ve bugünkü klip-başına overlay yolu kullanılır.
    /// </summary>
    private static bool CanConcatRun(LayerPlacement placement) =>
        placement.OverlayAnchorFactorX == 0.5d
        && placement.OverlayAnchorFactorY == 0.5d
        && !placement.NeedsAnchorPad
        && placement.BoxWidth % 2 == 0
        && placement.BoxHeight % 2 == 0;

    /// <summary>
    /// Yerleşim proje tuvalinin TAMAMINI birim dönüşümle kaplıyor mu (scale=1, merkez çapa,
    /// dönme yok, kaydırma yok)? Böyle bir katman için <c>overlay x = W/2 - 0.5*w</c> ile
    /// <c>pad=W:H:(ow-iw)/2</c> AYNI pikseli verir (W ve w çift) — tuval + overlay yerine
    /// letterbox pad kullanılabilir.
    /// </summary>
    private static bool CoversCanvas(LayerPlacement placement, int width, int height) =>
        !placement.Rotates
        && placement.BoxWidth == width
        && placement.BoxHeight == height
        && placement.OverlayAnchorFactorX == 0.5d
        && placement.OverlayAnchorFactorY == 0.5d
        && placement.AnchorTargetX == width / 2d
        && placement.AnchorTargetY == height / 2d;

    /// <summary>
    /// Run'ı grafiğe yazar ve akış etiketini döndürür.
    /// Tek segmentli run = bugünkü klip zinciri (bayt bayt aynı çıktı). Çok segmentli run:
    /// her segment kendi zincirini kurar (kutuya normalize pad ile), sonra tek concat.
    /// <paramref name="opaque"/> = tek katmanlı hızlı yol: kompozisyon yoktur, segmentler proje
    /// tuvaline arka plan rengiyle letterbox pad'lenip yuv420p'de birleşir (M3 hattı).
    /// </summary>
    private static string EmitRun(
        List<string> lines, LayerRun run, ExportPlan plan, string fpsArg,
        string background, bool opaque, int labelIndex)
    {
        var label = $"v{labelIndex.ToString(CultureInfo.InvariantCulture)}";
        var startUs = UsOf(run.StartFrame, plan.FpsNum, plan.FpsDen);
        var single = run.Segments.Count == 1;

        // Tek segmentli run'da segment zincirinin sonuna timeline ofseti doğrudan eklenir;
        // çok segmentlide ofset CONCAT SONRASINA taşınır (segmentler 0'dan başlamalı).
        var segmentLabels = new List<string>(run.Segments.Count);
        for (var i = 0; i < run.Segments.Count; i++)
        {
            var segment = run.Segments[i];
            var outLabel = single
                ? label
                : $"s{labelIndex.ToString(CultureInfo.InvariantCulture)}"
                  + $"_{i.ToString(CultureInfo.InvariantCulture)}";
            segmentLabels.Add(outLabel);
            lines.Add(
                $"[{segment.InputIndex.ToString(CultureInfo.InvariantCulture)}:v]"
                + BuildVideoChain(segment, run.Placement, plan, fpsArg, background,
                    opaque, normalizeToBox: !single)
                + "," + SetPtsFilter(single ? startUs : 0)
                + $"[{outLabel}]");
        }

        if (!single)
        {
            var offset = startUs > 0 ? "," + SetPtsFilter(startUs) : "";
            lines.Add(
                string.Concat(segmentLabels.Select(l => $"[{l}]"))
                + $"concat=n={run.Segments.Count.ToString(CultureInfo.InvariantCulture)}:v=1:a=0"
                + offset + $"[{label}]");
        }

        return label;
    }

    /// <summary>
    /// Klibi timeline'daki yerine kaydıran setpts (tasarım 04 §2.2): setpts olmadan overlay
    /// ilk frame'den itibaren gösterir. enable ile BİRLİKTE kullanılır.
    /// </summary>
    private static string SetPtsFilter(long startUs) => startUs > 0
        ? $"setpts=PTS-STARTPTS+{TimeFormat.Sec(startUs)}/TB"
        : "setpts=PTS-STARTPTS";

    // ───────────────────────── Video katman zinciri ─────────────────────────

    /// <summary>
    /// Katman zinciri (rendering-semantics §2.3 sırası + §6):
    /// [HDR tonemap] → setparams(BT.709/tv, §6.1) → fps → trim=end_frame →
    /// scale(fit=contain × scale) → setsar=1 → format=rgba → [kutuya normalize pad] →
    /// [colorchannelmixer=aa (opaklık, §6.3)] → [çapa pad'i] → [rotate c=none] → settb=AVTB.
    /// Timeline ofseti (setpts) çağıran tarafta eklenir — run'da concat SONRASINA taşınır.
    /// <paramref name="opaque"/>: tek katmanlı hızlı yol — RGB kompozisyon yoktur, katman proje
    /// tuvaline ARKA PLAN rengiyle letterbox pad'lenir ve yuv420p'de kalır (M3 hattı; alpha
    /// taşımadığı için concat/encode zinciri hiç RGB'ye çıkmaz).
    /// </summary>
    private static string BuildVideoChain(
        LayerSegment segment, LayerPlacement placement, ExportPlan plan,
        string fpsArg, string background, bool opaque, bool normalizeToBox)
    {
        var clip = segment.Clip;
        var chain = new List<string>();
        if (segment.Source.IsHdr)
        {
            chain.Add(ColorChain.ForSource(segment.Source.ColorTransfer));
        }

        // §6.1: kaynak renk varsayımı RGB'ye geçişten ÖNCE beyan edilir — sonra beyan etmek
        // dönüşümü etkilemez, yalnız etiketi düzeltir (ve renkler kayar).
        chain.Add(SourceColorParams);
        chain.Add($"fps={fpsArg}");
        chain.Add($"trim=end_frame={segment.Frames.ToString(CultureInfo.InvariantCulture)}");

        // fit=contain (§2.2) ve transform.scale (§2.3 adım 1-2) TEK ölçekte birleşir: hedef
        // kutu proje tuvalinin scale katıdır, force_original_aspect_ratio=decrease aspect'i
        // korur → sonuç tam olarak w_fit*scale × h_fit*scale. Tek resample = tek yumuşama.
        chain.Add($"scale={placement.BoxWidth.ToString(CultureInfo.InvariantCulture)}"
                  + $":{placement.BoxHeight.ToString(CultureInfo.InvariantCulture)}"
                  + ":force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic");

        if (opaque)
        {
            // Hızlı yol = M3 hattı: taban tuval yerine letterbox pad. Kutu proje tuvalidir ve
            // çapa merkezdedir (CoversCanvas), dolayısıyla ortalanmış pad, taban tuvale
            // yapılan overlay ile BİREBİR aynı pikselleri verir. Bu pad aynı zamanda concat'in
            // istediği boyut normalizasyonudur — normalizeToBox'a ayrıca gerek yoktur.
            chain.Add($"pad={plan.Width.ToString(CultureInfo.InvariantCulture)}"
                      + $":{plan.Height.ToString(CultureInfo.InvariantCulture)}"
                      + $":(ow-iw)/2:(oh-ih)/2:color={background}");
            chain.Add("setsar=1");
            chain.Add("format=yuv420p");
            chain.Add("settb=AVTB");
            return string.Join(',', chain);
        }

        chain.Add("setsar=1");

        // §6.3: kompozisyon RGB'de yapılır → HER katman rgba ile girer (overlay'in alpha'lı
        // giriş formatı zaten rgba'dır; opak katmanı yuv420p bırakmak overlay'e sessiz bir
        // dönüşüm sokar ve ölçekleme chroma'yı gereksizce alt örneklerdi).
        chain.Add("format=rgba");

        if (normalizeToBox)
        {
            // concat girişleri AYNI boyutta olmalı; gerçek ölçek çıktısı kaynağın aspect'ine
            // bağlıdır → şeffaf, SİMETRİK pad ile kutuya sabitlenir. CanConcatRun bu pad'in
            // geometriyi kaydırmadığını (merkez çapa + çift kutu) garanti eder.
            chain.Add($"pad={placement.BoxWidth.ToString(CultureInfo.InvariantCulture)}"
                      + $":{placement.BoxHeight.ToString(CultureInfo.InvariantCulture)}"
                      + $":(ow-iw)/2:(oh-ih)/2:color={TransparentPad}");
        }

        if (clip.Opacity < 1)
        {
            // §6.3: src.a *= opacity (straight alpha), statik değer — keyframe'li opaklık M5.
            chain.Add($"colorchannelmixer=aa={Num(clip.Opacity)}");
        }

        if (placement.Rotates)
        {
            if (placement.NeedsAnchorPad)
            {
                // Çapayı tuval merkezine getiren şeffaf pad — rotate merkez etrafında döndüğü
                // için bu, ÇAPA etrafında dönmenin birebir karşılığıdır (§2.5 telafi formülü).
                chain.Add($"pad=w=iw*{Num(placement.PadWidthFactor)}:h=ih*{Num(placement.PadHeightFactor)}"
                          + $":x=iw*{Num(placement.PadXFactor)}:y=ih*{Num(placement.PadYFactor)}"
                          + $":color={TransparentPad}");
            }

            // ow=oh=hypot(iw,ih) (= §2.5'in Dg'si) dönen kutuyu her açıda kapsar; c=none şeffaf
            // arka plan. Bu tuvalin BÜYÜKLÜĞÜ LayerPlacement.Intermediate* ile önceden hesaplanıp
            // MaxLayerDimension'a karşı doğrulanmıştır (denetim #2) — buradaki ifade ffmpeg'in
            // gerçek iw/ih'siyle aynı değeri config anında bir kez üretir.
            // Filtergraph içinde argüman virgülü KAÇIRILMALIDIR (\,) — aksi halde filtre ayracı sanılır.
            chain.Add($"rotate=a={Num(placement.RotationRad)}:c=none:ow=hypot(iw\\,ih):oh=ow");
        }

        chain.Add("settb=AVTB");
        return string.Join(',', chain);
    }

    /// <summary>
    /// Klibin ffmpeg girişi. Video/ses klibi: input-level trim (-ss/-t, §2.1). GÖRSEL klip:
    /// dosyada zaman ekseni yoktur → <c>-loop 1 -t</c>; -t bir frame CÖMERT verilir (görsel
    /// demuxer'ının kendi fps'i proje fps'inden farklı olabilir), kesin kare sayısını zincirdeki
    /// <c>trim=end_frame</c> sabitler — taban tuvaldeki <c>d=</c> + trim deseninin aynısı.
    /// </summary>
    private static ExportInput InputFor(
        MediaClip clip, ExportAssetSource source, long clipFrames, ExportPlan plan) =>
        clip.Kind == MediaClipKind.Image
            ? new ExportInput(source.Path, 0, UsOf(clipFrames + 1, plan.FpsNum, plan.FpsDen), Loop: true)
            : new ExportInput(source.Path, clip.SourceInUs, clip.SourceOutUs - clip.SourceInUs);

    /// <summary>overlay_x = P.x - anchorFactor * &lt;w|h&gt; (§2.5); çarpan 0 ise sade sabit.</summary>
    private static string OverlayCoordinate(double target, double anchorFactor, string dimension) =>
        anchorFactor == 0
            ? Num(target)
            : $"{Num(target)}-{Num(anchorFactor)}*{dimension}";

    // ───────────────────────── Klip doğrulaması ─────────────────────────

    private static MediaClip ValidateClip(Clip clip, int width, int height)
    {
        if (clip is not MediaClip media)
        {
            var kind = clip switch
            {
                TextClip => "text",
                ShapeClip => "shape",
                StickerClip => "sticker",
                _ => clip.GetType().Name,
            };
            var kindTr = clip switch
            {
                TextClip => "metin",
                ShapeClip => "şekil",
                StickerClip => "çıkartma",
                _ => kind,
            };
            throw new UnsupportedFeatureException($"{kind}-clip",
                $"Timeline'da {kindTr} klibi var — {kindTr} klipleri dışa aktarıcıda henüz "
                + "desteklenmiyor (overlay varlıkları M4 dalga 2'de geliyor). Dışa aktarmadan "
                + "önce bu klipleri kaldırın.");
        }

        if (media.Speed is not { Rate: 1 })
        {
            throw new UnsupportedFeatureException("speed",
                $"'{media.Id}' klibinde hız değişimi var (speed.rate="
                + $"{(media.Speed?.Rate ?? 0).ToString(CultureInfo.InvariantCulture)}) — "
                + "hız değişimi henüz desteklenmiyor (M4 dalga 2'de geliyor).");
        }

        if (media.TransitionIn is not null || media.TransitionOut is not null)
        {
            throw new UnsupportedFeatureException("transition",
                $"'{media.Id}' klibinde geçiş (transition) var — geçişler henüz desteklenmiyor "
                + "(M4 dalga 2'de geliyor). Geçişi kaldırıp yeniden deneyin.");
        }

        if (HasAnyKeyframes(media.Keyframes))
        {
            throw new UnsupportedFeatureException("keyframes",
                $"'{media.Id}' klibinde keyframe animasyonu var — keyframe'ler henüz "
                + "desteklenmiyor (M5'te geliyor).");
        }

        if (media.Effects is { Count: > 0 } && media.Effects.Any(e => e.Enabled))
        {
            throw new UnsupportedFeatureException("effects",
                $"'{media.Id}' klibinde etkin efekt var — efektler henüz desteklenmiyor "
                + "(M4 dalga 2'de geliyor). Efektleri kapatıp yeniden deneyin.");
        }

        ValidateGeometry(media, width, height);

        if (media.SourceInUs < 0 || media.SourceOutUs <= media.SourceInUs)
        {
            throw new InvalidTimelineException(
                $"clip '{media.Id}' has an invalid source range "
                + $"[{media.SourceInUs}..{media.SourceOutUs}] us.");
        }

        // Süre formülü (rendering-semantics §1.3); rate=1 olduğundan tam eşitlik beklenir.
        var expectedDurationUs = Timecode.ClipTimelineDurationUs(
            media.SourceInUs, media.SourceOutUs, 1d);
        if (media.TimelineDurationUs != expectedDurationUs)
        {
            throw new InvalidTimelineException(
                $"clip '{media.Id}' violates the duration contract: timelineDurationUs="
                + $"{media.TimelineDurationUs} but (sourceOutUs - sourceInUs)/rate={expectedDurationUs}.");
        }

        if (media.Audio is { } audio)
        {
            if (audio.Volume is < 0 or > 2)
            {
                throw new InvalidTimelineException(
                    $"clip '{media.Id}' audio.volume must be within [0..2].");
            }

            if (audio.FadeInUs < 0 || audio.FadeOutUs < 0
                || audio.FadeInUs + audio.FadeOutUs > media.TimelineDurationUs)
            {
                throw new InvalidTimelineException(
                    $"clip '{media.Id}' audio fades ({audio.FadeInUs}+{audio.FadeOutUs} us) "
                    + $"exceed the clip duration ({media.TimelineDurationUs} us).");
            }
        }

        return media;
    }

    /// <summary>
    /// Transform/opaklık sözleşmesi (rendering-semantics §2 + şema sınırları). Ses klibi
    /// görsel katman üretmediği için geometri doğrulaması ATLANIR.
    /// </summary>
    private static void ValidateGeometry(MediaClip media, int width, int height)
    {
        // Bu mesajlar 422 ProblemDetails.Detail olarak KULLANICIYA görünür (ExportEndpoints) —
        // kardeş UnsupportedFeature mesajlarıyla aynı dilde olmalıdır (M4 dalga 1 denetimi).
        if (media.Opacity is < 0 or > 1 || double.IsNaN(media.Opacity))
        {
            throw new InvalidTimelineException(
                $"'{media.Id}' klibinin opaklığı [0..1] aralığında olmalı "
                + $"(gelen değer {media.Opacity.ToString(CultureInfo.InvariantCulture)}).");
        }

        if (media.Kind == MediaClipKind.Audio)
        {
            return;
        }

        var transform = media.Transform
            ?? throw new InvalidTimelineException($"'{media.Id}' klibinde transform bilgisi yok.");

        if (!double.IsFinite(transform.X) || !double.IsFinite(transform.Y)
            || !double.IsFinite(transform.Scale) || !double.IsFinite(transform.RotationDeg)
            || !double.IsFinite(transform.AnchorX) || !double.IsFinite(transform.AnchorY))
        {
            throw new InvalidTimelineException(
                $"'{media.Id}' klibinin transform değerlerinden biri sonlu bir sayı değil.");
        }

        if (transform.AnchorX is < 0 or > 1 || transform.AnchorY is < 0 or > 1)
        {
            throw new InvalidTimelineException(
                $"'{media.Id}' klibinin çapa (anchor) noktası [0..1] aralığında olmalı.");
        }

        if (transform.Scale <= 0)
        {
            throw new InvalidTimelineException(
                $"'{media.Id}' klibinin ölçeği pozitif olmalı "
                + $"(gelen değer {transform.Scale.ToString(CultureInfo.InvariantCulture)}).");
        }

        var placement = LayerGeometry.Compute(transform, width, height);
        if (placement.BoxWidth < 2 || placement.BoxHeight < 2)
        {
            throw new InvalidTimelineException(
                $"'{media.Id}' klibinin ölçeği katmanı bir pikselin altına düşürüyor.");
        }

        // Tavan ARA TUVALDEN doğrulanır (denetim #2): çapa telafisi pad'i kutuyu 2x'e,
        // rotate hypot'u ~1.41x'e büyütür — kutuyu doğrulamak gerçek tavanı ~23170 piksele
        // (rgba'da ~2.1 GB/kare, worker OOM) taşırdı. Mesaj hem kutuyu hem ara tuvali verir ki
        // kullanıcı "ölçek küçük ama neden reddedildi" sorusunun cevabını görsün.
        if (placement.IntermediateWidth > LayerGeometry.MaxLayerDimension
            || placement.IntermediateHeight > LayerGeometry.MaxLayerDimension)
        {
            var rotationNote = placement.Rotates
                ? " (dönme, katmanı köşegeni kadar büyük bir ara tuvale açar"
                  + (placement.NeedsAnchorPad ? "; merkez dışı çapa bu tuvali ayrıca büyütür)" : ")")
                : "";
            throw new UnsupportedFeatureException("transform-scale",
                $"'{media.Id}' klibinin ölçeği çok büyük: katman "
                + $"{placement.BoxWidth.ToString(CultureInfo.InvariantCulture)}x"
                + $"{placement.BoxHeight.ToString(CultureInfo.InvariantCulture)} piksele, "
                + "ara tuval "
                + $"{placement.IntermediateWidth.ToString(CultureInfo.InvariantCulture)}x"
                + $"{placement.IntermediateHeight.ToString(CultureInfo.InvariantCulture)} piksele çıkıyor"
                + rotationNote
                + $"; üst sınır {LayerGeometry.MaxLayerDimension.ToString(CultureInfo.InvariantCulture)}. "
                + "Ölçeği (gerekirse dönme açısını) küçültüp yeniden deneyin.");
        }
    }

    private static bool HasAnyKeyframes(KeyframeTracks? keyframes) =>
        keyframes is not null
        && (keyframes.X is { Count: > 0 }
            || keyframes.Y is { Count: > 0 }
            || keyframes.Scale is { Count: > 0 }
            || keyframes.RotationDeg is { Count: > 0 }
            || keyframes.Opacity is { Count: > 0 }
            || keyframes.Volume is { Count: > 0 });

    // ───────────────────────── Ses zinciri ─────────────────────────

    /// <summary>
    /// Klibin DOKÜMANDA BEYAN EDİLEN ses ayarı (kaynağa bakmadan), yoksa null. apps/editor
    /// resolve.ts (clipAudioOf + isClipMuted) ile birebir aynı semantik:
    ///  - video klibi: gömülü ses; audio alanı null ise (detach) ses YOK;
    ///  - ses klibi: kendi sesi; null alan birim kazanca düşer;
    ///  - görsel klibi: hiç ses yok (still image ses taşımaz);
    ///  - track.muted ya da clip.audio.muted → ses YOK; track.hidden ses üretimini ETKİLEMEZ.
    /// </summary>
    private static ClipAudio? DeclaredAudioOf(MediaClip clip, Track track)
    {
        if (track.Muted || clip.Kind == MediaClipKind.Image)
        {
            return null;
        }

        var audio = clip.Kind == MediaClipKind.Audio
            ? clip.Audio ?? new ClipAudio { Volume = 1, FadeInUs = 0, FadeOutUs = 0, Muted = false }
            : clip.Audio;
        return audio is { Muted: false } ? audio : null;
    }

    /// <summary>
    /// Klibin DUYULABİLİR ses ayarı: beyan edilen ses + kaynakta gerçekten ses stream'i olması.
    /// </summary>
    private static ClipAudio? AudibleAudioOf(MediaClip clip, Track track, ExportAssetSource source) =>
        source.HasAudio ? DeclaredAudioOf(clip, track) : null;

    /// <summary>
    /// ATIL klip: track GİZLİ ve klip şema gereği ses de üretemiyor → ne görüntü ne ses.
    /// Böyle bir klip hiçbir ffmpeg girişi açmaz; asset'i indirmeye (plan.AssetIds) ve worker'ın
    /// kaynak-aralığı kapısına (plan.Clips) sokmaya da gerek yoktur — render EDİLMEYEN bir klibin
    /// tüm export'u "source-out-of-range" ile düşürmesi böylece imkânsızlaşır (M4 dalga 1 denetimi).
    /// Kaynağa bağlı olmayan (yalnız dokümandan okunan) bir karardır: Validate'te de,
    /// Compile'da da AYNI sonucu verir.
    /// </summary>
    private static bool IsInert(MediaClip clip, Track track) =>
        track.Hidden && DeclaredAudioOf(clip, track) is null;

    /// <summary>
    /// Klip ses zinciri (rendering-semantics §8 + görev sözleşmesi):
    /// asetpts → aformat → volume → afade in/out (curve=tri) → 5 ms micro-fade (§8.4) → adelay.
    /// No-op filtreler (volume=1, fade=0, delay=0) determinism ve hız için ÜRETİLMEZ — snapshot
    /// sabitler.
    /// Micro-fade kuralı (§8.4, preview'daki gain.ts ile aynı mantık): her sert kesim kenarına
    /// 5 ms lineer fade; o kenarda kullanıcı fade'i varsa atlanır (fade zaten sıfıra iner);
    /// seamless splice istisnası — AYNI TRACK'te bitişik + aynı asset + B.sourceIn==A.sourceOut
    /// + aynı rate ise ortak kenarda micro-fade uygulanmaz (split edilmiş klipte ses çukuru olmasın).
    /// </summary>
    private static string BuildAudioChain(
        MediaClip clip, ClipAudio audio, MediaClip? prevClip, MediaClip? nextClip,
        int inputIndex, long startSnappedUs, int audioIndex)
    {
        var durationUs = clip.SourceOutUs - clip.SourceInUs;
        var parts = new List<string>
        {
            "asetpts=PTS-STARTPTS",
            "aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000",
        };

        if (audio.Volume != 1)
        {
            parts.Add($"volume={Num(audio.Volume)}");
        }

        if (audio.FadeInUs > 0)
        {
            parts.Add($"afade=t=in:st=0:d={TimeFormat.Sec(audio.FadeInUs)}:curve=tri");
        }

        if (audio.FadeOutUs > 0)
        {
            parts.Add(
                $"afade=t=out:st={TimeFormat.Sec(durationUs - audio.FadeOutUs)}"
                + $":d={TimeFormat.Sec(audio.FadeOutUs)}:curve=tri");
        }

        // §8.4 micro-fade'ler: kullanıcı fade'i o kenarı zaten sıfıra indiriyorsa ya da kenar
        // seamless splice ise atlanır; klip 5 ms'den kısaysa (teorik uç) hiç üretilmez.
        var microIn = audio.FadeInUs <= 0
                      && !(prevClip is not null && IsSeamlessSplice(prevClip, clip))
                      && durationUs > MicroFadeUs;
        var microOut = audio.FadeOutUs <= 0
                       && !(nextClip is not null && IsSeamlessSplice(clip, nextClip))
                       && durationUs > MicroFadeUs;
        if (microIn)
        {
            parts.Add($"afade=t=in:st=0:d={TimeFormat.Sec(MicroFadeUs)}:curve=tri");
        }

        if (microOut)
        {
            parts.Add(
                $"afade=t=out:st={TimeFormat.Sec(durationUs - MicroFadeUs)}"
                + $":d={TimeFormat.Sec(MicroFadeUs)}:curve=tri");
        }

        var delayMs = (startSnappedUs + 500) / 1000; // µs → ms, half-up
        if (delayMs > 0)
        {
            var ms = delayMs.ToString(CultureInfo.InvariantCulture);
            parts.Add($"adelay={ms}|{ms}");
        }

        return $"[{inputIndex.ToString(CultureInfo.InvariantCulture)}:a]{string.Join(',', parts)}"
               + $"[a{audioIndex.ToString(CultureInfo.InvariantCulture)}]";
    }

    /// <summary>
    /// §8.4 seamless splice: aynı asset'in kaynağında tam bitişik devam — timeline'da boşluksuz,
    /// B.sourceIn == A.sourceOut ve rate eşit. Formül apps/editor gain.ts isSeamlessSplice ile
    /// birebir aynıdır (preview↔export paritesi).
    /// </summary>
    public static bool IsSeamlessSplice(MediaClip a, MediaClip b) =>
        a.AssetId == b.AssetId
        && a.Speed?.Rate == b.Speed?.Rate
        && a.TimelineStartUs + a.TimelineDurationUs == b.TimelineStartUs
        && a.SourceOutUs == b.SourceInUs;

    // ───────────────────────── Yardımcılar ─────────────────────────

    /// <summary>Proje fps grid'ine snap (rendering-semantics §1.4) — Timecode half-up sözleşmesiyle.</summary>
    private static long SnapUs(long us, int fpsNum, int fpsDen) =>
        UsOf(FrameOf(us, fpsNum, fpsDen), fpsNum, fpsDen);

    /// <summary>µs → proje grid frame numarası (rendering-semantics §1.4 frameFromUs).</summary>
    private static long FrameOf(long us, int fpsNum, int fpsDen) =>
        new Timecode(us).ToFrameNumber(fpsNum, fpsDen);

    /// <summary>Frame numarası → µs (rendering-semantics §1.4 usFromFrame).</summary>
    private static long UsOf(long frame, int fpsNum, int fpsDen) =>
        Timecode.FromFrameNumber(frame, fpsNum, fpsDen).Micros;

    /// <summary>Genel sayı literal'i — InvariantCulture, en fazla 6 kesir hanesi.</summary>
    private static string Num(double value) =>
        value.ToString("0.######", CultureInfo.InvariantCulture);

    /// <summary>
    /// Şema hex rengi (#RGB | #RRGGBB | #RRGGBBAA) → ffmpeg renk literal'i (0xRRGGBB).
    /// Alpha bileşeni kullanılmaz (taban tuval opak).
    /// </summary>
    private static string FfmpegColor(string? hex)
    {
        var value = (hex ?? "").TrimStart('#');
        var rgb = value.Length switch
        {
            3 => string.Concat(value.Select(c => new string(c, 2))),
            6 => value,
            8 => value[..6],
            _ => "000000",
        };
        return "0x" + rgb.ToUpperInvariant();
    }
}
