/**
 * Defensive bridge to editorStore's play-state API.
 *
 * The timeline feature owns editorStore, and `isPlaying` + `setIsPlaying`
 * HAVE landed there. The player still only CALLS that API through optional
 * access: today that optionality is purely defensive (it decouples the player
 * from the store's exact shape), not a missing-feature workaround.
 */
import { useEditorStore } from '../../state/editorStore';

interface PlayStateSlice {
  isPlaying?: boolean;
  setIsPlaying?: (playing: boolean) => void;
}

/** Mirror the engine's play state into editorStore (no-op only if the API were absent — defensive). */
export function setIsPlayingSafe(playing: boolean): void {
  const state = useEditorStore.getState() as unknown as PlayStateSlice;
  if (state.isPlaying === playing) return;
  state.setIsPlaying?.(playing);
}

/** Read isPlaying from an editorStore state object (undefined only for state objects without the slice). */
export function readIsPlaying(state: unknown): boolean | undefined {
  return (state as PlayStateSlice).isPlaying;
}

/**
 * Read userSeekSeq from an editorStore state object. The store types and
 * initializes `userSeekSeq` (state/editorStore.ts), so against the real store
 * this never returns undefined; the undefined leg is defensive, for state
 * objects without the slice. Intersection contract (A): setPlayheadUs with
 * source 'user' (the default) bumps userSeekSeq; 'engine' writes don't — so
 * comparing the seq across a subscription tells USER seeks apart from the
 * player's own clock forwarding.
 */
export function readUserSeekSeq(state: unknown): number | undefined {
  return (state as { userSeekSeq?: number }).userSeekSeq;
}
