/**
 * Defensive bridge to editorStore's play-state API.
 *
 * The timeline feature owns editorStore and is adding `isPlaying` +
 * `setIsPlaying` there. The player only CALLS that API — and tolerates it not
 * being present yet (optional access), so the two features can land in any
 * order.
 */
import { useEditorStore } from '../../state/editorStore';

interface PlayStateSlice {
  isPlaying?: boolean;
  setIsPlaying?: (playing: boolean) => void;
}

/** Mirror the engine's play state into editorStore (no-op until the API exists). */
export function setIsPlayingSafe(playing: boolean): void {
  const state = useEditorStore.getState() as unknown as PlayStateSlice;
  if (state.isPlaying === playing) return;
  state.setIsPlaying?.(playing);
}

/** Read isPlaying from an editorStore state object (undefined until it exists). */
export function readIsPlaying(state: unknown): boolean | undefined {
  return (state as PlayStateSlice).isPlaying;
}

/**
 * Read userSeekSeq from an editorStore state object (undefined until the
 * timeline feature lands it). Intersection contract (A): setPlayheadUs with
 * source 'user' (the default) bumps userSeekSeq; 'engine' writes don't — so
 * comparing the seq across a subscription tells USER seeks apart from the
 * player's own clock forwarding.
 */
export function readUserSeekSeq(state: unknown): number | undefined {
  return (state as { userSeekSeq?: number }).userSeekSeq;
}
