using Microsoft.Extensions.Configuration;
using VideoEdit.Infrastructure.Storage;

namespace VideoEdit.UnitTests;

/// <summary>
/// Backlog maddesi: "compose R2__* env adları ↔ backend config binding birebir eşleşme testi"
/// (denetim #36). compose.yml api/worker servislerine R2__AccountId, R2__AccessKeyId,
/// R2__SecretAccessKey, R2__Bucket, R2__ExportsBucket geçirir — bu adlar değişirse bu test kırılır.
/// </summary>
public class R2OptionsTests
{
    /// <summary>compose.yml'de geçirilen env adlarının konfig-anahtar karşılıkları.</summary>
    private static readonly Dictionary<string, string> ComposeEnvBindings = new()
    {
        // env "R2__AccountId" → konfig anahtarı "R2:AccountId" (çift alt çizgi = ':')
        ["R2:AccountId"] = "test-account",
        ["R2:AccessKeyId"] = "test-access-key",
        ["R2:SecretAccessKey"] = "test-secret",
        ["R2:Bucket"] = "videoedit-media",
        ["R2:ExportsBucket"] = "videoedit-exports",
    };

    private static R2Options Bind(Dictionary<string, string> values)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(values!)
            .Build();
        var options = new R2Options();
        configuration.GetSection(R2Options.SectionName).Bind(options);
        return options;
    }

    [Fact]
    public void ComposeEnvNames_BindToOptions_ExactMatch()
    {
        var options = Bind(ComposeEnvBindings);

        Assert.Equal("test-account", options.AccountId);
        Assert.Equal("test-access-key", options.AccessKeyId);
        Assert.Equal("test-secret", options.SecretAccessKey);
        Assert.Equal("videoedit-media", options.Bucket);
        Assert.Equal("videoedit-exports", options.ExportsBucket);
        Assert.Null(options.ServiceUrl); // compose R2__ServiceUrl geçmez — prod'da AccountId'den türetilir
    }

    [Fact]
    public void ResolveServiceUrl_WithoutServiceUrl_DerivesR2EndpointFromAccountId()
    {
        var options = Bind(ComposeEnvBindings);
        Assert.Equal("https://test-account.r2.cloudflarestorage.com", options.ResolveServiceUrl());
    }

    [Fact]
    public void ResolveServiceUrl_WithServiceUrl_UsesItVerbatim()
    {
        // Dev: MinIO endpoint'i doğrudan kullanılır (appsettings.Development.json).
        var options = new R2Options { ServiceUrl = "http://localhost:9000", AccountId = "ignored" };
        Assert.Equal("http://localhost:9000", options.ResolveServiceUrl());
    }

    [Fact]
    public void ResolveServiceUrl_BothMissing_ThrowsInsteadOfGarbageUrl()
    {
        // Eskiden "https://.r2.cloudflarestorage.com" üretilip sessizce ayağa kalkılıyordu.
        var options = new R2Options();
        Assert.Throws<InvalidOperationException>(() => options.ResolveServiceUrl());
        Assert.Throws<InvalidOperationException>(
            () => new R2Options { ServiceUrl = "  ", AccountId = "" }.ResolveServiceUrl());
    }

    [Fact]
    public void SectionName_IsR2_MatchingComposePrefix()
    {
        Assert.Equal("R2", R2Options.SectionName);
    }
}
