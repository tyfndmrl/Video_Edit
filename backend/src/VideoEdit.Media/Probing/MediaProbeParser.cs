using System.Globalization;
using System.Text.Json;

namespace VideoEdit.Media.Probing;

/// <summary>
/// ffprobe `-print_format json -show_format -show_streams` çıktısını MediaProbe'a çevirir.
/// SAF parser — process çalıştırmaz (birim testleri doğrudan JSON string'iyle çalışır).
/// Parse edilemeyen ya da hiç stream'i olmayan çıktı → UnsupportedMediaException (gate).
/// </summary>
public static class MediaProbeParser
{
    public static MediaProbe Parse(string json)
    {
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(json);
        }
        catch (JsonException ex)
        {
            throw new UnsupportedMediaException($"ffprobe output is not valid JSON: {ex.Message}");
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("streams", out var streams)
                || streams.ValueKind != JsonValueKind.Array
                || streams.GetArrayLength() == 0)
            {
                throw new UnsupportedMediaException("ffprobe found no streams in the file.");
            }

            JsonElement? video = null;
            JsonElement? audio = null;
            foreach (var stream in streams.EnumerateArray())
            {
                var codecType = GetString(stream, "codec_type");
                if (codecType == "video" && video is null && !IsAttachedPic(stream))
                {
                    video = stream;
                }
                else if (codecType == "audio" && audio is null)
                {
                    audio = stream;
                }
            }

            if (video is null && audio is null)
            {
                throw new UnsupportedMediaException("file contains no decodable video or audio stream.");
            }

            var durationUs = ParseDurationUs(root, video, audio);

            int width = 0, height = 0, fpsNum = 0, fpsDen = 0, avgNum = 0, avgDen = 0;
            var isVfr = false;
            string? colorTransfer = null, colorPrimaries = null, videoCodec = null;
            string? colorSpace = null, colorRange = null;
            var videoIndex = -1;

            if (video is { } v)
            {
                videoIndex = GetInt(v, "index") ?? -1;
                videoCodec = GetString(v, "codec_name");
                width = GetInt(v, "width") ?? 0;
                height = GetInt(v, "height") ?? 0;
                if (width <= 0 || height <= 0)
                {
                    throw new UnsupportedMediaException("video stream reports no valid dimensions.");
                }

                // Rotation: side_data displaymatrix (yeni) ya da tags.rotate (eski) — 90/270'te swap.
                var rotation = ReadRotationDegrees(v);
                if (rotation is 90 or 270)
                {
                    (width, height) = (height, width);
                }

                (fpsNum, fpsDen) = ParseRational(GetString(v, "r_frame_rate"));
                (avgNum, avgDen) = ParseRational(GetString(v, "avg_frame_rate"));
                var avgUnknown = avgNum <= 0 || avgDen <= 0;
                if (avgUnknown)
                {
                    // avg "0/0" (bazı container'larda) → nominal olarak r'a düş.
                    (avgNum, avgDen) = (fpsNum, fpsDen);
                }

                // VFR: r ≠ avg (cross-multiply — double karşılaştırması değil).
                // avg parse EDİLEMEDİYSE CFR VARSAYILMAZ: isVfr=true kabul edilir ki proxy
                // reçetesi fps filtresini zorunlu eklesin (bilinmeyen kaynak VFR gibi işlenir —
                // CFR kaynağa fps eklemek zararsızdır, VFR'ı CFR sanmak A/V senkronu bozar).
                isVfr = avgUnknown
                        || (fpsNum > 0 && fpsDen > 0 && avgNum > 0 && avgDen > 0
                            && (long)fpsNum * avgDen != (long)avgNum * fpsDen);

                colorTransfer = GetString(v, "color_transfer");
                colorPrimaries = GetString(v, "color_primaries");
                colorSpace = GetString(v, "color_space");
                colorRange = GetString(v, "color_range");
            }

            int? sampleRate = null, channels = null;
            string? audioCodec = null;
            var audioIndex = -1;
            if (audio is { } a)
            {
                audioIndex = GetInt(a, "index") ?? -1;
                audioCodec = GetString(a, "codec_name");
                // ffprobe sample_rate'i STRING yazar ("48000").
                if (GetString(a, "sample_rate") is { } sr
                    && int.TryParse(sr, NumberStyles.Integer, CultureInfo.InvariantCulture, out var srInt))
                {
                    sampleRate = srInt;
                }

                channels = GetInt(a, "channels");
            }

            return new MediaProbe
            {
                RawJson = json,
                DurationUs = durationUs,
                HasVideo = video is not null,
                HasAudio = audio is not null,
                Width = width,
                Height = height,
                FpsNum = fpsNum,
                FpsDen = fpsDen,
                AvgFpsNum = avgNum,
                AvgFpsDen = avgDen,
                IsVfr = isVfr,
                AudioSampleRate = sampleRate,
                AudioChannels = channels,
                ColorTransfer = colorTransfer,
                ColorPrimaries = colorPrimaries,
                ColorSpace = colorSpace,
                ColorRange = colorRange,
                IsHdr = Recipes.ColorChain.IsHdr(colorTransfer, colorPrimaries),
                VideoCodec = videoCodec,
                AudioCodec = audioCodec,
                VideoStreamIndex = videoIndex,
                AudioStreamIndex = audioIndex,
            };
        }
    }

    /// <summary>format.duration (saniye string) → µs, half-up; yoksa stream duration'larına düşer.</summary>
    private static long? ParseDurationUs(JsonElement root, JsonElement? video, JsonElement? audio)
    {
        foreach (var candidate in EnumerateDurationCandidates(root, video, audio))
        {
            if (decimal.TryParse(candidate, NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds)
                && seconds >= 0)
            {
                // roundHalfUp (rendering-semantics §1.2): floor(x + 0.5) — decimal ile tam hassas.
                return (long)Math.Floor((seconds * 1_000_000m) + 0.5m);
            }
        }

        return null;
    }

    private static IEnumerable<string> EnumerateDurationCandidates(
        JsonElement root, JsonElement? video, JsonElement? audio)
    {
        if (root.TryGetProperty("format", out var format) && GetString(format, "duration") is { } fd)
        {
            yield return fd;
        }

        if (video is { } v && GetString(v, "duration") is { } vd)
        {
            yield return vd;
        }

        if (audio is { } a && GetString(a, "duration") is { } ad)
        {
            yield return ad;
        }
    }

    /// <summary>Normalize edilmiş rotation (0/90/180/270). displaymatrix negatif derece verebilir.</summary>
    private static int ReadRotationDegrees(JsonElement videoStream)
    {
        double? rotation = null;

        if (videoStream.TryGetProperty("side_data_list", out var sideDataList)
            && sideDataList.ValueKind == JsonValueKind.Array)
        {
            foreach (var sideData in sideDataList.EnumerateArray())
            {
                if (sideData.TryGetProperty("rotation", out var rot))
                {
                    rotation = rot.ValueKind switch
                    {
                        JsonValueKind.Number => rot.GetDouble(),
                        JsonValueKind.String when double.TryParse(
                            rot.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => d,
                        _ => rotation,
                    };
                    if (rotation is not null)
                    {
                        break;
                    }
                }
            }
        }

        if (rotation is null
            && videoStream.TryGetProperty("tags", out var tags)
            && GetString(tags, "rotate") is { } rotateTag
            && double.TryParse(rotateTag, NumberStyles.Float, CultureInfo.InvariantCulture, out var tagDeg))
        {
            rotation = tagDeg;
        }

        if (rotation is null)
        {
            return 0;
        }

        var normalized = (int)Math.Round(rotation.Value, MidpointRounding.AwayFromZero) % 360;
        return normalized < 0 ? normalized + 360 : normalized;
    }

    private static (int Num, int Den) ParseRational(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return (0, 0);
        }

        var slash = value.IndexOf('/');
        if (slash < 0)
        {
            return int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var whole)
                ? (whole, 1)
                : (0, 0);
        }

        return int.TryParse(value[..slash], NumberStyles.Integer, CultureInfo.InvariantCulture, out var num)
               && int.TryParse(value[(slash + 1)..], NumberStyles.Integer, CultureInfo.InvariantCulture, out var den)
            ? (num, den)
            : (0, 0);
    }

    private static bool IsAttachedPic(JsonElement stream) =>
        stream.TryGetProperty("disposition", out var disposition)
        && disposition.TryGetProperty("attached_pic", out var attachedPic)
        && attachedPic.ValueKind == JsonValueKind.Number
        && attachedPic.GetInt32() == 1;

    private static string? GetString(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? GetInt(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.Number
        && value.TryGetInt32(out var i)
            ? i
            : null;
}
