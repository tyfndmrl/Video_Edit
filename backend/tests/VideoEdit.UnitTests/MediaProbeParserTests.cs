using VideoEdit.Media;
using VideoEdit.Media.Probing;

namespace VideoEdit.UnitTests;

/// <summary>ffprobe JSON parse kuralları: rotation swap, VFR, HDR, gate hataları.</summary>
public class MediaProbeParserTests
{
    private static string VideoJson(
        string extraVideoFields = "", string formatDuration = "3.000000", bool withAudio = true)
    {
        var audio = withAudio
            ? """
              ,{"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2}
              """
            : "";
        return $$"""
        {
          "streams": [
            {"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,
             "r_frame_rate":"30/1","avg_frame_rate":"30/1"{{extraVideoFields}}}{{audio}}
          ],
          "format": {"duration":"{{formatDuration}}"}
        }
        """;
    }

    [Fact]
    public void StandardVideo_ParsesAllFields()
    {
        var probe = MediaProbeParser.Parse(VideoJson());

        Assert.True(probe.HasVideo);
        Assert.True(probe.HasAudio);
        Assert.Equal(3_000_000, probe.DurationUs);
        Assert.Equal(1920, probe.Width);
        Assert.Equal(1080, probe.Height);
        Assert.Equal((30, 1), (probe.FpsNum, probe.FpsDen));
        Assert.False(probe.IsVfr);
        Assert.False(probe.IsHdr);
        Assert.Equal(48000, probe.AudioSampleRate);
        Assert.Equal(2, probe.AudioChannels);
        Assert.Equal("h264", probe.VideoCodec);
        Assert.Equal("aac", probe.AudioCodec);
        Assert.Equal(0, probe.VideoStreamIndex);
        Assert.Equal(1, probe.AudioStreamIndex);
    }

    [Fact]
    public void Duration_RoundsHalfUpToMicros()
    {
        // 1.2345675 sn → 1_234_567.5 µs → half-up → 1_234_568.
        var probe = MediaProbeParser.Parse(VideoJson(formatDuration: "1.2345675"));
        Assert.Equal(1_234_568, probe.DurationUs);
    }

    [Fact]
    public void DisplayMatrixRotationMinus90_SwapsDimensions()
    {
        var probe = MediaProbeParser.Parse(VideoJson(
            extraVideoFields: ""","side_data_list":[{"side_data_type":"Display Matrix","rotation":-90}]"""));
        Assert.Equal(1080, probe.Width);
        Assert.Equal(1920, probe.Height);
    }

    [Fact]
    public void RotateTag90_SwapsDimensions()
    {
        var probe = MediaProbeParser.Parse(VideoJson(extraVideoFields: ""","tags":{"rotate":"90"}"""));
        Assert.Equal(1080, probe.Width);
        Assert.Equal(1920, probe.Height);
    }

    [Fact]
    public void Rotation180_DoesNotSwap()
    {
        var probe = MediaProbeParser.Parse(VideoJson(
            extraVideoFields: ""","side_data_list":[{"side_data_type":"Display Matrix","rotation":180}]"""));
        Assert.Equal(1920, probe.Width);
        Assert.Equal(1080, probe.Height);
    }

    [Fact]
    public void Vfr_WhenAvgDiffersFromR()
    {
        var json = VideoJson().Replace("\"avg_frame_rate\":\"30/1\"", "\"avg_frame_rate\":\"2997/100\"");
        var probe = MediaProbeParser.Parse(json);
        Assert.True(probe.IsVfr);
        Assert.Equal((2997, 100), (probe.AvgFpsNum, probe.AvgFpsDen));
        Assert.Equal((30, 1), (probe.FpsNum, probe.FpsDen));
    }

    [Fact]
    public void AvgZeroOverZero_FallsBackToR_ButTreatedAsVfr()
    {
        // avg parse edilemiyorsa (0/0) CFR VARSAYILMAZ: isVfr=true → proxy reçetesi fps
        // filtresini zorunlu ekler (VFR'ı CFR sanmak A/V senkronu bozar; tersi zararsız).
        var json = VideoJson().Replace("\"avg_frame_rate\":\"30/1\"", "\"avg_frame_rate\":\"0/0\"");
        var probe = MediaProbeParser.Parse(json);
        Assert.True(probe.IsVfr);
        Assert.Equal((30, 1), (probe.AvgFpsNum, probe.AvgFpsDen)); // nominal r'a düşer
    }

    [Theory]
    [InlineData(""","color_transfer":"smpte2084","color_primaries":"bt2020" """)]  // PQ
    [InlineData(""","color_transfer":"arib-std-b67" """)]                          // HLG
    [InlineData(""","color_transfer":"bt709","color_primaries":"bt2020" """)]      // yalnız primaries
    public void Hdr_DetectedFromTransferOrPrimaries(string colorFields)
    {
        Assert.True(MediaProbeParser.Parse(VideoJson(extraVideoFields: colorFields.TrimEnd())).IsHdr);
    }

    [Fact]
    public void Sdr_Bt709_NotHdr()
    {
        var probe = MediaProbeParser.Parse(VideoJson(
            extraVideoFields: ""","color_transfer":"bt709","color_primaries":"bt709" """.TrimEnd()));
        Assert.False(probe.IsHdr);
    }

    [Fact]
    public void Mp3WithCoverArt_AttachedPicIsNotVideo()
    {
        const string json = """
        {
          "streams": [
            {"index":0,"codec_type":"video","codec_name":"mjpeg","width":600,"height":600,
             "r_frame_rate":"90000/1","avg_frame_rate":"0/0","disposition":{"attached_pic":1}},
            {"index":1,"codec_type":"audio","codec_name":"mp3","sample_rate":"44100","channels":2}
          ],
          "format": {"duration":"180.5"}
        }
        """;
        var probe = MediaProbeParser.Parse(json);
        Assert.False(probe.HasVideo);
        Assert.True(probe.HasAudio);
        Assert.Equal(180_500_000, probe.DurationUs);
        Assert.Equal(1, probe.AudioStreamIndex);
    }

    [Fact]
    public void DurationMissingInFormat_FallsBackToStreamDuration()
    {
        const string json = """
        {
          "streams": [
            {"index":0,"codec_type":"video","codec_name":"h264","width":640,"height":360,
             "r_frame_rate":"25/1","avg_frame_rate":"25/1","duration":"2.500000"}
          ],
          "format": {}
        }
        """;
        Assert.Equal(2_500_000, MediaProbeParser.Parse(json).DurationUs);
    }

    [Fact]
    public void MalformedJson_ThrowsUnsupportedMedia()
    {
        Assert.Throws<UnsupportedMediaException>(() => MediaProbeParser.Parse("this is not json"));
    }

    [Fact]
    public void NoStreams_ThrowsUnsupportedMedia()
    {
        Assert.Throws<UnsupportedMediaException>(
            () => MediaProbeParser.Parse("""{"streams":[],"format":{}}"""));
        Assert.Throws<UnsupportedMediaException>(
            () => MediaProbeParser.Parse("""{"format":{}}"""));
    }

    [Fact]
    public void OnlyDataStream_ThrowsUnsupportedMedia()
    {
        const string json = """
        {"streams":[{"index":0,"codec_type":"data","codec_name":"bin_data"}],"format":{"duration":"1.0"}}
        """;
        Assert.Throws<UnsupportedMediaException>(() => MediaProbeParser.Parse(json));
    }
}
