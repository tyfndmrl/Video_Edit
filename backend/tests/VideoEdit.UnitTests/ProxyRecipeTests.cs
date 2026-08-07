using System.Globalization;
using VideoEdit.Media.Probing;
using VideoEdit.Media.Recipes;

namespace VideoEdit.UnitTests;

/// <summary>
/// Proxy reçetesi komut satırı SNAPSHOT testleri (tasarım 02 §3.3 normatif + M1 kuralları).
/// Komut değişikliği bilinçli olmalı: snapshot kırılırsa önce tasarım dokümanına bak.
/// </summary>
public class ProxyRecipeTests
{
    private static MediaProbe Probe(
        int width, int height,
        bool hasAudio = true,
        bool isVfr = false,
        int avgNum = 30, int avgDen = 1,
        string? colorTransfer = null, string? colorPrimaries = null,
        long? durationUs = 10_000_000) => new()
    {
        RawJson = "{}",
        DurationUs = durationUs,
        HasVideo = true,
        HasAudio = hasAudio,
        Width = width,
        Height = height,
        FpsNum = 30,
        FpsDen = 1,
        AvgFpsNum = avgNum,
        AvgFpsDen = avgDen,
        IsVfr = isVfr,
        ColorTransfer = colorTransfer,
        ColorPrimaries = colorPrimaries,
        IsHdr = ColorChain.IsHdr(colorTransfer, colorPrimaries),
        VideoStreamIndex = 0,
        AudioStreamIndex = hasAudio ? 1 : -1,
    };

    private static string Join(IReadOnlyList<string> args) => string.Join(' ', args);

    [Fact]
    public void Landscape1080p_Cfr_Sdr_WithAudio_Snapshot()
    {
        var args = ProxyRecipe.BuildVideoArgs(Probe(1920, 1080), "in.mp4", "out.mp4");
        Assert.Equal(
            "-y -i in.mp4 -map 0:0 -map 0:1 "
            + "-vf scale=-2:540:flags=bicubic "
            + "-c:v libx264 -preset veryfast -crf 23 -profile:v main -pix_fmt yuv420p "
            + "-g 15 -keyint_min 15 -sc_threshold 0 -bf 0 "
            + "-c:a aac -b:a 128k -ac 2 -ar 48000 "
            + "-movflags +faststart out.mp4",
            Join(args));
    }

    [Fact]
    public void VfrSource_GetsMandatoryFpsFilter_NominalCfrFromAvg()
    {
        // avg 29.97 (2997/100) → nominal standart oran 30000/1001 (rendering-semantics §1.6).
        var probe = Probe(1920, 1080, isVfr: true, avgNum: 2997, avgDen: 100);
        var filter = ProxyRecipe.BuildVideoFilter(probe);
        Assert.Equal("scale=-2:540:flags=bicubic,fps=30000/1001", filter);
    }

    [Fact]
    public void CfrSource_HasNoFpsFilter()
    {
        Assert.DoesNotContain("fps=", ProxyRecipe.BuildVideoFilter(Probe(1920, 1080)));
    }

    [Fact]
    public void UnknownAvgFrameRate_TreatedAsVfr_GetsFpsFilter()
    {
        // Parser avg=0/0'ı isVfr=true yapar (CFR varsayılmaz) → reçete fps filtresini ekler
        // (nominal, r'a düşen avg'dan: 30/1).
        const string json = """
        {
          "streams": [
            {"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,
             "r_frame_rate":"30/1","avg_frame_rate":"0/0"}
          ],
          "format": {"duration":"3.0"}
        }
        """;
        var probe = MediaProbeParser.Parse(json);
        Assert.True(probe.IsVfr);
        Assert.Equal("scale=-2:540:flags=bicubic,fps=30/1", ProxyRecipe.BuildVideoFilter(probe));
    }

    [Fact]
    public void HdrSource_TonemapChainBeforeScale_UsesNormativeConstant()
    {
        var probe = Probe(3840, 2160, colorTransfer: "smpte2084", colorPrimaries: "bt2020");
        var filter = ProxyRecipe.BuildVideoFilter(probe);
        // ÖZDEŞLİK sözleşmesi: proxy, ColorChain.HdrToSdr SABİTİNİ kullanır (M3 export da aynı).
        Assert.StartsWith(ColorChain.HdrToSdr + ",", filter, StringComparison.Ordinal);
        Assert.Equal(ColorChain.HdrToSdr + ",scale=-2:540:flags=bicubic", filter);
    }

    [Fact]
    public void HdrHlg_AlsoDetected()
    {
        var probe = Probe(1920, 1080, colorTransfer: "arib-std-b67");
        Assert.True(probe.IsHdr);
        Assert.StartsWith(ColorChain.HdrToSdr, ProxyRecipe.BuildVideoFilter(probe), StringComparison.Ordinal);
    }

    [Fact]
    public void UntaggedBt2020_GetsTinParameterFromProbe()
    {
        // primaries=bt2020 ama transfer HDR tag'li değil → zscale girişine tin= eklenir (§6.2).
        var probe = Probe(3840, 2160, colorTransfer: "bt2020-10", colorPrimaries: "bt2020");
        var filter = ProxyRecipe.BuildVideoFilter(probe);
        Assert.Contains("zscale=t=linear:npl=100:tin=bt2020-10,", filter, StringComparison.Ordinal);
    }

    [Fact]
    public void PortraitSource_UsesConditionalScaleVariant()
    {
        var filter = ProxyRecipe.BuildVideoFilter(Probe(1080, 1920));
        Assert.Equal("scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)':flags=bicubic", filter);
    }

    [Fact]
    public void NoAudio_SkipsAudioArgsEntirely()
    {
        var joined = Join(ProxyRecipe.BuildVideoArgs(Probe(1920, 1080, hasAudio: false), "in.mp4", "out.mp4"));
        Assert.DoesNotContain("-c:a", joined);
        Assert.DoesNotContain("aac", joined);
        Assert.DoesNotContain("128k", joined);
    }

    // ── UPSCALE YASAĞI (M1 reçete kuralı): kısa kenar ≤ 540 ise scale atlanır. ──

    [Fact]
    public void SmallSource240p_NeverUpscaled_NoScaleFilter()
    {
        Assert.Equal("", ProxyRecipe.BuildVideoFilter(Probe(320, 240)));
        var joined = Join(ProxyRecipe.BuildVideoArgs(Probe(320, 240), "in.mp4", "out.mp4"));
        Assert.DoesNotContain("-vf", joined);
    }

    [Fact]
    public void Exactly540ShortSide_NoScaleFilter()
    {
        Assert.Equal("", ProxyRecipe.BuildVideoFilter(Probe(960, 540)));
        Assert.Equal("", ProxyRecipe.BuildVideoFilter(Probe(540, 960))); // dikey eşdeğeri
    }

    [Fact]
    public void SmallSource_OddDimensions_GetEvenAlignOnly()
    {
        // Upscale yok ama libx264/yuv420p çift boyut ister — yalnız hizalama filtresi.
        Assert.Equal(
            "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=bicubic",
            ProxyRecipe.BuildVideoFilter(Probe(853, 480)));
    }

    [Fact]
    public void SmallVfrSource_KeepsFpsFilterWithoutScale()
    {
        var probe = Probe(320, 240, isVfr: true, avgNum: 25, avgDen: 1);
        Assert.Equal("fps=25/1", ProxyRecipe.BuildVideoFilter(probe));
    }

    [Fact]
    public void AudioOnlyProxy_Snapshot()
    {
        Assert.Equal(
            "-y -i in.mp3 -vn -c:a aac -b:a 128k -ac 2 -ar 48000 -movflags +faststart out.m4a",
            Join(ProxyRecipe.BuildAudioArgs("in.mp3", "out.m4a")));
    }

    // ── NominalCfr eşlemesi ──

    [Theory]
    [InlineData(2997, 100, 30000, 1001)]   // 29.97 → NTSC
    [InlineData(30, 1, 30, 1)]
    [InlineData(2398, 100, 24000, 1001)]   // 23.98 → 23.976
    [InlineData(25, 1, 25, 1)]
    [InlineData(5994, 100, 60000, 1001)]   // 59.94
    [InlineData(120, 1, 60, 1)]            // aralık dışı → en yakın standart (60)
    [InlineData(27, 1, 25, 1)]             // 27 → 25 (|27-25|=2 < |27-29.97|=2.97)
    public void NominalCfr_PicksNearestStandardRate(int avgNum, int avgDen, int expectedNum, int expectedDen)
    {
        Assert.Equal((expectedNum, expectedDen), NominalCfr.FromAvg(avgNum, avgDen));
    }

    // ── TR locale: arg üretimi CurrentCulture'dan bağımsız nokta üretmeli ──

    [Fact]
    public void ArgGeneration_UnderTurkishCulture_ProducesInvariantOutput()
    {
        var culture = CultureInfo.CurrentCulture;
        var uiCulture = CultureInfo.CurrentUICulture;
        try
        {
            CultureInfo.CurrentCulture = new CultureInfo("tr-TR");
            CultureInfo.CurrentUICulture = new CultureInfo("tr-TR");

            // Ortam gerçekten virgül üretiyor — testin anlamlı olduğunun kanıtı.
            Assert.Equal("0,5", 0.5.ToString(CultureInfo.CurrentCulture));

            var probe = Probe(1920, 1080, isVfr: true, avgNum: 2997, avgDen: 100,
                colorTransfer: "smpte2084", durationUs: 3_000_000);
            var proxyJoined = Join(ProxyRecipe.BuildVideoArgs(probe, "in.mp4", "out.mp4"));
            Assert.Contains("fps=30000/1001", proxyJoined, StringComparison.Ordinal);

            // Poster -ss: 3 sn × 0.1 = 0.3 sn → "0.300000" (nokta!).
            var posterJoined = Join(PosterRecipe.BuildVideoArgs(probe, "in.mp4", "poster.jpg"));
            Assert.Contains("-ss 0.300000", posterJoined, StringComparison.Ordinal);
            Assert.DoesNotContain("0,3", posterJoined, StringComparison.Ordinal);
        }
        finally
        {
            CultureInfo.CurrentCulture = culture;
            CultureInfo.CurrentUICulture = uiCulture;
        }
    }

    // ── Poster reçetesi ──

    [Fact]
    public void Poster_SeekIsMinOfOneSecondAndTenPercent()
    {
        Assert.Equal(300_000, PosterRecipe.PosterTimeUs(3_000_000));      // 3 sn → 0.3 sn
        Assert.Equal(1_000_000, PosterRecipe.PosterTimeUs(60_000_000));   // 60 sn → 1 sn tavan
        Assert.Equal(0, PosterRecipe.PosterTimeUs(null));
    }

    [Fact]
    public void Poster_SmallSource_NoScale_LargeSource_CappedAt1280()
    {
        Assert.Null(PosterRecipe.BuildFilter(Probe(320, 240)));
        Assert.Equal("scale=1280:-2:flags=bicubic", PosterRecipe.BuildFilter(Probe(1920, 1080)));
    }

    [Fact]
    public void Poster_VideoArgs_Snapshot()
    {
        var args = PosterRecipe.BuildVideoArgs(Probe(1920, 1080, durationUs: 60_000_000), "in.mp4", "poster.jpg");
        Assert.Equal(
            "-y -ss 1.000000 -i in.mp4 -map 0:0 -frames:v 1 -vf scale=1280:-2:flags=bicubic -q:v 4 poster.jpg",
            Join(args));
    }

    [Fact]
    public void Poster_ImageArgs_NoSeek()
    {
        var joined = Join(PosterRecipe.BuildImageArgs(Probe(4000, 3000, hasAudio: false), "in.png", "poster.jpg"));
        Assert.DoesNotContain("-ss", joined);
        Assert.Contains("scale=1280:-2:flags=bicubic", joined, StringComparison.Ordinal);
    }
}
