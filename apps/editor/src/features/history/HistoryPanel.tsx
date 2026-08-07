/**
 * HistoryPanel — "İşlem Geçmişi" listesi (Inspector paneli bölümü).
 *
 * docStore'un history + cursor'ına abone olur ve ters kronolojik (en yeni
 * üstte) bir liste çizer. Satıra tıklamak docStore.jumpTo(index) ile o noktaya
 * atlar; bu HEM geri HEM ileri çalışır (cursor = index + 1). Mevcut konumun
 * üstündeki, yani geri alınmış girdiler soluk gösterilir.
 *
 * Performans: history 200 girdiye kadar çıkabilir (HISTORY_LIMIT). Sanallaştırma
 * yok; bunun yerine granüler selector'lar (history / cursor / transactionOpen)
 * ve useMemo ile satır modeli yalnız gerçekten değiştiğinde yeniden türetilir —
 * doc her mutasyonda değişse de bu panel yeniden render edilmez.
 */
import { useMemo } from 'react';
import { useDocStore } from '../../state/docStore';
import { buildHistoryRows, historyRowHint, type HistoryRow } from './historyLogic';

export function HistoryPanel() {
  // Granular selectors: `doc` deliberately NOT selected — it changes on every
  // pointermove during a drag, while history/cursor change once per commit.
  const history = useDocStore((s) => s.history);
  const cursor = useDocStore((s) => s.cursor);
  // jumpTo throws while a gesture is open (docStore.assertNoActiveTransaction);
  // disable the rows instead of letting a click blow up mid-drag.
  const transactionOpen = useDocStore((s) => s.transactionOpen);

  const rows = useMemo(() => buildHistoryRows(history, cursor), [history, cursor]);

  if (rows.length === 0) {
    return <p className="px-3 py-2 text-xs text-fg-muted">Henüz işlem yok.</p>;
  }

  return (
    <ol className="flex flex-col gap-0.5 px-2 py-2">
      {rows.map((row) => (
        <HistoryRowItem key={row.index} row={row} disabled={transactionOpen} />
      ))}
    </ol>
  );
}

function HistoryRowItem({ row, disabled }: { row: HistoryRow; disabled: boolean }) {
  const hint = historyRowHint(row);
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        aria-current={row.current ? 'step' : undefined}
        title={`${row.label} — ${hint}`}
        className={[
          'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs',
          'disabled:pointer-events-none disabled:opacity-50',
          row.current
            ? 'bg-surface-3 font-semibold text-fg'
            : row.undone
              ? 'text-fg-muted opacity-50 hover:bg-surface-2 hover:opacity-80'
              : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
        ].join(' ')}
        onClick={() => useDocStore.getState().jumpTo(row.index)}
      >
        {/* Fixed-width gutter so labels stay aligned; only the current row
            paints a marker (a transparent glyph would leak into copied text). */}
        <span aria-hidden="true" className="w-2 shrink-0 text-center text-[10px] leading-none text-accent">
          {row.current ? '▶' : ''}
        </span>
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        {row.time !== '' && (
          <span className="shrink-0 font-mono text-[10px] text-fg-muted">{row.time}</span>
        )}
      </button>
    </li>
  );
}
