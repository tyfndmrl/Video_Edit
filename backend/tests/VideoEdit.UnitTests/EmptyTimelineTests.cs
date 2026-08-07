using System.Text.Json;
using VideoEdit.Contracts;

namespace VideoEdit.UnitTests;

/// <summary>
/// EmptyTimeline builder'ının cross-language sözleşmesi: nil UUID ve default ayarlarla
/// üretilen doküman, packages/timeline-schema/test-vectors/empty-doc.fixture.json ile
/// TAM (deep) eşit olmalı. Fixture nil-UUID placeholder taşır; gerçek kullanımda
/// projectId route'taki proje id'sidir.
/// </summary>
public class EmptyTimelineTests
{
    private static JsonDocument LoadFixture()
    {
        var path = TestVectorFiles.Resolve("packages/timeline-schema/test-vectors/empty-doc.fixture.json");
        return JsonDocument.Parse(File.ReadAllText(path));
    }

    [Fact]
    public void Create_WithNilUuidAndDefaults_DeepEqualsEmptyDocFixture()
    {
        using var fixture = LoadFixture();
        using var built = EmptyTimeline.Create(
            Guid.Empty, width: 1920, height: 1080, fpsNum: 30, fpsDen: 1, audioSampleRate: 48000);

        Assert.True(
            JsonElement.DeepEquals(built.RootElement, fixture.RootElement),
            $"Builder output does not match fixture.\nBuilt:   {built.RootElement.GetRawText()}\nFixture: {fixture.RootElement.GetRawText()}");
    }

    [Fact]
    public void Create_ProducesAllSchemaRequiredFields()
    {
        var projectId = Guid.CreateVersion7();
        using var doc = EmptyTimeline.Create(projectId, 1280, 720, 60, 1, 44100);
        var root = doc.RootElement;

        Assert.Equal(1, root.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(projectId.ToString("D"), root.GetProperty("projectId").GetString());

        var settings = root.GetProperty("settings");
        Assert.Equal(1280, settings.GetProperty("width").GetInt32());
        Assert.Equal(720, settings.GetProperty("height").GetInt32());
        Assert.Equal(60, settings.GetProperty("fps").GetProperty("num").GetInt32());
        Assert.Equal(1, settings.GetProperty("fps").GetProperty("den").GetInt32());
        Assert.Equal(44100, settings.GetProperty("audioSampleRate").GetInt32());
        Assert.Equal("#000000", settings.GetProperty("backgroundColor").GetString());

        Assert.Equal(JsonValueKind.Array, root.GetProperty("tracks").ValueKind);
        Assert.Equal(0, root.GetProperty("tracks").GetArrayLength());
        Assert.Equal(JsonValueKind.Array, root.GetProperty("markers").ValueKind);
        Assert.Equal(0, root.GetProperty("markers").GetArrayLength());
    }
}
