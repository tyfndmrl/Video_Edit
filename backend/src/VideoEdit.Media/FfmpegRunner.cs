using System.Diagnostics;

namespace VideoEdit.Media;

/// <summary>FfmpegRunner sonucu. Success değilse StderrTail teşhis içindir.</summary>
/// <param name="Overran">
/// Süreç, ÇIKTI SAATİNİN tavanını aştığı için öldürüldü (bkz.
/// <see cref="FfmpegRunner.OutputTimeCeilingUs"/>). <see cref="TimedOut"/>'tan AYRI bir
/// haldir ve karıştırılmamalıdır: TimedOut "hiç çıktı üretmiyor", Overran ise "durmadan
/// çıktı üretiyor ama ASLA bitmeyecek" demektir. Çağıran ikisini AYRI makine koduna
/// çevirmelidir, yoksa kullanıcı sonsuz döngüyü "zaman aşımı" sanır.
/// </param>
public sealed record FfmpegRunResult(
    int ExitCode, string StderrTail, bool TimedOut, bool Overran = false)
{
    public bool Success => ExitCode == 0 && !TimedOut && !Overran;
}

/// <summary>
/// ffmpeg process yönetimi:
///  - argümanlar ProcessStartInfo.ArgumentList ile verilir (string birleştirme YOK —
///    boşluklu path / quoting hataları yapısal olarak imkânsız);
///  - `-progress pipe:1 -nostats` kendisi ekler, out_time_us/out_time_ms parse edip
///    (İKİSİ DE mikrosaniye) toplam süreye oranlayarak callback çağırır;
///  - stderr ring buffer'da son ~8 KB tutulur (hata teşhisi);
///  - watchdog: 120 sn boyunca hiçbir progress/stderr çıktısı yoksa süreç öldürülür;
///  - İKİNCİ TAVAN (opsiyonel): <c>-progress</c> akışındaki <c>out_time</c> verilen tavanı
///    aşarsa süreç öldürülür ve sonuç <see cref="FfmpegRunResult.Overran"/> döner;
///  - CancellationToken iptalinde Kill(entireProcessTree: true).
/// Progress callback'i stdout OKUMA DÖNGÜSÜNDEN sırayla await edilir — çağıran tarafta
/// eşzamanlılık koruması gerekmez (DbContext'e yazan callback'ler güvenlidir).
/// </summary>
public sealed class FfmpegRunner(FfmpegOptions options)
{
    public static readonly TimeSpan DefaultWatchdogTimeout = TimeSpan.FromSeconds(120);
    private const int StderrTailCapacity = 8 * 1024;

    /// <summary>
    /// <see cref="OutputTimeCeilingUs"/>'nin ORANSAL payı. Tavan mutlak bir sayı DEĞİL, beklenen
    /// süreye göre ölçeklenir: 4 saatlik bir çizelgenin makul sapması 2 saniyeliğinkinden
    /// büyüktür.
    /// </summary>
    public const double OutputTimeCeilingFactor = 1.10;

    /// <summary>
    /// <see cref="OutputTimeCeilingUs"/>'nin SABİT payı (5 sn). Oransal pay tek başına kısa
    /// çizelgelerde anlamsız kalırdı: 1 saniyelik bir çıktıda %10 yalnız 100 ms'tir ve tek bir
    /// ses paketi (AAC 1024 örnek @48 kHz ≈ 21 ms) bile onu tüketebilirdi.
    /// </summary>
    public const long OutputTimeCeilingSlackUs = 5_000_000;

    /// <summary>
    /// Testler için süreç kancası: her ffmpeg süreci başlatıldığında çağrılır. Bellek kapısı
    /// tahmininin ölçüm testi (ExportMemoryEstimateTests) TAM BU sürecin tepe RSS'ini
    /// örneklemek zorundadır — ada göre süreç aramak makinedeki canlı worker'ın ffmpeg'ini
    /// yakalayıp ölçümü kirletirdi. Prod'da null (FreeSpaceProbe deseniyle aynı sınıf).
    /// </summary>
    internal Action<Process>? ProcessStarted { get; set; }

    /// <summary>
    /// ÇIKTI SAATİ TAVANI: <c>-progress</c> akışındaki <c>out_time</c> bunu aşarsa süreç
    /// öldürülür. Sessizlik bekçisinin (<see cref="DefaultWatchdogTimeout"/>) GÖREMEDİĞİ hali
    /// yakalar — kaçak grafik durmadan progress bastığı için "sessiz" olmaz ve bekçi asla
    /// tetiklenmez; ölçüldü: böyle bir süreç 90 saniyede 135 sn CPU yakıp çıktıyı doğru
    /// boyutun 1,5 katına şişirdi ve tek export kanalını kilitledi.
    /// <para>
    /// PAY ÖLÇÜLEREK SEÇİLDİ, tahmin edilmedi. NORMAL render'ın bildirdiği EN BÜYÜK
    /// <c>out_time</c> beklenen sürenin ALTINDADIR (son video karesinin damgası): 19 sn'lik
    /// çizelgede 18,933 sn, 60 sn'lik çizelgede 59,933 sn — ikisinde de 66,7 ms EKSİK.
    /// Yani tavan yanlış öldürme üretmek için ölçülen en büyük değerin %37 üstüne çıkmalıdır.
    /// </para>
    /// <para>
    /// TAVAN, İŞİN KABUL ETTİĞİ SAPMADAN GENİŞ OLMAK ZORUNDADIR: worker çıktı süresini beklenen
    /// ±1 sn ile doğruluyor (<c>ExportJob.OutputDurationToleranceUs</c>). Tavan onun altında
    /// kalsaydı, işin KABUL EDECEĞİ bir render'ı runner öldürürdü.
    /// </para>
    /// </summary>
    public static long OutputTimeCeilingUs(long expectedDurationUs) =>
        (long)(expectedDurationUs * OutputTimeCeilingFactor) + OutputTimeCeilingSlackUs;

    /// <param name="args">Reçete argümanları (girdi/filtre/codec/çıktı). Runner başa
    /// -hide_banner -nostats -progress pipe:1 ekler.</param>
    /// <param name="totalDurationUs">Progress oranı için beklenen çıktı süresi (µs);
    /// null ise callback çağrılmaz.</param>
    /// <param name="onProgress">0..1 aralığında oran — stdout okuma döngüsünden seri çağrılır.</param>
    /// <param name="outputTimeCeilingUs">
    /// Verilirse çıktı saati tavanı (µs) — bkz. <see cref="OutputTimeCeilingUs"/>. AÇIKÇA
    /// İSTENİR, <paramref name="totalDurationUs"/>'ten SESSİZCE TÜRETİLMEZ: pay yalnız EXPORT
    /// reçetesi için ölçüldü. Varlık işleme reçeteleri (proxy/filmstrip/poster) farklı çıktı
    /// zaman tabanları kullanır ve o rejim ÖLÇÜLMEDİ — tavan oraya sessizce sızsaydı
    /// ölçülmemiş bir yanlış-öldürme riski doğardı; onlar KAPSAM DIŞIDIR ve yalnız sessizlik
    /// bekçisiyle korunur (docs/backlog.md).
    /// </param>
    public async Task<FfmpegRunResult> RunAsync(
        IReadOnlyList<string> args,
        long? totalDurationUs = null,
        Func<double, CancellationToken, Task>? onProgress = null,
        TimeSpan? watchdogTimeout = null,
        long? outputTimeCeilingUs = null,
        CancellationToken ct = default)
    {
        var psi = new ProcessStartInfo
        {
            FileName = options.FfmpegPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("-hide_banner");
        psi.ArgumentList.Add("-nostats");
        psi.ArgumentList.Add("-progress");
        psi.ArgumentList.Add("pipe:1");
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = new Process { StartInfo = psi };
        process.Start();
        ProcessStarted?.Invoke(process);

        var lastActivityTicks = Environment.TickCount64;
        var timedOut = false;
        var overran = false;

        await using var cancelRegistration = ct.Register(() => TryKill(process));

        var stderrTail = new ProcessTailBuffer(StderrTailCapacity);
        var stderrTask = ProcessTailBuffer.PumpAsync(
            process.StandardError, stderrTail,
            () => Volatile.Write(ref lastActivityTicks, Environment.TickCount64));

        // Watchdog: periyodik kontrol; timeout'u aşan sessizlikte süreç ağacını öldür.
        var watchdogLimit = watchdogTimeout ?? DefaultWatchdogTimeout;
        using var watchdogCts = new CancellationTokenSource();
        var watchdogTask = Task.Run(async () =>
        {
            while (!watchdogCts.Token.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), watchdogCts.Token);
                }
                catch (OperationCanceledException)
                {
                    return;
                }

                var idle = TimeSpan.FromMilliseconds(
                    Environment.TickCount64 - Volatile.Read(ref lastActivityTicks));
                if (idle > watchdogLimit)
                {
                    // Yarış düzeltmesi: süreç NORMAL bitmişse (stdout EOF ↔ CancelAsync arası
                    // pencere) timedOut bayrağı SET EDİLMEZ — başarılı koşu timeout sanılmaz.
                    if (process.HasExited)
                    {
                        return;
                    }

                    timedOut = true;
                    TryKill(process);
                    return;
                }
            }
        }, CancellationToken.None);

        // stdout: -progress key=value akışı. Callback İNLİNE await edilir (seri).
        while (await process.StandardOutput.ReadLineAsync(CancellationToken.None) is { } line)
        {
            Volatile.Write(ref lastActivityTicks, Environment.TickCount64);
            if (overran || !FfmpegProgressParser.TryParseOutTimeUs(line, out var outUs))
            {
                continue;
            }

            // ÇIKTI SAATİ TAVANI — sessizlik bekçisinin göremediği hal. Öldürme, döngüden
            // ÇIKMADAN yapılır: stdout okumaya devam edilir ki boru dolup süreç kapanışta
            // bloke olmasın; sonraki satırlar 'overran' bayrağıyla atlanır.
            if (outputTimeCeilingUs is { } ceiling && outUs > ceiling)
            {
                overran = true;
                TryKill(process);
                continue;
            }

            if (onProgress is not null && totalDurationUs is > 0)
            {
                var fraction = Math.Clamp((double)outUs / totalDurationUs.Value, 0d, 1d);
                await onProgress(fraction, ct);
            }
        }

        await process.WaitForExitAsync(CancellationToken.None);
        await watchdogCts.CancelAsync();
        await Task.WhenAll(stderrTask, watchdogTask);

        ct.ThrowIfCancellationRequested();

        return new FfmpegRunResult(process.ExitCode, stderrTail.ToString(), timedOut, overran);
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Süreç zaten bitmiş olabilir — yut.
        }
    }

}
