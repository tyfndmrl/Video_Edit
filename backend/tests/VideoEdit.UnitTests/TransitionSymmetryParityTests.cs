using System.Text.Json;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Export;

namespace VideoEdit.UnitTests;

/// <summary>
/// Cross-language GEÇİŞ SİMETRİSİ sözleşmesi (kabul/ret paritesi):
/// packages/timeline-schema/test-vectors/transition-symmetry-vectors.json hem vitest
/// (invariants.test.ts "matches the shared transition-symmetry vectors") hem bu paket
/// tarafından koşulur. Ölçülen kurallar (rendering-semantics §5.2): bitişiklik, iki yanın
/// derin-eşitliği (tip + süre), sürenin ızgara/çift-kare/üst-sınır şartları ve HIZ-FARKINDA
/// BAŞ el payı (kaynak ekseninde, kare-defteri yarımıyla: halfUs = frameToUs(dFrames/2));
/// zaman ekseni olmayan görsel (still) taraf paydan muaftır. Hakem
/// <see cref="ExportCompiler.Validate"/>'tir — KUYRUK payı asset süresi istediği ve hakem
/// onu göremediği için bu dosyanın DIŞINDADIR (zod tarafı da assetDurations vermeden koşar).
/// 'half-frame-ledger-boundary' vakası ailenin var oluş nedenidir: 14 karelik geçişte
/// derleyici yarımı 233333µs isterken zod eskiden 233334µs istiyordu (naif D/2) — ±1µs'lik
/// GERÇEK bir kabul/ret ayrışması. docs/backlog.md 14. tur "M3 sınıfı" ailelerinden
/// 'geçiş simetrisi'nin kapanışıdır.
/// </summary>
public class TransitionSymmetryParityTests
{
    private sealed record TransitionSpec(string Type, long DurationUs);

    private sealed record TransitionCase(
        string Name, long ADurationUs, long BDurationUs, long GapUs,
        double ARate, double BRate, long BSourceInUs,
        TransitionSpec? ATransition, TransitionSpec? BTransition, bool BStill, bool Valid);

    private sealed record TransitionFile(List<TransitionCase> Cases);

    private static readonly TransitionFile Vectors = Load();

    private static TransitionFile Load()
    {
        var path = TestVectorFiles.Resolve(
            "packages/timeline-schema/test-vectors/transition-symmetry-vectors.json");
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        return JsonSerializer.Deserialize<TransitionFile>(File.ReadAllText(path), options)
            ?? throw new InvalidOperationException($"Could not parse {path}");
    }

    [Fact]
    public void VectorFile_CarriesBothDirections()
    {
        Assert.NotEmpty(Vectors.Cases);
        Assert.Contains(Vectors.Cases, c => c.Valid);
        Assert.Contains(Vectors.Cases, c => !c.Valid);
    }

    public static TheoryData<string> TransitionCaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var c in Vectors.Cases)
        {
            data.Add(c.Name);
        }

        return data;
    }

    private static Transition ToTransition(TransitionSpec spec) => new()
    {
        Type = spec.Type switch
        {
            "crossfade" => TransitionType.Crossfade,
            "dissolve" => TransitionType.Dissolve,
            _ => throw new InvalidOperationException($"vektörde tanınmayan geçiş tipi: {spec.Type}"),
        },
        DurationUs = spec.DurationUs,
    };

    [Theory]
    [MemberData(nameof(TransitionCaseNames))]
    public void Validate_MatchesTheSharedTransitionVectors(string name)
    {
        var c = Vectors.Cases.Single(x => x.Name == name);

        // Vektör sözleşmesindeki kurulum (dosyadaki description ile birebir):
        // A: start 0, sourceIn 0, sourceOut = aDur × aRate; B: start = aDur + gap,
        // sourceIn = bSourceIn, sourceOut = bSourceIn + bDur × bRate; bStill → görsel klip.
        var a = ExportTestDocs.SpeedClip(
            ExportTestDocs.AssetA, 0, 0, (long)(c.ADurationUs * c.ARate), c.ARate);
        var bStart = c.ADurationUs + c.GapUs;
        MediaClip b = c.BStill
            ? ExportTestDocs.ImageClip(ExportTestDocs.AssetB, bStart, c.BDurationUs)
            : ExportTestDocs.SpeedClip(
                ExportTestDocs.AssetB, bStart, c.BSourceInUs,
                c.BSourceInUs + (long)(c.BDurationUs * c.BRate), c.BRate);
        if (c.ATransition is { } aTransition)
        {
            a.TransitionOut = ToTransition(aTransition);
        }

        if (c.BTransition is { } bTransition)
        {
            b.TransitionIn = ToTransition(bTransition);
        }

        var doc = ExportTestDocs.Doc(clips: [a, b]);

        if (c.Valid)
        {
            Assert.NotNull(ExportCompiler.Validate(doc));
        }
        else
        {
            var ex = Record.Exception(() => ExportCompiler.Validate(doc));
            Assert.True(ex is ExportCompileException,
                $"{name}: tipli ret (ExportCompileException) bekleniyordu, "
                + $"gelen: {ex?.GetType().Name ?? "istisna yok"}.");
        }
    }
}
