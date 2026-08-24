using VideoEdit.Contracts.Timeline;
using VideoEdit.Media;
using VideoEdit.Media.Export;

namespace VideoEdit.UnitTests;

/// <summary>
/// GÖRSEL kliplerde geçiş — üç katmanın (invariants.ts / editör timelineOps / bu compiler)
/// AYNI yorumda olduğunun backend tarafındaki kanıtı.
/// <para>
/// Denetim bulgusu (YÜKSEK): editör ve şema D/2 kaynak payını HER medya klibine
/// uyguluyordu. Görsel klip <c>sourceIn = 0, sourceOut = 4 sn</c> ile doğar → payı daima 0 →
/// iki fotoğraf arasına crossfade (slayt gösterisi) EKLENEMİYORDU. Compiler ise görseli
/// açıkça muaf tutar: <see cref="ExportClipPlan.IsStillInput"/> girişi <c>-loop 1 -t</c> ile
/// açar, pencerenin istediği kadar kare üretir ve kaynak-aralığı defterine hiç girmez.
/// </para>
/// <para>
/// Bu dosya compiler'ın davranışını KİLİTLER: şema/editör tarafındaki muafiyet bu davranışa
/// dayanıyor, dolayısıyla burada sessiz bir sıkılaştırma olursa üç katman yeniden ayrışır.
/// </para>
/// </summary>
public sealed class ExportImageTransitionTests
{
    /// <summary>AssetC ve AssetB birer PNG (ses yok), AssetA sesli video.</summary>
    private static Dictionary<Guid, ExportAssetSource> Sources() => new()
    {
        [ExportTestDocs.AssetA] = new ExportAssetSource("assets/a.mp4", true, "bt709", "bt709"),
        [ExportTestDocs.AssetB] = new ExportAssetSource("assets/one.png", false, "bt709", "bt709"),
        [ExportTestDocs.AssetC] = new ExportAssetSource("assets/two.png", false, "bt709", "bt709"),
    };

    /// <summary>
    /// İki 4 sn'lik fotoğraf, aralarında 400 ms (12 frame @30, ÇİFT) crossfade. Editörün
    /// ürettiği şeklin birebir aynısı: her ikisinde de sourceIn = 0.
    /// </summary>
    private static TimelineDoc Slideshow(long transitionUs = 400_000)
    {
        var a = ExportTestDocs.ImageClip(ExportTestDocs.AssetB, 0, 4_000_000);
        var b = ExportTestDocs.ImageClip(ExportTestDocs.AssetC, 4_000_000, 4_000_000);
        ExportTestDocs.Link(a, b, transitionUs);
        return ExportTestDocs.Doc(clips: [a, b]);
    }

    [Fact]
    public void Compile_CrossfadeBetweenTwoPhotographs_IsAccepted()
    {
        var compiled = ExportCompiler.Compile(Slideshow(), Sources(), ExportProfile.Hd1080p);

        // Kesim 4 sn'de, D = 400 ms → offset = kesim - D/2 = 4 - 0.2 = 3.8 sn (§5.3).
        Assert.Contains("xfade=transition=fade:duration=0.400000:offset=3.800000",
            compiled.FilterGraphScript);
        // Toplam süre geçişten ETKİLENMEZ (§5.1): 8 sn.
        Assert.Equal(8_000_000, compiled.ExpectedDurationUs);
    }

    [Fact]
    public void Compile_ImageTransitionInputs_StayLoopedWithNoSeek()
    {
        var compiled = ExportCompiler.Compile(Slideshow(), Sources(), ExportProfile.Hd1080p);

        // Görsel girişte -ss ÜRETİLMEZ: dosyada zaman ekseni yok, pay "kaynaktan" alınmaz.
        // Kare sayısını zincirdeki trim sabitler; -t bir kare cömert verilir.
        Assert.All(compiled.Inputs, input => Assert.True(input.Loop));
        Assert.All(compiled.Inputs, input => Assert.DoesNotContain("-ss", input.ToArgs()));
        // D/2 = 6 frame pay: A 120+6, B 6+120 frame okur.
        Assert.Contains("trim=end_frame=126,", compiled.FilterGraphScript);
    }

    [Fact]
    public void Validate_ImageTransition_KeepsStillClipsOutOfTheSourceRangeLedger()
    {
        // Kaynak-aralığı defteri worker'ın "bu aralık dosyada var mı" kapısıdır. Görsel
        // oraya girmemelidir; girseydi 4 sn + 200 ms pay bir PNG'de aranır ve export düşerdi.
        var plan = ExportCompiler.Validate(Slideshow());
        Assert.Empty(plan.Clips);
        // Dosyanın kendisi yine de İNDİRİLİR.
        Assert.Equal(2, plan.AssetIds.Count);
    }

    [Fact]
    public void Validate_MixedCut_StillDemandsTheHandleOnTheVIDEOSide()
    {
        // A = görsel (kuyruk payı aranmaz), B = video sourceIn 0 (baş payı YOK) → RED.
        // Muafiyet klip BAŞINA verilir; "geçişte pay hiç aranmaz" DEĞİLDİR.
        var a = ExportTestDocs.ImageClip(ExportTestDocs.AssetB, 0, 4_000_000);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 4_000_000, 0, 4_000_000);
        ExportTestDocs.Link(a, b, 400_000);

        var ex = Assert.Throws<UnsupportedFeatureException>(
            () => ExportCompiler.Validate(ExportTestDocs.Doc(clips: [a, b])));
        Assert.Equal("transition-handle", ex.Feature);
    }

    [Fact]
    public void Validate_MixedCut_AcceptsAnImageWithNoHandleWhenTheVideoSideHasOne()
    {
        // A = video (kuyruk payı compiler'da ölçülemez, worker'ın defter kapısına kalır),
        // B = GÖRSEL sourceIn 0 → baş payı aranmaz, geçiş kurulur.
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 1_000_000, 5_000_000);
        var b = ExportTestDocs.ImageClip(ExportTestDocs.AssetB, 4_000_000, 4_000_000);
        ExportTestDocs.Link(a, b, 400_000);

        var compiled = ExportCompiler.Compile(
            ExportTestDocs.Doc(clips: [a, b]), Sources(), ExportProfile.Hd1080p);

        Assert.Contains("xfade=transition=fade:duration=0.400000:offset=3.800000",
            compiled.FilterGraphScript);
        // Video tarafı KUYRUK payını KAYNAKTAN alır (4.0 sn + 0.2 sn), görsel hiç almaz.
        Assert.Equal(["-ss", "1.000000", "-t", "4.200000", "-i", "assets/a.mp4"],
            compiled.Inputs[0].ToArgs());
        Assert.True(compiled.Inputs[1].Loop);
    }

    [Fact]
    public void Validate_ImageTransition_StillEnforcesTheEvenFrameAndLengthRules()
    {
        // Muafiyet YALNIZ paya dairdir. D'nin frame ızgarası ve "kısa komşunun yarısı"
        // üst sınırı görselde de aynen geçerlidir.
        Assert.Throws<InvalidTimelineException>(
            () => ExportCompiler.Validate(Slideshow(transitionUs: 2_100_000)));

        // 5 frame @30 = 166_667us: ızgarada olsa bile TEK frame → red.
        Assert.Throws<InvalidTimelineException>(
            () => ExportCompiler.Validate(Slideshow(transitionUs: 166_667)));
    }
}
