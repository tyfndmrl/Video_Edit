using System.Text.Json;
using VideoEdit.Media.Waveform;

namespace VideoEdit.UnitTests;

/// <summary>
/// .NET içi waveform pencereleme (backlog kararı: audiowaveform binary'si yok).
/// Sentetik PCM ile peak sayısı/aralığı ve audiowaveform version:2 JSON şekli doğrulanır.
/// </summary>
public class WaveformPeaksBuilderTests
{
    [Fact]
    public void Silence_ProducesZeroPeaks()
    {
        var builder = new WaveformPeaksBuilder();
        builder.AddSamples(new short[800]); // 5 tam pencere (160'lık)
        builder.Complete();

        Assert.Equal(5, builder.PeakCount);
        var (mins, maxes) = ReadPeaks(builder);
        Assert.All(mins, m => Assert.Equal(0, m));
        Assert.All(maxes, m => Assert.Equal(0, m));
    }

    [Fact]
    public void SquareWave_ProducesFullScaleMinMax()
    {
        var builder = new WaveformPeaksBuilder();
        var samples = new short[320];
        for (var i = 0; i < samples.Length; i++)
        {
            samples[i] = i % 2 == 0 ? (short)16384 : (short)-16384;
        }

        builder.AddSamples(samples);
        builder.Complete();

        Assert.Equal(2, builder.PeakCount);
        var (mins, maxes) = ReadPeaks(builder);
        Assert.All(mins, m => Assert.Equal(-64, m));  // -16384/256
        Assert.All(maxes, m => Assert.Equal(64, m));  // 16384/256
    }

    [Fact]
    public void PartialLastWindow_IsFlushedOnComplete()
    {
        var builder = new WaveformPeaksBuilder();
        builder.AddSamples(new short[820]); // 5 tam + 100 örneklik kısmi pencere
        builder.Complete();
        Assert.Equal(6, builder.PeakCount);
    }

    [Fact]
    public void KnownSine_ProducesExpectedPeakCountAndRange()
    {
        // 1 sn @ 8000 Hz, 440 Hz sinüs, genlik 32000 → 50 peak; her 160 örneklik pencere
        // ~8.8 periyot görür → her pencerede tam genliğe yaklaşılır.
        var builder = new WaveformPeaksBuilder();
        var samples = new short[8000];
        for (var i = 0; i < samples.Length; i++)
        {
            samples[i] = (short)(32000 * Math.Sin(2 * Math.PI * 440 * i / 8000));
        }

        builder.AddSamples(samples);
        builder.Complete();

        Assert.Equal(50, builder.PeakCount); // 50 peak/sn sözleşmesi
        var (mins, maxes) = ReadPeaks(builder);
        Assert.All(mins, m => Assert.InRange(m, -125, -115));  // ≈ -32000/256 = -125
        Assert.All(maxes, m => Assert.InRange(m, 115, 125));
    }

    [Fact]
    public void Int8Scaling_ExtremesMapExactly()
    {
        var builder = new WaveformPeaksBuilder(samplesPerPixel: 2);
        builder.AddSamples([short.MinValue, short.MaxValue]);
        builder.Complete();
        var (mins, maxes) = ReadPeaks(builder);
        Assert.Equal(-128, mins[0]); // -32768 >> 8
        Assert.Equal(127, maxes[0]); //  32767 >> 8
    }

    [Fact]
    public void Int8Scaling_UsesArithmeticShift_FloorSemantics()
    {
        // audiowaveform (BBC) paritesi: shift (floor). Eski /256 (trunc) -1'i 0'a
        // yapıştırıyordu; -1 >> 8 = -1, 255 >> 8 = 0 olmalı.
        var builder = new WaveformPeaksBuilder(samplesPerPixel: 2);
        builder.AddSamples([-1, 255]);
        builder.Complete();
        var (mins, maxes) = ReadPeaks(builder);
        Assert.Equal(-1, mins[0]);
        Assert.Equal(0, maxes[0]);
    }

    [Fact]
    public void PcmBytes_OddChunkBoundary_CarriesHalfSample()
    {
        // Aynı örnekler: (a) tek parça, (b) tek-byte'lık kaydırmalı parçalar → özdeş sonuç.
        var samples = new short[400];
        for (var i = 0; i < samples.Length; i++)
        {
            samples[i] = (short)((i * 37) - 3000);
        }

        var bytes = new byte[samples.Length * 2];
        Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);

        var whole = new WaveformPeaksBuilder();
        whole.AddPcmBytes(bytes);
        whole.Complete();

        var chunked = new WaveformPeaksBuilder();
        chunked.AddPcmBytes(bytes.AsSpan(0, 33));   // tek sayıda byte → yarım örnek taşınır
        chunked.AddPcmBytes(bytes.AsSpan(33, 100));
        chunked.AddPcmBytes(bytes.AsSpan(133));
        chunked.Complete();

        Assert.Equal(ToJson(whole), ToJson(chunked));
    }

    [Fact]
    public void Json_MatchesAudiowaveformVersion2Shape()
    {
        var builder = new WaveformPeaksBuilder();
        builder.AddSamples(new short[480]); // 3 pencere
        using var doc = JsonDocument.Parse(ToJson(builder));
        var root = doc.RootElement;

        Assert.Equal(2, root.GetProperty("version").GetInt32());
        Assert.Equal(1, root.GetProperty("channels").GetInt32());
        Assert.Equal(8000, root.GetProperty("sample_rate").GetInt32());
        Assert.Equal(160, root.GetProperty("samples_per_pixel").GetInt32());
        Assert.Equal(8, root.GetProperty("bits").GetInt32());
        Assert.Equal(3, root.GetProperty("length").GetInt32());
        Assert.Equal(6, root.GetProperty("data").GetArrayLength()); // length × 2 (min,max)
    }

    private static (List<int> Mins, List<int> Maxes) ReadPeaks(WaveformPeaksBuilder builder)
    {
        using var doc = JsonDocument.Parse(ToJson(builder));
        var data = doc.RootElement.GetProperty("data");
        var mins = new List<int>();
        var maxes = new List<int>();
        for (var i = 0; i < data.GetArrayLength(); i += 2)
        {
            mins.Add(data[i].GetInt32());
            maxes.Add(data[i + 1].GetInt32());
        }

        return (mins, maxes);
    }

    private static string ToJson(WaveformPeaksBuilder builder)
    {
        using var stream = new MemoryStream();
        builder.WriteJson(stream);
        return System.Text.Encoding.UTF8.GetString(stream.ToArray());
    }
}
