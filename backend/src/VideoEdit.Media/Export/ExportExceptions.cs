namespace VideoEdit.Media.Export;

/// <summary>
/// FilterGraph Compiler doğrulama hatalarının ortak tabanı. İkisi de KULLANICI-kaynaklı ve
/// DETERMİNİSTİKTİR: API ön-doğrulamada 422'ye map'ler, worker retry'sız Failed işaretler.
/// </summary>
public abstract class ExportCompileException(string message) : Exception(message);

/// <summary>
/// Timeline dokümanı şema olarak geçerli ama M3 export kapsamının DIŞINDA bir özellik
/// kullanıyor (çoklu görsel track, transition, keyframe, effect, text/shape/sticker klip,
/// speed.rate≠1, transform/opacity ...). <see cref="Feature"/> makine-okur kod,
/// Message kullanıcıya gösterilebilir açıklamadır.
/// </summary>
public sealed class UnsupportedFeatureException(string feature, string message)
    : ExportCompileException(message)
{
    /// <summary>Makine-okur özellik kodu (ör. "transition", "keyframes", "multiple-video-tracks").</summary>
    public string Feature { get; } = feature;
}

/// <summary>
/// Timeline dokümanı sözleşme invariant'larını ihlal ediyor (schemaVersion, klip
/// sıralama/bitişiklik, süre formülü, kaynak aralığı...). Editör bu dokümanı üretmemeliydi —
/// sessiz düzeltme YOK, ihlal görünür olmalı (rendering-semantics ek kuralı).
/// </summary>
public sealed class InvalidTimelineException(string message) : ExportCompileException(message);
