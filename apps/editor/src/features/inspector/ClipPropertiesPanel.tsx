/**
 * ClipPropertiesPanel — the Inspector's selected-clip editor.
 *
 * Shape of the thing: this component paints, `clipInspectorModel` derives and
 * `state/timelineOps` mutates. No clamping, no unit math and no invariant
 * knowledge lives here — a slider and a typed number must land on exactly the
 * same document value, so both go through the same op.
 *
 * Undo shape (docs/backlog + M2 history contract):
 * - drag a slider / scrub a label -> ONE entry (liveEdit transaction),
 * - type a number and blur/Enter   -> ONE entry (plain op),
 * - and either way autosave is transaction-aware, so a drag is a single PUT.
 *
 * Units are the document's, not the screen's (docs/rendering-semantics.md):
 * §8.1 volume is linear gain 0..2 (the dB text is a label), §8.2 fades are
 * linear ramps in microseconds, §2 transform is normalized around the
 * composition center with scale=1 meaning "fit".
 */
import { useEffect, useMemo, useState } from 'react';
import { MAX_LAYER_DIMENSION } from '@videoedit/timeline-schema';
import { useDocStore } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { useAssetStore } from '../../state/assetStore';
import { useProjectSession } from '../../state/projectSession';
import {
  COLOR_ADJUST_MAX,
  COLOR_ADJUST_MIN,
  POSITION_LIMIT,
  POSITION_DECIMALS,
  ROTATION_DECIMALS,
  ROTATION_LIMIT,
  SCALE_DECIMALS,
  SCALE_MIN,
  SHAPE_RADIUS_MAX,
  SHAPE_STROKE_WIDTH_MAX,
  SPEED_DECIMALS,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_PRESETS,
  TEXT_BACKGROUND_PADDING_MAX,
  TEXT_LINE_HEIGHT_MAX,
  TEXT_LINE_HEIGHT_MIN,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  TEXT_STROKE_WIDTH_MAX,
  VOLUME_MAX,
  VOLUME_MIN,
  applyClipAudioToDraft,
  applyClipColorAdjustToDraft,
  applyClipOpacityToDraft,
  applyClipShapeToDraft,
  applyClipTextToDraft,
  applyClipTransformToDraft,
  maxClipScale,
  resetClipColorAdjust,
  resetClipTransform,
  rotationBlockReason,
  transitionChainSiblings,
  setClipAudio,
  setClipColorAdjust,
  setClipColorAdjustEnabled,
  setClipOpacity,
  setClipShape,
  setClipSpeed,
  setClipText,
  setClipTransform,
  type ClipAudioPatch,
  type ClipShapePatch,
  type ClipTextPatch,
  type ClipTransformPatch,
  type ColorAdjustPatch,
  type OpResult,
} from '../../state/timelineOps';
import { inspectorFailureMessage, inspectorNoticeMessage } from './inspectorFeedback';
import { useKeyframeInspector } from '../keyframes/useKeyframeInspector';
import { weightsFor } from '../text/fontManifest';
import { useFontCatalogue } from '../text/fontCatalogue';
import { measureTextLayout } from '../text/overlayRaster';
import {
  buildClipInspectorModel,
  formatDb,
  formatGain,
  formatNumber,
  formatSeconds,
  formatSpeed,
  MIXED_LABEL,
  type ColorSection,
  type ShapeSection,
  type SpeedSection,
  type TextBoxMeasurer,
  type TextSection,
} from './clipInspectorModel';
import { isBurstEditOpen, isLiveEditOpen, updateBurstEdit, updateLiveEdit } from './liveEdit';
import {
  ColorField,
  NumberField,
  PropertySection,
  ReadonlyRow,
  SegmentedField,
  SelectField,
  SliderField,
  TextAreaField,
  ToggleField,
} from './PropertyFields';

const US = 1_000_000;

/** Stable empty list: a fresh `[]` would re-run the guard memos every render. */
const EMPTY_IDS: readonly string[] = [];

/**
 * The panel's text measurer (see `TextBoxMeasurer`). Module scope, not a hook:
 * it must be a STABLE reference or the model memo would rebuild every render.
 * Returns null without a DOM — the model then falls back to the same
 * font-independent bound the export compiler uses.
 */
const measuredTextBox: TextBoxMeasurer = (clip) => {
  const layout = measureTextLayout(clip.text);
  return { widthPx: layout.bboxWidthPx, heightPx: layout.bboxHeightPx };
};

/** An op result the user has to see, tagged with the section that caused it. */
interface OpMessage {
  source: 'speed' | 'color' | 'visual';
  text: string;
  kind: 'error' | 'notice';
}

/**
 * The refusal/repair line. Rendered INSIDE the section that produced it (see
 * ClipPropertiesPanel) with `role="status"` so a screen reader announces it
 * without stealing focus.
 */
function OpMessageLine({ message }: { message: OpMessage }) {
  return (
    <p
      role="status"
      data-testid="clip-inspector-message"
      data-kind={message.kind}
      data-source={message.source}
      className={`text-[11px] leading-snug ${
        message.kind === 'error' ? 'text-red-400' : 'text-amber-400'
      }`}
    >
      {message.text}
    </p>
  );
}

export function ClipPropertiesPanel() {
  const doc = useDocStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const assets = useAssetStore((s) => s.assets);
  const sessionReady = useProjectSession((s) => s.status) === 'ready';

  const model = useMemo(
    // The measurer is the browser's own Canvas2D shaping through the SHARED
    // layout rule (features/text/textLayout), i.e. the same box the export's
    // SkiaSharp produces. It is what turns the scale / font-size ceilings from
    // "safe guess" into "the number the server will actually accept".
    () => buildClipInspectorModel(doc, selection, assets, measuredTextBox),
    [doc, selection, assets],
  );

  /**
   * Keyframe layer (features/keyframes). It answers three things per field:
   * what to render next to it, which number to show (an ANIMATED channel shows
   * the sample at the playhead, not the static base the compositor ignores) and
   * whether an edit belongs to a keyframe instead of the base value.
   */
  const kf = useKeyframeInspector(sessionReady);

  /**
   * Inline op feedback for the sections that can REFUSE (speed) or repair
   * something the user did not ask for (transition shortened, keyframes
   * merged). The timeline has a bubble for this; the panel needs its own,
   * because a click on "0.5x" that does nothing reads as a broken button.
   *
   * The message carries its SOURCE and is rendered inside that section: the
   * panel scrolls, and a refusal printed 400 px above the button the user just
   * pressed is the same silence it was meant to break.
   */
  const [opMessage, setOpMessage] = useState<OpMessage | null>(null);
  // Any selection change invalidates the message (it described other clips).
  useEffect(() => setOpMessage(null), [selection]);
  const reportFrom =
    (source: OpMessage['source']) =>
    (result: OpResult): OpResult => {
      if (!result.ok) {
        setOpMessage({ source, text: inspectorFailureMessage(result.reason), kind: 'error' });
      } else {
        const notice = inspectorNoticeMessage(result.notice);
        setOpMessage(notice === null ? null : { source, text: notice, kind: 'notice' });
      }
      return result;
    };
  const reportSpeed = reportFrom('speed');
  const reportColor = reportFrom('color');
  const reportVisual = reportFrom('visual');

  /**
   * Görüntü bölümünün iki ÖN bilgisi (tıklamadan önce söylenir, sonra değil):
   *  - dönme, ölçek animasyonlu klipte yazılamaz (dışa aktarıcı katmanı kırpardı)
   *    -> alan KİLİTLENİR, gerekçe altında yazar;
   *  - geçişli klipte yerleşim EŞİT olmak zorundadır -> op zincirin tamamına
   *    yazar ve panel bunu önceden ilan eder ("komşu klip de değişecek").
   */
  const visualClipIds = model.visual?.clipIds ?? EMPTY_IDS;
  const rotationBlocked = useMemo(
    () => rotationBlockReason(doc, visualClipIds),
    [doc, visualClipIds],
  );
  const transitionChained = useMemo(
    () => visualClipIds.some((id) => transitionChainSiblings(doc, id).length > 0),
    [doc, visualClipIds],
  );

  /**
   * Scale ceiling is a per-CLIP property, not a constant: the export compiler
   * caps a rendered layer at 8192 px. For media/shape/sticker that is the
   * canvas (1080p tops out around 4.266, 4K around 2.133); for TEXT it is the
   * clip's OWN measured box (§7 draws it at `bbox * scale`), which is why the
   * model — not this component — derives it. `visual.maxScale` is the strictest
   * of the selected clips, i.e. exactly what the op will clamp to.
   */
  const scaleMax = model.visual?.maxScale ?? maxClipScale(doc.settings);

  if (model.count === 0) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-sm text-fg-muted"
        data-testid="clip-inspector-empty"
      >
        Klip seçili değil — özelliklerini görmek için zaman çizelgesinde bir klibe tıklayın.
      </div>
    );
  }

  const editable = model.editable && sessionReady;
  const { audio, visual, identity, text, shape, speed, color } = model;

  // Animated channels show the SAMPLE at the playhead (see useKeyframeInspector).
  const opacityShown = visual === null ? null : kf.display('opacity', visual.opacity);
  const volumeShown = audio === null ? null : kf.display('volume', audio.volume);

  /**
   * Routes a value to the document: inside a pointer gesture it coalesces into
   * the open transaction, otherwise it is a standalone op (one history entry).
   */
  const writeAudio = (patch: ClipAudioPatch): void => {
    if (audio === null || !editable) return;
    // An ANIMATED volume must not have its base written: sampleKeyframes wins,
    // so the slider would move and the sound would not change.
    if (
      patch.volume !== undefined &&
      Object.keys(patch).length === 1 &&
      kf.writeChannel('volume', patch.volume)
    ) {
      return;
    }
    if (isLiveEditOpen()) updateLiveEdit((d) => void applyClipAudioToDraft(d, audio.clipIds, patch));
    else setClipAudio(audio.clipIds, patch);
  };
  const writeTransform = (patch: ClipTransformPatch): void => {
    if (visual === null || !editable) return;
    // Split per channel: animated -> keyframe at the playhead, static -> base
    // value exactly as before (a clip nobody animated behaves identically).
    const rest: ClipTransformPatch = {};
    let restKeys = 0;
    for (const channel of ['x', 'y', 'scale', 'rotationDeg'] as const) {
      const value = patch[channel];
      if (value === undefined) continue;
      if (kf.writeChannel(channel, value)) continue;
      rest[channel] = value;
      restKeys++;
    }
    if (restKeys === 0) return;
    if (isLiveEditOpen()) {
      updateLiveEdit((d) => void applyClipTransformToDraft(d, visual.clipIds, rest));
    } else {
      // Yerleşim yazımı artık SESSİZ değil: geçiş zincirine yayıldığında
      // (bkz. timelineOps.propagateTransformToChain) bildirim döner ve bölümün
      // kendi satırında görünür.
      reportVisual(setClipTransform(visual.clipIds, rest));
    }
  };
  const writeOpacity = (opacity: number): void => {
    if (visual === null || !editable) return;
    if (kf.writeChannel('opacity', opacity)) return;
    if (isLiveEditOpen()) updateLiveEdit((d) => void applyClipOpacityToDraft(d, visual.clipIds, opacity));
    else setClipOpacity(visual.clipIds, opacity);
  };
  /**
   * Three routes, one op — a typing/colour BURST (many keystrokes, one entry),
   * a pointer gesture (slider/scrub), or a discrete op. The order matters: a
   * burst and a gesture can never be open at once (liveEdit closes one to open
   * the other), but the burst is checked first because it is the one a
   * keystroke belongs to.
   */
  const writeText = (patch: ClipTextPatch): void => {
    if (text === null || !editable) return;
    if (isBurstEditOpen()) updateBurstEdit((d) => void applyClipTextToDraft(d, text.clipIds, patch));
    else if (isLiveEditOpen()) updateLiveEdit((d) => void applyClipTextToDraft(d, text.clipIds, patch));
    else setClipText(text.clipIds, patch);
  };
  /**
   * colorAdjust: the six §4.1 sliders. Same three routes as everything else,
   * except the value is a plain number the OP clamps — the panel never does
   * colour math (the shader, the reference and ffmpeg must all see the same
   * number).
   */
  const writeColor = (patch: ColorAdjustPatch): void => {
    if (color === null || !editable) return;
    if (isLiveEditOpen()) {
      updateLiveEdit((d) => void applyClipColorAdjustToDraft(d, color.clipIds, patch));
    } else {
      reportColor(setClipColorAdjust(color.clipIds, patch));
    }
  };
  const writeShape = (patch: ClipShapePatch): void => {
    if (shape === null || !editable) return;
    if (isBurstEditOpen()) updateBurstEdit((d) => void applyClipShapeToDraft(d, shape.clipIds, patch));
    else if (isLiveEditOpen()) {
      updateLiveEdit((d) => void applyClipShapeToDraft(d, shape.clipIds, patch));
    } else {
      setClipShape(shape.clipIds, patch);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="clip-inspector">
      <PropertySection title="Klip" testId="clip-inspector-identity">
        {identity !== null ? (
          <>
            <p className="truncate text-xs font-semibold text-fg" title={identity.name}>
              {identity.name}
            </p>
            <ReadonlyRow label="Tür" value={`${identity.kindLabel} · ${identity.trackLabel}`} />
            {identity.sourceRange !== null && (
              <ReadonlyRow label="Kaynak" value={identity.sourceRange} />
            )}
            <ReadonlyRow label="Başlangıç" value={identity.startTc} />
            <ReadonlyRow label="Bitiş" value={identity.endTc} />
            <ReadonlyRow label="Süre" value={identity.durationTc} />
          </>
        ) : (
          <>
            <p className="text-xs font-semibold text-fg">{model.count} klip seçili</p>
            <p className="text-[11px] text-fg-muted">
              Ortak alanlar düzenlenebilir; farklı değerler {MIXED_LABEL} gösterir ve
              değiştirdiğinizde tüm seçime uygulanır.
            </p>
          </>
        )}
        {!model.editable && (
          <p className="text-[11px] text-accent">Seçim kilitli bir track üzerinde — salt okunur.</p>
        )}
      </PropertySection>

      {audio !== null && (
        <PropertySection title="Ses" testId="clip-inspector-audio">
          <SliderField
            id="clip-volume"
            testId="clip-volume"
            label="Seviye"
            value={volumeShown}
            neutral={1}
            min={VOLUME_MIN}
            max={VOLUME_MAX}
            step={0.01}
            valueText={formatGain(volumeShown)}
            hint={formatDb(volumeShown)}
            disabled={!editable}
            gesture={{ actionType: 'clipAudio', label: 'Ses seviyesi değiştirildi' }}
            onChange={(v) => writeAudio({ volume: v })}
            adornment={kf.adornment('volume')}
          />
          <SliderField
            id="clip-fade-in"
            testId="clip-fade-in"
            label="Fade in"
            value={audio.fadeInUs}
            neutral={0}
            min={0}
            max={Math.max(0.01, audio.maxFadeUs / US)}
            step={0.01}
            valueText={formatSeconds(audio.fadeInUs)}
            disabled={!editable}
            gesture={{ actionType: 'clipAudio', label: 'Ses açılması (fade in) değiştirildi' }}
            onChange={(sec) => writeAudio({ fadeInUs: Math.round(sec * US) })}
          />
          <SliderField
            id="clip-fade-out"
            testId="clip-fade-out"
            label="Fade out"
            value={audio.fadeOutUs}
            neutral={0}
            min={0}
            max={Math.max(0.01, audio.maxFadeUs / US)}
            step={0.01}
            valueText={formatSeconds(audio.fadeOutUs)}
            disabled={!editable}
            gesture={{ actionType: 'clipAudio', label: 'Ses kapanması (fade out) değiştirildi' }}
            onChange={(sec) => writeAudio({ fadeOutUs: Math.round(sec * US) })}
          />
          <ToggleField
            label="Sessize al"
            testId="clip-muted"
            value={audio.muted}
            disabled={!editable}
            onChange={(v) => writeAudio({ muted: v })}
          />
        </PropertySection>
      )}

      {text !== null && (
        <TextPropertiesSection section={text} editable={editable} write={writeText} />
      )}

      {shape !== null && (
        <ShapePropertiesSection section={shape} editable={editable} write={writeShape} />
      )}

      {visual !== null && (
        <PropertySection
          title="Görüntü"
          testId="clip-inspector-visual"
          action={
            <button
              type="button"
              data-testid="clip-transform-reset"
              disabled={!editable}
              onClick={() => resetClipTransform(visual.clipIds)}
              className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted hover:text-fg disabled:pointer-events-none disabled:opacity-40"
            >
              Sıfırla
            </button>
          }
        >
          <NumberField
            id="clip-x"
            testId="clip-x"
            label="Konum X"
            value={kf.display('x', visual.x)}
            min={-POSITION_LIMIT}
            max={POSITION_LIMIT}
            step={0.01}
            decimals={POSITION_DECIMALS}
            perPixel={0.002}
            disabled={!editable}
            gesture={{ actionType: 'clipTransform', label: 'Konum değiştirildi' }}
            onChange={(v) => writeTransform({ x: v })}
            adornment={kf.adornment('x')}
          />
          <NumberField
            id="clip-y"
            testId="clip-y"
            label="Konum Y"
            value={kf.display('y', visual.y)}
            min={-POSITION_LIMIT}
            max={POSITION_LIMIT}
            step={0.01}
            decimals={POSITION_DECIMALS}
            perPixel={0.002}
            disabled={!editable}
            gesture={{ actionType: 'clipTransform', label: 'Konum değiştirildi' }}
            onChange={(v) => writeTransform({ y: v })}
            adornment={kf.adornment('y')}
          />
          <NumberField
            id="clip-scale"
            testId="clip-scale"
            label="Ölçek"
            value={kf.display('scale', visual.scale)}
            min={SCALE_MIN}
            max={scaleMax}
            step={0.01}
            decimals={SCALE_DECIMALS}
            perPixel={0.005}
            disabled={!editable}
            gesture={{ actionType: 'clipTransform', label: 'Ölçek değiştirildi' }}
            onChange={(v) => writeTransform({ scale: v })}
            adornment={kf.adornment('scale')}
          />
          <NumberField
            id="clip-rotation"
            testId="clip-rotation"
            label="Döndürme"
            value={kf.display('rotationDeg', visual.rotationDeg)}
            min={-ROTATION_LIMIT}
            max={ROTATION_LIMIT}
            step={1}
            decimals={ROTATION_DECIMALS}
            perPixel={0.5}
            unit="°"
            disabled={!editable || rotationBlocked !== null}
            gesture={{ actionType: 'clipTransform', label: 'Döndürme değiştirildi' }}
            onChange={(v) => writeTransform({ rotationDeg: v })}
            adornment={kf.adornment('rotationDeg')}
          />
          {rotationBlocked !== null && (
            <p
              className="text-[10px] leading-snug text-amber-400"
              data-testid="clip-rotation-block"
              data-reason={rotationBlocked}
            >
              {inspectorFailureMessage(rotationBlocked)}
            </p>
          )}
          <SliderField
            id="clip-opacity"
            testId="clip-opacity"
            label="Opaklık"
            value={opacityShown}
            neutral={1}
            min={0}
            max={1}
            step={0.01}
            valueText={
              opacityShown === null ? MIXED_LABEL : `${Math.round(opacityShown * 100)}%`
            }
            disabled={!editable}
            gesture={{ actionType: 'clipOpacity', label: 'Opaklık değiştirildi' }}
            onChange={(v) => writeOpacity(v)}
            adornment={kf.adornment('opacity')}
          />
          {transitionChained && (
            <p
              className="text-[10px] leading-snug text-amber-400"
              data-testid="clip-transform-chain-note"
            >
              Bu klipte geçiş var: geçişli kliplerin yerleşimi AYNI olmak zorunda, bu yüzden
              konum/ölçek/döndürme değişikliği geçişin diğer klibine de uygulanır.
            </p>
          )}
          {opMessage !== null && opMessage.source === 'visual' && (
            <OpMessageLine message={opMessage} />
          )}
          {kf.summary !== null && (
            <p
              className="text-[10px] leading-snug text-accent"
              data-testid="clip-kf-summary"
              data-channels={kf.model.animated.join(',')}
            >
              Animasyonlu: {kf.summary}. Gösterilen değerler playhead anındaki örneklerdir;
              alanı değiştirmek o andaki keyframe'i yazar (yoksa ekler).
            </p>
          )}
          <p
            className="text-[10px] leading-snug text-fg-muted"
            data-testid="clip-scale-limit-note"
            data-max={scaleMax}
            data-from-text-box={visual?.maxScaleFromTextBox === true ? 'true' : 'false'}
          >
            Konum kompozisyon merkezine göre normalize (0 = ortada, 0.5 = yarım kompozisyon
            kadar sağ/aşağı); Ölçek 1 = sığdır. Ölçek en fazla{' '}
            {formatNumber(scaleMax, SCALE_DECIMALS)} olabilir — çıktıda katman{' '}
            {MAX_LAYER_DIMENSION} pikseli aşamaz.{' '}
            {visual?.maxScaleFromTextBox === true
              ? 'Metin katmanı kareye SIĞDIRILMAZ, kendi kutusu kadar çizilir (yazı boyutu × ölçek): tavanı bu yüzden metnin ölçülen kutusu belirliyor, proje çözünürlüğü değil.'
              : `Bu tavan proje çözünürlüğünden gelir (${doc.settings.width}×${doc.settings.height}).`}
          </p>
        </PropertySection>
      )}

      {/*
        Sıra bilinçli: kimlik -> ses -> biçim -> geometri -> HIZ -> RENK.
        Hız ve renk en sonda çünkü ikisi de UZUN bölümler (5 ön ayar + 6 slider)
        ve panel kaydırmalı: yukarı konsalardı her klip için en çok kullanılan
        Görüntü alanlarını ekranın dışına iterlerdi (ölçüldü: +638 px).
      */}
      {speed !== null && (
        <SpeedPropertiesSection
          section={speed}
          editable={editable}
          report={reportSpeed}
          message={opMessage?.source === 'speed' ? opMessage : null}
        />
      )}

      {color !== null && (
        <ColorPropertiesSection
          section={color}
          editable={editable}
          write={writeColor}
          report={reportColor}
          message={opMessage?.source === 'color' ? opMessage : null}
        />
      )}

      {/*
        Kapsam dürüstlüğü (review-gate kural 4): panelin kapsamadığı klip
        alanları burada AÇIKÇA yazılır. Sessizce eksik bırakmak, kullanıcının
        "neden yok?" diye aramasına ve denetimde kapsam kayması bulgusuna yol
        açıyor. Hedef milestone'lar docs/backlog.md kapsam tablosundan gelir.
      */}
      <PropertySection title="Kapsam" testId="clip-inspector-scope">
        <p className="text-[10px] leading-snug text-fg-muted">
          Bu panel klibin hızını, rengini, sesini, dönüşümünü ve metin/şekil biçimini düzenler.
          Keyframe animasyonu artık burada: alanların yanındaki elmas düğmesi playhead'e keyframe
          yazar, eğri timeline'daki keyframe şeridinden düzenlenir. Henüz burada olmayanlar: çapa
          (anchor) noktası — merkezde sabit; LUT (.cube) efekti — MVP KAPSAMI DIŞINDA: dosya
          yükleme yolu, efekt seçimi ve önizleme shader'ı yoktur (dışa aktarma motorunda
          karşılığı hazırdır, editör yüzeyi yazılmadı — bkz. docs/poc-bilinen-sinirlar.md §1.3).
          Efekt parametreleri (fx.*) MVP
          şemasında keyframe'lenemez (bilinçli karar). Hız ve renk düzeltme önizlemede ve dışa
          aktarımda AYNI normatif formüllerle uygulanır (süre = kaynak ÷ hız; renk sırası
          pozlama → sıcaklık → ton → kontrast+parlaklık → doygunluk); dışa aktarım tarafını M5’in
          sunucu dilimi karşılar — sunucu bir özelliği desteklemiyorsa gerekçe “Dışa Aktarmalar”
          kartında görünür, sessizce düşmez.
        </p>
      </PropertySection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Speed section (M5) — rendering-semantics §1.3
// ---------------------------------------------------------------------------

/**
 * Speed is a LAYOUT edit, so this section is deliberately not a slider: every
 * value is one discrete, refusable op with its own history entry. Dragging
 * would mean re-laying out the track (and reconciling transitions) per pixel.
 *
 * "Sonrakileri kaydır" (ripple) is a sticky choice rather than a second set of
 * buttons: the user decides ONCE whether slowing a clip pushes the rest of the
 * timeline, and every preset then obeys it.
 */
function SpeedPropertiesSection({
  section,
  editable,
  report,
  message,
}: {
  section: SpeedSection;
  editable: boolean;
  report: (result: OpResult) => OpResult;
  message: OpMessage | null;
}) {
  const [ripple, setRipple] = useState(false);
  const apply = (rate: number): void => {
    if (!editable) return;
    report(setClipSpeed(section.clipIds, rate, { ripple }));
  };

  // What the panel can promise without rippling: a clip may only grow into the
  // gap after it. Shown so a refusal is never the first time the user hears it.
  const bound = section.minRateWithoutRipple;
  const limited = !ripple && bound !== null && bound > SPEED_MIN;

  return (
    <PropertySection
      title="Hız"
      testId="clip-inspector-speed"
      action={
        <span className="font-mono text-[11px] text-fg" data-testid="clip-speed-value">
          {formatSpeed(section.rate)}
        </span>
      }
    >
      <div className="flex gap-1" role="group" aria-label="Hız ön ayarları" data-testid="clip-speed-presets">
        {SPEED_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            data-testid={`clip-speed-preset-${preset}`}
            aria-pressed={section.rate === preset}
            disabled={!editable}
            onClick={() => apply(preset)}
            className={`min-w-0 flex-1 rounded border px-1 py-1 text-[11px] disabled:pointer-events-none disabled:opacity-40 ${
              section.rate === preset
                ? 'border-accent/60 bg-accent/10 text-fg'
                : 'border-edge bg-surface-2 text-fg-muted hover:text-fg'
            }`}
          >
            {formatSpeed(preset)}
          </button>
        ))}
      </div>

      <NumberField
        id="clip-speed"
        testId="clip-speed"
        label="Hız"
        value={section.rate}
        min={SPEED_MIN}
        max={SPEED_MAX}
        step={0.05}
        decimals={SPEED_DECIMALS}
        perPixel={0}
        // Typing only: a speed drag would re-lay out the track (and reconcile
        // transitions) per pixel, and the write cannot live inside a liveEdit
        // transaction because it goes through a refusable plain op.
        scrubbable={false}
        unit="x"
        disabled={!editable}
        gesture={{ actionType: 'clipSpeed', label: 'Klip hızı değiştirildi' }}
        onChange={(rate) => apply(rate)}
      />

      <ToggleField
        label="Sonrakileri kaydır"
        testId="clip-speed-ripple"
        value={ripple}
        disabled={!editable}
        onChange={setRipple}
      />

      <ReadonlyRow label="Süre" value={formatSeconds(section.durationUs, 2)} />
      {section.nextGapUs !== null && (
        <ReadonlyRow label="Boşluk" value={formatSeconds(section.nextGapUs, 2)} />
      )}

      {message !== null && <OpMessageLine message={message} />}

      <p className="text-[10px] leading-snug text-fg-muted" data-testid="clip-speed-note">
        Süre = (kaynak çıkış − kaynak giriş) ÷ hız; kaynak aralığı değişmez. Ses tonu korunur
        (önizlemede tarayıcı, dışa aktarımda <code>atempo</code>).
        {limited && (
          <>
            {' '}
            Sonraki klibe kadar boşluk sınırlı: kaydırmadan en yavaş{' '}
            <strong data-testid="clip-speed-min-rate">{formatSpeed(bound)}</strong> olabilir.
          </>
        )}
        {section.hasTransition && (
          <> Kenarda geçiş var: hız arttıkça geçişin kaynak payı da artar, gerekirse kısaltılır.</>
        )}
      </p>
    </PropertySection>
  );
}

// ---------------------------------------------------------------------------
// Colour correction section (M5) — rendering-semantics §4.1
// ---------------------------------------------------------------------------

/** The six §4.1 params, in the order a colourist reaches for them. */
const COLOR_FIELDS = [
  { key: 'exposure' as const, label: 'Pozlama', testId: 'clip-color-exposure' },
  { key: 'brightness' as const, label: 'Parlaklık', testId: 'clip-color-brightness' },
  { key: 'contrast' as const, label: 'Kontrast', testId: 'clip-color-contrast' },
  { key: 'saturation' as const, label: 'Doygunluk', testId: 'clip-color-saturation' },
  { key: 'temperature' as const, label: 'Sıcaklık', testId: 'clip-color-temperature' },
  { key: 'tint' as const, label: 'Ton', testId: 'clip-color-tint' },
];

function ColorPropertiesSection({
  section,
  editable,
  write,
  report,
  message,
}: {
  section: ColorSection;
  editable: boolean;
  write: (patch: ColorAdjustPatch) => void;
  report: (result: OpResult) => OpResult;
  message: OpMessage | null;
}) {
  return (
    <PropertySection
      title="Renk"
      testId="clip-inspector-color"
      action={
        <button
          type="button"
          data-testid="clip-color-reset"
          disabled={!editable || !section.present}
          onClick={() => report(resetClipColorAdjust(section.clipIds))}
          className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted hover:text-fg disabled:pointer-events-none disabled:opacity-40"
        >
          Sıfırla
        </button>
      }
    >
      <ToggleField
        label="Renk düzeltme"
        testId="clip-color-enabled"
        value={section.enabled}
        disabled={!editable}
        onChange={(enabled) => report(setClipColorAdjustEnabled(section.clipIds, enabled))}
      />
      {COLOR_FIELDS.map((field) => (
        <SliderField
          key={field.key}
          id={field.testId}
          testId={field.testId}
          label={field.label}
          value={section[field.key]}
          neutral={0}
          min={COLOR_ADJUST_MIN}
          max={COLOR_ADJUST_MAX}
          step={0.01}
          valueText={formatNumber(section[field.key], 2)}
          disabled={!editable}
          gesture={{ actionType: 'clipColor', label: `${field.label} değiştirildi` }}
          onChange={(v) => write({ [field.key]: v })}
        />
      ))}
      {message !== null && <OpMessageLine message={message} />}
      <p className="text-[10px] leading-snug text-fg-muted" data-testid="clip-color-note">
        Değerler −1..1 (0 = etkisiz) ve sıra sabittir: pozlama → sıcaklık → ton →
        kontrast+parlaklık → doygunluk. Önizleme bunu tek geçişli shader ile, dışa aktarım aynı
        formüllerle ffmpeg tarafında uygular; ±1/255 kanal farkı beklenir.
      </p>
    </PropertySection>
  );
}

// ---------------------------------------------------------------------------
// Text / shape style sections (M4 wave 2)
// ---------------------------------------------------------------------------

const ALIGN_OPTIONS = [
  { value: 'left' as const, label: 'Sol' },
  { value: 'center' as const, label: 'Orta' },
  { value: 'right' as const, label: 'Sağ' },
];

function TextPropertiesSection({
  section,
  editable,
  write,
}: {
  section: TextSection;
  editable: boolean;
  write: (patch: ClipTextPatch) => void;
}) {
  // The picker lists what the SERVER can resolve (GET /api/fonts). It used to
  // list a hard-coded set whose default ('inter') did not exist server-side, so
  // every text clip exported with `font-missing` (M4 dalga-2, KRİTİK bulgu #1).
  const { entries: fonts, failed: fontsUnavailable } = useFontCatalogue();
  const weightOptions = weightsFor(section.fontId ?? '').map((w) => ({
    value: String(w),
    label: w >= 700 ? `${w} (Kalın)` : `${w}`,
  }));

  return (
    <PropertySection title="Metin" testId="clip-inspector-text">
      <TextAreaField
        id="clip-text-content"
        testId="clip-text-content"
        label="İçerik"
        value={section.content}
        rows={3}
        placeholder="Metin yazın (Enter yeni satır)"
        disabled={!editable}
        burst={{ actionType: 'clipText', label: 'Metin içeriği değiştirildi' }}
        onChange={(content) => write({ content })}
      />
      <SelectField
        id="clip-text-font"
        testId="clip-text-font"
        label="Yazı tipi"
        value={section.fontId}
        options={fonts
          .filter((f) => !f.deprecated || f.id === section.fontId)
          .map((f) => ({ value: f.id, label: f.label }))}
        disabled={!editable}
        onChange={(fontId) => write({ fontId })}
      />
      <NumberField
        id="clip-text-size"
        testId="clip-text-size"
        label="Boyut"
        value={section.fontSizePx}
        min={TEXT_SIZE_MIN}
        // TÜRETİLMİŞ tavan (sabit TEXT_SIZE_MAX değil): punto, satır sayısı,
        // arka plan payı ve klibin ölçeği AYNI 8192 px'lik katman bütçesini
        // harcar. Sabit tavan, sunucunun reddedeceği bir belge yazdırıyordu.
        max={section.maxFontSizePx}
        step={1}
        decimals={0}
        perPixel={1}
        unit="px"
        disabled={!editable}
        gesture={{ actionType: 'clipText', label: 'Metin boyutu değiştirildi' }}
        onChange={(fontSizePx) => write({ fontSizePx })}
      />
      {section.maxFontSizePx < TEXT_SIZE_MAX && (
        <p
          className="text-[10px] leading-snug text-fg-muted"
          data-testid="clip-text-size-limit-note"
          data-max={section.maxFontSizePx}
        >
          Bu metin için boyut en fazla {formatNumber(section.maxFontSizePx, 0)} px olabilir:
          dışa aktarımda tek katman {MAX_LAYER_DIMENSION} pikseli aşamaz ve bu sınırı punto,
          satır sayısı, arka plan payı ve klibin ölçeği birlikte belirler. Daha büyük yazı
          için ölçeği, satır sayısını ya da arka plan payını küçültün.
        </p>
      )}
      <SelectField
        id="clip-text-weight"
        testId="clip-text-weight"
        label="Kalınlık"
        value={section.fontWeight === null ? null : String(section.fontWeight)}
        options={weightOptions}
        disabled={!editable}
        onChange={(v) => write({ fontWeight: Number(v) })}
      />
      <ToggleField
        label="İtalik"
        testId="clip-text-italic"
        value={section.italic}
        disabled={!editable}
        onChange={(italic) => write({ italic })}
      />
      <ColorField
        id="clip-text-fill"
        testId="clip-text-fill"
        label="Renk"
        value={section.fill}
        disabled={!editable}
        burst={{ actionType: 'clipText', label: 'Metin rengi değiştirildi' }}
        onChange={(fill) => write({ fill })}
      />
      <SegmentedField
        label="Hizalama"
        testId="clip-text-align"
        value={section.align as 'left' | 'center' | 'right' | null}
        options={ALIGN_OPTIONS}
        disabled={!editable}
        onChange={(align) => write({ align })}
      />
      <NumberField
        id="clip-text-line-height"
        testId="clip-text-line-height"
        label="Satır y."
        value={section.lineHeight}
        min={TEXT_LINE_HEIGHT_MIN}
        max={TEXT_LINE_HEIGHT_MAX}
        step={0.05}
        decimals={2}
        perPixel={0.01}
        disabled={!editable}
        gesture={{ actionType: 'clipText', label: 'Satır yüksekliği değiştirildi' }}
        onChange={(lineHeight) => write({ lineHeight })}
      />

      <ToggleField
        label="Kontur"
        testId="clip-text-stroke"
        value={section.strokeEnabled}
        disabled={!editable}
        onChange={(strokeEnabled) => write({ strokeEnabled })}
      />
      {section.strokeEnabled !== false && (
        <>
          <ColorField
            id="clip-text-stroke-color"
            testId="clip-text-stroke-color"
            label="Kontur r."
            value={section.strokeColor}
            disabled={!editable}
            burst={{ actionType: 'clipText', label: 'Kontur rengi değiştirildi' }}
            onChange={(strokeColor) => write({ strokeColor })}
          />
          <NumberField
            id="clip-text-stroke-width"
            testId="clip-text-stroke-width"
            label="Kalınlık"
            value={section.strokeWidthPx}
            min={0}
            max={TEXT_STROKE_WIDTH_MAX}
            step={1}
            decimals={0}
            perPixel={0.5}
            unit="px"
            disabled={!editable}
            gesture={{ actionType: 'clipText', label: 'Kontur kalınlığı değiştirildi' }}
            onChange={(strokeWidthPx) => write({ strokeWidthPx })}
          />
        </>
      )}

      <ToggleField
        label="Arka plan"
        testId="clip-text-background"
        value={section.backgroundEnabled}
        disabled={!editable}
        onChange={(backgroundEnabled) => write({ backgroundEnabled })}
      />
      {section.backgroundEnabled === true && (
        <>
          <ColorField
            id="clip-text-bg-color"
            testId="clip-text-bg-color"
            label="Arka r."
            value={section.backgroundColor}
            disabled={!editable}
            burst={{ actionType: 'clipText', label: 'Arka plan rengi değiştirildi' }}
            onChange={(backgroundColor) => write({ backgroundColor })}
          />
          <NumberField
            id="clip-text-bg-padding"
            testId="clip-text-bg-padding"
            label="Boşluk"
            value={section.backgroundPaddingPx}
            min={0}
            max={TEXT_BACKGROUND_PADDING_MAX}
            step={1}
            decimals={0}
            perPixel={0.5}
            unit="px"
            disabled={!editable}
            gesture={{ actionType: 'clipText', label: 'Arka plan boşluğu değiştirildi' }}
            onChange={(backgroundPaddingPx) => write({ backgroundPaddingPx })}
          />
          <NumberField
            id="clip-text-bg-radius"
            testId="clip-text-bg-radius"
            label="Köşe"
            value={section.backgroundRadiusPx}
            min={0}
            max={TEXT_BACKGROUND_PADDING_MAX}
            step={1}
            decimals={0}
            perPixel={0.5}
            unit="px"
            disabled={!editable}
            gesture={{ actionType: 'clipText', label: 'Arka plan köşesi değiştirildi' }}
            onChange={(backgroundRadiusPx) => write({ backgroundRadiusPx })}
          />
        </>
      )}

      {/*
        Dürüstlük notu (rendering-semantics §7; M4 dalga-2 denetimi bulgu #3c).
        ESKİ not "küçük farklar olabilir" diyordu ve YANLIŞTI: kutu kuralları iki
        tarafta farklıydı (kontur 6'da 32×24 / 26×14), üstelik önizleme sistem
        fontuyla ölçüyordu. İkisi de düzeltildi — kural tek (test-vectors/
        text-layout-vectors.json), font AYNI TTF (@font-face, /api/fonts) — ama
        SATIR KIRILIMI/shaping hâlâ iki ayrı motorda (Canvas2D vs HarfBuzz)
        koşuyor. Not bu KALAN farkı söylüyor; sunucu ölçüm ucu (POST
        /api/overlays/measure) bağlanana kadar abartmadan, küçültmeden.
      */}
      <p className="text-[10px] leading-snug text-fg-muted" data-testid="clip-text-raster-note">
        Kutu ve arka plan kuralları önizleme ile dışa aktarımda AYNIDIR ve aynı yazı tipi
        dosyası kullanılır. Kalan fark shaping/kerning düzeyindedir: karmaşık yazımlarda
        (bitişik harfler, RTL, emoji) satır genişliği birkaç piksel kayabilir — bağlayıcı
        ölçüm sunucudur (SkiaSharp + HarfBuzz).
      </p>
      {fontsUnavailable && (
        <p className="text-[10px] leading-snug text-accent" data-testid="clip-text-font-offline-note">
          Yazı tipi listesi sunucudan alınamadı; son bilinen liste gösteriliyor. Önizleme
          yerel bir yazı tipiyle çizilebilir — dışa aktarım yine sunucudaki dosyayı kullanır.
        </p>
      )}
    </PropertySection>
  );
}

const SHAPE_TYPE_OPTIONS = [
  { value: 'rect' as const, label: 'Dikdörtgen' },
  { value: 'ellipse' as const, label: 'Elips' },
  { value: 'line' as const, label: 'Çizgi' },
  { value: 'arrow' as const, label: 'Ok' },
];

function ShapePropertiesSection({
  section,
  editable,
  write,
}: {
  section: ShapeSection;
  editable: boolean;
  write: (patch: ClipShapePatch) => void;
}) {
  return (
    <PropertySection title="Şekil" testId="clip-inspector-shape">
      <SelectField
        id="clip-shape-type"
        testId="clip-shape-type"
        label="Tür"
        value={section.type as 'rect' | 'ellipse' | 'line' | 'arrow' | null}
        options={SHAPE_TYPE_OPTIONS}
        disabled={!editable}
        onChange={(type) => write({ type })}
      />
      <ColorField
        id="clip-shape-fill"
        testId="clip-shape-fill"
        label="Dolgu"
        value={section.fill}
        disabled={!editable}
        burst={{ actionType: 'clipShape', label: 'Şekil rengi değiştirildi' }}
        onChange={(fill) => write({ fill })}
      />
      <ToggleField
        label="Kontur"
        testId="clip-shape-stroke"
        value={section.strokeEnabled}
        disabled={!editable}
        onChange={(strokeEnabled) => write({ strokeEnabled })}
      />
      {section.strokeEnabled === true && (
        <>
          <ColorField
            id="clip-shape-stroke-color"
            testId="clip-shape-stroke-color"
            label="Kontur r."
            value={section.strokeColor}
            disabled={!editable}
            burst={{ actionType: 'clipShape', label: 'Kontur rengi değiştirildi' }}
            onChange={(strokeColor) => write({ strokeColor })}
          />
          <NumberField
            id="clip-shape-stroke-width"
            testId="clip-shape-stroke-width"
            label="Kalınlık"
            value={section.strokeWidthPx}
            min={0}
            max={SHAPE_STROKE_WIDTH_MAX}
            step={1}
            decimals={0}
            perPixel={0.5}
            unit="px"
            disabled={!editable}
            gesture={{ actionType: 'clipShape', label: 'Kontur kalınlığı değiştirildi' }}
            onChange={(strokeWidthPx) => write({ strokeWidthPx })}
          />
        </>
      )}
      <NumberField
        id="clip-shape-radius"
        testId="clip-shape-radius"
        label="Köşe"
        value={section.radiusPx}
        min={0}
        max={SHAPE_RADIUS_MAX}
        step={1}
        decimals={0}
        perPixel={0.5}
        unit="px"
        disabled={!editable}
        gesture={{ actionType: 'clipShape', label: 'Köşe yarıçapı değiştirildi' }}
        onChange={(radiusPx) => write({ radiusPx })}
      />
      <p className="text-[10px] leading-snug text-fg-muted" data-testid="clip-shape-scope-note">
        Şeklin doğal kutusu tüm karedir: Ölçek 1 = kareyi kaplayan şekil (yeni şekiller 0.5 ile
        gelir). Ölçek UNIFORM'dur — şemada şekle özel genişlik/yükseklik alanı olmadığı için
        en-boy oranı değiştirilemez; boyut için Görüntü bölümündeki Ölçek alanını kullanın.
        Köşe yarıçapı proje pikselindedir.
      </p>
    </PropertySection>
  );
}
