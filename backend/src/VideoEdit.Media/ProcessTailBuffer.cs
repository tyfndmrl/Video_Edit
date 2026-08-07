namespace VideoEdit.Media;

/// <summary>
/// Satır bazlı ring buffer: son ~capacity karakteri tutar (process stderr kuyruğu).
/// FfmpegRunner ve WaveformGenerator PAYLAŞIR — sınırsız ReadToEnd yok (geveze/bozuk bir
/// ffmpeg koşusunun stderr'i RAM'i şişiremez; her koşulda yalnız son ~capacity tutulur).
/// </summary>
public sealed class ProcessTailBuffer(int capacity)
{
    private readonly Lock _lock = new();
    private readonly Queue<string> _lines = new();
    private int _size;

    public void Add(string line)
    {
        if (line.Length > capacity)
        {
            line = line[^capacity..];
        }

        lock (_lock)
        {
            _lines.Enqueue(line);
            _size += line.Length + 1;
            while (_size > capacity && _lines.Count > 1)
            {
                _size -= _lines.Dequeue().Length + 1;
            }
        }
    }

    public override string ToString()
    {
        lock (_lock)
        {
            return string.Join('\n', _lines);
        }
    }

    /// <summary>
    /// reader'ı EOF'a kadar satır satır okuyup tail'e ekler; her satırda onActivity çağrılır
    /// (FfmpegRunner'ın inaktivite watchdog damgası için).
    /// </summary>
    public static Task PumpAsync(TextReader reader, ProcessTailBuffer tail, Action? onActivity = null) =>
        Task.Run(async () =>
        {
            while (await reader.ReadLineAsync(CancellationToken.None) is { } line)
            {
                onActivity?.Invoke();
                tail.Add(line);
            }
        }, CancellationToken.None);
}
