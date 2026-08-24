using System.Text.Json;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Export;

namespace VideoEdit.UnitTests;

/// <summary>
/// Cross-language keyframe SIRALAMA sözleşmesi (kabul/ret paritesi):
/// packages/timeline-schema/test-vectors/keyframe-order-vectors.json hem vitest
/// (invariants.test.ts "matches the shared keyframe-order vectors") hem bu paket tarafından
/// koşulur. Kural: bir kanalın keyframe'leri timeUs'a göre KESİN ARTAN olmalı (tekrar yok) —
/// zod "keyframes must be strictly sorted by timeUs", C# eşi KeyframeCompiler.Parse'ın
/// sıralılık dalı; hakem <see cref="ExportCompiler.Validate"/>'tir. Her vaka hem görsel
/// (opacity) hem ses (volume) kanalında koşar (keyframe-bounds deseninin aynısı).
/// docs/backlog.md "M3 sınıfı" parite aileleri kaydından 'keyframe sıralaması'nın kapanışıdır.
/// </summary>
public class KeyframeOrderParityTests
{
    private sealed record OrderCase(string Name, long TimelineDurationUs, List<long> TimesUs, bool Valid);

    private sealed record OrderFile(List<OrderCase> Cases);

    private static readonly OrderFile Vectors = Load();

    private static OrderFile Load()
    {
        var path = TestVectorFiles.Resolve(
            "packages/timeline-schema/test-vectors/keyframe-order-vectors.json");
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        return JsonSerializer.Deserialize<OrderFile>(File.ReadAllText(path), options)
            ?? throw new InvalidOperationException($"Could not parse {path}");
    }

    [Fact]
    public void VectorFile_CarriesBothDirections()
    {
        Assert.NotEmpty(Vectors.Cases);
        Assert.Contains(Vectors.Cases, c => c.Valid);
        Assert.Contains(Vectors.Cases, c => !c.Valid);
    }

    public static TheoryData<string, long, long[], bool, bool> OrderCases()
    {
        var data = new TheoryData<string, long, long[], bool, bool>();
        foreach (var c in Vectors.Cases)
        {
            data.Add(c.Name, c.TimelineDurationUs, [.. c.TimesUs], c.Valid, true);  // opacity
            data.Add(c.Name, c.TimelineDurationUs, [.. c.TimesUs], c.Valid, false); // volume
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(OrderCases))]
    public void Validate_MatchesTheSharedOrderVectors(
        string name, long timelineDurationUs, long[] timesUs, bool valid, bool visualChannel)
    {
        var keyframes = timesUs.Select(t => ExportTestDocs.Kf(t, 1)).ToList();
        var clip = ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, timelineDurationUs,
            visualChannel ? null : ExportTestDocs.Audio());
        clip.Keyframes = visualChannel
            ? new KeyframeTracks { Opacity = keyframes }
            : new KeyframeTracks { Volume = keyframes };
        var doc = ExportTestDocs.Doc(clips: clip);

        if (valid)
        {
            Assert.NotNull(ExportCompiler.Validate(doc));
        }
        else
        {
            var ex = Record.Exception(() => ExportCompiler.Validate(doc));
            Assert.True(ex is InvalidTimelineException,
                $"{name}: tipli ret (InvalidTimelineException) bekleniyordu, "
                + $"gelen: {ex?.GetType().Name ?? "istisna yok"}.");
        }
    }
}
