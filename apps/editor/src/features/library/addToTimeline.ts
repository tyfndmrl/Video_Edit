/**
 * addToTimeline — kütüphanedeki hazır (ready) asset kartına ÇİFT TIK ile
 * timeline'a ekleme (DnD'ye klavyesiz/hassasiyetsiz yedek yol).
 *
 * Yerleşim politikası:
 * 1. Playhead'de, türe uyan (video/image -> video, audio -> audio) kilitsiz
 *    ilk track'e sığdırmayı dene;
 * 2. playhead'de her aday track'te çakışma varsa proje SONUNA ekle;
 * 3. uygun track yoksa (veya kenar durum yuvarlamaları eklemeyi engellerse)
 *    yeni track aç (addClipFromAsset newTrack).
 *
 * Tüm mutasyonlar addClipFromAsset üzerinden gider (grid snap, overlap reddi,
 * undo girdisi, seçim oradadır); başarısız deneme dokümanı DEĞİŞTİRMEZ, bu
 * yüzden sıralı denemeler güvenlidir.
 */
import type { Uuid } from '@videoedit/timeline-schema';
import { useAssetStore } from '../../state/assetStore';
import { useDocStore } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { useProjectSession } from '../../state/projectSession';
import {
  addClipFromAsset,
  projectEndUs,
  type AddClipResult,
} from '../../state/timelineOps';

export function addAssetToTimelineAtPlayhead(assetId: Uuid): AddClipResult {
  // Drop hedefiyle aynı guard: proje (yeniden) yüklenirken doküman mutasyonu yok.
  if (useProjectSession.getState().status !== 'ready') {
    return { ok: false, reason: 'project not ready' };
  }
  const asset = useAssetStore.getState().getAsset(assetId);
  if (!asset) return { ok: false, reason: 'asset not found' };
  if (asset.status !== 'ready') return { ok: false, reason: 'asset is not ready' };

  const d = useDocStore.getState().doc;
  const playheadUs = useEditorStore.getState().playheadUs;
  const requiredType = asset.kind === 'audio' ? 'audio' : 'video';
  const candidates = d.tracks.filter((t) => t.type === requiredType && !t.locked);

  // 1) Playhead'de ilk sığan aday track.
  for (const track of candidates) {
    const res = addClipFromAsset(assetId, { trackId: track.id }, playheadUs);
    if (res.ok) return res;
  }

  // 2) Çakışma: proje sonu her track'te garanti boştur (grid yuvarlaması nadir
  //    kenar durumlarda geri düşebilir; o zaman 3. adım devralır).
  const endUs = projectEndUs(d);
  if (endUs !== playheadUs) {
    for (const track of candidates) {
      const res = addClipFromAsset(assetId, { trackId: track.id }, endUs);
      if (res.ok) return res;
    }
  }

  // 3) Uygun track yok — türe uyan yeni track aç.
  return addClipFromAsset(assetId, { newTrack: true }, playheadUs);
}
