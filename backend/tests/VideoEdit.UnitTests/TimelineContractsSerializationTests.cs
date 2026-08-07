using System.Text.Json;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;

namespace VideoEdit.UnitTests;

/// <summary>
/// Üretilen DTO'ların (TimelineContracts.g.cs) System.Text.Json ile kullanılabilirlik duman
/// testi: discriminated union'lar (Clip 'kind', Easing 'type') doğru concrete tipe iner ve
/// round-trip'te discriminator kaybolmaz. SchemaGen'in şema dönüşümlerini regresyona karşı korur.
/// </summary>
public class TimelineContractsSerializationTests
{
    private const string MediaClipJson = """
        {
          "id": "0198c0de-0000-7000-8000-000000000001",
          "timelineStartUs": 0,
          "timelineDurationUs": 2000000,
          "transform": { "x": 0, "y": 0, "scale": 1, "rotationDeg": 0, "anchorX": 0.5, "anchorY": 0.5 },
          "keyframes": {
            "opacity": [
              { "timeUs": 0, "value": 0, "easing": { "type": "easeInOut" } },
              { "timeUs": 1000000, "value": 1, "easing": { "type": "cubicBezier", "x1": 0.2, "y1": 0.1, "x2": 0.8, "y2": 0.9 } }
            ]
          },
          "effects": [],
          "opacity": 1,
          "kind": "audio",
          "assetId": "0198c0de-0000-7000-8000-000000000002",
          "sourceInUs": 0,
          "sourceOutUs": 4000000,
          "speed": { "rate": 2 },
          "audio": null
        }
        """;

    [Fact]
    public void ClipUnion_DeserializesByKindDiscriminator()
    {
        var clip = JsonSerializer.Deserialize<Clip>(MediaClipJson);

        var media = Assert.IsType<MediaClip>(clip);
        Assert.Equal(MediaClipKind.Audio, media.Kind);
        Assert.Equal(2_000_000, media.TimelineDurationUs);
        Assert.Equal(2, media.Speed.Rate);
        Assert.Null(media.Audio);

        var keyframes = media.Keyframes.Opacity!;
        Assert.IsType<EasingEaseInOut>(keyframes[0].Easing);
        var bezier = Assert.IsType<EasingCubicBezier>(keyframes[1].Easing);
        Assert.Equal(0.2, bezier.X1);
    }

    [Fact]
    public void ClipUnion_RoundTripsThroughBaseType()
    {
        var clip = JsonSerializer.Deserialize<Clip>(MediaClipJson)!;
        var json = JsonSerializer.Serialize(clip); // declared type = base Clip

        using var document = JsonDocument.Parse(json);
        Assert.Equal("audio", document.RootElement.GetProperty("kind").GetString());
        Assert.Equal("easeInOut", document.RootElement
            .GetProperty("keyframes").GetProperty("opacity")[0]
            .GetProperty("easing").GetProperty("type").GetString());

        // İkinci tur aynı concrete tipe dönmeli.
        var again = Assert.IsType<MediaClip>(JsonSerializer.Deserialize<Clip>(json));
        Assert.Equal(MediaClipKind.Audio, again.Kind);
    }

    [Fact]
    public void CanonicalOptions_AbsentOptionalFields_DoNotLeakAsNull()
    {
        // Girdide olmayan optional alanlar (transitionIn/transitionOut) ve null gelen alanlar
        // (audio) kanonik TimelineJson.Options ile serialize edildiğinde çıktıda YOK olmalı.
        var clip = JsonSerializer.Deserialize<Clip>(MediaClipJson, TimelineJson.Options)!;
        var json = JsonSerializer.Serialize(clip, TimelineJson.Options);

        using var document = JsonDocument.Parse(json);
        Assert.False(document.RootElement.TryGetProperty("transitionIn", out _),
            "transitionIn absent in input must not appear as null in output");
        Assert.False(document.RootElement.TryGetProperty("transitionOut", out _),
            "transitionOut absent in input must not appear as null in output");
        Assert.False(document.RootElement.TryGetProperty("audio", out _),
            "audio: null in input must not be re-emitted");

        // Doldurulmamış keyframe kanalları (x/y/scale/...) da sızmamalı.
        var keyframes = document.RootElement.GetProperty("keyframes");
        Assert.False(keyframes.TryGetProperty("x", out _));
        Assert.False(keyframes.TryGetProperty("volume", out _));

        // Track.name optional — girdide yoksa çıktıda olmamalı.
        var track = JsonSerializer.Deserialize<Track>(
            """{"id":"0198c0de-0000-7000-8000-000000000003","type":"video","muted":false,"hidden":false,"locked":false,"clips":[]}""",
            TimelineJson.Options)!;
        var trackJson = JsonSerializer.Serialize(track, TimelineJson.Options);
        using var trackDocument = JsonDocument.Parse(trackJson);
        Assert.False(trackDocument.RootElement.TryGetProperty("name", out _),
            "name absent in input must not appear as null in output");
    }

    [Fact]
    public void ClipUnion_UnknownDiscriminatorThrows()
    {
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Clip>("""{ "kind": "hologram" }"""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Easing>("""{ "x1": 0.1 }"""));
    }
}
