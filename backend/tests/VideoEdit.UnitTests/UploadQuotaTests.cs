using VideoEdit.Api.Assets;

namespace VideoEdit.UnitTests;

public class UploadQuotaTests
{
    private static readonly QuotasOptions Defaults = new();

    [Fact]
    public void Defaults_MatchProductPolicy()
    {
        Assert.Equal(20L * 1024 * 1024 * 1024, Defaults.MaxTotalBytesPerUser); // 20 GiB
        Assert.Equal(4L * 1024 * 1024 * 1024, Defaults.MaxFileSizeBytes); // 4 GiB
        Assert.Equal(5, Defaults.MaxConcurrentUploads);
    }

    [Fact]
    public void Evaluate_UnderAllLimits_Allowed()
    {
        var result = UploadQuota.Evaluate(
            requestedBytes: 1_000_000, usedBytes: 0, activeUploads: 0, Defaults);
        Assert.Equal(QuotaViolation.None, result);
    }

    [Fact]
    public void Evaluate_ExactlyFillsTotalQuota_Allowed()
    {
        // used + requested == max → sınır DAHİL kabul (aşım ancak > max'ta).
        var result = UploadQuota.Evaluate(
            requestedBytes: 4L * 1024 * 1024 * 1024,
            usedBytes: 16L * 1024 * 1024 * 1024,
            activeUploads: 0, Defaults);
        Assert.Equal(QuotaViolation.None, result);
    }

    [Fact]
    public void Evaluate_OneByteOverTotalQuota_Rejected()
    {
        var result = UploadQuota.Evaluate(
            requestedBytes: 4L * 1024 * 1024 * 1024,
            usedBytes: 16L * 1024 * 1024 * 1024 + 1,
            activeUploads: 0, Defaults);
        Assert.Equal(QuotaViolation.TotalBytesExceeded, result);
    }

    [Fact]
    public void Evaluate_AtConcurrentUploadCap_Rejected()
    {
        var result = UploadQuota.Evaluate(
            requestedBytes: 1, usedBytes: 0, activeUploads: 5, Defaults);
        Assert.Equal(QuotaViolation.TooManyConcurrentUploads, result);
    }

    [Fact]
    public void Evaluate_JustBelowConcurrentUploadCap_Allowed()
    {
        var result = UploadQuota.Evaluate(
            requestedBytes: 1, usedBytes: 0, activeUploads: 4, Defaults);
        Assert.Equal(QuotaViolation.None, result);
    }

    [Fact]
    public void Evaluate_ConcurrencyViolation_TakesPrecedence_YieldsRetryableError()
    {
        // İkisi birden ihlaldeyse eşzamanlılık (429, geçici) döner — istemci retry edebilir;
        // 403 (kota) kalıcı sinyaldir, yanlışlıkla verilmemeli.
        var result = UploadQuota.Evaluate(
            requestedBytes: long.MaxValue / 2, usedBytes: long.MaxValue / 2, activeUploads: 99, Defaults);
        Assert.Equal(QuotaViolation.TooManyConcurrentUploads, result);
    }

    [Fact]
    public void Evaluate_RespectsCustomOptions()
    {
        var custom = new QuotasOptions
        {
            MaxTotalBytesPerUser = 100,
            MaxConcurrentUploads = 1,
        };

        Assert.Equal(QuotaViolation.TotalBytesExceeded,
            UploadQuota.Evaluate(requestedBytes: 60, usedBytes: 50, activeUploads: 0, custom));
        Assert.Equal(QuotaViolation.TooManyConcurrentUploads,
            UploadQuota.Evaluate(requestedBytes: 1, usedBytes: 0, activeUploads: 1, custom));
        Assert.Equal(QuotaViolation.None,
            UploadQuota.Evaluate(requestedBytes: 50, usedBytes: 50, activeUploads: 0, custom));
    }
}
