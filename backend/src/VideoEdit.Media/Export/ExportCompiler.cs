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
/// Clips tüm track'lerin kliplerinin render sırasında düzleştirilmiş halidir (worker'ın
/// kaynak-aralığı kapısı bunu kullanır).
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
/// FilterGraph Compiler v2 (M4 dalga 1 = çok katman kompozisyonu; geçiş/keyframe/efekt/hız
/// ve metin-şekil-çıkartma klipleri hâlâ tipli hata). TimelineDoc → deterministik
/// CompiledExport. Kurallar:
///  - trim INPUT seviyesinde -ss/-t (tasarım 04 §2.1; -to ASLA); aynı asset'ten N klip = N giriş;
///  - segment defteri FRAME SAYISIYLA tutulur: her klip proje fps grid'inde tam frame sayısına
///    çözülür ve zincire trim=end_frame=N eklenir — µs-farkı aritmetiğinin NTSC'de ürettiği
///    ±1 frame kaymaları biter (rendering-semantics §1.4);
///  - KOMPOZİSYON (tasarım 04 §2.2 + rendering-semantics §2.2): taban DAİMA proje
///    çözünürlüğünde settings.backgroundColor tuvalidir; her klip bu tuvale overlay edilir.
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
        var allClips = new List<MediaClip>();
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
            allClips.AddRange(clips);
        }

        if (trackPlans.Count == 0)
        {
            throw new InvalidTimelineException("timeline has no clips — nothing to export.");
        }

        if (totalDurationUs <= 0)
        {
            throw new InvalidTimelineException("timeline duration is shorter than one output frame.");
        }

        var assetIds = allClips.Select(c => c.AssetId).Distinct().ToList();
        return new ExportPlan(
            doc, trackPlans, allClips, assetIds, totalDurationUs,
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

        // ── Taban tuval: proje çözünürlüğünde, TAM toplam frame sayısı kadar (frame defteri).
        //    color d= bir frame CÖMERT verilir; trim=end_frame kesin sayıyı garanti eder
        //    (d'nin µs yuvarlaması kaynak frame sayısını belirleyemez).
        var totalFrames = FrameOf(plan.TotalDurationUs, plan.FpsNum, plan.FpsDen);
        var canvasHeadroomUs = UsOf(totalFrames + 1, plan.FpsNum, plan.FpsDen);
        //    Tuval RGB'dir: kompozisyon RGB'de yapılır (§6.3) ve settings.backgroundColor zaten
        //    RGB hex'tir — araya yuv420p sokmak arka plan rengini gereksizce yuvarlardı.
        videoLines.Add(
            $"color=c={background}:s={plan.Width}x{plan.Height}:r={fpsArg}:d={TimeFormat.Sec(canvasHeadroomUs)},"
            + $"trim=end_frame={totalFrames.ToString(CultureInfo.InvariantCulture)},"
            + "format=rgba,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[base]");

        // enable penceresinin bitişi yarım frame geri çekilir: bitişik iki klipte aynı t
        // değeri iki overlay'i birden tetiklemesin (tasarım 04 §8 tuzak 9).
        var halfFrameUs = UsOf(1, plan.FpsNum, plan.FpsDen) / 2;

        var composite = "base";
        var layerIndex = 0;

        // Render sırası: plan.Tracks zaten sondan başa (en alt katman önce) sıralıdır.
        foreach (var trackPlan in plan.Tracks)
        {
            for (var i = 0; i < trackPlan.Clips.Count; i++)
            {
                var clip = trackPlan.Clips[i];
                var source = sources[clip.AssetId];

                // hidden = YALNIZ görsel gizleme (resolve.ts semantiği): ses üretilmeye devam eder.
                var isVisual = !trackPlan.Track.Hidden && clip.Kind != MediaClipKind.Audio;
                var audio = AudibleAudioOf(clip, trackPlan.Track, source);
                if (!isVisual && audio is null)
                {
                    continue; // ne görüntü ne ses — giriş bile açılmaz
                }

                var startFrame = FrameOf(clip.TimelineStartUs, plan.FpsNum, plan.FpsDen);
                var endFrame = FrameOf(
                    clip.TimelineStartUs + clip.TimelineDurationUs, plan.FpsNum, plan.FpsDen);
                var startUs = UsOf(startFrame, plan.FpsNum, plan.FpsDen);

                var inputIndex = inputs.Count;
                inputs.Add(new ExportInput(
                    source.Path, clip.SourceInUs, clip.SourceOutUs - clip.SourceInUs));

                if (isVisual)
                {
                    var label = $"v{layerIndex.ToString(CultureInfo.InvariantCulture)}";
                    var next = $"c{layerIndex.ToString(CultureInfo.InvariantCulture)}";
                    var placement = LayerGeometry.Compute(clip.Transform, plan.Width, plan.Height);

                    videoLines.Add(
                        $"[{inputIndex.ToString(CultureInfo.InvariantCulture)}:v]"
                        + BuildVideoChain(clip, source, placement, fpsArg,
                            endFrame - startFrame, startUs)
                        + $"[{label}]");

                    var endEnableUs = UsOf(endFrame, plan.FpsNum, plan.FpsDen) - halfFrameUs;
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
                    layerIndex++;
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

    // ───────────────────────── Video katman zinciri ─────────────────────────

    /// <summary>
    /// Katman zinciri (rendering-semantics §2.3 sırası + §6):
    /// [HDR tonemap] → setparams(BT.709/tv, §6.1) → fps → trim=end_frame →
    /// scale(fit=contain × scale) → setsar=1 → format=rgba → [colorchannelmixer=aa
    /// (opaklık, §6.3)] → [çapa pad'i] → [rotate c=none] → settb=AVTB → setpts(+timeline konumu).
    /// </summary>
    private static string BuildVideoChain(
        MediaClip clip, ExportAssetSource source, LayerPlacement placement,
        string fpsArg, long clipFrames, long startUs)
    {
        var chain = new List<string>();
        if (source.IsHdr)
        {
            chain.Add(ColorChain.ForSource(source.ColorTransfer));
        }

        // §6.1: kaynak renk varsayımı RGB'ye geçişten ÖNCE beyan edilir — sonra beyan etmek
        // dönüşümü etkilemez, yalnız etiketi düzeltir (ve renkler kayar).
        chain.Add(SourceColorParams);
        chain.Add($"fps={fpsArg}");
        chain.Add($"trim=end_frame={clipFrames.ToString(CultureInfo.InvariantCulture)}");

        // fit=contain (§2.2) ve transform.scale (§2.3 adım 1-2) TEK ölçekte birleşir: hedef
        // kutu proje tuvalinin scale katıdır, force_original_aspect_ratio=decrease aspect'i
        // korur → sonuç tam olarak w_fit*scale × h_fit*scale. Tek resample = tek yumuşama.
        chain.Add($"scale={placement.BoxWidth.ToString(CultureInfo.InvariantCulture)}"
                  + $":{placement.BoxHeight.ToString(CultureInfo.InvariantCulture)}"
                  + ":force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic");
        chain.Add("setsar=1");

        // §6.3: kompozisyon RGB'de yapılır → HER katman rgba ile girer (overlay'in alpha'lı
        // giriş formatı zaten rgba'dır; opak katmanı yuv420p bırakmak overlay'e sessiz bir
        // dönüşüm sokar ve ölçekleme chroma'yı gereksizce alt örneklerdi).
        chain.Add("format=rgba");

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
                          + ":color=#00000000");
            }

            // ow=oh=hypot(iw,ih) (= §2.5'in Dg'si) dönen kutuyu her açıda kapsar; c=none şeffaf
            // arka plan. Bu tuvalin BÜYÜKLÜĞÜ LayerPlacement.Intermediate* ile önceden hesaplanıp
            // MaxLayerDimension'a karşı doğrulanmıştır (denetim #2) — buradaki ifade ffmpeg'in
            // gerçek iw/ih'siyle aynı değeri config anında bir kez üretir.
            // Filtergraph içinde argüman virgülü KAÇIRILMALIDIR (\,) — aksi halde filtre ayracı sanılır.
            chain.Add($"rotate=a={Num(placement.RotationRad)}:c=none:ow=hypot(iw\\,ih):oh=ow");
        }

        chain.Add("settb=AVTB");
        chain.Add(startUs > 0
            // Klibi timeline'daki yerine kaydırır (tasarım 04 §2.2): setpts olmadan overlay
            // ilk frame'den itibaren gösterir. enable ile BİRLİKTE kullanılır.
            ? $"setpts=PTS-STARTPTS+{TimeFormat.Sec(startUs)}/TB"
            : "setpts=PTS-STARTPTS");
        return string.Join(',', chain);
    }

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

        if (media.Kind == MediaClipKind.Image)
        {
            throw new UnsupportedFeatureException("image-clip",
                $"'{media.Id}' klibi bir görsel klibi — görsel klipleri dışa aktarıcıda henüz "
                + "desteklenmiyor (M4 dalga 2'de geliyor).");
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
        if (media.Opacity is < 0 or > 1 || double.IsNaN(media.Opacity))
        {
            throw new InvalidTimelineException(
                $"clip '{media.Id}' opacity must be within [0..1] "
                + $"(was {media.Opacity.ToString(CultureInfo.InvariantCulture)}).");
        }

        if (media.Kind == MediaClipKind.Audio)
        {
            return;
        }

        var transform = media.Transform
            ?? throw new InvalidTimelineException($"clip '{media.Id}' has no transform.");

        if (!double.IsFinite(transform.X) || !double.IsFinite(transform.Y)
            || !double.IsFinite(transform.Scale) || !double.IsFinite(transform.RotationDeg)
            || !double.IsFinite(transform.AnchorX) || !double.IsFinite(transform.AnchorY))
        {
            throw new InvalidTimelineException($"clip '{media.Id}' has a non-finite transform value.");
        }

        if (transform.AnchorX is < 0 or > 1 || transform.AnchorY is < 0 or > 1)
        {
            throw new InvalidTimelineException(
                $"clip '{media.Id}' transform anchor must be within [0..1].");
        }

        if (transform.Scale <= 0)
        {
            throw new InvalidTimelineException(
                $"clip '{media.Id}' transform.scale must be positive "
                + $"(was {transform.Scale.ToString(CultureInfo.InvariantCulture)}).");
        }

        var placement = LayerGeometry.Compute(transform, width, height);
        if (placement.BoxWidth < 2 || placement.BoxHeight < 2)
        {
            throw new InvalidTimelineException(
                $"clip '{media.Id}' transform.scale collapses the layer below one pixel.");
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
    /// Klibin DUYULABİLİR ses ayarı, yoksa null. apps/editor resolve.ts (clipAudioOf +
    /// isClipMuted) ile birebir aynı semantik:
    ///  - video klibi: gömülü ses; audio alanı null ise (detach) ses YOK;
    ///  - ses klibi: kendi sesi; null alan birim kazanca düşer;
    ///  - görsel klibi: hiç ses yok (zaten kapsam dışı);
    ///  - track.muted ya da clip.audio.muted → ses YOK; track.hidden ses üretimini ETKİLEMEZ;
    ///  - kaynakta gerçekten ses stream'i yoksa → ses YOK.
    /// </summary>
    private static ClipAudio? AudibleAudioOf(MediaClip clip, Track track, ExportAssetSource source)
    {
        if (track.Muted || !source.HasAudio || clip.Kind == MediaClipKind.Image)
        {
            return null;
        }

        var audio = clip.Kind == MediaClipKind.Audio
            ? clip.Audio ?? new ClipAudio { Volume = 1, FadeInUs = 0, FadeOutUs = 0, Muted = false }
            : clip.Audio;
        return audio is { Muted: false } ? audio : null;
    }

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
