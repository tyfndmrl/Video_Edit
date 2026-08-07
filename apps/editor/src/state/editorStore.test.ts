/**
 * editorStore playhead write discipline (intersection contract A):
 * - setPlayheadUs(t, 'user') always wins and bumps userSeekSeq,
 * - 'engine' writes flow freely while playing,
 * - while PAUSED a stale 'engine' write arriving after a newer user seek is
 *   silently ignored; the pause-settle write (no user seek since the engine
 *   last owned the playhead) is accepted.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from './editorStore';

const US = 1_000_000;

beforeEach(() => {
  const s = useEditorStore.getState();
  s.setIsPlaying(true);
  s.setPlayheadUs(0, 'engine'); // engine owns the playhead again
  s.setIsPlaying(false);
  s.setPlayheadUs(0, 'engine'); // settle at 0 — accepted, re-syncs the gate
});

describe('user writes', () => {
  it('always apply and bump userSeekSeq (repeated same-time seeks included)', () => {
    const seq0 = useEditorStore.getState().userSeekSeq;
    useEditorStore.getState().setPlayheadUs(2 * US);
    expect(useEditorStore.getState().playheadUs).toBe(2 * US);
    expect(useEditorStore.getState().userSeekSeq).toBe(seq0 + 1);

    useEditorStore.getState().setPlayheadUs(2 * US); // same time, new intent
    expect(useEditorStore.getState().userSeekSeq).toBe(seq0 + 2);
  });

  it('default source is user (existing call sites keep their semantics)', () => {
    const seq0 = useEditorStore.getState().userSeekSeq;
    useEditorStore.getState().setPlayheadUs(US);
    expect(useEditorStore.getState().userSeekSeq).toBe(seq0 + 1);
  });

  it('clamps to >= 0 and rounds to integer microseconds', () => {
    useEditorStore.getState().setPlayheadUs(-5);
    expect(useEditorStore.getState().playheadUs).toBe(0);
    useEditorStore.getState().setPlayheadUs(10.6);
    expect(useEditorStore.getState().playheadUs).toBe(11);
  });
});

describe('engine writes', () => {
  it('flow freely while playing and do not bump userSeekSeq', () => {
    const s = useEditorStore.getState();
    s.setIsPlaying(true);
    const seq0 = useEditorStore.getState().userSeekSeq;
    s.setPlayheadUs(3 * US, 'engine');
    s.setPlayheadUs(4 * US, 'engine');
    expect(useEditorStore.getState().playheadUs).toBe(4 * US);
    expect(useEditorStore.getState().userSeekSeq).toBe(seq0);
  });

  it('a STALE engine write after a paused user seek is silently ignored', () => {
    const s = useEditorStore.getState();
    s.setIsPlaying(false);
    s.setPlayheadUs(5 * US); // user scrub while paused
    // Async settle from an OLDER seek lands late:
    s.setPlayheadUs(1 * US, 'engine');
    expect(useEditorStore.getState().playheadUs).toBe(5 * US); // user target holds
    // ...and it stays ignored until playback runs again.
    s.setPlayheadUs(2 * US, 'engine');
    expect(useEditorStore.getState().playheadUs).toBe(5 * US);
  });

  it('the pause-settle write (engine owned the playhead last) IS accepted', () => {
    const s = useEditorStore.getState();
    s.setIsPlaying(true);
    s.setPlayheadUs(3 * US, 'engine'); // clock tick while playing
    s.setIsPlaying(false);
    s.setPlayheadUs(3 * US + 100, 'engine'); // frame-snap settle right after pause
    expect(useEditorStore.getState().playheadUs).toBe(3 * US + 100);
  });

  it('playback after a user seek restores paused engine-write rights', () => {
    const s = useEditorStore.getState();
    s.setIsPlaying(false);
    s.setPlayheadUs(5 * US); // user seek: paused engine writes now blocked
    s.setPlayheadUs(9 * US, 'engine');
    expect(useEditorStore.getState().playheadUs).toBe(5 * US);

    s.setIsPlaying(true);
    s.setPlayheadUs(6 * US, 'engine'); // playing: flows, re-syncs the gate
    s.setIsPlaying(false);
    s.setPlayheadUs(6 * US + 33_333, 'engine'); // pause settle accepted again
    expect(useEditorStore.getState().playheadUs).toBe(6 * US + 33_333);
  });

  it('while playing, a user seek still wins the value it wrote until the next engine tick', () => {
    const s = useEditorStore.getState();
    s.setIsPlaying(true);
    s.setPlayheadUs(1 * US, 'engine');
    s.setPlayheadUs(8 * US); // user seek during playback
    expect(useEditorStore.getState().playheadUs).toBe(8 * US);
    s.setPlayheadUs(8 * US + 16_000, 'engine'); // engine follows — accepted
    expect(useEditorStore.getState().playheadUs).toBe(8 * US + 16_000);
  });
});
