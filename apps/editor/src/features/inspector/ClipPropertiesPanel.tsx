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
  SHAPE_RADIUS_MAX,
  SHAPE_STROKE_WIDTH_MAX,
  TEXT_BACKGROUND_PADDING_MAX,
  TEXT_LINE_HEIGHT_MAX,
  TEXT_LINE_HEIGHT_MIN,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  TEXT_STROKE_WIDTH_MAX,
  VOLUME_MAX,
  VOLUME_MIN,
  applyClipAudioToDraft,
  applyClipOpacityToDraft,
  applyClipShapeToDraft,
  applyClipTextToDraft,
  applyClipTransformToDraft,
  maxClipScale,
  resetClipTransform,
  setClipAudio,
  setClipOpacity,
  setClipShape,
  setClipText,
  setClipTransform,
  type ClipAudioPatch,
  type ClipShapePatch,
  type ClipTextPatch,
  type ClipTransformPatch,
} from '../../state/timelineOps';
import { FONT_MANIFEST, weightsFor } from '../text/fontManifest';
import {
  buildClipInspectorModel,
  formatDb,
  formatGain,
  formatNumber,
  formatSeconds,
  MIXED_LABEL,
  type ShapeSection,
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
  const { audio, visual, identity, text, shape } = model;

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
          Bu panel klibin sesini, dönüşümünü ve metin/şekil biçimini düzenler. Henüz burada
          olmayanlar: çapa (anchor) noktası — merkezde sabit; hız (slow-mo/timelapse), renk
          düzeltme/efektler ve keyframe animasyonu → M5.
        </p>
      </PropertySection>
    </div>
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
        options={FONT_MANIFEST.map((f) => ({ value: f.id, label: f.label }))}
        disabled={!editable}
        onChange={(fontId) => write({ fontId })}
      />
      <NumberField
        id="clip-text-size"
        testId="clip-text-size"
        label="Boyut"
        value={section.fontSizePx}
        min={TEXT_SIZE_MIN}
        max={TEXT_SIZE_MAX}
        step={1}
        decimals={0}
        perPixel={1}
        unit="px"
        disabled={!editable}
        gesture={{ actionType: 'clipText', label: 'Metin boyutu değiştirildi' }}
        onChange={(fontSizePx) => write({ fontSizePx })}
      />
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
        Dürüstlük notu (rendering-semantics §7): önizlemedeki metin rasterı
        TARAYICININ Canvas2D ölçümüyle çizilir; BAĞLAYICI ölçüm sunucudaki
        SkiaSharp'tır. Sunucu bbox/raster ucu (TODO) bağlanana kadar satır
        genişlikleri export'ta birkaç piksel kayabilir — kullanıcının bunu
        ekranda görmesi, sonradan "neden farklı?" diye aramasından iyidir.
      */}
      <p className="text-[10px] leading-snug text-fg-muted" data-testid="clip-text-raster-note">
        Önizleme metni tarayıcı yazı tipiyle çizilir; dışa aktarımda metni sunucu (SkiaSharp)
        aynı yazı tipi kimliğiyle yeniden çizer — satır genişliklerinde küçük farklar olabilir.
        Sunucu ölçümü (bbox) bağlandığında bu fark kapanır.
      </p>
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
