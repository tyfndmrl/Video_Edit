/**
 * ShortcutsHelpOverlay — '?' tuşu / TopBar '?' butonuyla açılan kısayol
 * listesi. ConflictDialog/ExportDialog ile aynı hafif fixed-overlay deseni
 * (dialog kütüphanesi yok). Kapatma: buton, arka plana tıklama veya tekrar
 * '?' / Escape. Escape'i odak overlay içindeyken useModalFocus işler
 * (dispatcher'daki Escape dalı, odak dışarıda kalırsa devreye giren yedek).
 * Modal odak sözleşmesi (açılışta odak içeri, Tab tuzağı, kapanışta odağın
 * tetikleyiciye dönmesi) ortak useModalFocus hook'undan gelir ve a11y-smoke
 * e2e'de gerçek klavyeyle ölçülür.
 */
import { useModalFocus } from '../../lib/useModalFocus';
import {
  SHORTCUT_SECTIONS,
  closeShortcutsOverlay,
  useShortcutsOverlayStore,
} from './shortcutsHelp';

export function ShortcutsHelpOverlay() {
  const open = useShortcutsOverlayStore((s) => s.open);
  const { containerRef, onKeyDown } = useModalFocus(open, closeShortcutsOverlay);
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={closeShortcutsOverlay}
      onKeyDown={onKeyDown}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        className="max-h-[85vh] w-[34rem] overflow-y-auto rounded-lg border border-edge bg-surface-2 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 id="shortcuts-title" className="text-sm font-semibold text-fg">
            Klavye kısayolları
          </h2>
          <button
            type="button"
            aria-label="Kapat"
            className="rounded border border-edge px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-3 hover:text-fg"
            onClick={closeShortcutsOverlay}
          >
            Kapat (Esc)
          </button>
        </div>

        <div className="mt-3 flex flex-col gap-4">
          {SHORTCUT_SECTIONS.map((section) => (
            <section key={section.title}>
              <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
                {section.title}
              </h3>
              <ul className="flex flex-col gap-1">
                {section.entries.map((entry) => (
                  <li key={entry.keys} className="flex items-baseline gap-3 text-xs">
                    <kbd className="w-52 shrink-0 rounded border border-edge bg-surface-1 px-1.5 py-0.5 font-mono text-[11px] text-fg">
                      {entry.keys}
                    </kbd>
                    <span className="text-fg-muted">{entry.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <p className="mt-4 text-[11px] leading-snug text-fg-muted">
          Kısayollar bir yazı alanı odaktayken devre dışıdır.
        </p>
      </div>
    </div>
  );
}
