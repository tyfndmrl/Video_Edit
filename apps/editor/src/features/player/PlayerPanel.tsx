/** Preview player panel — WebGL2 compositor + <video> pool (M2). Placeholder for M0. */
export function PlayerPanel() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="flex aspect-video max-h-full w-full max-w-4xl items-center justify-center rounded border border-edge bg-black text-sm text-fg-muted">
          Player (M2)
        </div>
      </div>
      <div className="flex items-center justify-center gap-2 border-t border-edge bg-surface-2 px-3 py-1.5 text-xs text-fg-muted">
        <span className="font-mono">00:00:00:00</span>
      </div>
    </div>
  );
}
