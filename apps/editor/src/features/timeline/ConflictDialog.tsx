/**
 * 409 conflict dialog — the document changed in another tab. The only safe
 * MVP resolution is adopting the server document (local unsaved changes are
 * discarded, undo history cleared).
 */
import { useAutosaveStore } from '../../state/autosave';
import { resolveConflictFromServer } from '../../state/projectSession';

export function ConflictDialog() {
  const conflict = useAutosaveStore((s) => s.conflict);
  if (!conflict) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
        className="w-96 rounded-lg border border-edge bg-surface-2 p-4 shadow-xl"
      >
        <h2 id="conflict-title" className="text-sm font-semibold text-fg">
          Proje başka bir sekmede değiştirildi
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-fg-muted">
          Sunucudaki doküman bu sekmedekinden daha yeni (revizyon{' '}
          {conflict.revisionNumber}). Devam etmek için sunucudaki sürüm yüklenecek; bu sekmedeki
          kaydedilmemiş değişiklikler ve geri alma geçmişi silinecek.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-surface-0 hover:opacity-90"
            onClick={() => resolveConflictFromServer()}
          >
            Sunucudaki sürümü yükle
          </button>
        </div>
      </div>
    </div>
  );
}
