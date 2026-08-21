using System.Text.Json;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Export;

namespace VideoEdit.UnitTests;

/// <summary>
/// Cross-language KLİP YERLEŞİMİ sözleşmesi (kabul/ret paritesi):
/// packages/timeline-schema/test-vectors/clip-placement-vectors.json hem vitest
/// (invariants.test.ts "matches the shared clip-placement vectors") hem bu paket tarafından
/// koşulur. Kural: track içinde klipler timelineStartUs'a göre sıralı ve çakışmasız
/// (önceki klibin bitişi ≤ sonrakinin başlangıcı); boşluk serbesttir. Hakem
/// <see cref="ExportCompiler.Validate"/>'tir. Vektördeki her kenar 30fps proje ızgarasına
/// oturur ve süre formülü kurulumdan sağlanır — yalnız yerleşim kuralı ayrıştırır.
/// docs/backlog.md 14. tur "M3 sınıfı" ailelerinden 'klip yerleşimi'nin kapanışıdır.
/// </summary>
public class ClipPlacementParityTests
{
    private sealed record ClipSpec(long StartUs, long DurationUs);

    private sealed record PlacementCase(string Name, List<ClipSpec> Clips, bool Valid);

    private sealed record PlacementFile(List<PlacementCase> Cases);

    private static readonly PlacementFile Vectors = Load();

    private static PlacementFile Load()
    {
        var path = TestVectorFiles.Resolve(
            "packages/timeline-schema/test-vectors/clip-placement-vectors.json");
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        return JsonSerializer.Deserialize<PlacementFile>(File.ReadAllText(path), options)
            ?? throw new InvalidOperationException($"Could not parse {path}");
    }

    [Fact]
    public void VectorFile_CarriesBothDirections()
    {
        Assert.NotEmpty(Vectors.Cases);
        Assert.Contains(Vectors.Cases, c => c.Valid);
        Assert.Contains(Vectors.Cases, c => !c.Valid);
    }

    public static TheoryData<string> PlacementCaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var c in Vectors.Cases)
        {
            data.Add(c.Name);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(PlacementCaseNames))]
    public void Validate_MatchesTheSharedPlacementVectors(string name)
    {
        var c = Vectors.Cases.Single(x => x.Name == name);
        var clips = c.Clips
            .Select(spec => (Clip)ExportTestDocs.VideoClip(
                ExportTestDocs.AssetA, spec.StartUs, 0, spec.DurationUs))
            .ToArray();
        var doc = ExportTestDocs.Doc(clips: clips);

        if (c.Valid)
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
