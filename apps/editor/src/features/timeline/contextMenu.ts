/**
 * contextMenu — timeline sağ tık menüsünün İÇERİK MODELİ (saf).
 *
 * Menü öğeleri burada üretilir, TimelineContextMenu yalnız çizer, menuActions
 * yalnız MEVCUT timelineOps fonksiyonlarını çağırır. Yeni düzenleme mantığı
 * yoktur.
 *
 * SÖZLEŞME: her öğenin `disabled` değeri, o öğeyi çalıştıracak op'un KENDİ ret
 * kuralından (`*BlockReason`) gelir — menü, op'un reddedeceği bir eylemi asla
 * teklif etmez. Bu yüzden her öğe `blockReason` alanını da taşır: hem ipucu
 * metni olur hem de "disabled === (blockReason !== null)" testi mümkün olur.
 *
 * Bağlamdaki `playheadUs` menünün AÇILDIĞI andaki değerdir (dondurulmuş).
 * Menü açıkken playhead'in kayması (oynatma, ok tuşu) menüyü bayatlatıyordu:
 * "Playhead'de böl" aktif kalıyor, tıklayınca "Playhead'in altında klip yok"
 * uyarısı çıkıyordu. Aynı donmuş değer runTimelineMenuAction ile op'a geçirilir.
 */
import type { MicroSec, TimelineDoc, Uuid } from '@videoedit/timeline-schema';
import {
  copyBlockReason,
  cutBlockReason,
  deleteBlockReason,
  detachAudioBlockReason,
  duplicateBlockReason,
  pasteBlockReason,
  splitBlockReason,
  trackDeleteBlockReason,
  trimToPlayheadBlockReason,
} from '../../state/timelineOps';

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
  /** Neden devre dışı (op'un ret gerekçesi) — aktif öğelerde null. */
  blockReason: string | null;
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
  /**
   * Menü açılırken normalize edilmiş seçim (klip id'leri). Sayı değil KİMLİK
   * listesi: duplicate/cut/delete ret kuralları gerçek kliplere bakar.
   */
  selection: readonly Uuid[];
  /** Menü açılış anındaki playhead — DONDURULMUŞ (bkz. dosya başı notu). */
  playheadUs: MicroSec;
  /** Doküman mutasyonuna izin var mı (proje hazır değilse false). */
  mutationAllowed: boolean;
}

const SEPARATOR: TimelineMenuSeparator = { kind: 'separator' };

/** Proje hazır değilken hiçbir mutasyon teklif edilmez. */
const NOT_ALLOWED = 'doküman şu anda düzenlenemiyor';

function item(
  id: TimelineMenuActionId,
  label: string,
  shortcut: string | undefined,
  blockReason: string | null,
  danger = false,
): TimelineMenuItem {
  const base: TimelineMenuItem = {
    kind: 'item',
    id,
    label,
    shortcut,
    disabled: blockReason !== null,
    blockReason,
  };
  return danger ? { ...base, danger } : base;
}

/** mutationAllowed=false ise her mutasyon öğesi aynı gerekçeyle kapanır. */
function gated(ctx: TimelineMenuContext, reason: () => string | null): string | null {
  return ctx.mutationAllowed ? reason() : NOT_ALLOWED;
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
      return [item('addMarker', 'Buraya marker ekle', 'M', gated(ctx, () => null))];
    case 'empty':
      return [pasteItem(ctx)];
  }
}

function pasteItem(ctx: TimelineMenuContext): TimelineMenuItem {
  // pasteAtPlayhead: pano içeriğini KENDİ track'lerine, playhead'den başlayarak
  // yapıştırır. Ret kuralı op'un ta kendisi (pasteBlockReason): pano boşsa da,
  // hedef aralık doluysa da menü öğesi kapalıdır.
  return item(
    'paste',
    'Yapıştır',
    'Ctrl+V',
    gated(ctx, () => pasteBlockReason(ctx.doc, ctx.playheadUs)),
  );
}

function clipMenu(ctx: TimelineMenuContext, clipId: Uuid): TimelineMenuEntry[] {
  const found = ctx.doc.tracks.some((t) => t.clips.some((c) => c.id === clipId));
  if (!found) return [];
  const selection = new Set(ctx.selection);

  return [
    item(
      'splitAtPlayhead',
      "Playhead'de böl",
      'C',
      gated(ctx, () => splitBlockReason(ctx.doc, ctx.playheadUs, selection)),
    ),
    item('cut', 'Kes', 'Ctrl+X', gated(ctx, () => cutBlockReason(ctx.doc, ctx.selection))),
    // Kopyalama dokümanı değiştirmez: proje kilitliyken bile serbesttir.
    item('copy', 'Kopyala', 'Ctrl+C', copyBlockReason(ctx.doc, ctx.selection)),
    item(
      'duplicate',
      'Çoğalt',
      'Ctrl+D',
      gated(ctx, () => duplicateBlockReason(ctx.doc, ctx.selection)),
    ),
    item(
      'delete',
      'Sil',
      'Delete',
      gated(ctx, () => deleteBlockReason(ctx.doc, ctx.selection)),
      true,
    ),
    item(
      'rippleDelete',
      'Ripple sil',
      'Shift+Delete',
      gated(ctx, () => deleteBlockReason(ctx.doc, ctx.selection)),
      true,
    ),
    SEPARATOR,
    item(
      'trimStartToPlayhead',
      "Klip başını playhead'e kırp",
      'Q',
      gated(ctx, () => trimToPlayheadBlockReason(ctx.doc, ctx.playheadUs, selection)),
    ),
    item(
      'trimEndToPlayhead',
      "Klip sonunu playhead'e kırp",
      'W',
      gated(ctx, () => trimToPlayheadBlockReason(ctx.doc, ctx.playheadUs, selection)),
    ),
    SEPARATOR,
    // Yalnız KENDİ sesi olan video klipte ve yerleştirilecek yer varsa aktif.
    item(
      'detachAudio',
      'Sesi ayır',
      undefined,
      gated(ctx, () => detachAudioBlockReason(ctx.doc, clipId)),
    ),
  ];
}

function trackMenu(ctx: TimelineMenuContext, trackId: Uuid): TimelineMenuEntry[] {
  const track = ctx.doc.tracks.find((t) => t.id === trackId);
  if (!track) return [];
  const flagReason = gated(ctx, () => null);

  return [
    pasteItem(ctx),
    SEPARATOR,
    item('toggleMuted', track.muted ? 'Sesi aç' : 'Sessize al', undefined, flagReason),
    item('toggleHidden', track.hidden ? 'Göster' : 'Gizle', undefined, flagReason),
    item('toggleLocked', track.locked ? 'Kilidi aç' : 'Kilitle', undefined, flagReason),
    item(
      'deleteTrack',
      "Track'i sil",
      undefined,
      gated(ctx, () => trackDeleteBlockReason(ctx.doc, trackId)),
      true,
    ),
  ];
}
