namespace VideoEdit.Media.Probing;

/// <summary>
/// ffprobe çıktısının tipli özeti. Tüm süre alanları TAMSAYI MİKROSANİYEDİR
/// (sözleşme: rendering-semantics §1.1 — float saniye hiçbir modele girmez).
/// Width/Height ROTATION UYGULANMIŞ değerlerdir (displaymatrix/rotate 90/270 → swap);
/// ffmpeg decode'da autorotate uyguladığı için filtre zincirindeki iw/ih de bu değerlerle
/// eşleşir.
/// </summary>
public sealed record MediaProbe
{
    /// <summary>Ham ffprobe JSON çıktısı — Asset.Probe (jsonb) kolonuna aynen yazılır.</summary>
    public required string RawJson { get; init; }

    /// <summary>format.duration (saniye string) → InvariantCulture parse × 1e6, half-up. Yoksa null.</summary>
    public long? DurationUs { get; init; }

    /// <summary>Gerçek görüntü stream'i var mı (attached_pic kapak resimleri SAYILMAZ).</summary>
    public bool HasVideo { get; init; }

    public bool HasAudio { get; init; }

    /// <summary>Rotation uygulanmış genişlik (video yoksa 0).</summary>
    public int Width { get; init; }

    /// <summary>Rotation uygulanmış yükseklik (video yoksa 0).</summary>
    public int Height { get; init; }

    /// <summary>r_frame_rate rational'ı (video yoksa 0/0).</summary>
    public int FpsNum { get; init; }
    public int FpsDen { get; init; }

    /// <summary>avg_frame_rate rational'ı; ffprobe "0/0" verdiyse r_frame_rate'e düşülmüş halidir.</summary>
    public int AvgFpsNum { get; init; }
    public int AvgFpsDen { get; init; }

    /// <summary>VFR tespiti: r_frame_rate ≠ avg_frame_rate (tasarım 02 §3.2).</summary>
    public bool IsVfr { get; init; }

    public int? AudioSampleRate { get; init; }
    public int? AudioChannels { get; init; }

    public string? ColorTransfer { get; init; }
    public string? ColorPrimaries { get; init; }

    /// <summary>
    /// HDR tespiti (rendering-semantics §6.2): color_trc ∈ {smpte2084, arib-std-b67}
    /// VEYA color_primaries = bt2020.
    /// </summary>
    public bool IsHdr { get; init; }

    public string? VideoCodec { get; init; }
    public string? AudioCodec { get; init; }

    /// <summary>Seçilen video stream'inin MUTLAK stream index'i (-map 0:N için); yoksa -1.</summary>
    public int VideoStreamIndex { get; init; } = -1;

    /// <summary>Seçilen ses stream'inin mutlak index'i; yoksa -1.</summary>
    public int AudioStreamIndex { get; init; } = -1;
}
