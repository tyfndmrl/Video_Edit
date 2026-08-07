/** Inspector panel — selected clip properties, keyframe editor (M3). Placeholder for M0. */
export function InspectorPanel() {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-edge bg-surface-2 px-3 py-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
        Inspector
      </header>
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-fg-muted">
        No selection
      </div>
    </div>
  );
}
