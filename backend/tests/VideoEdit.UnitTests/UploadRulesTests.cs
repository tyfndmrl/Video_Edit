using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Domain.Services;

namespace VideoEdit.UnitTests;

public class UploadRulesTests
{
    // ---------- contentType → Kind whitelist ----------

    [Theory]
    [InlineData("video/mp4", AssetKind.Video)]
    [InlineData("video/quicktime", AssetKind.Video)]
    [InlineData("video/webm", AssetKind.Video)]
    [InlineData("audio/mpeg", AssetKind.Audio)]
    [InlineData("audio/mp4", AssetKind.Audio)]
    [InlineData("audio/wav", AssetKind.Audio)]
    [InlineData("image/png", AssetKind.Image)]
    [InlineData("image/jpeg", AssetKind.Image)]
    [InlineData("image/webp", AssetKind.Image)]
    public void TryGetKind_WhitelistedTypes_DeriveKind(string contentType, AssetKind expected)
    {
        Assert.True(UploadRules.TryGetKind(contentType, out var kind));
        Assert.Equal(expected, kind);
    }

    [Theory]
    [InlineData("VIDEO/MP4")] // büyük/küçük harf normalize edilir
    [InlineData("  video/mp4  ")] // kenar boşlukları
    public void TryGetKind_NormalizesCaseAndWhitespace(string contentType)
    {
        Assert.True(UploadRules.TryGetKind(contentType, out var kind));
        Assert.Equal(AssetKind.Video, kind);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("text/html")] // XSS vektörü — asla
    [InlineData("image/svg+xml")] // XSS vektörü — asla
    [InlineData("video/x-msvideo")] // AVI whitelist dışı
    [InlineData("video/mp4; codecs=avc1")] // parametreli tip kabul edilmez
    [InlineData("application/octet-stream")]
    public void TryGetKind_NonWhitelisted_Rejected(string? contentType)
    {
        Assert.False(UploadRules.TryGetKind(contentType, out _));
    }

    // ---------- partCount ----------

    [Theory]
    [InlineData(1, 1)]
    [InlineData(UploadRules.PartSizeBytes - 1, 1)]
    [InlineData(UploadRules.PartSizeBytes, 1)] // tam 64 MiB → tek part
    [InlineData(UploadRules.PartSizeBytes + 1, 2)]
    [InlineData(2L * 1024 * 1024 * 1024, 32)] // 2 GiB → 32 part (tasarım 02 §1.2)
    [InlineData(4L * 1024 * 1024 * 1024, 64)] // max dosya (4 GiB) → 64 part
    public void PartCount_CeilDivision(long sizeBytes, int expected)
    {
        Assert.Equal(expected, UploadRules.PartCount(sizeBytes));
    }

    [Fact]
    public void PartSize_IsExactly64MiB_ContractConstant()
    {
        // Frontend sözleşmesi: init yanıtı partSize=67108864 döner; R2 eşit-part kuralı
        // bu sabite yaslanır — değişirse frontend ile birlikte değişmeli.
        Assert.Equal(67_108_864, UploadRules.PartSizeBytes);
    }

    // ---------- complete part sırası ----------

    [Theory]
    [InlineData(new[] { 1 }, 1)]
    [InlineData(new[] { 1, 2, 3, 4 }, 4)]
    public void CompletedPartSequence_ExactOrderedSequence_Valid(int[] parts, int expectedCount)
    {
        Assert.Null(UploadRules.ValidateCompletedPartSequence(parts, expectedCount));
    }

    [Fact]
    public void CompletedPartSequence_Empty_Invalid()
    {
        Assert.NotNull(UploadRules.ValidateCompletedPartSequence([], 1));
    }

    [Fact]
    public void CompletedPartSequence_CountMismatch_Invalid()
    {
        Assert.NotNull(UploadRules.ValidateCompletedPartSequence([1, 2], 3)); // eksik part
        Assert.NotNull(UploadRules.ValidateCompletedPartSequence([1, 2, 3, 4], 3)); // fazla part
    }

    [Fact]
    public void CompletedPartSequence_Unsorted_Invalid()
    {
        // CompleteMultipartUpload partNumber sırası zorunlu (tasarım 02 tuzak #4) —
        // sunucu sessizce sıralamaz, istemci sözleşme ihlalini görür.
        Assert.NotNull(UploadRules.ValidateCompletedPartSequence([2, 1, 3], 3));
    }

    [Fact]
    public void CompletedPartSequence_DuplicateOrGap_Invalid()
    {
        Assert.NotNull(UploadRules.ValidateCompletedPartSequence([1, 1, 2], 3)); // tekrar
        Assert.NotNull(UploadRules.ValidateCompletedPartSequence([1, 3, 4], 3)); // boşluk
        Assert.NotNull(UploadRules.ValidateCompletedPartSequence([2, 3, 4], 3)); // 1'den başlamıyor
    }

    // ---------- fileName sanitize (Asset.SanitizeFileName + StorageKey) ----------

    [Theory]
    [InlineData("My Video.MP4", "source.mp4")] // uzantı küçük harfe iner, ad atılır
    [InlineData("clip.mov", "source.mov")]
    [InlineData("archive.tar.gz", "source.gz")] // yalnız SON uzantı
    [InlineData("noextension", "source")]
    [InlineData("trailingdot.", "source")]
    [InlineData("weird.mp4?v=1", "source")] // uzantıda ASCII dışı/özel karakter → uzantı atılır
    [InlineData("ünïcode.мр4", "source")] // kiril uzantı → atılır
    [InlineData("..\\..\\etc\\passwd.png", "source.png")] // path traversal girişimi zararsızlaşır
    [InlineData("a/b/c.webm", "source.webm")]
    public void SanitizeFileName_ProducesSafeKeySegment(string fileName, string expected)
    {
        Assert.Equal(expected, Asset.SanitizeFileName(fileName));
    }

    [Fact]
    public void Create_StorageKey_UsesSanitizedFileName_NeverRawInput()
    {
        var ownerId = Guid.CreateVersion7();
        var asset = Asset.Create(
            ownerId, AssetKind.Video, "Tatil Videosu (final) %20.MOV", "video/quicktime", 42,
            new DateTimeOffset(2026, 8, 7, 0, 0, 0, TimeSpan.Zero));

        Assert.Equal($"u/{ownerId}/a/{asset.Id}/original/source.mov", asset.StorageKey);
        Assert.Equal("Tatil Videosu (final) %20.MOV", asset.OriginalFileName); // asıl ad DB'de
    }
}
