/**
 * viewControl — a tiny registry the mounted TimelinePanel exposes so
 * keyboard shortcuts (+/-, Shift+Z) can drive viewport-aware zoom/fit
 * without the dispatcher knowing the canvas width.
 */
export interface TimelineViewControl {
  /** Multiply pxPerUs by `factor`, anchored at the viewport center. */
  zoomBy(factor: number): void;
  /** Fit the whole project into the viewport. */
  fitToProject(): void;
}

let control: TimelineViewControl | null = null;

export function registerTimelineViewControl(c: TimelineViewControl): () => void {
  control = c;
  return () => {
    if (control === c) control = null;
  };
}

export function getTimelineViewControl(): TimelineViewControl | null {
  return control;
}
