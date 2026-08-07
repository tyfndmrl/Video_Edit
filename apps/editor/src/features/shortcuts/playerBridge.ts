/**
 * playerBridge — lazy access to the playback engine for keyboard shortcuts.
 *
 * Integration contract (design 01 §4.1): the player feature exports
 * `getPlaybackEngine(): PlaybackEngine | null` from
 * src/features/player/engine.ts. The dispatcher resolves the engine PER
 * KEYPRESS (never caches an instance) and no-ops while it is null (player not
 * mounted / no project loaded).
 */
import type { MicroSec } from '@videoedit/timeline-schema';
import { getPlaybackEngine } from '../player/engine';

/** Structural subset of the design §4.1 PlaybackEngine the shortcuts need. */
export interface PlaybackEngineLike {
  play(): void;
  pause(): void;
  seek(timeUs: MicroSec, opts?: { precise: boolean }): Promise<void>;
  setPlaybackRate(rate: number): void;
}

let testEngine: PlaybackEngineLike | null | undefined;

/** Resolve the current engine, or null (player not mounted yet). */
export async function resolvePlaybackEngine(): Promise<PlaybackEngineLike | null> {
  if (testEngine !== undefined) return testEngine;
  return getPlaybackEngine();
}

/** Fire-and-forget helper for keydown handlers. */
export function withEngine(fn: (engine: PlaybackEngineLike) => void): void {
  void resolvePlaybackEngine().then((engine) => {
    if (engine) fn(engine);
  });
}

/** Test hook: inject a fake engine (pass undefined to restore real resolution). */
export function setPlaybackEngineForTests(engine: PlaybackEngineLike | null | undefined): void {
  testEngine = engine;
}
