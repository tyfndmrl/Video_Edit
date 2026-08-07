using System.Globalization;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Recipes;

namespace VideoEdit.Media.Export;

/// <summary>
/// Doğrulama çıktısı: normalize plan. API ön-doğrulaması yalnız <see cref="ExportCompiler.Validate"/>
/// çağırır (asset yolu gerekmez); worker aynı planla kaynakları indirip Compile'a geçer.
/// TotalDurationUs son klibin proje fps grid'ine snap edilmiş bitişidir.
/// </summary>
public sealed record ExportPlan(
    TimelineDoc Doc,
    Track VideoTrack,
    IReadOnlyList<MediaClip> Clips,
    IReadOnlyList<Guid> AssetIds,
    long TotalDurationUs,
    int FpsNum,
    int FpsDen,
    int Width,
    int Height);

/// <summary>
/// FilterGraph Compiler v1 (M3 = tek video track, geçişsiz/keyframe'siz/efektsiz).
/// TimelineDoc → deterministik CompiledExport. Kurallar:
///  - trim INPUT seviyesinde -ss/-t (tasarım 04 §2.1; -to ASLA); aynı asset'ten N klip = N giriş;
///  - segment defteri FRAME SAYISIYLA tutulur: her klip/boşluk proje fps grid'inde tam frame
///    sayısına çözülür ve zincire trim=end_frame=N eklenir — µs-farkı aritmetiğinin NTSC'de
///    ürettiği ±1 frame kaymaları biter (rendering-semantics §1.4);
///  - her video zinciri fps=&lt;projeFps&gt;,trim=end_frame=N,…,settb=AVTB,setpts=PTS-STARTPTS ile
///    normalize edilir (tasarım 04 §1) + scale/pad ile proje tuvaline letterbox (aspect korunur);
///  - HDR kaynakta ColorChain.ForSource (rendering-semantics §6.2 normatif sabiti) zincirin başındadır;
///  - klipler arası boşluklar color source gap segmentleriyle doldurulur, hepsi tek concat'e girer;
///    concat SONRASI setparams frame'leri BT.709/tv olarak işaretler — ffmpeg 7+ çıktı CLI
///    tag'lerini filtergraph frame metadata'sıyla ezdiği için CLI bayrakları tek başına yetmez
///    (CLI bayrakları emniyet kemeri olarak kalır);
///  - ses: asetpts → aformat(48k fltp stereo) → volume(lineer) → afade in/out (curve=tri, §8.2)
///    → 5 ms micro-fade (§8.4 — kullanıcı fade'i o kenardaysa ya da seamless splice ise atlanır)
///    → adelay; miks amix=normalize=0 + alimiter=limit=0.98 (§8.3); hiç ses yoksa anullsrc;
///  - tüm sayısal literal'ler InvariantCulture (TimeFormat) — TR locale'de virgül SIZAMAZ.
/// </summary>
public static class ExportCompiler
{
    /// <summary>§8.4: sert kesim sınırındaki micro-fade süresi — 5 ms (= 240 sample @48 kHz).</summary>
    public const long MicroFadeUs = 5_000;

    /// <summary>Çıktı frame'lerine damgalanan renk parametreleri (rendering-semantics §6.1).</summary>
    public const string OutputColorParams =
        "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";
    /// <summary>M3 kapsam + sözleşme doğrulaması. İhlalde ExportCompileException türevi fırlatır.</summary>
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

        // BOŞ track'ler (clips.length == 0, tipi ne olursa olsun) yok sayılır: editör +V/+A ile
        // içeriksiz track ekler — bunlar export kapsamını değiştirmez, 422'ye düşürmez.
        var populated = tracks.Where(t => t.Clips is { Count: > 0 }).ToList();
        if (populated.Count == 0)
        {
            throw new InvalidTimelineException("timeline has no clips — nothing to export.");
        }

        if (populated.Count > 1)
        {
            throw new UnsupportedFeatureException("multiple-tracks",
                $"Dışa aktarma M3'te tek video track destekler; timeline'da {populated.Count.ToString(CultureInfo.InvariantCulture)} "
                + "dolu track var. Çok katmanlı kompozisyon M4'te geliyor — şimdilik diğer track'lerdeki "
                + "klipleri kaldırın.");
        }

        var track = populated[0];
        if (track.Type != TrackType.Video)
        {
            throw new UnsupportedFeatureException("track-type",
                $"M3 dışa aktarıcı yalnız video track'i destekler; '{track.Id}' track'inin tipi '{track.Type}'.");
        }

        if (track.Hidden)
        {
            throw new UnsupportedFeatureException("hidden-track",
                "Tek video track gizli durumda — boş tuval dışa aktarılamaz. Track'i görünür yapın.");
        }

        var fpsNum = (int)settings.Fps.Num;
        var fpsDen = (int)settings.Fps.Den;
        var clips = new List<MediaClip>(track.Clips.Count);
        foreach (var clip in track.Clips)
        {
            var media = ValidateClip(clip);

            // Frame-grid güvenlik ağı (rendering-semantics §1.4): editör klipleri zaten proje fps
            // grid'inde üretir; grid dışı değer frame defterini bozup ±1 frame kayma üretir —
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

        // Sıralama + bitişiklik invariant'ı (schema.ts Track.clips yorumu): timelineStartUs artan,
        // overlap YOK. Boşluk serbesttir — compiler gap segmenti üretir.
        for (var i = 1; i < clips.Count; i++)
        {
            var prevEnd = clips[i - 1].TimelineStartUs + clips[i - 1].TimelineDurationUs;
            if (clips[i].TimelineStartUs < prevEnd)
            {
                throw new InvalidTimelineException(
                    $"clips '{clips[i - 1].Id}' and '{clips[i].Id}' overlap or are out of order "
                    + $"(previous ends at {prevEnd} us, next starts at {clips[i].TimelineStartUs} us).");
            }
        }

        var last = clips[^1];
        var totalDurationUs = SnapUs(last.TimelineStartUs + last.TimelineDurationUs, fpsNum, fpsDen);
        if (totalDurationUs <= 0)
        {
            throw new InvalidTimelineException("timeline duration is shorter than one output frame.");
        }

        var assetIds = clips.Select(c => c.AssetId).Distinct().ToList();
        return new ExportPlan(
            doc, track, clips, assetIds, totalDurationUs,
            fpsNum, fpsDen, (int)settings.Width, (int)settings.Height);
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
        var lines = new List<string>();
        var segmentLabels = new List<string>();
        var audioLabels = new List<string>();

        // Segment defteri FRAME domain'inde tutulur: klip/boşluk sınırları proje fps grid'inde
        // frame numarasına çözülür, render trim=end_frame=N ile deftere sabitlenir. µs-farkından
        // süre türetmek NTSC'de (30000/1001) ±1 frame kayma üretir — frame sayısı üretmez.
        long prevEndFrame = 0;
        var gapIndex = 0;
        for (var i = 0; i < plan.Clips.Count; i++)
        {
            var clip = plan.Clips[i];
            var source = sources[clip.AssetId];

            var startFrame = FrameOf(clip.TimelineStartUs, plan.FpsNum, plan.FpsDen);
            var endFrame = FrameOf(
                clip.TimelineStartUs + clip.TimelineDurationUs, plan.FpsNum, plan.FpsDen);
            var clipFrames = endFrame - startFrame;

            // Boşluk segmenti: bir önceki klibin bitiş frame'i ile bu klibin başlangıç frame'i
            // arası. İlk klip 0'dan geç başlıyorsa baştaki boşluk da doldurulur (timeline 0'dan
            // başlar). color d= bir frame CÖMERT verilir; trim=end_frame kesin sayıyı garanti
            // eder (d'nin µs yuvarlaması kaynak frame sayısını belirleyemez).
            var gapFrames = startFrame - prevEndFrame;
            if (gapFrames > 0)
            {
                var label = $"g{gapIndex}";
                var gapHeadroomUs = UsOf(gapFrames + 1, plan.FpsNum, plan.FpsDen);
                lines.Add(
                    $"color=c={background}:s={plan.Width}x{plan.Height}:r={fpsArg}:d={TimeFormat.Sec(gapHeadroomUs)},"
                    + $"trim=end_frame={gapFrames.ToString(CultureInfo.InvariantCulture)},"
                    + $"format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[{label}]");
                segmentLabels.Add(label);
                gapIndex++;
            }

            var inputIndex = inputs.Count;
            inputs.Add(new ExportInput(
                source.Path, clip.SourceInUs, clip.SourceOutUs - clip.SourceInUs));

            var chain = new List<string>();
            if (source.IsHdr)
            {
                chain.Add(ColorChain.ForSource(source.ColorTransfer));
            }

            chain.Add($"fps={fpsArg}");
            chain.Add($"trim=end_frame={clipFrames.ToString(CultureInfo.InvariantCulture)}");
            chain.Add($"scale={plan.Width}:{plan.Height}"
                      + ":force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic");
            chain.Add($"pad={plan.Width}:{plan.Height}:(ow-iw)/2:(oh-ih)/2:color={background}");
            chain.Add("setsar=1");
            chain.Add("format=yuv420p");
            chain.Add("settb=AVTB");
            chain.Add("setpts=PTS-STARTPTS");
            var videoLabel = $"v{i}";
            lines.Add($"[{inputIndex}:v]{string.Join(',', chain)}[{videoLabel}]");
            segmentLabels.Add(videoLabel);

            // adelay pozisyonu frame defterinden türetilir (startFrame → µs) — klibin
            // dokümandaki µs'i değil, defterdeki frame sınırı esas alınır.
            var startUs = UsOf(startFrame, plan.FpsNum, plan.FpsDen);
            var prevClip = i > 0 ? plan.Clips[i - 1] : null;
            var nextClip = i + 1 < plan.Clips.Count ? plan.Clips[i + 1] : null;
            if (BuildAudioChain(clip, prevClip, nextClip, plan.VideoTrack, source, inputIndex,
                    startUs, audioLabels.Count) is { } audioLine)
            {
                lines.Add(audioLine);
                audioLabels.Add($"a{audioLabels.Count}");
            }

            prevEndFrame = endFrame;
        }

        // Video: tüm segmentler (klipler + boşluklar) tek concat'te birleşir. Concat SONRASI
        // setparams frame'leri BT.709/tv işaretler — ffmpeg 7+/8 çıktı renk tag'lerini
        // filtergraph frame metadata'sından alır; CLI -color_* bayrakları tek başına EZİLİR
        // (bayraklar emniyet kemeri olarak profde durmaya devam eder).
        lines.Add(
            string.Concat(segmentLabels.Select(l => $"[{l}]"))
            + $"concat=n={segmentLabels.Count.ToString(CultureInfo.InvariantCulture)}:v=1:a=0,"
            + OutputColorParams + "[vout]");

        // Ses: parçalar amix=normalize=0 + alimiter (rendering-semantics §8.3); hiç ses yoksa
        // toplam süre kadar sessizlik (anullsrc sonsuzdur — atrim şart).
        if (audioLabels.Count > 0)
        {
            lines.Add(
                string.Concat(audioLabels.Select(l => $"[{l}]"))
                + $"amix=inputs={audioLabels.Count.ToString(CultureInfo.InvariantCulture)}"
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

    // ───────────────────────── Klip doğrulaması ─────────────────────────

    private static MediaClip ValidateClip(Clip clip)
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
                $"Timeline'da {kindTr} klibi var — {kindTr} klipleri M3 dışa aktarıcıda henüz "
                + "desteklenmiyor (overlay varlıkları M4'te geliyor). Dışa aktarmadan önce bu "
                + "klipleri kaldırın.");
        }

        if (media.Kind != MediaClipKind.Video)
        {
            var kind = media.Kind == MediaClipKind.Image ? "image" : "audio";
            var kindTr = media.Kind == MediaClipKind.Image ? "görsel" : "ses";
            throw new UnsupportedFeatureException($"{kind}-clip",
                $"'{media.Id}' klibi bir {kindTr} klibi — M3'te yalnız video klipleri dışa "
                + "aktarılabilir (görsel/ses klipleri M4'te geliyor).");
        }

        if (media.Speed is not { Rate: 1 })
        {
            throw new UnsupportedFeatureException("speed",
                $"'{media.Id}' klibinde hız değişimi var (speed.rate="
                + $"{(media.Speed?.Rate ?? 0).ToString(CultureInfo.InvariantCulture)}) — "
                + "hız değişimi M3'te desteklenmiyor (M4'te geliyor).");
        }

        if (media.TransitionIn is not null || media.TransitionOut is not null)
        {
            throw new UnsupportedFeatureException("transition",
                $"'{media.Id}' klibinde geçiş (transition) var — geçişler M3'te desteklenmiyor "
                + "(M4'te geliyor). Geçişi kaldırıp yeniden deneyin.");
        }

        if (HasAnyKeyframes(media.Keyframes))
        {
            throw new UnsupportedFeatureException("keyframes",
                $"'{media.Id}' klibinde keyframe animasyonu var — keyframe'ler M3'te "
                + "desteklenmiyor (M4'te geliyor).");
        }

        if (media.Effects is { Count: > 0 } && media.Effects.Any(e => e.Enabled))
        {
            throw new UnsupportedFeatureException("effects",
                $"'{media.Id}' klibinde etkin efekt var — efektler M3'te desteklenmiyor "
                + "(M4'te geliyor). Efektleri kapatıp yeniden deneyin.");
        }

        if (media.Transform is not { X: 0, Y: 0, Scale: 1, RotationDeg: 0 })
        {
            throw new UnsupportedFeatureException("transform",
                $"'{media.Id}' klibi taşınmış/ölçeklenmiş/döndürülmüş — konumlandırma (transform) "
                + "M3'te desteklenmiyor (tek tam-kare track; M4'te geliyor).");
        }

        if (media.Opacity != 1)
        {
            throw new UnsupportedFeatureException("opacity",
                $"'{media.Id}' klibinin opaklığı {media.Opacity.ToString(CultureInfo.InvariantCulture)} — "
                + "opaklık M3'te desteklenmiyor (M4'te geliyor).");
        }

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
    /// Klip ses zinciri (rendering-semantics §8 + görev sözleşmesi):
    /// asetpts → aformat → volume → afade in/out (curve=tri) → 5 ms micro-fade (§8.4) → adelay.
    /// No-op filtreler (volume=1, fade=0, delay=0) determinism ve hız için ÜRETİLMEZ — snapshot
    /// sabitler. Ses zinciri yalnız: klip sesi var + klip muted değil + track muted değil +
    /// kaynakta gerçekten ses stream'i var ise üretilir.
    /// Micro-fade kuralı (§8.4, preview'daki gain.ts ile aynı mantık): her sert kesim kenarına
    /// 5 ms lineer fade; o kenarda kullanıcı fade'i varsa atlanır (fade zaten sıfıra iner);
    /// seamless splice istisnası — bitişik + aynı asset + B.sourceIn==A.sourceOut + aynı rate
    /// ise ortak kenarda micro-fade uygulanmaz (split edilmiş klipte ses çukuru olmasın).
    /// </summary>
    private static string? BuildAudioChain(
        MediaClip clip, MediaClip? prevClip, MediaClip? nextClip, Track track,
        ExportAssetSource source, int inputIndex, long startSnappedUs, int audioIndex)
    {
        if (clip.Audio is not { Muted: false } audio || track.Muted || !source.HasAudio)
        {
            return null;
        }

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

        return $"[{inputIndex}:a]{string.Join(',', parts)}[a{audioIndex}]";
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
    /// Alpha bileşeni M3'te kullanılmaz (taban tuval opak).
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
