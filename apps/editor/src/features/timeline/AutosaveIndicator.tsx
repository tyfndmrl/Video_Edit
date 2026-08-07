/** Autosave status chip for the timeline top bar (saved / saving / error / conflict). */
import { useAutosaveStore } from '../../state/autosave';

export function AutosaveIndicator() {
  const status = useAutosaveStore((s) => s.status);
  const errorMessage = useAutosaveStore((s) => s.errorMessage);

  let text: string;
  let cls: string;
  switch (status) {
    case 'saving':
    case 'dirty':
      text = 'Kaydediliyor…';
      cls = 'text-amber-400 border-amber-400/40';
      break;
    case 'saved':
      text = 'Kaydedildi';
      cls = 'text-emerald-400 border-emerald-400/40';
      break;
    case 'error':
      text = 'Kaydedilemedi';
      cls = 'text-danger border-danger/40';
      break;
    case 'conflict':
      text = 'Çakışma';
      cls = 'text-danger border-danger/40';
      break;
    default:
      text = '—';
      cls = 'text-fg-muted border-edge';
  }

  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${cls}`}
      title={status === 'error' ? (errorMessage ?? undefined) : undefined}
    >
      {text}
    </span>
  );
}
