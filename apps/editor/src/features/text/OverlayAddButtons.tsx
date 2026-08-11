/**
 * "Metin ekle" / "Şekil ekle" — the discoverable entry point for overlay
 * layers, rendered in the TopBar.
 *
 * Thin on purpose: placement policy is overlayActions, mutation is timelineOps.
 * The buttons are disabled exactly while the document cannot be mutated (project
 * loading), which is the same gate the timeline's +V/+A buttons use.
 */
import { useProjectSession } from '../../state/projectSession';
import { addShapeAtPlayhead, addTextAtPlayhead } from './overlayActions';

export function OverlayAddButtons() {
  const sessionReady = useProjectSession((s) => s.status) === 'ready';

  return (
    <div className="flex items-center gap-1">
      <OverlayButton
        testId="add-text-clip"
        title="Playhead'e metin katmanı ekle"
        disabled={!sessionReady}
        onClick={() => addTextAtPlayhead()}
      >
        Metin ekle
      </OverlayButton>
      <OverlayButton
        testId="add-shape-clip"
        title="Playhead'e şekil katmanı ekle"
        disabled={!sessionReady}
        onClick={() => addShapeAtPlayhead()}
      >
        Şekil ekle
      </OverlayButton>
    </div>
  );
}

function OverlayButton({
  testId,
  title,
  disabled,
  onClick,
  children,
}: {
  testId: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      disabled={disabled}
      className="rounded border border-edge px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
