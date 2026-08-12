using System.Text.Json;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Export;

namespace VideoEdit.UnitTests;

/// <summary>
/// Frame-grid sözleşmesinin GERÇEK sınır testi: dokümanları editörün KENDİ op'ları üretir
/// (apps/editor/src/state/frameGridCrossBoundary.test.ts — asset ekleme, bölme, kırpma,
/// ripple kırpma, taşıma, çoklu taşıma, katman ekleme, hız), sonuç
/// packages/timeline-schema/test-vectors/frame-grid-corpus.json dosyasına yazılır ve BURADA
/// derleyicinin kendisine verilir.
/// <para>
/// Neden replica değil de gerçek derleyici: teslim öncesi kusur tam olarak iki tarafın
/// "kare ızgarasında" tanımının ayrışmasıydı — derleyici SÜRENİN, editör KENARLARIN ızgarada
/// olmasını sağlıyordu; 30 fps'te ikisi aynı anda sağlanamaz (frame1=33_333, frame2=66_667 →
/// bir karelik klip 33_334 µs). Editörün ürettiği belge PUT 200 ile kaydediliyor, export
/// 422 dönüyordu. Aynı belgeleri iki tarafta da koşmayan her test bu kusuru kaçırır.
/// </para>
/// </summary>
public class FrameGridCrossBoundaryTests
{
    private sealed record CorpusCase(string Label, string Fps, TimelineDoc Doc);

    private sealed record CorpusFile(List<CorpusCase> Cases);

    private static readonly CorpusFile Corpus = Load();

    private static CorpusFile Load()
    {
        var path = TestVectorFiles.Resolve(
            "packages/timeline-schema/test-vectors/frame-grid-corpus.json");
        if (!File.Exists(path))
        {
            throw new InvalidOperationException(
                $"Frame-grid corpus missing at '{path}'. Generate it with "
                + "`pnpm --filter @videoedit/editor test src/state/frameGridCrossBoundary.test.ts`.");
        }

        // Belge gövdesi prod yolunun AYNI seçenekleriyle okunur (jsonb → DTO).
        var options = new JsonSerializerOptions(TimelineJson.Options)
        {
            PropertyNameCaseInsensitive = true,
        };
        return JsonSerializer.Deserialize<CorpusFile>(File.ReadAllText(path), options)
            ?? throw new InvalidOperationException($"Could not parse {path}");
    }

    /// <summary>
    /// Korpus daralırsa test sessizce "yeşil" olmasın: dört proje hızının DÖRDÜ de temsil
    /// edilmeli ve her hız için birden çok op sonucu bulunmalı.
    /// </summary>
    [Fact]
    public void Corpus_CoversEveryProjectRate()
    {
        Assert.True(Corpus.Cases.Count >= 32, $"corpus too small: {Corpus.Cases.Count}");
        foreach (var fps in new[] { "30/1", "30000/1001", "25/1", "24000/1001" })
        {
            Assert.True(
                Corpus.Cases.Count(c => c.Fps == fps) >= 8,
                $"corpus has too few cases for {fps}");
        }
    }

    public static TheoryData<int> CaseIndices()
    {
        var data = new TheoryData<int>();
        for (var i = 0; i < Corpus.Cases.Count; i++)
        {
            data.Add(i);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(CaseIndices))]
    public void EditorProducedDocument_PassesExportCompilerValidate(int index)
    {
        var c = Corpus.Cases[index];
        var doc = ExportTestDocs.Roundtrip(c.Doc);

        var plan = ExportCompiler.Validate(doc);

        Assert.NotNull(plan);
        Assert.NotEmpty(plan.Tracks);

        // Kenar defteri: derleyicinin klip başına ürettiği start/end FRAME'i µs'ye geri
        // çevirdiğimizde belgedeki değerlerin TAM kendisi çıkmalı. Yuvarlama toleransıyla
        // "yakın" olmak yetmez — render penceresi bu iki frame numarasından kurulur
        // (trim=start_frame:end_frame), yani kenar ızgarada değilse belgedeki süre ile
        // render edilen süre ayrışır.
        foreach (var trackPlan in plan.Tracks)
        {
            foreach (var clip in trackPlan.Clips)
            {
                var startFrame = new Timecode(clip.TimelineStartUs)
                    .ToFrameNumber(plan.FpsNum, plan.FpsDen);
                var endUs = clip.TimelineStartUs + clip.TimelineDurationUs;
                var endFrame = new Timecode(endUs).ToFrameNumber(plan.FpsNum, plan.FpsDen);
                Assert.Equal(
                    clip.TimelineStartUs,
                    Timecode.FromFrameNumber(startFrame, plan.FpsNum, plan.FpsDen).Micros);
                Assert.Equal(
                    endUs,
                    Timecode.FromFrameNumber(endFrame, plan.FpsNum, plan.FpsDen).Micros);
                Assert.True(endFrame > startFrame, $"{c.Label}: clip shorter than one frame");
            }
        }
    }
}
