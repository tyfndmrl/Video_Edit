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
import { useMemo } from 'react';
import { MAX_LAYER_DIMENSION } from '@videoedit/timeline-schema';
import { useDocStore } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { useAssetStore } from '../../state/assetStore';
import { useProjectSession } from '../../state/projectSession';
import {
  POSITION_LIMIT,
  POSITION_DECIMALS,
  ROTATION_DECIMALS,
  ROTATION_LIMIT,
  SCALE_DECIMALS,
  SCALE_MIN,
  VOLUME_MAX,
  VOLUME_MIN,
  applyClipAudioToDraft,
  applyClipOpacityToDraft,
  applyClipTransformToDraft,
  maxClipScale,
  resetClipTransform,
  setClipAudio,
  setClipOpacity,
  setClipTransform,
  type ClipAudioPatch,
  type ClipTransformPatch,
} from '../../state/timelineOps';
import {
  buildClipInspectorModel,
  formatDb,
  formatGain,
  formatNumber,
  formatSeconds,
  MIXED_LABEL,
} from './clipInspectorModel';
import { isLiveEditOpen, updateLiveEdit } from './liveEdit';
import {
  NumberField,
  PropertySection,
  ReadonlyRow,
  SliderField,
  ToggleField,
} from './PropertyFields';

const US = 1_000_000;

export function ClipPropertiesPanel() {
  const doc = useDocStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const assets = useAssetStore((s) => s.assets);
  const sessionReady = useProjectSession((s) => s.status) === 'ready';

  const model = useMemo(
    () => buildClipInspectorModel(doc, selection, assets),
    [doc, selection, assets],
  );

  /**
   * Scale ceiling is a PROJECT property, not a constant: the export compiler
   * caps a rendered layer at 8192 px, so 1080p tops out around 4.266 and 4K
   * around 2.133. Changing the project resolution moves this field's max.
   */
  const scaleMax = useMemo(() => maxClipScale(doc.settings), [doc.settings]);

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
  const { audio, visual, identity } = model;

  /**
   * Routes a value to the document: inside a pointer gesture it coalesces into
   * the open transaction, otherwise it is a standalone op (one history entry).
   */
  const writeAudio = (patch: ClipAudioPatch): void => {
    if (audio === null || !editable) return;
    if (isLiveEditOpen()) updateLiveEdit((d) => void applyClipAudioToDraft(d, audio.clipIds, patch));
    else setClipAudio(audio.clipIds, patch);
  };
  const writeTransform = (patch: ClipTransformPatch): void => {
    if (visual === null || !editable) return;
    if (isLiveEditOpen()) {
      updateLiveEdit((d) => void applyClipTransformToDraft(d, visual.clipIds, patch));
    } else {
      setClipTransform(visual.clipIds, patch);
    }
  };
  const writeOpacity = (opacity: number): void => {
    if (visual === null || !editable) return;
    if (isLiveEditOpen()) updateLiveEdit((d) => void applyClipOpacityToDraft(d, visual.clipIds, opacity));
    else setClipOpacity(visual.clipIds, opacity);
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
            value={audio.volume}
            neutral={1}
            min={VOLUME_MIN}
            max={VOLUME_MAX}
            step={0.01}
            valueText={formatGain(audio.volume)}
            hint={formatDb(audio.volume)}
            disabled={!editable}
            gesture={{ actionType: 'clipAudio', label: 'Ses seviyesi değiştirildi' }}
            onChange={(v) => writeAudio({ volume: v })}
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
            value={visual.x}
            min={-POSITION_LIMIT}
            max={POSITION_LIMIT}
            step={0.01}
            decimals={POSITION_DECIMALS}
            perPixel={0.002}
            disabled={!editable}
            gesture={{ actionType: 'clipTransform', label: 'Konum değiştirildi' }}
            onChange={(v) => writeTransform({ x: v })}
          />
          <NumberField
            id="clip-y"
            testId="clip-y"
            label="Konum Y"
            value={visual.y}
            min={-POSITION_LIMIT}
            max={POSITION_LIMIT}
            step={0.01}
            decimals={POSITION_DECIMALS}
            perPixel={0.002}
            disabled={!editable}
            gesture={{ actionType: 'clipTransform', label: 'Konum değiştirildi' }}
            onChange={(v) => writeTransform({ y: v })}
          />
          <NumberField
            id="clip-scale"
            testId="clip-scale"
            label="Ölçek"
            value={visual.scale}
            min={SCALE_MIN}
            max={scaleMax}
            step={0.01}
            decimals={SCALE_DECIMALS}
            perPixel={0.005}
            disabled={!editable}
            gesture={{ actionType: 'clipTransform', label: 'Ölçek değiştirildi' }}
            onChange={(v) => writeTransform({ scale: v })}
          />
          <NumberField
            id="clip-rotation"
            testId="clip-rotation"
            label="Döndürme"
            value={visual.rotationDeg}
            min={-ROTATION_LIMIT}
            max={ROTATION_LIMIT}
            step={1}
            decimals={ROTATION_DECIMALS}
            perPixel={0.5}
            unit="°"
            disabled={!editable}
            gesture={{ actionType: 'clipTransform', label: 'Döndürme değiştirildi' }}
            onChange={(v) => writeTransform({ rotationDeg: v })}
          />
          <SliderField
            id="clip-opacity"
            testId="clip-opacity"
            label="Opaklık"
            value={visual.opacity}
            neutral={1}
            min={0}
            max={1}
            step={0.01}
            valueText={
              visual.opacity === null
                ? MIXED_LABEL
                : `${Math.round(visual.opacity * 100)}%`
            }
            disabled={!editable}
            gesture={{ actionType: 'clipOpacity', label: 'Opaklık değiştirildi' }}
            onChange={(v) => writeOpacity(v)}
          />
          <p className="text-[10px] leading-snug text-fg-muted" data-testid="clip-scale-limit-note">
            Konum kompozisyon merkezine göre normalize (0 = ortada, 0.5 = yarım kompozisyon
            kadar sağ/aşağı); Ölçek 1 = sığdır. Bu projede ölçek en fazla{' '}
            {formatNumber(scaleMax, SCALE_DECIMALS)} olabilir ({doc.settings.width}×
            {doc.settings.height} çıktıda katman {MAX_LAYER_DIMENSION} pikseli aşamaz).
          </p>
        </PropertySection>
      )}

      {/*
        Kapsam dürüstlüğü (review-gate kural 4): panelin kapsamadığı klip
        alanları burada AÇIKÇA yazılır. Sessizce eksik bırakmak, kullanıcının
        "neden yok?" diye aramasına ve denetimde kapsam kayması bulgusuna yol
        açıyor. Hedef milestone'lar docs/backlog.md kapsam tablosundan gelir.
      */}
      <PropertySection title="Kapsam" testId="clip-inspector-scope">
        <p className="text-[10px] leading-snug text-fg-muted">
          Bu panel klibin sesini ve dönüşümünü düzenler. Henüz burada olmayanlar: çapa
          (anchor) noktası — merkezde sabit; hız (slow-mo/timelapse), renk düzeltme/efektler
          ve keyframe animasyonu → M5; metin/şekil/sticker özellikleri ve geçişler → M4 dalga 2.
        </p>
      </PropertySection>
    </div>
  );
}
