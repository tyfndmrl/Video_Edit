using System.Runtime.InteropServices;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// Kullanılabilir bellek okuyucusu — export bellek kabul kapısının ölçüm ucu
/// (<c>ExportJob.EnsureMemoryAsync</c>). Disk kapısındaki <c>DriveInfo.AvailableFreeSpace</c>'in
/// bellek eşidir ve aynı sözleşmeyi taşır: ölçülemiyorsa <c>-1</c> döner ve kapı ATLANIR
/// (ölçüm yokluğu yanlış ret üretmez; gerçek darlıkta render zaten kendi hatasıyla düşer).
/// <para>
/// YÖNTEM SEÇİMİ (Windows): <c>kernel32!GlobalMemoryStatusEx</c> → <b><c>ullAvailPageFile</c></b>
/// (commit boşluğu), <c>ullAvailPhys</c> DEĞİL. Karar ÖLÇÜMLE verildi (2026-08-24 canlı tur):
/// ilk sürüm <c>ullAvailPhys</c> (free+standby) okuyordu ve 2160p bileşimi
/// "tahmin 7,0 GiB &gt; kullanılabilir 4,9 GiB" diye reddetti — oysa AYNI yük altındaki
/// makinede aynı render dakikalar önce İKİ KEZ başarıyla koşmuştu (tepe RSS 5,6 GB;
/// duvar 78-79 sn, boş makinedekiyle aynı bant). Mekanizma: Windows talep gelince DİĞER
/// süreçlerin çalışma kümelerini kırpar; <c>ullAvailPhys</c> o an serbest+standby'ı sayar ve
/// elde EDİLEBİLİR belleği sistematik KÜÇÜMSER. Bir Windows sürecini gerçekten öldüren sınır
/// COMMIT tavanıdır (aynı turda ölçüldü: commit limit 81,9 GiB / kullanılan 43,2 GiB —
/// boşluk 38,7 GiB varken fiziksel "boş" yalnız 4,7 GiB görünüyordu). Kapı bu yüzden commit
/// boşluğuna karşı sorar: OOM'u bu sınır belirler; fiziksel baskı ise yalnız yavaşlatır
/// (bugün WorkerCount=1 — tek render'ın kırpma maliyeti ölçülemedi bile). Yönetilen
/// alternatif yok: <c>GC.GetGCMemoryInfo()</c> SON GC anının fotoğrafıdır (boşta worker'da
/// dakikalarca bayat) ve yük YÜZDESİNDEN türetilir (%1 ≈ 328 MB nicemleme).
/// </para>
/// <para>
/// Linux (Docker worker imajı): iki kaynağın KÜÇÜĞÜ alınır — (1) <c>/proc/meminfo</c>
/// <c>MemAvailable</c>: çekirdeğin "yeni iş yükü takas etmeden ne kadar bellek bulur"
/// tahmini (geri kazanılabilir sayfa önbelleği dahil; salt <c>MemFree</c> bu yüzden YANLIŞ
/// olurdu — Linux boş belleği bilerek önbellek olarak kullanır; tipik konteyner TAKASSIZ
/// koşar, dolayısıyla Windows'taki commit-boşluğu ayrımı burada doğmaz — OOM killer'ın
/// sınırına en yakın pratik ölçü budur); (2) cgroup bellek limiti:
/// compose.yml worker'a <b>6g limit KOYAR</b> ("ffmpeg OOM koruması") ve limitli konteynerde
/// <c>/proc/meminfo</c> HOST/VM değerlerini gösterir — limit okunmazsa kapı konteynerde
/// yanlış (fazla) sayı görür. cgroup v2 (<c>memory.max/current</c>) önce, v1
/// (<c>memory/memory.limit_in_bytes|usage_in_bytes</c> — Docker Desktop/WSL2'de ÖLÇÜLEN
/// yerleşim: limit 6442450944 olarak birebir görünür) yedek okunur; "limitsiz" (v2 'max',
/// v1 PAGE_COUNTER_MAX civarı) atlanır. cgroup kullanımı sayfa önbelleğini içerir, yani
/// limit−kullanım küçümser — kapı için GÜVENLİ yön.
/// </para>
/// </summary>
internal static class AvailableMemory
{
    /// <summary>Kullanılabilir bellek (bayt) — sınıf yorumundaki platform semantiğiyle; ölçülemiyorsa -1.</summary>
    public static long TryGetAvailableBytes()
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                var status = new MemoryStatusEx { Length = (uint)Marshal.SizeOf<MemoryStatusEx>() };
                return GlobalMemoryStatusEx(ref status) ? (long)status.AvailPageFile : -1;
            }

            if (OperatingSystem.IsLinux())
            {
                var memAvailable = ReadMemInfoAvailable();
                var cgroupAvailable = ReadCgroupAvailable();
                return (memAvailable, cgroupAvailable) switch
                {
                    ( >= 0, >= 0) => Math.Min(memAvailable, cgroupAvailable),
                    ( >= 0, _) => memAvailable,
                    (_, >= 0) => cgroupAvailable,
                    _ => -1,
                };
            }

            return -1;
        }
        catch (Exception)
        {
            return -1; // ölçülemiyorsa kontrolü atla — disk kapısının -1 sözleşmesiyle aynı
        }
    }

    /// <summary><c>/proc/meminfo</c> <c>MemAvailable</c> satırı (kB → bayt); yoksa -1.</summary>
    private static long ReadMemInfoAvailable()
    {
        foreach (var line in File.ReadLines("/proc/meminfo"))
        {
            if (!line.StartsWith("MemAvailable:", StringComparison.Ordinal))
            {
                continue;
            }

            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            return parts.Length >= 2 && long.TryParse(parts[1], out var kib) ? kib * 1024 : -1;
        }

        return -1;
    }

    /// <summary>
    /// cgroup bellek limiti − kullanım (bayt); limit yoksa/okunamazsa -1. v2 önce
    /// (birleşik hiyerarşi: <c>memory.max</c> "max" = limitsiz), v1 yedek (limitsizlik
    /// PAGE_COUNTER_MAX civarı dev bir sayıdır — 2^60 üstü limitsiz sayılır).
    /// </summary>
    private static long ReadCgroupAvailable()
    {
        const long noLimitFloor = 1L << 60;

        var v2Max = ReadCgroupLong("/sys/fs/cgroup/memory.max");
        if (v2Max is > 0 and < noLimitFloor
            && ReadCgroupLong("/sys/fs/cgroup/memory.current") is >= 0 and var v2Current)
        {
            return Math.Max(0, v2Max.Value - v2Current);
        }

        var v1Limit = ReadCgroupLong("/sys/fs/cgroup/memory/memory.limit_in_bytes");
        if (v1Limit is > 0 and < noLimitFloor
            && ReadCgroupLong("/sys/fs/cgroup/memory/memory.usage_in_bytes") is >= 0 and var v1Usage)
        {
            return Math.Max(0, v1Limit.Value - v1Usage);
        }

        return -1;
    }

    /// <summary>Tek sayılık cgroup dosyası; yok/boş/sayı değil ("max" dahil) → null.</summary>
    private static long? ReadCgroupLong(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        var text = File.ReadAllText(path).Trim();
        return long.TryParse(text, out var value) ? value : null;
    }

    /// <summary>
    /// Win32 <c>MEMORYSTATUSEX</c> (blittable — tüm alanlar sabit boyutlu tamsayı).
    /// <c>Length</c> çağrıdan ÖNCE doldurulmak zorundadır (API sözleşmesi).
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    // DllImport (LibraryImport DEĞİL — o AllowUnsafeBlocks ister; tek çağrılık blittable
    // struct için proje geneline unsafe açmaya değmez).
    [DllImport("kernel32.dll", EntryPoint = "GlobalMemoryStatusEx", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);
}
