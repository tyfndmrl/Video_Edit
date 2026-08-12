/**
 * VersionsOverlay — "Sürümler" panel (M6). The user's very first requirement
 * list asked for "otomatik kayıt + versiyon geçmişi"; autosave shipped in M2
 * and the backend has kept revisions ever since (GET/POST
 * /api/projects/{id}/revisions, POST /restore), but there was no way to SEE or
 * USE them. This is that surface.
 *
 * Same lightweight fixed-overlay pattern as timeline/ConflictDialog,
 * export/ExportDialog and shortcuts/ShortcutsHelpOverlay (no dialog library).
 *
 * Contents:
 * - "Şu anki hali kaydet": optional label + manual checkpoint,
 * - the revision list (number, kind badge, label, local date-time), newest
 *   first, with the project's current saved revision marked,
 * - "Bu sürüme dön" per row, behind an inline confirmation — a restore
 *   replaces the open document and CLEARS the undo history (it is recoverable:
 *   the server snapshots the current state as PreRestore first, and that row
 *   shows up in this very list).
 *
 * While a write action runs the whole panel is inert and the document store is
 * locked (versionsActions) — closing is refused so the user is never left with
 * a silently frozen editor.
 */
import { useState } from 'react';
import { useProjectRevisions } from '../../entities/versions';
import { useAutosaveStore } from '../../state/autosave';
import { buildVersionRows, restoreRowHint, type VersionRow } from './versionsLogic';
import { createProjectCheckpoint, restoreProjectRevision } from './versionsActions';
import { closeVersionsOverlay, useVersionsStore } from './versionsStore';

/** Mount point: renders nothing while closed so the query stays idle. */
export function VersionsOverlay({ projectId }: { projectId: string }) {
  const open = useVersionsStore((s) => s.open);
  if (!open) return null;
  return <VersionsPanel projectId={projectId} />;
}

function VersionsPanel({ projectId }: { projectId: string }) {
  const busy = useVersionsStore((s) => s.busy);
  const error = useVersionsStore((s) => s.error);
  const notice = useVersionsStore((s) => s.notice);
  // Only this project's revision counts as "current" — a controller armed for
  // another project says nothing about this one.
  const currentRevision = useAutosaveStore((s) => (s.projectId === projectId ? s.revision : null));
  const { data, isPending, isError } = useProjectRevisions(projectId);
  const [label, setLabel] = useState('');
  const [confirming, setConfirming] = useState<number | null>(null);

  const rows = buildVersionRows(data?.items ?? [], currentRevision);
  const locked = busy !== null;

  const onCheckpoint = async (): Promise<void> => {
    const ok = await createProjectCheckpoint(projectId, label);
    if (ok) setLabel('');
  };

  const onRestore = async (revisionNumber: number): Promise<void> => {
    const ok = await restoreProjectRevision(projectId, revisionNumber);
    if (ok) setConfirming(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={closeVersionsOverlay}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="versions-title"
        aria-busy={locked}
        data-testid="versions-overlay"
        className="flex max-h-[85vh] w-[38rem] flex-col rounded-lg border border-edge bg-surface-2 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 id="versions-title" className="text-sm font-semibold text-fg">
            Sürümler
          </h2>
          <button
            type="button"
            aria-label="Kapat"
            disabled={locked}
            title={locked ? 'İşlem bitene kadar kapatılamaz' : 'Kapat'}
            data-testid="versions-close"
            className="rounded border border-edge px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
            onClick={closeVersionsOverlay}
          >
            Kapat
          </button>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-fg-muted">
          Otomatik kayıtlar sunucuda saklanır. Bir sürüme dönmek açık dokümanı değiştirir ve geri
          alma geçmişini temizler; dönüşten önceki hal listeye “Geri dönüş öncesi” olarak eklenir.
        </p>

        {/* --- Manual checkpoint ------------------------------------------ */}
        <div className="mt-3 flex items-end gap-2 rounded border border-edge bg-surface-1 p-2.5">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[10px] font-semibold tracking-wide text-fg-muted uppercase">
              Etiket (isteğe bağlı)
            </span>
            <input
              type="text"
              value={label}
              disabled={locked}
              maxLength={200}
              placeholder="ör. Müzik eklenmeden önce"
              data-testid="versions-checkpoint-label"
              className="w-full rounded border border-edge bg-surface-0 px-2 py-1 text-xs text-fg placeholder:text-fg-muted/60 disabled:opacity-50"
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={locked}
            data-testid="versions-checkpoint-submit"
            className="shrink-0 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-surface-0 hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
            onClick={() => void onCheckpoint()}
          >
            {busy === 'checkpoint' ? 'Kaydediliyor…' : 'Şu anki hali kaydet'}
          </button>
        </div>

        {error !== null && (
          <p
            role="alert"
            data-testid="versions-error"
            className="mt-3 rounded border border-danger/40 bg-danger/10 px-2.5 py-2 text-xs leading-relaxed text-danger"
          >
            {error}
          </p>
        )}
        {notice !== null && (
          <p
            role="status"
            data-testid="versions-notice"
            className="mt-3 rounded border border-emerald-400/40 bg-emerald-400/10 px-2.5 py-2 text-xs leading-relaxed text-emerald-400"
          >
            {notice}
          </p>
        )}
        {busy === 'restore' && (
          <p
            role="status"
            data-testid="versions-restoring"
            className="mt-3 rounded border border-amber-400/40 bg-amber-400/10 px-2.5 py-2 text-xs text-amber-400"
          >
            Sürüme dönülüyor — editör bu sırada kilitli.
          </p>
        )}

        {/* --- Revision list ---------------------------------------------- */}
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded border border-edge">
          {isPending ? (
            <p className="px-3 py-3 text-xs text-fg-muted">Yükleniyor…</p>
          ) : isError ? (
            <p className="px-3 py-3 text-xs text-danger">Sürüm listesi alınamadı.</p>
          ) : rows.length === 0 ? (
            <p data-testid="versions-empty" className="px-3 py-3 text-xs text-fg-muted">
              Henüz kayıtlı sürüm yok. Düzenleme yaptıkça otomatik kayıtlar oluşur; “Şu anki hali
              kaydet” ile hemen bir kayıt noktası da bırakabilirsiniz.
            </p>
          ) : (
            <ol data-testid="versions-rows" className="flex flex-col">
              {rows.map((row) => (
                <VersionRowItem
                  key={row.id}
                  row={row}
                  locked={locked}
                  confirming={confirming === row.revisionNumber}
                  onAskConfirm={() => setConfirming(row.revisionNumber)}
                  onCancelConfirm={() => setConfirming(null)}
                  onConfirm={() => void onRestore(row.revisionNumber)}
                />
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

function VersionRowItem({
  row,
  locked,
  confirming,
  onAskConfirm,
  onCancelConfirm,
  onConfirm,
}: {
  row: VersionRow;
  locked: boolean;
  confirming: boolean;
  onAskConfirm: () => void;
  onCancelConfirm: () => void;
  onConfirm: () => void;
}) {
  return (
    <li
      data-testid={`versions-row-${row.revisionNumber}`}
      aria-current={row.current ? 'true' : undefined}
      className={`flex flex-col gap-1.5 border-b border-edge px-3 py-2 last:border-b-0 ${
        row.current ? 'bg-surface-3' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="w-10 shrink-0 font-mono text-[11px] text-fg-muted">#{row.revisionNumber}</span>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${row.badgeClass}`}>
          {row.kindLabel}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-fg" title={row.label}>
          {row.label === '' ? '—' : row.label}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-fg-muted">{row.time}</span>
        {row.current && (
          <span className="shrink-0 text-[10px] font-semibold text-accent">Güncel kayıt</span>
        )}
        {!confirming && (
          <button
            type="button"
            disabled={locked}
            title={restoreRowHint(row)}
            data-testid={`versions-restore-${row.revisionNumber}`}
            className="shrink-0 rounded border border-edge px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
            onClick={onAskConfirm}
          >
            Bu sürüme dön
          </button>
        )}
      </div>

      {confirming && (
        <div className="flex items-center justify-end gap-2 rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1.5">
          <span className="min-w-0 flex-1 text-[11px] leading-snug text-amber-400">
            {row.revisionNumber} numaralı sürüme dönülsün mü? Açık doküman değişir ve geri alma
            geçmişi temizlenir.
          </span>
          <button
            type="button"
            disabled={locked}
            data-testid="versions-restore-cancel"
            className="shrink-0 rounded border border-edge px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
            onClick={onCancelConfirm}
          >
            Vazgeç
          </button>
          <button
            type="button"
            disabled={locked}
            data-testid="versions-restore-confirm"
            className="shrink-0 rounded bg-accent px-2.5 py-0.5 text-[11px] font-semibold text-surface-0 hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
            onClick={onConfirm}
          >
            Evet, dön
          </button>
        </div>
      )}
    </li>
  );
}
