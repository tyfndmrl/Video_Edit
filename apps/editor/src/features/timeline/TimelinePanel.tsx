/** Timeline panel — hybrid canvas body + DOM overlay (M1/M2). Placeholder for M0. */
export function TimelinePanel() {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-edge bg-surface-2 px-3 py-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
        Timeline
      </header>
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-fg-muted">
        Canvas timeline (M1)
      </div>
    </div>
  );
}
