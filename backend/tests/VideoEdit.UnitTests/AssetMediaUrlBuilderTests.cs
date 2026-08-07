using VideoEdit.Api.Endpoints;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;

namespace VideoEdit.UnitTests;

public class AssetMediaUrlBuilderTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 7, 12, 0, 0, TimeSpan.Zero);

    /// <summary>Sahte presigner: key'i deterministik URL'e çevirir (IStorageService.PresignGet mock'u).</summary>
    private static string FakePresign(string key) => $"https://signed.example/{key}?sig=test";

    private static Asset ReadyAsset(
        string? proxy = null, string? filmstrip = null, string? waveform = null, string? poster = null)
    {
        var asset = Asset.Create(
            Guid.CreateVersion7(), AssetKind.Video, "clip.mp4", "video/mp4", 1024, Now);
        asset.Status = AssetStatus.Ready;
        asset.ProxyKey = proxy;
        asset.FilmstripKey = filmstrip;
        asset.WaveformKey = waveform;
        asset.ThumbnailKey = poster;
        return asset;
    }

    [Fact]
    public void Build_AllDerivativesPresent_AllUrlsPresigned()
    {
        var asset = ReadyAsset(
            proxy: "u/x/a/y/proxy/540p.mp4",
            filmstrip: "u/x/a/y/filmstrip/sprite_1.jpg",
            waveform: "u/x/a/y/waveform/peaks.json",
            poster: "u/x/a/y/thumb/poster.jpg");

        var urls = AssetMediaUrlBuilder.Build(asset, FakePresign);

        Assert.Equal(FakePresign(asset.StorageKey), urls.Original);
        Assert.Equal("https://signed.example/u/x/a/y/proxy/540p.mp4?sig=test", urls.Proxy);
        Assert.Equal("https://signed.example/u/x/a/y/filmstrip/sprite_1.jpg?sig=test", urls.Filmstrip);
        Assert.Equal("https://signed.example/u/x/a/y/waveform/peaks.json?sig=test", urls.Waveform);
        Assert.Equal("https://signed.example/u/x/a/y/thumb/poster.jpg?sig=test", urls.Poster);
    }

    [Fact]
    public void Build_MissingDerivatives_OnlyOriginalPresent()
    {
        var urls = AssetMediaUrlBuilder.Build(ReadyAsset(), FakePresign);

        Assert.NotNull(urls.Original);
        Assert.Null(urls.Proxy);
        Assert.Null(urls.Filmstrip);
        Assert.Null(urls.FilmstripManifest);
        Assert.Null(urls.Waveform);
        Assert.Null(urls.Poster);
    }

    [Fact]
    public void Build_FilmstripKeyIsSprite_DerivesManifestSibling()
    {
        var urls = AssetMediaUrlBuilder.Build(
            ReadyAsset(filmstrip: "u/x/a/y/filmstrip/sprite_1.jpg"), FakePresign);

        Assert.Equal("https://signed.example/u/x/a/y/filmstrip/sprite_1.jpg?sig=test", urls.Filmstrip);
        Assert.Equal("https://signed.example/u/x/a/y/filmstrip/manifest.json?sig=test", urls.FilmstripManifest);
    }

    [Fact]
    public void Build_FilmstripKeyIsManifest_DerivesFirstSpriteSibling()
    {
        var urls = AssetMediaUrlBuilder.Build(
            ReadyAsset(filmstrip: "u/x/a/y/filmstrip/manifest.json"), FakePresign);

        Assert.Equal("https://signed.example/u/x/a/y/filmstrip/manifest.json?sig=test", urls.FilmstripManifest);
        Assert.Equal("https://signed.example/u/x/a/y/filmstrip/sprite_1.jpg?sig=test", urls.Filmstrip);
    }

    // ---------- BuildAsync: çoklu-sprite çözümü (manifest storage'dan okunur) ----------

    private static Func<string, CancellationToken, Task<byte[]?>> ManifestReader(string? json) =>
        (_, _) => Task.FromResult(json is null ? null : System.Text.Encoding.UTF8.GetBytes(json));

    [Fact]
    public async Task BuildAsync_ManifestWithMultipleSprites_ReturnsPresignedSpriteMap()
    {
        var manifest = """{"intervalUs":1000000,"cols":30,"rows":10,"frameCount":600,"sprites":["sprite_1.jpg","sprite_2.jpg"]}""";
        string? readKey = null;
        Func<string, CancellationToken, Task<byte[]?>> reader = (key, _) =>
        {
            readKey = key;
            return Task.FromResult<byte[]?>(System.Text.Encoding.UTF8.GetBytes(manifest));
        };

        var urls = await AssetMediaUrlBuilder.BuildAsync(
            ReadyAsset(filmstrip: "u/x/a/y/filmstrip/sprite_1.jpg"), FakePresign, reader);

        Assert.Equal("u/x/a/y/filmstrip/manifest.json", readKey); // tek küçük GetObject
        Assert.NotNull(urls.Sprites);
        Assert.Equal(2, urls.Sprites!.Count);
        Assert.Equal("https://signed.example/u/x/a/y/filmstrip/sprite_1.jpg?sig=test", urls.Sprites["sprite_1.jpg"]);
        Assert.Equal("https://signed.example/u/x/a/y/filmstrip/sprite_2.jpg?sig=test", urls.Sprites["sprite_2.jpg"]);
        // Eski alanlar korunur (geriye uyumluluk).
        Assert.Equal("https://signed.example/u/x/a/y/filmstrip/sprite_1.jpg?sig=test", urls.Filmstrip);
        Assert.Equal("https://signed.example/u/x/a/y/filmstrip/manifest.json?sig=test", urls.FilmstripManifest);
    }

    [Fact]
    public async Task BuildAsync_ManifestUnreadable_OmitsSpritesButKeepsFilmstripFields()
    {
        var urls = await AssetMediaUrlBuilder.BuildAsync(
            ReadyAsset(filmstrip: "u/x/a/y/filmstrip/sprite_1.jpg"), FakePresign, ManifestReader(null));

        Assert.Null(urls.Sprites);
        Assert.NotNull(urls.Filmstrip);
        Assert.NotNull(urls.FilmstripManifest);
    }

    [Fact]
    public async Task BuildAsync_MalformedManifest_OmitsSprites()
    {
        var urls = await AssetMediaUrlBuilder.BuildAsync(
            ReadyAsset(filmstrip: "u/x/a/y/filmstrip/sprite_1.jpg"), FakePresign, ManifestReader("{not json"));

        Assert.Null(urls.Sprites);
        Assert.NotNull(urls.Filmstrip);
    }

    [Fact]
    public async Task BuildAsync_SpriteNamesWithPathSeparators_AreSkipped()
    {
        var manifest = """{"sprites":["sprite_1.jpg","../../../etc/passwd","a/b.jpg"]}""";

        var urls = await AssetMediaUrlBuilder.BuildAsync(
            ReadyAsset(filmstrip: "u/x/a/y/filmstrip/manifest.json"), FakePresign, ManifestReader(manifest));

        Assert.NotNull(urls.Sprites);
        Assert.Single(urls.Sprites!);
        Assert.True(urls.Sprites!.ContainsKey("sprite_1.jpg"));
    }

    [Fact]
    public async Task BuildAsync_NoFilmstripKey_DoesNotReadStorage()
    {
        var reads = 0;
        Func<string, CancellationToken, Task<byte[]?>> reader = (_, _) =>
        {
            reads++;
            return Task.FromResult<byte[]?>(null);
        };

        var urls = await AssetMediaUrlBuilder.BuildAsync(ReadyAsset(), FakePresign, reader);

        Assert.Equal(0, reads);
        Assert.Null(urls.Sprites);
        Assert.Null(urls.Filmstrip);
    }
}
