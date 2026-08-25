using Microsoft.Extensions.Configuration;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Media.Export;
using VideoEdit.Worker.Jobs;

namespace VideoEdit.UnitTests;

/// <summary>
/// B7 borcu: tahmin sabitleri worker config'inden ayarlanabilir, varsayılanlar bu makinede
/// ölçülen değerlere ÇİVİLİ. İki iddia ailesi:
/// <list type="number">
///   <item><b>Regresyon çivisi.</b> Override verilmediğinde etkin değerler 2026-08-24 ölçüm
///     turunun sayılarının TA KENDİSİDİR (literal olarak; const'a referansla değil — const
///     sessizce değişirse bu testler kırmızıya döner) ve <c>options</c>'sız çağrı ile
///     override'sız <c>options</c>'lı çağrı bayt bayt aynı tahmini üretir.</item>
///   <item><b>Opsiyonla ezilebilirlik.</b> Her sabit "ExportEstimates" section'ından
///     (env: <c>ExportEstimates__*</c>) ezilebilir, formülün YALNIZ o terimi değişir ve
///     kapı örneği (ExportJobTests'teki DI testleri) enjekte edilen değerleri okur.</item>
/// </list>
/// </summary>
public sealed class ExportEstimateOptionsTests
{
    // ---------- 1) Regresyon çivisi: ölçülen varsayılanlar literal olarak sabit ----------

    [Fact]
    public void MeasuredDefaults_ArePinnedLiterally()
    {
        // Bellek sabitleri (ExportMemoryEstimateTests canlı korpusunun kalibre ettiği değerler).
        Assert.Equal(268_435_456, ExportJob.MemoryBaseBytes);              // 256 MiB
        Assert.Equal(400, ExportJob.MemoryEncoderBytesPerTargetPixel);
        Assert.Equal(4_194_304, ExportJob.MemoryDemuxBytesPerInput);       // 4 MiB
        Assert.Equal(48, ExportJob.MemoryDecodeBytesPerSourcePixel);
        Assert.Equal(400, ExportJob.MemoryMixBytesPerCanvasPixel);

        // Çıktı bit hızı tabanları (1080p ölçüldü, diğerleri piksel alanı oranı — ExportProfiles).
        Assert.Equal(10_000_000, ExportProfiles.EstimatedBitsPerSecond(ExportProfile.Hd1080p));
        Assert.Equal(5_000_000, ExportProfiles.EstimatedBitsPerSecond(ExportProfile.Hd720p));
        Assert.Equal(40_000_000, ExportProfiles.EstimatedBitsPerSecond(ExportProfile.Uhd2160p));
        Assert.Equal(10_000_000, ExportProfiles.EstimatedBitsPerSecond(ExportProfile.Vertical1080p));
    }

    [Fact]
    public void EmptyOptions_ResolveToTheMeasuredDefaults()
    {
        var options = new ExportEstimateOptions();

        Assert.Equal(268_435_456, options.EffectiveMemoryBaseBytes);
        Assert.Equal(400, options.EffectiveMemoryEncoderBytesPerTargetPixel);
        Assert.Equal(4_194_304, options.EffectiveMemoryDemuxBytesPerInput);
        Assert.Equal(48, options.EffectiveMemoryDecodeBytesPerSourcePixel);
        Assert.Equal(400, options.EffectiveMemoryMixBytesPerCanvasPixel);
        Assert.Equal(10_000_000, options.EffectiveOutputBitsPerSecondFloor(ExportProfile.Hd1080p));
        Assert.Equal(5_000_000, options.EffectiveOutputBitsPerSecondFloor(ExportProfile.Hd720p));
        Assert.Equal(40_000_000, options.EffectiveOutputBitsPerSecondFloor(ExportProfile.Uhd2160p));
        Assert.Equal(10_000_000, options.EffectiveOutputBitsPerSecondFloor(ExportProfile.Vertical1080p));
    }

    [Fact]
    public void EstimateWithoutOptions_EqualsEstimateWithEmptyOptions()
    {
        (long Tp, long Cp, int In, int Pv, long Mp)[] grid =
        [
            (1280L * 720, 1920L * 1080, 1, 1, 1920L * 1080),
            (1920L * 1080, 1920L * 1080, 4, 4, 2 * 1920L * 1080),
            (3840L * 2160, 1920L * 1080, 7, 3, 3 * 1920L * 1080),
        ];
        foreach (var (tp, cp, inputs, pv, mp) in grid)
        {
            Assert.Equal(
                ExportJob.EstimateRequiredMemoryBytes(tp, cp, inputs, pv, mp),
                ExportJob.EstimateRequiredMemoryBytes(tp, cp, inputs, pv, mp, new ExportEstimateOptions()));
        }

        // Ölçülen bileşim noktası literal çivi: 1080p bileşim (4 giriş, 4 görsel tepe,
        // 2×1080p çözücü) → 4 562 445 926 B (formül + varsayılanlardan; elle hesaplandı).
        Assert.Equal(4_562_445_926,
            ExportJob.EstimateRequiredMemoryBytes(1920L * 1080, 1920L * 1080, 4, 4, 2 * 1920L * 1080));
    }

    // ---------- 2) Opsiyonla ezilebilirlik: formülün yalnız ilgili terimi oynar ----------

    [Fact]
    public void MemoryOverrides_MoveExactlyTheirOwnTerm()
    {
        // Formül girdileri: tp=1000, cp=2000, in=3, pv=2, mp=500. Beklenenler formül +
        // sabitlerden elle hesaplandı (bkz. xmldoc'lardaki formül; %20 pay = *12/10 kesmeli).
        const long tp = 1000, cp = 2000, mp = 500;
        const int inputs = 3, pv = 2;

        Assert.Equal(338_690_841, ExportJob.EstimateRequiredMemoryBytes(tp, cp, inputs, pv, mp));

        Assert.Equal(339_410_841, ExportJob.EstimateRequiredMemoryBytes(tp, cp, inputs, pv, mp,
            new ExportEstimateOptions { MemoryEncoderBytesPerTargetPixel = 1000 }));

        Assert.Equal(17_768_294, ExportJob.EstimateRequiredMemoryBytes(tp, cp, inputs, pv, mp,
            new ExportEstimateOptions { MemoryBaseBytes = 1_000_000 }));

        Assert.Equal(4204, ExportJob.EstimateRequiredMemoryBytes(tp, cp, inputs, pv, mp,
            new ExportEstimateOptions
            {
                MemoryBaseBytes = 1,
                MemoryEncoderBytesPerTargetPixel = 1,
                MemoryDemuxBytesPerInput = 1,
                MemoryDecodeBytesPerSourcePixel = 1,
                MemoryMixBytesPerCanvasPixel = 1,
            }));
    }

    [Fact]
    public void BitrateFloorOverride_ReplacesTheProfileFloor_ButNotTheMaxFormula()
    {
        var options = new ExportEstimateOptions { OutputBitsPerSecond720p = 22_000_000 };

        // Kaynaksız: taban override'ı döner.
        Assert.Equal(22_000_000,
            ExportJob.EffectiveOutputBitsPerSecond(ExportProfile.Hd720p, [], options));

        // Kaynak tabandan hızlıysa formül DEĞİŞMEDİ: max(taban, kaynak) hâlâ kaynağı seçer.
        var fast = MakeAsset(AssetKind.Video, sizeBytes: 40_000_000, durationUs: 10_000_000); // 32 Mb/s
        Assert.Equal(32_000_000,
            ExportJob.EffectiveOutputBitsPerSecond(ExportProfile.Hd720p, [fast], options));

        // Kaynak tabandan yavaşsa override kazanır (varsayılan 5 Mb/s'te kaynak kazanırdı —
        // override'ın gerçekten OKUNDUĞUNUN kanıtı).
        var slow = MakeAsset(AssetKind.Video, sizeBytes: 10_000_000, durationUs: 10_000_000); // 8 Mb/s
        Assert.Equal(22_000_000,
            ExportJob.EffectiveOutputBitsPerSecond(ExportProfile.Hd720p, [slow], options));
        Assert.Equal(8_000_000,
            ExportJob.EffectiveOutputBitsPerSecond(ExportProfile.Hd720p, [slow]));

        // Override edilmeyen profil ölçülen varsayılanda kalır.
        Assert.Equal(40_000_000,
            ExportJob.EffectiveOutputBitsPerSecond(ExportProfile.Uhd2160p, [], options));
    }

    [Fact]
    public void ConfigurationSection_BindsEveryKnob_EnvShapeKeys()
    {
        // env ExportEstimates__X ↔ config "ExportEstimates:X" — aynı anahtar uzayı.
        Dictionary<string, string?> keys = new()
        {
            ["ExportEstimates:MemoryBaseBytes"] = "111",
            ["ExportEstimates:MemoryEncoderBytesPerTargetPixel"] = "222",
            ["ExportEstimates:MemoryDemuxBytesPerInput"] = "333",
            ["ExportEstimates:MemoryDecodeBytesPerSourcePixel"] = "444",
            ["ExportEstimates:MemoryMixBytesPerCanvasPixel"] = "555",
            ["ExportEstimates:OutputBitsPerSecond1080p"] = "666",
            ["ExportEstimates:OutputBitsPerSecond720p"] = "777",
            ["ExportEstimates:OutputBitsPerSecond2160p"] = "888",
            ["ExportEstimates:OutputBitsPerSecondVertical"] = "999",
        };
        var config = new ConfigurationBuilder().AddInMemoryCollection(keys).Build();

        var options = config.GetSection(ExportEstimateOptions.SectionName).Get<ExportEstimateOptions>();

        Assert.NotNull(options);
        Assert.Equal(111, options!.MemoryBaseBytes);
        Assert.Equal(222, options.MemoryEncoderBytesPerTargetPixel);
        Assert.Equal(333, options.MemoryDemuxBytesPerInput);
        Assert.Equal(444, options.MemoryDecodeBytesPerSourcePixel);
        Assert.Equal(555, options.MemoryMixBytesPerCanvasPixel);
        Assert.Equal(666, options.OutputBitsPerSecond1080p);
        Assert.Equal(777, options.OutputBitsPerSecond720p);
        Assert.Equal(888, options.OutputBitsPerSecond2160p);
        Assert.Equal(999, options.OutputBitsPerSecondVertical);

        // MEKANİK TAMLIK: sınıfa eklenen her yeni ayar bu binding testine de girmek zorunda —
        // aksi halde anahtar adı yanlış yazılıp env'den hiç okunmayan "hayalet ayar" doğar.
        var knobs = typeof(ExportEstimateOptions).GetProperties()
            .Where(p => p.PropertyType == typeof(long?))
            .Select(p => p.Name)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        var covered = keys.Keys
            .Select(k => k.Split(':')[1])
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        Assert.Equal(knobs, covered);
    }

    [Fact]
    public void Validate_RejectsNonPositiveOverrides_AndAcceptsNullOrPositive()
    {
        new ExportEstimateOptions().Validate(); // hepsi null → geçerli
        new ExportEstimateOptions { MemoryBaseBytes = 1, OutputBitsPerSecond720p = 1 }.Validate();

        var ex = Assert.Throws<InvalidOperationException>(
            () => new ExportEstimateOptions { MemoryEncoderBytesPerTargetPixel = 0 }.Validate());
        Assert.Contains("ExportEstimates__MemoryEncoderBytesPerTargetPixel=0", ex.Message);

        Assert.Throws<InvalidOperationException>(
            () => new ExportEstimateOptions { OutputBitsPerSecond2160p = -5 }.Validate());
    }

    [Fact]
    public void DescribeEffective_NamesTheOverriddenKnobs()
    {
        var pristine = new ExportEstimateOptions().DescribeEffective();
        Assert.Contains("yok (ölçülen varsayılanlar)", pristine);
        Assert.Contains("bellek taban=268435456 B", pristine);
        Assert.Contains("2160p=40000000", pristine);

        var tuned = new ExportEstimateOptions
        {
            MemoryEncoderBytesPerTargetPixel = 640,
            OutputBitsPerSecond2160p = 60_000_000,
        }.DescribeEffective();
        Assert.Contains("kodlayıcı=640 B/hedef-px", tuned);
        Assert.Contains("2160p=60000000", tuned);
        Assert.Contains("MemoryEncoderBytesPerTargetPixel", tuned);
        Assert.Contains("OutputBitsPerSecond2160p", tuned);
        Assert.DoesNotContain("MemoryBaseBytes", tuned);
    }

    private static Asset MakeAsset(AssetKind kind, long sizeBytes, long durationUs)
    {
        var asset = Asset.Create(
            Guid.CreateVersion7(), kind, "a.bin", "application/octet-stream",
            sizeBytes, DateTimeOffset.UtcNow);
        asset.DurationMicros = durationUs;
        return asset;
    }
}
