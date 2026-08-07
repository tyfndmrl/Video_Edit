using System.Text.Json;
using VideoEdit.Media.Probing;
using VideoEdit.Media.Recipes;

namespace VideoEdit.UnitTests;

public class FilmstripRecipeTests
{
    private static MediaProbe Probe(int width, int height) => new()
    {
        RawJson = "{}",
        HasVideo = true,
        Width = width,
        Height = height,
        VideoStreamIndex = 0,
    };

    // interval = max(1, ceil(durationSec/3000)) — tasarım 02 §3.4 adaptif aralık.
    [Theory]
    [InlineData(3_000_000L, 1)]              // 3 sn
    [InlineData(3_000_000_000L, 1)]          // tam 3000 sn → hâlâ 1
    [InlineData(3_000_000_001L, 2)]          // 3000 sn + 1 µs → 2
    [InlineData(9_000_000_000L, 3)]          // 9000 sn (2.5 saat) → 3
    [InlineData(0L, 1)]                      // taban 1
    public void IntervalSec_AdaptiveRule(long durationUs, int expected)
    {
        Assert.Equal(expected, FilmstripRecipe.IntervalSec(durationUs));
    }

    [Theory]
    [InlineData(1920, 1080, 90)]   // 16:9 → 160×90
    [InlineData(320, 240, 120)]    // 4:3 → 160×120
    [InlineData(1080, 1920, 284)]  // dikey: 284.44 → çift sayıya half-up = 284
    [InlineData(1280, 720, 90)]
    public void TileHeight_EvenRounded(int width, int height, int expected)
    {
        Assert.Equal(expected, FilmstripRecipe.TileHeight(width, height));
    }

    [Theory]
    [InlineData(3_000_000L, 3)]     // 3 sn @ 1 sn aralık → 3 kare
    [InlineData(3_500_000L, 4)]     // 3.5 sn → ceil = 4
    [InlineData(500_000L, 1)]       // yarım saniye → yine 1 (t=0 karesi)
    [InlineData(0L, 1)]
    public void FrameCount_CeilOfDurationOverInterval(long durationUs, long expected)
    {
        Assert.Equal(expected, FilmstripRecipe.FrameCount(durationUs));
    }

    [Fact]
    public void BuildFilter_Snapshot()
    {
        Assert.Equal(
            "fps=1/1,scale=160:-2,tile=30x10",
            FilmstripRecipe.BuildFilter(Probe(1920, 1080), 3_000_000));
    }

    [Fact]
    public void BuildFilter_LongVideo_UsesWiderInterval()
    {
        Assert.Equal(
            "fps=1/3,scale=160:-2,tile=30x10",
            FilmstripRecipe.BuildFilter(Probe(1920, 1080), 9_000_000_000));
    }

    [Fact]
    public void BuildFilter_Hdr_ColorChainAfterFpsBeforeScale()
    {
        // Sıra bilinçli (denetim bulgusu #7): fps ÖNCE → HDR tonemap yalnız SEÇİLEN karelere
        // uygulanır (kare başına tonemap ~30× pahalıydı); sonra ColorChain, sonra scale/tile.
        var probe = Probe(3840, 2160) with { ColorTransfer = "smpte2084", IsHdr = true };
        var filter = FilmstripRecipe.BuildFilter(probe, 3_000_000);
        Assert.Equal($"fps=1/1,{ColorChain.HdrToSdr},scale=160:-2,tile=30x10", filter);
    }

    [Fact]
    public void BuildArgs_Snapshot()
    {
        var args = FilmstripRecipe.BuildArgs(Probe(1920, 1080), 3_000_000, "in.mp4", "sprite_%d.jpg");
        Assert.Equal(
            "-y -i in.mp4 -map 0:0 -vf fps=1/1,scale=160:-2,tile=30x10 -q:v 5 sprite_%d.jpg",
            string.Join(' ', args));
    }

    [Fact]
    public void Manifest_ValuesAndJsonShape()
    {
        var manifest = FilmstripRecipe.BuildManifest(
            Probe(1920, 1080), 3_000_000, ["sprite_1.jpg"]);

        Assert.Equal(1_000_000, manifest.IntervalUs);
        Assert.Equal(160, manifest.TileW);
        Assert.Equal(90, manifest.TileH);
        Assert.Equal(30, manifest.Cols);
        Assert.Equal(10, manifest.Rows);
        Assert.Equal(3, manifest.FrameCount);
        Assert.Equal(["sprite_1.jpg"], manifest.Sprites);

        using var doc = JsonDocument.Parse(FilmstripRecipe.SerializeManifest(manifest));
        var root = doc.RootElement;
        Assert.Equal(1_000_000, root.GetProperty("intervalUs").GetInt64());
        Assert.Equal(160, root.GetProperty("tileW").GetInt32());
        Assert.Equal(90, root.GetProperty("tileH").GetInt32());
        Assert.Equal(30, root.GetProperty("cols").GetInt32());
        Assert.Equal(10, root.GetProperty("rows").GetInt32());
        Assert.Equal(3, root.GetProperty("frameCount").GetInt64());
        Assert.Equal("sprite_1.jpg", root.GetProperty("sprites")[0].GetString());
    }

    [Fact]
    public void Manifest_MultiSprite_LongVideo()
    {
        // 900 sn @ 1 sn aralık → 900 kare → 3 sprite (300 kare/sprite).
        var manifest = FilmstripRecipe.BuildManifest(
            Probe(1280, 720), 900_000_000, ["sprite_1.jpg", "sprite_2.jpg", "sprite_3.jpg"]);
        Assert.Equal(900, manifest.FrameCount);
        Assert.Equal(3, manifest.Sprites.Count);
    }
}
