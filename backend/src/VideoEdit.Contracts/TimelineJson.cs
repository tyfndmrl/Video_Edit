using System.Text.Json;
using System.Text.Json.Serialization;

namespace VideoEdit.Contracts;

/// <summary>
/// Timeline dokümanları için KANONİK System.Text.Json ayarları.
/// Üretilen DTO'lar (TimelineContracts.g.cs) property adlarını JsonPropertyName ile taşıdığı
/// için camelCase policy yalnız ekstra/elle yazılmış tipler için güvenlik ağıdır.
/// WhenWritingNull: optional alanlar (transitionIn, name, ...) girdide yoksa çıktı JSON'unda
/// null olarak SIZMAZ — schema round-trip'i alan-alan korunur.
/// </summary>
public static class TimelineJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };
}
