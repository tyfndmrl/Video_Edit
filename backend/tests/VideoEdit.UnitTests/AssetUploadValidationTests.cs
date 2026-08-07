using VideoEdit.Api.Endpoints;
using VideoEdit.Contracts;
using VideoEdit.Domain;

namespace VideoEdit.UnitTests;

public class AssetUploadValidationTests
{
    private const long MaxFileSize = 4L * 1024 * 1024 * 1024; // 4 GiB (Quotas default)

    private static InitAssetUploadRequest Init(
        string fileName = "clip.mp4", long sizeBytes = 1024, string contentType = "video/mp4") =>
        new(fileName, sizeBytes, contentType);

    // ---------- init ----------

    [Fact]
    public void ValidateInit_ValidRequest_NoErrors_DerivesKind()
    {
        var errors = AssetUploadValidation.ValidateInit(Init(contentType: "audio/wav"), MaxFileSize, out var kind);
        Assert.Empty(errors);
        Assert.Equal(AssetKind.Audio, kind);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ValidateInit_MissingFileName_Error(string fileName)
    {
        var errors = AssetUploadValidation.ValidateInit(Init(fileName: fileName), MaxFileSize, out _);
        Assert.Contains("fileName", errors.Keys);
    }

    [Fact]
    public void ValidateInit_FileNameOverColumnLimit_Error()
    {
        var errors = AssetUploadValidation.ValidateInit(
            Init(fileName: new string('a', 501)), MaxFileSize, out _);
        Assert.Contains("fileName", errors.Keys);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(MaxFileSize + 1)]
    public void ValidateInit_SizeOutOfRange_Error(long sizeBytes)
    {
        var errors = AssetUploadValidation.ValidateInit(Init(sizeBytes: sizeBytes), MaxFileSize, out _);
        Assert.Contains("sizeBytes", errors.Keys);
    }

    [Fact]
    public void ValidateInit_SizeExactlyAtLimit_Allowed()
    {
        var errors = AssetUploadValidation.ValidateInit(Init(sizeBytes: MaxFileSize), MaxFileSize, out _);
        Assert.Empty(errors);
    }

    [Fact]
    public void ValidateInit_NonWhitelistedContentType_Error()
    {
        var errors = AssetUploadValidation.ValidateInit(Init(contentType: "text/html"), MaxFileSize, out _);
        Assert.Contains("contentType", errors.Keys);
    }

    [Fact]
    public void ValidateInit_CollectsAllErrorsAtOnce()
    {
        var errors = AssetUploadValidation.ValidateInit(
            new InitAssetUploadRequest("", 0, "application/pdf"), MaxFileSize, out _);
        Assert.Equal(3, errors.Count);
    }

    // ---------- presign ----------

    [Fact]
    public void ValidatePresign_ValidSubset_NoErrors()
    {
        Assert.Empty(AssetUploadValidation.ValidatePresign([5, 6, 7], partCount: 32));
    }

    [Fact]
    public void ValidatePresign_EmptyOrNull_Error()
    {
        Assert.NotEmpty(AssetUploadValidation.ValidatePresign(null, 32));
        Assert.NotEmpty(AssetUploadValidation.ValidatePresign([], 32));
    }

    [Fact]
    public void ValidatePresign_MoreThan20PerRequest_Error()
    {
        var tooMany = Enumerable.Range(1, 21).ToArray();
        Assert.NotEmpty(AssetUploadValidation.ValidatePresign(tooMany, partCount: 64));
        // Tam 20 serbest.
        Assert.Empty(AssetUploadValidation.ValidatePresign(
            Enumerable.Range(1, 20).ToArray(), partCount: 64));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-3)]
    [InlineData(33)] // partCount=32'nin dışı
    public void ValidatePresign_OutOfRangePartNumber_Error(int partNumber)
    {
        Assert.NotEmpty(AssetUploadValidation.ValidatePresign([partNumber], partCount: 32));
    }

    [Fact]
    public void ValidatePresign_DuplicatePartNumbers_Error()
    {
        Assert.NotEmpty(AssetUploadValidation.ValidatePresign([3, 3], partCount: 32));
    }

    // ---------- complete ----------

    private static List<CompletedPartDto> Parts(params int[] numbers) =>
        numbers.Select(n => new CompletedPartDto(n, $"\"etag-{n}\"")).ToList();

    [Fact]
    public void ValidateComplete_OrderedFullSequence_NoErrors()
    {
        Assert.Empty(AssetUploadValidation.ValidateComplete(Parts(1, 2, 3), partCount: 3));
    }

    [Fact]
    public void ValidateComplete_UnsortedParts_Error()
    {
        Assert.NotEmpty(AssetUploadValidation.ValidateComplete(Parts(2, 1, 3), partCount: 3));
    }

    [Fact]
    public void ValidateComplete_MissingPart_Error()
    {
        Assert.NotEmpty(AssetUploadValidation.ValidateComplete(Parts(1, 2), partCount: 3));
    }

    [Fact]
    public void ValidateComplete_EmptyEtag_Error()
    {
        var parts = new List<CompletedPartDto> { new(1, ""), new(2, "\"ok\"") };
        var errors = AssetUploadValidation.ValidateComplete(parts, partCount: 2);
        Assert.Contains("parts.etag", errors.Keys);
    }

    [Fact]
    public void ValidateComplete_NullOrEmpty_Error()
    {
        Assert.NotEmpty(AssetUploadValidation.ValidateComplete(null, 1));
        Assert.NotEmpty(AssetUploadValidation.ValidateComplete(new List<CompletedPartDto>(), 1));
    }
}
