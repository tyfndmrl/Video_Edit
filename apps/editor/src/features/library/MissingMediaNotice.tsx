/**
 * MissingMediaNotice — seçili kliplerin medyası silinmişse Inspector uyarısı.
 *
 * Timeline'daki kırmızı blok "bir şey ters" der; kullanıcının ne yapacağını
 * öğrendiği yer burasıdır. Bileşen KENDİ verisini okur (doküman + seçim +
 * asset haritası) ve sorun yoksa hiçbir şey çizmez — Inspector'a tek satırla
 * takılabilsin diye.
 */
import { isMediaClip, type Clip } from '@videoedit/timeline-schema';
import { useDocStore } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { useAssetStore } from '../../state/assetStore';
import { isMissingAsset, useAssetPresence } from './missingMedia';

/** Klip medya taşıyorsa assetId'si, taşımıyorsa null (metin/şekil). */
function clipAssetId(clip: Clip): string | null {
  if (isMediaClip(clip) || clip.kind === 'sticker') return clip.assetId;
  return null;
}

export function MissingMediaNotice() {
  const doc = useDocStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const assets = useAssetStore((s) => s.assets);
  const presence = useAssetPresence();

  let missingCount = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (!selection.has(clip.id)) continue;
      const assetId = clipAssetId(clip);
      if (assetId !== null && isMissingAsset(assetId, assets, presence)) missingCount++;
    }
  }

  if (missingCount === 0) return null;

  return (
    <p
      role="alert"
      data-testid="clip-missing-media"
      className="border-b border-danger/30 bg-danger/10 px-3 py-2 text-[11px] leading-snug text-danger"
    >
      {missingCount === 1
        ? 'Bu klibin medyası kitaplıktan silinmiş — klip oynatılamaz'
        : `Seçili ${missingCount} klibin medyası kitaplıktan silinmiş — bu klipler oynatılamaz`}
      {' ve dışa aktarma "asset-missing" hatasıyla başarısız olur. '}
      Klibi timeline'dan silin ya da medyayı yeniden yükleyip klibi yeniden ekleyin.
    </p>
  );
}
