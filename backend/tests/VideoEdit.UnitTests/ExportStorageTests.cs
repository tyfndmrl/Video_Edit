using Microsoft.Extensions.Options;
using VideoEdit.Infrastructure.Storage;

namespace VideoEdit.UnitTests;

/// <summary>
/// Export depolama yüzeyi birim testleri (ağsız):
///  - multipart eşik kararı + part aralığı matematiği (256 MiB üstü → 64 MiB eşit partlar,
///    son part kalan — R2 eşit-part kuralı); MinIO ile dev sentetik dosya GEREKMEZ, upload
///    yolu eşik/aralık fonksiyonlarından geçer;
///  - PresignExportGet URL'inin Content-Disposition override taşıdığı (cross-origin
///    &lt;a download&gt; çalışmaz — indirme tarayıcıda bu başlıkla tetiklenir). Presign yerel
///    imzalamadır, test ağa çıkmaz.
/// </summary>
public sealed class ExportStorageTests
{
    private const long MiB = 1024 * 1024;

    // ---------- Multipart eşik kararı ----------

    [Theory]
    [InlineData(1, false)]
    [InlineData(100 * MiB, false)]
    [InlineData(256 * MiB, false)]     // tam eşik: hâlâ tek PUT
    [InlineData(256 * MiB + 1, true)]  // eşik ÜSTÜ: multipart
    [InlineData(2048 * MiB, true)]
    public void ShouldUseMultipartExport_SwitchesStrictlyAbove256MiB(long sizeBytes, bool expected)
    {
        Assert.Equal(expected, R2StorageService.ShouldUseMultipartExport(sizeBytes));
    }

    [Fact]
    public void Thresholds_MatchDesignContract()
    {
        Assert.Equal(256L * MiB, R2StorageService.MultipartExportThresholdBytes);
        Assert.Equal(64L * MiB, R2StorageService.ExportPartSizeBytes);
    }

    // ---------- Part aralığı matematiği ----------

    [Fact]
    public void ExportPartRanges_EqualPartsWithRemainderTail()
    {
        // 300 MiB → 4 × 64 MiB + 44 MiB kuyruk.
        var ranges = R2StorageService.ExportPartRanges(300 * MiB);

        Assert.Equal(5, ranges.Count);
        Assert.All(ranges.Take(4), r => Assert.Equal(64 * MiB, r.Length));
        Assert.Equal(44 * MiB, ranges[^1].Length);

        // Aralıklar bitişik ve boşluksuz: offset zinciri toplam boyutu kapatır.
        long expectedOffset = 0;
        foreach (var (offset, length) in ranges)
        {
            Assert.Equal(expectedOffset, offset);
            expectedOffset += length;
        }

        Assert.Equal(300 * MiB, expectedOffset);
    }

    [Fact]
    public void ExportPartRanges_ExactMultiple_HasNoEmptyTailPart()
    {
        var ranges = R2StorageService.ExportPartRanges(128 * MiB);
        Assert.Equal(2, ranges.Count);
        Assert.All(ranges, r => Assert.Equal(64 * MiB, r.Length));
    }

    [Fact]
    public void ExportPartRanges_SmallFile_SinglePart()
    {
        var ranges = R2StorageService.ExportPartRanges(5);
        var part = Assert.Single(ranges);
        Assert.Equal((0L, 5L), part);
    }

    [Fact]
    public void ExportPartRanges_NonPositiveSize_Throws()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => R2StorageService.ExportPartRanges(0));
    }

    // ---------- PresignExportGet Content-Disposition ----------

    private static R2StorageService CreateService() => new(Options.Create(new R2Options
    {
        ServiceUrl = "http://localhost:9000",
        AccessKeyId = "test-key",
        SecretAccessKey = "test-secret",
        Bucket = "media",
        ExportsBucket = "exports",
    }));

    [Fact]
    public void PresignExportGet_IncludesAttachmentContentDisposition_WithJobIdFilename()
    {
        using var service = CreateService();
        var jobId = Guid.CreateVersion7();
        var url = service.PresignExportGet($"exports/{Guid.CreateVersion7():D}/{jobId:D}.mp4");

        // İmzalı URL'de response-content-disposition override'ı bulunmalı; dosya adı job
        // id'sinden türetilir. (Değer URL-encode edilir — ada encode'suz, sabit parçalara bakılır.)
        Assert.Contains("response-content-disposition=", url);
        Assert.Contains("attachment", url);
        Assert.Contains($"export-{jobId:D}.mp4", url);
    }

    [Fact]
    public void PresignExportGet_WithoutExportsBucket_Throws()
    {
        using var service = new R2StorageService(Options.Create(new R2Options
        {
            ServiceUrl = "http://localhost:9000",
            AccessKeyId = "k",
            SecretAccessKey = "s",
            Bucket = "media",
            ExportsBucket = "",
        }));
        Assert.Throws<InvalidOperationException>(
            () => service.PresignExportGet("exports/p/j.mp4"));
    }
}
