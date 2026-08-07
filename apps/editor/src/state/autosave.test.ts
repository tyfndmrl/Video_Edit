import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineDoc } from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings } from './docStore';
import {
  createAutosaveController,
  type AutosaveController,
  type AutosaveState,
  type SaveOutcome,
} from './autosave';

const PROJECT_ID = '01890000-0000-7000-8000-000000000001';

interface SaveCall {
  baseRevision: number;
  doc: TimelineDoc;
  resolve: (outcome: SaveOutcome) => void;
  reject: (err: unknown) => void;
}

function makeHarness(opts: { auto?: SaveOutcome | null } = {}) {
  const doc = createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings });
  const calls: SaveCall[] = [];
  const states: AutosaveState[] = [];
  const controller: AutosaveController = createAutosaveController(5, {
    getDoc: () => doc,
    save: (baseRevision, snapshot) =>
      new Promise<SaveOutcome>((resolve, reject) => {
        const call: SaveCall = { baseRevision, doc: snapshot, resolve, reject };
        calls.push(call);
        if (opts.auto !== null && opts.auto !== undefined) resolve(opts.auto);
      }),
    onState: (s) => states.push(s),
  });
  return { controller, calls, states, doc };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('autosave debounce / maxWait', () => {
  it('saves 2 s after the last change (trailing debounce)', async () => {
    const h = makeHarness({ auto: { type: 'ok', revisionNumber: 6 } });
    h.controller.noteChange();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].baseRevision).toBe(5);
    expect(h.controller.getState().status).toBe('saved');
    expect(h.controller.getState().revision).toBe(6);
  });

  it('restarts the debounce on every change', async () => {
    const h = makeHarness({ auto: { type: 'ok', revisionNumber: 6 } });
    h.controller.noteChange();
    await vi.advanceTimersByTimeAsync(1_500);
    h.controller.noteChange();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
  });

  it('maxWait forces a save at 15 s under continuous mutation', async () => {
    const h = makeHarness({ auto: { type: 'ok', revisionNumber: 6 } });
    // A change every second keeps the 2 s debounce from ever firing.
    for (let i = 0; i < 15; i++) {
      h.controller.noteChange();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(h.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.calls[0].baseRevision).toBe(5);
  });
});

describe('autosave single-queue', () => {
  it('waits for the in-flight save; latest snapshot wins afterwards', async () => {
    const h = makeHarness({ auto: null }); // manual resolution
    h.controller.noteChange();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.calls).toHaveLength(1);
    expect(h.controller.getState().status).toBe('saving');

    // New changes while in flight must NOT start a second request.
    h.controller.noteChange();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls).toHaveLength(1);

    // First save lands -> the queued change fires immediately with the new revision.
    h.calls[0].resolve({ type: 'ok', revisionNumber: 6 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].baseRevision).toBe(6);

    h.calls[1].resolve({ type: 'ok', revisionNumber: 7 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState().status).toBe('saved');
    expect(h.controller.getState().revision).toBe(7);
  });
});

describe('autosave 409 conflict', () => {
  it('enters conflict state, stops saving, and resumes after resolution', async () => {
    const serverDoc = { fake: 'doc' };
    const h = makeHarness({
      auto: { type: 'conflict', revisionNumber: 9, timeline: serverDoc },
    });
    h.controller.noteChange();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.calls).toHaveLength(1);
    const state = h.controller.getState();
    expect(state.status).toBe('conflict');
    expect(state.conflict).toEqual({ revisionNumber: 9, timeline: serverDoc });

    // Further changes must not trigger saves while conflicted.
    h.controller.noteChange();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);

    // User loads the server doc -> autosave resumes from the server revision.
    h.controller.resolveConflictWithServerDoc(9);
    expect(h.controller.getState().status).toBe('saved');
    expect(h.controller.getState().revision).toBe(9);
    expect(h.controller.getState().conflict).toBeNull();

    h.controller.noteChange();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].baseRevision).toBe(9);
  });
});

describe('autosave deferTimers (transaction-aware, finding 8)', () => {
  it('noteChange under deferTimers marks dirty only; the post-commit noteChange arms the timers', async () => {
    let deferred = true;
    const doc = createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings });
    const calls: number[] = [];
    const controller = createAutosaveController(5, {
      getDoc: () => doc,
      save: (baseRevision) => {
        calls.push(baseRevision);
        return Promise.resolve({ type: 'ok', revisionNumber: 6 } as SaveOutcome);
      },
      deferTimers: () => deferred,
    });

    controller.noteChange();
    controller.noteChange();
    expect(controller.getState().status).toBe('dirty');
    expect(controller.pendingSnapshot()).not.toBeNull(); // page-hide still safe
    await vi.advanceTimersByTimeAsync(60_000); // way past debounce AND maxWait
    expect(calls).toHaveLength(0);

    deferred = false; // transaction committed
    controller.noteChange();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual([5]);
    expect(controller.getState().status).toBe('saved');
  });
});

describe('autosave errors', () => {
  it('marks error and retries after the retry interval', async () => {
    let failFirst = true;
    const doc = createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings });
    const calls: number[] = [];
    const controller = createAutosaveController(5, {
      getDoc: () => doc,
      save: (baseRevision) => {
        calls.push(baseRevision);
        if (failFirst) {
          failFirst = false;
          return Promise.resolve({ type: 'error', message: 'boom' } as SaveOutcome);
        }
        return Promise.resolve({ type: 'ok', revisionNumber: 6 } as SaveOutcome);
      },
    });

    controller.noteChange();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(1);
    expect(controller.getState().status).toBe('error');
    expect(controller.getState().errorMessage).toBe('boom');

    await vi.advanceTimersByTimeAsync(5_000); // retry window
    expect(calls).toHaveLength(2);
    expect(controller.getState().status).toBe('saved');
    expect(controller.getState().revision).toBe(6);
  });

  it('pendingSnapshot exposes unsaved work for the keepalive flush', async () => {
    const h = makeHarness({ auto: { type: 'ok', revisionNumber: 6 } });
    expect(h.controller.pendingSnapshot()).toBeNull();
    h.controller.noteChange();
    expect(h.controller.pendingSnapshot()).toEqual({ baseRevision: 5, doc: h.doc });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.controller.pendingSnapshot()).toBeNull();
  });
});
