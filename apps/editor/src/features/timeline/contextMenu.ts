/**
 * contextMenu — timeline sağ tık menüsünün İÇERİK MODELİ (saf).
 *
 * Menü öğeleri burada üretilir, TimelineContextMenu yalnız çizer, TimelinePanel
 * yalnız MEVCUT timelineOps fonksiyonlarını çağırır. Yeni düzenleme mantığı
 * yoktur: her öğe zaten var olan bir kısayolun/op'un eşleniğidir, bu yüzden
 * disabled kuralları op'ların ret koşullarıyla birebir aynı tutulur (menü,
 * op'un reddedeceği bir eylemi asla teklif etmemeli).
 */
import type { MicroSec, TimelineDoc, Track, Uuid } from '@videoedit/timeline-schema';
import { clipEndUs, detachAudioBlockReason, trackDeleteBlockReason } from '../../state/timelineOps';

export type TimelineMenuActionId =
  | 'splitAtPlayhead'
  | 'cut'
  | 'copy'
  | 'duplicate'
  | 'delete'
  | 'rippleDelete'
  | 'trimStartToPlayhead'
  | 'trimEndToPlayhead'
  | 'detachAudio'
  | 'paste'
  | 'toggleMuted'
  | 'toggleHidden'
  | 'toggleLocked'
  | 'deleteTrack'
  | 'addMarker';

/** Neye sağ tıklandı. */
export type TimelineMenuTarget =
  | { kind: 'clip'; clipId: Uuid }
  /** Track başlığı veya o track'in boş lane alanı. */
  | { kind: 'track'; trackId: Uuid }
  /** Cetvel (ruler). */
  | { kind: 'ruler'; timeUs: MicroSec }
  /** Track'lerin dışı (satır arası boşluk / yeni-track bölgesi). */
  | { kind: 'empty' };

export interface TimelineMenuItem {
  kind: 'item';
  id: TimelineMenuActionId;
  label: string;
  /** Menüde sağda gösterilen kısayol ipucu. */
  shortcut?: string;
  disabled: boolean;
  /** Yıkıcı eylem (kırmızı). */
  danger?: boolean;
}

export interface TimelineMenuSeparator {
  kind: 'separator';
}

export type TimelineMenuEntry = TimelineMenuItem | TimelineMenuSeparator;

export interface TimelineMenuContext {
  target: TimelineMenuTarget;
  doc: TimelineDoc;
  /** Menü açılırken normalize edilmiş seçim büyüklüğü. */
  selectionCount: number;
  playheadUs: MicroSec;
  clipboardHasContent: boolean;
  /** Doküman mutasyonuna izin var mı (proje hazır değilse false). */
  mutationAllowed: boolean;
}

const SEPARATOR: TimelineMenuSeparator = { kind: 'separator' };

function item(
  id: TimelineMenuActionId,
  label: string,
  shortcut: string | undefined,
  disabled: boolean,
  danger = false,
): TimelineMenuItem {
  return danger
    ? { kind: 'item', id, label, shortcut, disabled, danger }
    : { kind: 'item', id, label, shortcut, disabled };
}

function locate(d: TimelineDoc, clipId: Uuid): { track: Track; startUs: MicroSec; endUs: MicroSec } | null {
  for (const track of d.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, startUs: clip.timelineStartUs, endUs: clipEndUs(clip) };
  }
  return null;
}

/**
 * Bağlam -> menü öğeleri. Hedef artık dokümanda yoksa boş dizi döner (çağıran
 * menüyü hiç açmaz).
 */
export function buildTimelineMenu(ctx: TimelineMenuContext): TimelineMenuEntry[] {
  switch (ctx.target.kind) {
    case 'clip':
      return clipMenu(ctx, ctx.target.clipId);
    case 'track':
      return trackMenu(ctx, ctx.target.trackId);
    case 'ruler':
      return [item('addMarker', 'Buraya marker ekle', 'M', !ctx.mutationAllowed)];
    case 'empty':
      return [pasteItem(ctx)];
  }
}

function pasteItem(ctx: TimelineMenuContext): TimelineMenuItem {
  // pasteAtPlayhead: pano içeriğini KENDİ track'lerine, playhead'den başlayarak
  // yapıştırır (mevcut op — menü yeni bir yapıştırma mantığı getirmez).
  return item('paste', 'Yapıştır', 'Ctrl+V', !ctx.mutationAllowed || !ctx.clipboardHasContent);
}

function clipMenu(ctx: TimelineMenuContext, clipId: Uuid): TimelineMenuEntry[] {
  const found = locate(ctx.doc, clipId);
  if (!found) return [];
  const editable = ctx.mutationAllowed && !found.track.locked;
  // splitAtPlayhead / trimSelectedToPlayhead yalnız playhead klibin İÇİNDEyken
  // (kenarlar hariç) iş yapar — clipsAtTime ile aynı koşul.
  const playheadInside = found.startUs < ctx.playheadUs && ctx.playheadUs < found.endUs;
  const hasSelection = ctx.selectionCount > 0;

  return [
    item('splitAtPlayhead', "Playhead'de böl", 'C', !editable || !playheadInside),
    item('cut', 'Kes', 'Ctrl+X', !editable || !hasSelection),
    item('copy', 'Kopyala', 'Ctrl+C', !hasSelection),
    item('duplicate', 'Çoğalt', 'Ctrl+D', !editable || !hasSelection),
    item('delete', 'Sil', 'Delete', !editable || !hasSelection, true),
    item('rippleDelete', 'Ripple sil', 'Shift+Delete', !editable || !hasSelection, true),
    SEPARATOR,
    item('trimStartToPlayhead', "Klip başını playhead'e kırp", 'Q', !editable || !playheadInside),
    item('trimEndToPlayhead', "Klip sonunu playhead'e kırp", 'W', !editable || !playheadInside),
    SEPARATOR,
    // Yalnız KENDİ sesi olan video klipte aktif — disabled kuralı op'un ret
    // koşulunun ta kendisi (detachAudioBlockReason), menü hiç reddedilecek bir
    // eylem teklif etmez.
    item(
      'detachAudio',
      'Sesi ayır',
      undefined,
      !ctx.mutationAllowed || detachAudioBlockReason(ctx.doc, clipId) !== null,
    ),
  ];
}

function trackMenu(ctx: TimelineMenuContext, trackId: Uuid): TimelineMenuEntry[] {
  const track = ctx.doc.tracks.find((t) => t.id === trackId);
  if (!track) return [];
  const flagsDisabled = !ctx.mutationAllowed;

  return [
    pasteItem(ctx),
    SEPARATOR,
    item('toggleMuted', track.muted ? 'Sesi aç' : 'Sessize al', undefined, flagsDisabled),
    item('toggleHidden', track.hidden ? 'Göster' : 'Gizle', undefined, flagsDisabled),
    item('toggleLocked', track.locked ? 'Kilidi aç' : 'Kilitle', undefined, flagsDisabled),
    item(
      'deleteTrack',
      "Track'i sil",
      undefined,
      !ctx.mutationAllowed || trackDeleteBlockReason(ctx.doc, trackId) !== null,
      true,
    ),
  ];
}
