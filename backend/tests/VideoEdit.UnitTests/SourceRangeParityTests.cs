using System.Text.Json;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Export;

namespace VideoEdit.UnitTests;

/// <summary>
/// Cross-language KAYNAK-ARALIĞI belge-değişmezi sözleşmesi (kabul/ret paritesi):
/// packages/timeline-schema/test-vectors/source-range-vectors.json hem vitest
/// (invariants.test.ts "matches the shared source-range vectors") hem bu paket tarafından
/// koşulur. Kural: bir medya klibi ancak <c>sourceInUs &gt;= 0</c>, <c>sourceOutUs &gt;
/// sourceInUs</c> ve <c>timelineDurationUs == roundHalfUp((sourceOutUs - sourceInUs) /
/// speed.rate)</c> ise geçerlidir; hakem <see cref="ExportCompiler.Validate"/>'tir.
/// <para>
/// Formülün SAYISAL paritesi zaten time-vectors.json 'duration' ile ölçülüyor; bu dosya
/// BELGE-seviyesi RED davranışını ölçer — C1 (keyframe üst sınırı) ile aynı sınıf: aynı
/// değişmez iki dilde ayrı yazıldığında kabul/ret ayrışabilir. Her vaka tek bir video
/// klibinde koşar ki yalnız kaynak-aralığı kuralı devrede olsun.
/// </para>
/// </summary>
public class SourceRangeParityTests
{
    private sealed record RangeCase(
        string Name, long SourceInUs, long SourceOutUs, double Rate, long TimelineDurationUs, bool Valid);

    private sealed record RangeFile(List<RangeCase> Cases);

    private static readonly RangeFile Vectors = Load();

    private static RangeFile Load()
    {
        var path = TestVectorFiles.Resolve(
            "packages/timeline-schema/test-vectors/source-range-vectors.json");
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        return JsonSerializer.Deserialize<RangeFile>(File.ReadAllText(path), options)
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

    public static TheoryData<string, long, long, double, long, bool> RangeCases()
    {
        var data = new TheoryData<string, long, long, double, long, bool>();
        foreach (var c in Vectors.Cases)
        {
            data.Add(c.Name, c.SourceInUs, c.SourceOutUs, c.Rate, c.TimelineDurationUs, c.Valid);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(RangeCases))]
    public void Validate_MatchesTheSharedSourceRangeVectors(
        string name, long sourceInUs, long sourceOutUs, double rate, long timelineDurationUs, bool valid)
    {
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, sourceInUs, sourceOutUs);
        clip.TimelineDurationUs = timelineDurationUs;
        clip.Speed = new MediaClipSpeed { Rate = rate };
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
