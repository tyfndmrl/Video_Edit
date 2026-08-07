using System.Text.Json;

namespace VideoEdit.Contracts;

/// <summary>
/// Şema-geçerli BOŞ timeline dokümanı üreticisi — tek kaynak.
/// Çıktı, packages/timeline-schema'daki TimelineDoc şemasının zorunlu alanlarının tamamını
/// içerir: schemaVersion, projectId, settings (width/height/fps/audioSampleRate/backgroundColor),
/// tracks, markers. Cross-language sözleşme:
/// packages/timeline-schema/test-vectors/empty-doc.fixture.json ile alan-alan eşleşir.
/// </summary>
public static class EmptyTimeline
{
    public const string DefaultBackgroundColor = "#000000";

    public static JsonDocument Create(
        Guid projectId, int width, int height, int fpsNum, int fpsDen, int audioSampleRate) =>
        JsonSerializer.SerializeToDocument(new
        {
            schemaVersion = 1,
            projectId = projectId.ToString("D"),
            settings = new
            {
                width,
                height,
                fps = new { num = fpsNum, den = fpsDen },
                audioSampleRate,
                backgroundColor = DefaultBackgroundColor,
            },
            tracks = Array.Empty<object>(),
            markers = Array.Empty<object>(),
        });
}
