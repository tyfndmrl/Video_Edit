using System.Globalization;

namespace VideoEdit.Contracts;

/// <summary>
/// Paylaşılan zaman sözleşmesi: tüm zamanlar tamsayı MİKROSANİYE (long). Float saniye YASAK.
/// Frame dönüşümleri sözleşmedeki half-up yuvarlama ile yapılır (JS Math.round eşdeğeri:
/// floor(x + 0.5)) — frontend ile birebir aynı sonuç.
/// </summary>
public readonly record struct Timecode(long Micros)
{
    public const long MicrosPerSecond = 1_000_000;

    public static readonly Timecode Zero = new(0);

    public static Timecode FromMicros(long micros) => new(micros);

    public static Timecode FromTimeSpan(TimeSpan value) => new(value.Ticks / (TimeSpan.TicksPerMillisecond / 1000));

    public TimeSpan ToTimeSpan() => TimeSpan.FromTicks(Micros * (TimeSpan.TicksPerMillisecond / 1000));

    /// <summary>Proje fps grid'inde frame numarası — round half-up (JS Math.round parity).</summary>
    public long ToFrameNumber(int fpsNum, int fpsDen)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(fpsNum);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(fpsDen);
        return RoundHalfUp(Micros * (double)fpsNum / (fpsDen * (double)MicrosPerSecond));
    }

    /// <summary>Frame numarasından mikrosaniye — round half-up.</summary>
    public static Timecode FromFrameNumber(long frame, int fpsNum, int fpsDen)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(fpsNum);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(fpsDen);
        return new Timecode(RoundHalfUp(frame * (double)fpsDen * MicrosPerSecond / fpsNum));
    }

    /// <summary>
    /// Timeline süresi: klip hıza bölünmüş kaynak aralığı, half-up yuvarlama.
    /// Sözleşme formülü (docs/rendering-semantics.md §1.3, time.ts clipTimelineDurationUs ile birebir):
    /// timelineDurationUs = round((sourceOutUs - sourceInUs) / rate).
    /// </summary>
    public static long ClipTimelineDurationUs(long sourceInUs, long sourceOutUs, double rate)
    {
        if (!double.IsFinite(rate) || rate <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(rate), rate, "rate must be a finite positive number");
        }

        return RoundHalfUp((sourceOutUs - sourceInUs) / rate);
    }

    /// <summary>
    /// Non-drop timecode: HH:MM:SS:FF (proje fps grid'inde).
    /// Sözleşme (time.ts formatTimecode ile birebir): frame sayısı FLOOR ile türetilir
    /// (half-up DEĞİL — 33333us @30fps hâlâ frame 0'dır); FF/SS bölmesi için nominal fps
    /// round(num/den)'dir (29.97 -> 30). Drop-frame bilinçli olarak desteklenmez (MVP kararı).
    /// </summary>
    public string ToTimecodeString(int fpsNum, int fpsDen)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(fpsNum);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(fpsDen);
        ArgumentOutOfRangeException.ThrowIfNegative(Micros);
        var totalFrames = (long)Math.Floor(Micros * (double)fpsNum / (fpsDen * (double)MicrosPerSecond));
        var framesPerSecond = RoundHalfUp(fpsNum / (double)fpsDen);
        if (framesPerSecond <= 0)
        {
            framesPerSecond = 1;
        }

        var ff = totalFrames % framesPerSecond;
        var totalSeconds = totalFrames / framesPerSecond;
        var ss = totalSeconds % 60;
        var mm = totalSeconds / 60 % 60;
        var hh = totalSeconds / 3600;
        return string.Create(CultureInfo.InvariantCulture, $"{hh:D2}:{mm:D2}:{ss:D2}:{ff:D2}");
    }

    /// <summary>JS Math.round eşdeğeri: yarım değerler +∞'a yuvarlanır.</summary>
    private static long RoundHalfUp(double value) => (long)Math.Floor(value + 0.5);

    public override string ToString() => Micros.ToString(CultureInfo.InvariantCulture);
}
