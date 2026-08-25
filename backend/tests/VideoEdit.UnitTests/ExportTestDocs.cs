using System.Text.Json;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Domain;

namespace VideoEdit.UnitTests;

/// <summary>
/// Export testleri için TimelineDoc üreticileri. Her doküman prod yoluyla AYNI şekilde
/// TimelineJson.Options üzerinden serialize→deserialize edilir (Job.TimelineSnapshot jsonb →
/// DTO yolunun birebir taklidi) — compiler'a hep "tel üzerinden gelmiş" DTO girer.
/// </summary>
internal static class ExportTestDocs
{
    public static readonly Guid AssetA = Guid.Parse("00000000-0000-0000-0000-0000000000a1");
    public static readonly Guid AssetB = Guid.Parse("00000000-0000-0000-0000-0000000000b2");
    public static readonly Guid AssetC = Guid.Parse("00000000-0000-0000-0000-0000000000c3");

    public static TimelineDoc Roundtrip(TimelineDoc doc)
    {
        var json = JsonSerializer.Serialize(doc, TimelineJson.Options);
        return JsonSerializer.Deserialize<TimelineDoc>(json, TimelineJson.Options)!;
    }

    public static string ToJson(TimelineDoc doc) => JsonSerializer.Serialize(doc, TimelineJson.Options);

    /// <summary>Tek video track'li doküman (M3 fixture'larının kısayolu).</summary>
    public static TimelineDoc Doc(
        Guid? projectId = null,
        int width = 1920, int height = 1080,
        int fpsNum = 30, int fpsDen = 1,
        string backgroundColor = "#000000",
        bool trackMuted = false,
        params Clip[] clips) => MultiTrackDoc(
        projectId: projectId,
        width: width, height: height,
        fpsNum: fpsNum, fpsDen: fpsDen,
        backgroundColor: backgroundColor,
        tracks: [VideoTrack(muted: trackMuted, clips: clips)]);

    /// <summary>
    /// Çok katmanlı doküman. tracks[0] EN ÜST katmandır (şema sözleşmesi, docs/design/01 §1.2) —
    /// render sırası sondan başadır.
    /// </summary>
    public static TimelineDoc MultiTrackDoc(
        Track[] tracks,
        Guid? projectId = null,
        int width = 1920, int height = 1080,
        int fpsNum = 30, int fpsDen = 1,
        string backgroundColor = "#000000") => Roundtrip(new TimelineDoc
    {
        SchemaVersion = 1,
        ProjectId = projectId ?? Guid.Parse("00000000-0000-0000-0000-00000000c001"),
        Settings = new ProjectSettings
        {
            Width = width,
            Height = height,
            Fps = new Rational { Num = fpsNum, Den = fpsDen },
            AudioSampleRate = 48000,
            BackgroundColor = backgroundColor,
        },
        Tracks = [.. tracks],
        Markers = [],
    });

    public static Track VideoTrack(bool muted = false, bool hidden = false, params Clip[] clips) =>
        MakeTrack(TrackType.Video, muted, hidden, clips);

    public static Track AudioTrack(bool muted = false, bool hidden = false, params Clip[] clips) =>
        MakeTrack(TrackType.Audio, muted, hidden, clips);

    public static Track OverlayTrack(bool muted = false, bool hidden = false, params Clip[] clips) =>
        MakeTrack(TrackType.Overlay, muted, hidden, clips);

    private static Track MakeTrack(TrackType type, bool muted, bool hidden, Clip[] clips) => new()
    {
        Id = Guid.CreateVersion7(),
        Type = type,
        Muted = muted,
        Hidden = hidden,
        Locked = false,
        Clips = [.. clips],
    };

    /// <summary>Geçerli video klip (rate=1, keyframe/effect yok; transform/opaklık verilebilir).</summary>
    public static MediaClip VideoClip(
        Guid assetId, long timelineStartUs, long sourceInUs, long sourceOutUs,
        ClipAudio? audio = null, Transform? transform = null, double opacity = 1) => new()
    {
        Id = Guid.CreateVersion7(),
        Kind = MediaClipKind.Video,
        AssetId = assetId,
        TimelineStartUs = timelineStartUs,
        TimelineDurationUs = sourceOutUs - sourceInUs,
        SourceInUs = sourceInUs,
        SourceOutUs = sourceOutUs,
        Speed = new MediaClipSpeed { Rate = 1 },
        Transform = transform ?? DefaultTransform(),
        Keyframes = new KeyframeTracks(),
        Effects = [],
        Opacity = opacity,
        Audio = audio,
    };

    /// <summary>
    /// Görsel (still image) klibi. Editörün ürettiği şeklin birebir aynısı (timelineOps
    /// buildClipFromAsset): sourceIn = 0, sourceOut = klip süresi (varsayılan 4 sn) — bu aralık
    /// dosyada bir zaman aralığına KARŞILIK GELMEZ, yalnız süre modelidir; audio DAİMA null.
    /// </summary>
    public static MediaClip ImageClip(
        Guid assetId, long timelineStartUs, long durationUs,
        Transform? transform = null, double opacity = 1) => new()
    {
        Id = Guid.CreateVersion7(),
        Kind = MediaClipKind.Image,
        AssetId = assetId,
        TimelineStartUs = timelineStartUs,
        TimelineDurationUs = durationUs,
        SourceInUs = 0,
        SourceOutUs = durationUs,
        Speed = new MediaClipSpeed { Rate = 1 },
        Transform = transform ?? DefaultTransform(),
        Keyframes = new KeyframeTracks(),
        Effects = [],
        Opacity = opacity,
        Audio = null,
    };

    /// <summary>Ses klibi (audio track içeriği) — görsel katman üretmez, yalnız mikse girer.</summary>
    public static MediaClip AudioClip(
        Guid assetId, long timelineStartUs, long sourceInUs, long sourceOutUs,
        ClipAudio? audio = null) => new()
    {
        Id = Guid.CreateVersion7(),
        Kind = MediaClipKind.Audio,
        AssetId = assetId,
        TimelineStartUs = timelineStartUs,
        TimelineDurationUs = sourceOutUs - sourceInUs,
        SourceInUs = sourceInUs,
        SourceOutUs = sourceOutUs,
        Speed = new MediaClipSpeed { Rate = 1 },
        Transform = DefaultTransform(),
        Keyframes = new KeyframeTracks(),
        Effects = [],
        Opacity = 1,
        Audio = audio,
    };

    /// <summary>
    /// Metin klibi. Şemada metnin içsel boyutu vardır (fontSizePx) ama compiler onu BİLMEZ —
    /// ölçek kutusu raster hattının bildirdiği bbox'tan gelir (rendering-semantics §7).
    /// </summary>
    public static TextClip TextClip(
        long timelineStartUs, long durationUs, string content = "MERHABA",
        Transform? transform = null, double opacity = 1) => new()
    {
        Id = Guid.CreateVersion7(),
        Kind = "text",
        TimelineStartUs = timelineStartUs,
        TimelineDurationUs = durationUs,
        Transform = transform ?? DefaultTransform(),
        Keyframes = new KeyframeTracks(),
        Effects = [],
        Opacity = opacity,
        Text = new TextClipText
        {
            Content = content,
            // KÜRATÖRLÜ id (fonts/manifest.json). Eskiden 'inter' yazıyordu — manifestte
            // OLMAYAN bir id; editörün varsayılanı da oydu ve metin içeren her export
            // 'font-missing' ile düşüyordu (metin-overlay denetimi, KRİTİK bulgu #1). Test
            // dokümanları da gerçek katalogdan seçilir, aksi halde 422 ön kontrolü
            // (ExportEndpoints) kendi test verimizi reddederdi.
            FontId = "roboto",
            FontSizePx = 64,
            FontWeight = 400,
            Italic = false,
            Fill = "#FFFFFF",
            Align = TextClipTextAlign.Center,
            LineHeight = 1.2,
        },
    };

    /// <summary>Şekil klibi — şemada içsel boyutu YOKTUR, rasteri proje tuvalidir (scale=1 = tam kare).</summary>
    public static ShapeClip ShapeClip(
        long timelineStartUs, long durationUs,
        Transform? transform = null, double opacity = 1) => new()
    {
        Id = Guid.CreateVersion7(),
        Kind = "shape",
        TimelineStartUs = timelineStartUs,
        TimelineDurationUs = durationUs,
        Transform = transform ?? DefaultTransform(),
        Keyframes = new KeyframeTracks(),
        Effects = [],
        Opacity = opacity,
        Shape = new ShapeClipShape { Type = ShapeClipShapeType.Rect, Fill = "#FF0000" },
    };

    /// <summary>Çıkartma klibi — rasterlenmez, kendi asset dosyası (PNG) girişe verilir.</summary>
    public static StickerClip StickerClip(
        Guid assetId, long timelineStartUs, long durationUs,
        Transform? transform = null, double opacity = 1) => new()
    {
        Id = Guid.CreateVersion7(),
        Kind = "sticker",
        TimelineStartUs = timelineStartUs,
        TimelineDurationUs = durationUs,
        Transform = transform ?? DefaultTransform(),
        Keyframes = new KeyframeTracks(),
        Effects = [],
        Opacity = opacity,
        AssetId = assetId,
    };

    /// <summary>
    /// Kesime SİMETRİK geçiş yazar (rendering-semantics §5.2: A.transitionOut ve B.transitionIn
    /// birlikte var olmalı ve derin-eşit olmalıdır). Roundtrip'ten ÖNCE çağrılır.
    /// </summary>
    public static void Link(
        MediaClip a, MediaClip b, long durationUs,
        TransitionType type = TransitionType.Crossfade)
    {
        a.TransitionOut = new Transition { Type = type, DurationUs = durationUs };
        b.TransitionIn = new Transition { Type = type, DurationUs = durationUs };
    }

    /// <summary>
    /// Bir varlığın GERÇEKÇİ kütüphane türü: belgede o varlığı hangi klip kullanıyorsa odur.
    /// <para>
    /// NEDEN VAR: fixture'lar bugüne kadar HER varlığı <c>AssetKind.Video</c> olarak
    /// seed'liyordu — çıkartma klibi de, görsel klibi de, ses klibi de bir "video" satırını
    /// gösteriyordu. Gerçek kütüphanede bu MÜMKÜN DEĞİLDİR (editör klip türünü varlığın
    /// türünden üretir: <c>timelineOps.buildClipFromAsset</c>, <c>addStickerClip</c>) ve
    /// <c>asset-clip-type</c> kapısı tam olarak bu uyuşmazlığı reddeder. Fixture'ın gerçekçi
    /// olması ZORUNLUDUR: aksi halde testler kapının reddettiği belgelerle "kabul" ölçerdi.
    /// </para>
    /// <para>
    /// Kural üretimden BAĞIMSIZ yazılmıştır (şema DTO'ları doğrudan okunur), yani kapı ile
    /// fixture aynı koddan beslenmiyor: gate kendi kendini onaylayamaz. Aynı varlık birden çok
    /// rolde kullanılıyorsa VİDEO kazanır (sesli video hem video hem ses klibine kaynak olabilir).
    /// LUT varlığı hiçbir klibin kaynağı değildir → varsayılan (Video) kalır; onun kapısı
    /// dosya ADINA bakar (<c>lut-asset-type</c>).
    /// </para>
    /// </summary>
    public static AssetKind AssetKindFor(TimelineDoc doc, Guid assetId)
    {
        var kinds = (doc.Tracks ?? [])
            .SelectMany(t => t.Clips ?? [])
            .Select(clip => clip switch
            {
                MediaClip media when media.AssetId == assetId => media.Kind switch
                {
                    MediaClipKind.Video => AssetKind.Video,
                    MediaClipKind.Audio => AssetKind.Audio,
                    _ => AssetKind.Image,
                },
                StickerClip sticker when sticker.AssetId == assetId => AssetKind.Image,
                _ => (AssetKind?)null,
            })
            .Where(k => k is not null)
            .Select(k => k!.Value)
            .ToList();

        if (kinds.Contains(AssetKind.Video))
        {
            return AssetKind.Video;
        }

        return kinds.Count > 0 ? kinds[0] : AssetKind.Video;
    }

    public static ClipAudio Audio(
        double volume = 1, long fadeInUs = 0, long fadeOutUs = 0, bool muted = false) => new()
    {
        Volume = volume,
        FadeInUs = fadeInUs,
        FadeOutUs = fadeOutUs,
        Muted = muted,
    };

    // ---------- M5: hız, efektler, keyframe'ler ----------

    /// <summary>
    /// Hızlandırılmış/yavaşlatılmış video klibi. Süre sözleşmesi (rendering-semantics §1.3)
    /// BURADA kurulur: timelineDurationUs = roundHalfUp((sourceOut-sourceIn)/rate) — compiler
    /// bunu doğrular, testin fixture'ı da aynı formülü kullanmalıdır.
    /// </summary>
    public static MediaClip SpeedClip(
        Guid assetId, long timelineStartUs, long sourceInUs, long sourceOutUs, double rate,
        ClipAudio? audio = null, Transform? transform = null)
    {
        var clip = VideoClip(assetId, timelineStartUs, sourceInUs, sourceOutUs, audio, transform);
        clip.Speed = new MediaClipSpeed { Rate = rate };
        clip.TimelineDurationUs = Timecode.ClipTimelineDurationUs(sourceInUs, sourceOutUs, rate);
        return clip;
    }

    /// <summary>colorAdjust efekti (§4.1) — verilmeyen parametreler şemada da etkisizdir (0).</summary>
    public static Effect ColorAdjust(
        double exposure = 0, double temperature = 0, double tint = 0,
        double contrast = 0, double brightness = 0, double saturation = 0, bool enabled = true)
    {
        var effect = new Effect
        {
            Id = Guid.CreateVersion7(),
            Type = EffectType.ColorAdjust,
            Enabled = enabled,
        };
        Put(effect, "exposure", exposure);
        Put(effect, "temperature", temperature);
        Put(effect, "tint", tint);
        Put(effect, "contrast", contrast);
        Put(effect, "brightness", brightness);
        Put(effect, "saturation", saturation);
        return effect;

        static void Put(Effect effect, string key, double value)
        {
            if (value != 0)
            {
                effect.Params[key] = value;
            }
        }
    }

    /// <summary>lut efekti (§4.2): .cube dosyası bir ASSET'tir, intensity karışım oranıdır.</summary>
    public static Effect Lut(Guid assetId, double intensity = 1, bool enabled = true)
    {
        var effect = new Effect
        {
            Id = Guid.CreateVersion7(),
            Type = EffectType.Lut,
            Enabled = enabled,
        };
        effect.Params["assetId"] = assetId.ToString();
        effect.Params["intensity"] = intensity;
        return effect;
    }

    /// <summary>Tek keyframe (§3.3: easing BU keyframe'den SONRAKİ segmente aittir).</summary>
    public static Keyframe Kf(long timeUs, double value, Easing? easing = null) => new()
    {
        TimeUs = timeUs,
        Value = value,
        Easing = easing ?? new EasingLinear { Type = "linear" },
    };

    /// <summary>
    /// PAYLAŞILAN ÖRNEKLEME BÜTÇESİ fixture'ı: tek video track'te <paramref name="clipCount"/>
    /// adet 60 sn'lik, ölçek animasyonlu görsel klip. <paramref name="easing"/> null ise
    /// animasyon TAMAMEN LİNEERDİR ve bütçeden HİÇ harcamaz (kapalı forma derlenir) —
    /// "önerilen eylem gerçekten işe yarıyor mu" sorusunun kontrol grubudur.
    /// <para>
    /// Aritmetik: 60 sn @30fps = 1800 kare; <c>scale</c> kanalı ScaleWidth + ScaleHeight
    /// olarak İKİ KEZ örneklenir → klip başına ~3600 örnek. 17 klip ≈ 61 200 &gt; 60 000.
    /// </para>
    /// </summary>
    public static TimelineDoc CurvedScaleDoc(int clipCount, Easing? easing = null)
    {
        const long durationUs = 60_000_000;
        easing ??= EaseInOut();
        var clips = new List<Clip>(clipCount);
        for (var i = 0; i < clipCount; i++)
        {
            var clip = ImageClip(AssetA, i * durationUs, durationUs);
            clip.Keyframes = new KeyframeTracks
            {
                Scale = [Kf(0, 1.0, easing), Kf(durationUs, 0.5)],
            };
            clips.Add(clip);
        }

        return Doc(clips: [.. clips]);
    }

    /// <summary>
    /// <see cref="CurvedScaleDoc"/>'un LİNEER easing'li eşi — aynı klip sayısı, aynı süre,
    /// aynı keyframe sayısı; tek fark easing tipi.
    /// </summary>
    public static TimelineDoc LinearScaleDoc(int clipCount)
    {
        const long durationUs = 60_000_000;
        var clips = new List<Clip>(clipCount);
        for (var i = 0; i < clipCount; i++)
        {
            var clip = ImageClip(AssetA, i * durationUs, durationUs);
            clip.Keyframes = new KeyframeTracks
            {
                Scale = [Kf(0, 1.0), Kf(durationUs, 0.5)],
            };
            clips.Add(clip);
        }

        return Doc(clips: [.. clips]);
    }

    public static Easing EaseInOut() => new EasingEaseInOut { Type = "easeInOut" };

    public static Easing EaseIn() => new EasingEaseIn { Type = "easeIn" };

    /// <summary>Serbest cubicBezier (şema y'yi serbest bırakır — overshoot/undershoot yasal).</summary>
    public static Easing Bezier(double x1, double y1, double x2, double y2) =>
        new EasingCubicBezier { Type = "cubicBezier", X1 = x1, Y1 = y1, X2 = x2, Y2 = y2 };

    public static Transform DefaultTransform() => new()
    {
        X = 0,
        Y = 0,
        Scale = 1,
        RotationDeg = 0,
        AnchorX = 0.5,
        AnchorY = 0.5,
    };

    public static Transform Transform(
        double x = 0, double y = 0, double scale = 1, double rotationDeg = 0,
        double anchorX = 0.5, double anchorY = 0.5) => new()
    {
        X = x,
        Y = y,
        Scale = scale,
        RotationDeg = rotationDeg,
        AnchorX = anchorX,
        AnchorY = anchorY,
    };
}
