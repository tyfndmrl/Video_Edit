using System.Collections.Concurrent;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// BU SÜREÇTE koşan render'ların iptal kancaları (jobId → <see cref="CancellationTokenSource"/>).
/// <para>
/// NEDEN VAR: reaper (<see cref="AssetReaperJob"/>) ölü sayıp <c>stalled</c> yazdığı bir iş
/// satırının ffmpeg süreci HÂLÂ KOŞUYOR olabilir. Kayıt olmadan reaper yalnız DB'yi düzeltir;
/// CPU'yu yakan ve tek export kanalını tutan süreç ayakta kalır — yani satır "başarısız" der,
/// makine "meşgul" kalır. Kayıt, o iki gerçeği tekrar aynı hizaya getirir.
/// </para>
/// <para>
/// KAPSAM: sözlük süreç içidir — yalnız AYNI worker sürecinde koşan render'a ANINDA ulaşır.
/// Süreçler-arası iptal kanalı DB SATIRININ KENDİSİDİR: reaper 'stalled'/API 'canceled'
/// yazınca render'ın SAHİBİ süreç bunu progress yolundaki durum yoklamasında görür ve kendi
/// ffmpeg ağacını öldürür (ExportJob.CancelPollInterval — reaper hangi worker'da koşarsa
/// koşsun çalışır). Bu sözlük yine de gereklidir, çünkü DB yoklaması ancak süreç PROGRESS
/// ÜRETİYORKEN koşar: hiç çıktı üretmeyen asılı bir render'ı aynı süreçte yalnız bu kayıt
/// (reaper Abort'u) ya da sessizlik bekçisi öldürebilir. Kayıt YOKSA reaper eskisi gibi
/// yalnız satırı düzeltir; hiçbir şey kötüleşmez.
/// </para>
/// <para>
/// KALAN SINIR (bilinçli, docs/poc-bilinen-sinirlar.md §4.1): stderr gevezeliğiyle sessizlik
/// bekçisini besleyip progress üretmeyen bir kaçak BAŞKA süreçteyse, ve worker süreci çöküp
/// ffmpeg'i öksüz bıraktıysa, hiçbir süreç-içi mekanizma ona ulaşamaz — bu OS düzeyi bir
/// süpürme işidir ve kapsam dışıdır.
/// </para>
/// </summary>
public sealed class RunningRenderRegistry
{
    private readonly ConcurrentDictionary<Guid, CancellationTokenSource> _running = new();

    /// <summary>Kaç render kayıtlı (teşhis/test).</summary>
    public int Count => _running.Count;

    /// <summary>
    /// İşi kaydeder; dönen nesne <c>Dispose</c> edildiğinde kayıt DÜŞER. Kaydı düşürmek
    /// ŞARTTIR: bitmiş bir işin CancellationTokenSource'u sözlükte kalırsa reaper onu iptal
    /// etmeye çalışır ve <see cref="ObjectDisposedException"/> ile karşılaşırdı.
    /// </summary>
    public IDisposable Register(Guid jobId, CancellationTokenSource cancellation)
    {
        _running[jobId] = cancellation;
        return new Registration(this, jobId);
    }

    /// <summary>
    /// İşin render'ını iptal eder (FfmpegRunner'ın iptal kaydı süreç AĞACINI öldürür).
    /// Dönen değer: gerçekten koşan bir render bulundu mu — çağıran bunu LOGLAMALIDIR,
    /// "öldürdüm" ile "zaten yoktu" ayrı gerçeklerdir.
    /// </summary>
    public bool Abort(Guid jobId)
    {
        if (!_running.TryGetValue(jobId, out var cancellation))
        {
            return false;
        }

        try
        {
            cancellation.Cancel();
            return true;
        }
        catch (ObjectDisposedException)
        {
            // İş, biz iptal etmeye çalışırken bitmiş olabilir (kayıt düşme yarışı) — yut.
            return false;
        }
    }

    private sealed class Registration(RunningRenderRegistry owner, Guid jobId) : IDisposable
    {
        public void Dispose() => owner._running.TryRemove(jobId, out _);
    }
}
