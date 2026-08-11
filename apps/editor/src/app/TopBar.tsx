/**
 * TopBar — ince editör üst çubuğu: solda "Projeler" (seçiciye dönüş) + proje
 * adı; sağda Undo/Redo, autosave çipi, kısayol listesi ('?'), export girişi ve
 * çıkış. Seçiciye dönüş activeProjectId'yi null'a çeker — EditorBoot
 * closeProject() ile autosave'i dispose-flush eder, URL'den ?project= silinir.
 */
import { useState } from 'react';
import { AutosaveIndicator } from '../features/timeline/AutosaveIndicator';
import { ExportDialog } from '../features/export/ExportDialog';
import { useHistoryNavigationBlockReason } from '../features/history/historyLogic';
import { returnToProjectPicker } from '../features/projects/projectPickerLogic';
import { toggleShortcutsOverlay } from '../features/shortcuts/shortcutsHelp';
import { logout } from '../entities/auth';
import { useDocStore } from '../state/docStore';
import { useProjectSession } from '../state/projectSession';

export function TopBar() {
  const projectId = useProjectSession((s) => s.projectId);
  const projectName = useProjectSession((s) => s.projectName);
  const sessionReady = useProjectSession((s) => s.status) === 'ready';
  // undo/redo are document mutations (they rewrite doc from patches and dirty
  // autosave), so they carry the SAME gate as the history panel rows: an open
  // gesture, a project load in flight, or an unresolved 409 conflict.
  const navBlocked = useHistoryNavigationBlockReason();
  const canUndo = useDocStore((s) => s.cursor > 0) && navBlocked === null;
  const canRedo = useDocStore((s) => s.cursor < s.history.length) && navBlocked === null;
  const [exportOpen, setExportOpen] = useState(false);

  return (
    <header className="flex items-center gap-2 border-b border-edge bg-surface-2 px-3 py-1.5">
      <button
        type="button"
        className="shrink-0 rounded border border-edge px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-3 hover:text-fg"
        title="Proje seçiciye dön"
        onClick={returnToProjectPicker}
      >
        Projeler
      </button>
      <span className="min-w-0 truncate text-xs font-semibold text-fg" title={projectName ?? undefined}>
        {projectName ?? '—'}
      </span>

      <div className="ml-3 flex items-center gap-1">
        <IconButton
          label="Geri al (Ctrl+Z)"
          title={navBlocked ?? undefined}
          disabled={!canUndo}
          onClick={() => useDocStore.getState().undo()}
        >
          ↺
        </IconButton>
        <IconButton
          label="Yinele (Ctrl+Y)"
          title={navBlocked ?? undefined}
          disabled={!canRedo}
          onClick={() => useDocStore.getState().redo()}
        >
          ↻
        </IconButton>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <AutosaveIndicator />
        <IconButton label="Klavye kısayolları (?)" onClick={toggleShortcutsOverlay}>
          ?
        </IconButton>
        <button
          type="button"
          disabled={!sessionReady}
          className="rounded bg-accent px-3 py-1 text-xs font-semibold text-surface-0 hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
          onClick={() => setExportOpen(true)}
        >
          Dışa Aktar
        </button>
        <button
          type="button"
          className="rounded border border-edge px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-3 hover:text-fg"
          title="Oturumu kapat"
          onClick={() => {
            // Token temizlenir + sunucudaki refresh token'lar iptal edilir;
            // reload sonrası LoginGate'in cookie denemesi 401 alır -> giriş formu.
            void logout().then(() => window.location.reload());
          }}
        >
          Çıkış
        </button>
      </div>
      {sessionReady && projectId !== null && (
        <ExportDialog
          projectId={projectId}
          open={exportOpen}
          onClose={() => setExportOpen(false)}
        />
      )}
    </header>
  );
}

function IconButton({
  label,
  title,
  disabled,
  onClick,
  children,
}: {
  label: string;
  /** Ek açıklama (ör. neden devre dışı); yoksa label gösterilir. */
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      className="flex h-6 w-6 items-center justify-center rounded border border-edge text-xs text-fg-muted hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
