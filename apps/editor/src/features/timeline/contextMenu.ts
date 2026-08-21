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
  addTransitionBlockReason,
  copyBlockReason,
  cutBlockReason,
  deleteBlockReason,
  detachAudioBlockReason,
  duplicateBlockReason,
  pasteBlockReason,
  removeTransitionBlockReason,
  splitBlockReason,
  trackDeleteBlockReason,
  trackMoveBlockReason,
  trackRenameBlockReason,
  trimToPlayheadBlockReason,
} from '../../state/timelineOps';
import { resolveTransitionEdge, transitionEdgeLabel } from './transitions';

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
  | 'addTransition'
  | 'removeTransition'
  | 'paste'
  | 'renameTrack'
  | 'moveTrackUp'
  | 'moveTrackDown'
  | 'toggleMuted'
  | 'toggleHidden'
  | 'toggleLocked'
  | 'deleteTrack'
  | 'addMarker'
  | 'addText';

/** Neye sağ tıklandı. */
export type TimelineMenuTarget =
  /**
   * `timeUs` = sağ tıklanan noktanın zamanı (opsiyonel; klavye/test yolları
   * vermeyebilir). Geçiş öğeleri klibin İKİ kenarından hangisinin kastedildiğini
   * bununla seçer: kesime yakın tıklamak o kesimi hedefler (bkz.
   * transitions.ts `resolveTransitionEdge`). Verilmezse 'out' tercih edilir.
   */
  | { kind: 'clip'; clipId: Uuid; timeUs?: MicroSec }
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
      return [pasteItem(ctx), SEPARATOR, addTextItem(ctx)];
  }
}

/**
 * "Metin ekle" — boş alanın en doğal eylemi (kullanıcı zaten "buraya bir şey
 * koy" demek için sağ tıkladı). Yerleşimi features/text/overlayActions yapar:
 * playhead'de sığan ilk overlay track, yoksa yeni katman → op ASLA reddetmez,
 * bu yüzden tek ret gerekçesi mutasyon kapısıdır.
 */
function addTextItem(ctx: TimelineMenuContext): TimelineMenuItem {
  return item('addText', 'Metin ekle', undefined, gated(ctx, () => null));
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

/**
 * Geçiş çifti: "Geçiş ekle" ve "Geçişi kaldır".
 *
 * Kenar seçimi (hangi kesim) `resolveTransitionEdge` ile yapılır ve etikete
 * YAZILIR — menü "Geçiş ekle (sağ kesim)" diyip op'un sol kesime dokunması
 * kullanıcı için sessiz bir yanlış uygulamadır. menuActions AYNI çözücüyü aynı
 * bağlamla çağırır, dolayısıyla etiket ile eylem birebir aynı kesimi gösterir.
 *
 * İki öğe farklı kenarlarda olabilir: bir klibin solunda geçiş varken sağında
 * boş bir kesim durabilir; o zaman "kaldır" sola, "ekle" sağa bakar.
 */
function transitionItems(ctx: TimelineMenuContext, clipId: Uuid): TimelineMenuEntry[] {
  const timeUs = ctx.target.kind === 'clip' ? ctx.target.timeUs : undefined;
  const addEdge = resolveTransitionEdge(ctx.doc, clipId, { timeUs, require: 'cut' });
  const removeEdge = resolveTransitionEdge(ctx.doc, clipId, { timeUs, require: 'transition' });
  return [
    item(
      'addTransition',
      `Geçiş ekle (${transitionEdgeLabel(addEdge)})`,
      undefined,
      gated(ctx, () => addTransitionBlockReason(ctx.doc, clipId, addEdge)),
    ),
    item(
      'removeTransition',
      `Geçişi kaldır (${transitionEdgeLabel(removeEdge)})`,
      undefined,
      gated(ctx, () => removeTransitionBlockReason(ctx.doc, clipId, removeEdge)),
    ),
  ];
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
    ...transitionItems(ctx, clipId),
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
    // Yeniden adlandırma bir UI jestidir (başlıkta satır içi input) ama ret
    // kuralı OP'UNDUR: kilitli track'te op reddeder, menü de gri gösterir.
    // Aynı input başlığa çift tıkla da açılır — menü öğesi keşfedilebilirlik.
    item(
      'renameTrack',
      'Yeniden adlandır',
      undefined,
      gated(ctx, () => trackRenameBlockReason(ctx.doc, trackId)),
    ),
    // tracks[0] = EN ÜST katman (şema sözleşmesi + export render sırası):
    // "yukarı taşı" görselde bir satır yukarı = dizide bir indeks geri = render
    // sırasında bir katman öne. Sürükle-bırak yerine menü: bkz. docs/backlog
    // kararı — track başlığı sürüklemesi ayrı bir pointer/çizim altyapısı
    // isterken menü aynı op'u sıfır yeni jest maliyetiyle sunar.
    item(
      'moveTrackUp',
      'Yukarı taşı',
      undefined,
      gated(ctx, () => trackMoveBlockReason(ctx.doc, trackId, 'up')),
    ),
    item(
      'moveTrackDown',
      'Aşağı taşı',
      undefined,
      gated(ctx, () => trackMoveBlockReason(ctx.doc, trackId, 'down')),
    ),
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
