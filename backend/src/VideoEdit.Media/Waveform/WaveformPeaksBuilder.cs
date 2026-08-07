using System.Text.Json;

namespace VideoEdit.Media.Waveform;

/// <summary>
/// s16le mono PCM akışından min/max peak pencereleme — SAF, streaming (tüm PCM'i RAM'e almaz;
/// yalnız peak listesi büyür: 1 saat ses ≈ 180K peak ≈ dert değil).
/// Çıktı audiowaveform (BBC) version:2 JSON formatıyla uyumludur — backlog kararı:
/// audiowaveform binary bağımlılığı YOK, pencereleme .NET içinde (tasarım 02 §3.5 alternatifi).
/// Ölçekleme: 16-bit örnek &gt;&gt; 8 (aritmetik shift, floor) → int8 (audiowaveform 8-bit paritesi).
/// </summary>
public sealed class WaveformPeaksBuilder(int samplesPerPixel = WaveformPeaksBuilder.DefaultSamplesPerPixel)
{
    /// <summary>8000 Hz / 160 örnek = 50 peak/sn (tasarım 02 §3.5).</summary>
    public const int DefaultSampleRate = 8000;
    public const int DefaultSamplesPerPixel = 160;

    private readonly int _samplesPerPixel = samplesPerPixel > 0
        ? samplesPerPixel
        : throw new ArgumentOutOfRangeException(nameof(samplesPerPixel));

    private readonly List<sbyte> _data = []; // [min0, max0, min1, max1, ...]
    private int _windowFill;
    private short _min = short.MaxValue;
    private short _max = short.MinValue;
    private byte? _carryByte; // chunk sınırında bölünen örneğin ilk byte'ı
    private bool _completed;

    public long TotalSamples { get; private set; }

    /// <summary>Tamamlanan peak (min/max çifti) sayısı — Complete öncesi kısmi pencere dahil değildir.</summary>
    public int PeakCount => _data.Count / 2;

    /// <summary>s16le byte akışı ekle — chunk sınırındaki yarım örnek taşınır (carry).</summary>
    public void AddPcmBytes(ReadOnlySpan<byte> bytes)
    {
        ThrowIfCompleted();
        if (bytes.IsEmpty)
        {
            return;
        }

        if (_carryByte is { } carry)
        {
            AddSample((short)(carry | (bytes[0] << 8)));
            bytes = bytes[1..];
            _carryByte = null;
        }

        var pairs = bytes.Length / 2;
        for (var i = 0; i < pairs; i++)
        {
            AddSample((short)(bytes[2 * i] | (bytes[(2 * i) + 1] << 8)));
        }

        if (bytes.Length % 2 != 0)
        {
            _carryByte = bytes[^1];
        }
    }

    public void AddSamples(ReadOnlySpan<short> samples)
    {
        ThrowIfCompleted();
        foreach (var sample in samples)
        {
            AddSample(sample);
        }
    }

    /// <summary>Kısmi son pencereyi kapatır; sonrasında ekleme yapılamaz.</summary>
    public void Complete()
    {
        if (_completed)
        {
            return;
        }

        _completed = true;
        if (_windowFill > 0)
        {
            FlushWindow();
        }
    }

    /// <summary>
    /// audiowaveform-uyumlu JSON:
    /// {version:2, channels:1, sample_rate, samples_per_pixel, bits:8, length, data:[min,max,...]}.
    /// </summary>
    public void WriteJson(Stream output, int sampleRate = DefaultSampleRate)
    {
        Complete();
        using var writer = new Utf8JsonWriter(output);
        writer.WriteStartObject();
        writer.WriteNumber("version", 2);
        writer.WriteNumber("channels", 1);
        writer.WriteNumber("sample_rate", sampleRate);
        writer.WriteNumber("samples_per_pixel", _samplesPerPixel);
        writer.WriteNumber("bits", 8);
        writer.WriteNumber("length", PeakCount);
        writer.WriteStartArray("data");
        foreach (var value in _data)
        {
            writer.WriteNumberValue(value);
        }

        writer.WriteEndArray();
        writer.WriteEndObject();
    }

    private void AddSample(short sample)
    {
        TotalSamples++;
        if (sample < _min)
        {
            _min = sample;
        }

        if (sample > _max)
        {
            _max = sample;
        }

        if (++_windowFill >= _samplesPerPixel)
        {
            FlushWindow();
        }
    }

    private void FlushWindow()
    {
        // int8 ölçek: aritmetik shift >>8 = floor(val/256) (−32768→−128, 32767→127, −1→−1).
        // audiowaveform (BBC) paritesi: o da shift kullanır; /256 negatifte 0'a doğru
        // yuvarlayıp (trunc) sessize yakın negatif örnekleri 0'a yapıştırıyordu.
        _data.Add((sbyte)(_min >> 8));
        _data.Add((sbyte)(_max >> 8));
        _windowFill = 0;
        _min = short.MaxValue;
        _max = short.MinValue;
    }

    private void ThrowIfCompleted()
    {
        if (_completed)
        {
            throw new InvalidOperationException("WaveformPeaksBuilder is completed; no more samples accepted.");
        }
    }
}
