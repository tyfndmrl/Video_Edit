using System.Text.Json;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Export;

namespace VideoEdit.UnitTests;

/// <summary>
/// Cross-language keyframe SINIR sözleşmesi:
/// packages/timeline-schema/test-vectors/keyframe-bounds-vectors.json hem vitest
/// (invariants.test.ts "matches the shared keyframe-bounds vectors") hem bu paket
/// tarafından koşulur. Kural (şema invaryantı): keyframe timeUs ∈ [0, clip.timelineDurationUs],
/// iki uç da KAPSAYICI — zod ihlali "keyframe timeUs … is outside [0, dur]" ile reddeder,
/// C# eşi <see cref="KeyframeCompiler.Parse"/> içindedir ve buradaki hakem
/// <see cref="ExportCompiler.Validate"/>'tir.
/// <para>
/// Her vaka hem GÖRSEL (opacity) hem SES (volume) kanalında koşar: iki kanal derleyicide aynı
/// Track yolundan geçer ve bu test o tekliği vektör düzeyinde sabitler. Kapının HTTP karşılığı
/// (422 + iş satırı yazılmaz) ExportEndpointsTests'te ayrıca ölçülür.
/// </para>
/// </summary>
public class KeyframeBoundsParityTests
{
    private sealed record BoundsCase(string Name, long TimelineDurationUs, long TimeUs, bool Valid);

    private sealed record BoundsFile(List<BoundsCase> Cases);

    private static readonly BoundsFile Vectors = Load();

    private static BoundsFile Load()
    {
        var path = TestVectorFiles.Resolve(
            "packages/timeline-schema/test-vectors/keyframe-bounds-vectors.json");
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        return JsonSerializer.Deserialize<BoundsFile>(File.ReadAllText(path), options)
            ?? throw new InvalidOperationException($"Could not parse {path}");
    }

    [Fact]
    public void VectorFile_CarriesBothDirections()
    {
        // Yalnız retleri (ya da yalnız kabulleri) taşıyan bir vektör dosyası SINIRI ölçmez.
        Assert.NotEmpty(Vectors.Cases);
        Assert.Contains(Vectors.Cases, c => c.Valid);
        Assert.Contains(Vectors.Cases, c => !c.Valid);
    }

    public static TheoryData<string, long, long, bool, bool> BoundsCases()
    {
        var data = new TheoryData<string, long, long, bool, bool>();
        foreach (var c in Vectors.Cases)
        {
            data.Add(c.Name, c.TimelineDurationUs, c.TimeUs, c.Valid, true);  // opacity (görsel)
            data.Add(c.Name, c.TimelineDurationUs, c.TimeUs, c.Valid, false); // volume (ses)
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(BoundsCases))]
    public void Validate_MatchesTheSharedBoundsVectors(
        string name, long timelineDurationUs, long timeUs, bool valid, bool visualChannel)
    {
        var clip = ExportTestDocs.VideoClip(
            ExportTestDocs.AssetA, 0, 0, timelineDurationUs,
            visualChannel ? null : ExportTestDocs.Audio());
        clip.Keyframes = visualChannel
            ? new KeyframeTracks { Opacity = [ExportTestDocs.Kf(timeUs, 1)] }
            : new KeyframeTracks { Volume = [ExportTestDocs.Kf(timeUs, 1)] };
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
            if (timeUs > timelineDurationUs)
            {
                // Üst sınır ihlalinde cümle zod'unkiyle hizalıdır (bilinçli parite).
                Assert.Contains($"outside [0, {timelineDurationUs}]", ex!.Message);
            }
        }
    }
}
