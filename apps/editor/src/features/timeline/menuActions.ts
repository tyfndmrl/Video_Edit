/**
 * menuActions — sağ tık menüsü öğesi -> MEVCUT timelineOps çağrısı eşlemesi.
 *
 * TimelinePanel.tsx'ten ayrı bir modül olmasının iki nedeni var:
 *
 * 1. Test edilebilirlik. "Menü, op'un reddedeceği eylemi teklif etmesin"
 *    sözleşmesi ancak menüyü kuran fonksiyon (buildTimelineMenu) ile eylemi
 *    çalıştıran fonksiyon AYNI testte yan yana koşabiliyorsa kanıtlanabilir.
 *    Panel .tsx olduğu için node ortamındaki vitest ile koşamıyordu; eşleme
 *    burada olduğu için contextMenu.test.ts artık her öğe için op'u GERÇEKTEN
 *    çağırıp `ok === !disabled` iddiasını doğruluyor.
 *
 * 2. Donmuş playhead. Menü açılırken okunan playhead menü state'inde donar ve
 *    op'a AYNI değer geçer (split/trim/paste/marker `timeUs` parametreleri).
 *    Aksi halde menü açıkken playhead kayınca menü bir şey gösterip op başka
 *    bir yerde çalışıyordu ("Playhead'de böl" aktif kalıyor, tıklayınca
 *    "Playhead'in altında klip yok" uyarısı çıkıyordu).
 */
import type { MicroSec, Uuid } from '@videoedit/timeline-schema';
import { useEditorStore } from '../../state/editorStore';
import {
  addMarkerAtPlayhead,
  copyClips,
  cutClips,
  deleteClips,
  deleteTrack,
  detachAudio,
  duplicateClips,
  pasteAtPlayhead,
  splitAtPlayhead,
  toggleTrackHidden,
  toggleTrackLocked,
  toggleTrackMuted,
  trimSelectedToPlayhead,
  type OpResult,
} from '../../state/timelineOps';
import type { TimelineMenuActionId, TimelineMenuTarget } from './contextMenu';

export interface TimelineMenuActionInput {
  target: TimelineMenuTarget;
  /** Menü açılışında normalize edilmiş seçim. */
  selection: readonly Uuid[];
  /** Menü açılışında DONDURULAN playhead (buildTimelineMenu ile aynı değer). */
  playheadUs: MicroSec;
}

const OK: OpResult = { ok: true };
const fail = (reason: string): OpResult => ({ ok: false, reason });

/**
 * Menü eylemini çalıştırır. Yeni düzenleme mantığı YOKTUR — her dal mevcut bir
 * op'a iner ve op'un OpResult'ını aynen döndürür (uyarı balonu onu okur).
 */
export function runTimelineMenuAction(
  id: TimelineMenuActionId,
  input: TimelineMenuActionInput,
): OpResult {
  const { target, playheadUs } = input;
  const selection = [...input.selection];

  switch (id) {
    case 'splitAtPlayhead':
      return splitAtPlayhead(playheadUs);
    case 'cut':
      return cutClips(selection);
    case 'copy':
      return copyClips(selection) ? OK : fail('nothing to copy');
    case 'duplicate':
      return duplicateClips(selection);
    case 'delete':
      return deleteClips(selection);
    case 'rippleDelete':
      return deleteClips(selection, { ripple: true });
    case 'trimStartToPlayhead':
      return trimSelectedToPlayhead('left', playheadUs);
    case 'trimEndToPlayhead':
      return trimSelectedToPlayhead('right', playheadUs);
    case 'detachAudio':
      return target.kind === 'clip' ? detachAudio(target.clipId) : fail('no clip target');
    case 'paste':
      return pasteAtPlayhead(playheadUs);
    case 'toggleMuted':
      return target.kind === 'track' ? toggleTrackMuted(target.trackId) : fail('no track target');
    case 'toggleHidden':
      return target.kind === 'track' ? toggleTrackHidden(target.trackId) : fail('no track target');
    case 'toggleLocked':
      return target.kind === 'track' ? toggleTrackLocked(target.trackId) : fail('no track target');
    case 'deleteTrack':
      return target.kind === 'track' ? deleteTrack(target.trackId) : fail('no track target');
    case 'addMarker':
      if (target.kind !== 'ruler') return fail('no ruler target');
      // "Buraya": playhead tıklanan kareye gider, marker AYNI kareye eklenir.
      // timeUs açıkça geçilir — setPlayheadUs'un yuvarlaması ile marker'ın
      // zamanı arasında fark kalmasın (menüde görülen kare = eklenen kare).
      useEditorStore.getState().setPlayheadUs(target.timeUs);
      addMarkerAtPlayhead(target.timeUs);
      return OK;
  }
}
