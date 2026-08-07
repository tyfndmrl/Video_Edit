/**
 * autosave app wiring — initAutosave's docStore subscription and page-hide
 * hooks (M2 chief-architect findings 7 + 8):
 * - transaction-aware: mid-gesture updates only mark dirty; the PUT timers arm
 *   when the transaction commits (no half-finished drag ever hits the server),
 * - visibilitychange 'hidden' flushes through the NORMAL fetch path,
 * - a loadDoc application (loadSeq bump) never marks the doc dirty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn<(path: string, options?: unknown) => Promise<unknown>>(),
}));

vi.mock('../entities/apiClient', () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly path: string,
      message: string,
      readonly body?: unknown,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return { apiFetch: apiFetchMock, ApiError };
});

import { createEmptyDoc, defaultProjectSettings, useDocStore } from './docStore';
import { disposeAutosave, initAutosave, useAutosaveStore } from './autosave';

const P1 = '01890000-0000-7000-8000-0000000000b1';

type Listener = () => void;

/** Minimal document/window stand-ins (node test env — no jsdom needed). */
function stubPageGlobals(): {
  fireVisibility: (state: 'hidden' | 'visible') => void;
} {
  const docListeners = new Map<string, Set<Listener>>();
  const fakeDocument = {
    visibilityState: 'visible' as 'hidden' | 'visible',
    addEventListener: (type: string, fn: Listener) => {
      const set = docListeners.get(type) ?? new Set<Listener>();
      set.add(fn);
      docListeners.set(type, set);
    },
    removeEventListener: (type: string, fn: Listener) => {
      docListeners.get(type)?.delete(fn);
    },
  };
  const fakeWindow = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('window', fakeWindow);
  return {
    fireVisibility(state) {
      fakeDocument.visibilityState = state;
      for (const fn of docListeners.get('visibilitychange') ?? []) fn();
    },
  };
}

function putCalls(): { path: string; body: { baseRevision: number; timeline: unknown } }[] {
  return apiFetchMock.mock.calls
    .filter(([, options]) => (options as { method?: string } | undefined)?.method === 'PUT')
    .map(([path, options]) => ({
      path: path as string,
      body: (options as { body: { baseRevision: number; timeline: unknown } }).body,
    }));
}

function editDoc(width: number): void {
  useDocStore.getState().mutate('w', 'Width', (d) => void (d.settings.width = width));
}

beforeEach(() => {
  vi.useFakeTimers();
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ revisionNumber: 6 });
  useDocStore.getState().setLocked(false);
  useDocStore.getState().loadDoc(createEmptyDoc(P1, { ...defaultProjectSettings }));
});

afterEach(() => {
  disposeAutosave();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('transaction-aware autosave (finding 8)', () => {
  it('mid-transaction updates mark dirty WITHOUT arming timers; commit arms them once', async () => {
    initAutosave(P1, 5);

    const tx = useDocStore.getState().beginTransaction('trim', 'Klip kırpıldı');
    tx.update((d) => void (d.settings.width = 801));
    tx.update((d) => void (d.settings.width = 802));
    tx.update((d) => void (d.settings.width = 803));

    // Status shows dirty (indicator), but NOTHING is sent mid-gesture even far
    // beyond debounce+maxWait.
    expect(useAutosaveStore.getState().status).toBe('dirty');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(putCalls()).toHaveLength(0);

    tx.commit();
    await vi.advanceTimersByTimeAsync(2_000); // trailing debounce after commit
    const puts = putCalls();
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe(`/api/projects/${P1}/timeline`);
    expect((puts[0].body.timeline as { settings: { width: number } }).settings.width).toBe(803);
  });

  it('an aborted empty gesture does not schedule anything', async () => {
    initAutosave(P1, 5);
    const tx = useDocStore.getState().beginTransaction('move', 'Klipler taşındı');
    tx.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(putCalls()).toHaveLength(0);
  });
});

describe('background flush via visibilitychange (finding 7)', () => {
  it("'hidden' flushes dirty work through the normal fetch path and adopts the new revision", async () => {
    const page = stubPageGlobals();
    initAutosave(P1, 5);
    editDoc(1281);

    page.fireVisibility('hidden');
    await vi.advanceTimersByTimeAsync(0); // let the save promise settle

    const puts = putCalls();
    expect(puts).toHaveLength(1);
    expect(puts[0].body.baseRevision).toBe(5);
    // Normal save path: revision adopted, so a comeback tab keeps saving cleanly.
    expect(useAutosaveStore.getState().revision).toBe(6);
    expect(useAutosaveStore.getState().status).toBe('saved');

    // No further PUT without new edits.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(putCalls()).toHaveLength(1);
  });

  it("'hidden' with nothing dirty sends nothing", async () => {
    const page = stubPageGlobals();
    initAutosave(P1, 5);
    page.fireVisibility('hidden');
    await vi.advanceTimersByTimeAsync(0);
    expect(putCalls()).toHaveLength(0);
  });
});

describe('loadDoc never marks dirty (loadSeq discipline)', () => {
  it('a plain loadDoc (no suppression wrapper) does not trigger a save', async () => {
    initAutosave(P1, 5);
    useDocStore.getState().loadDoc(createEmptyDoc(P1, { ...defaultProjectSettings }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(putCalls()).toHaveLength(0);
    expect(useAutosaveStore.getState().status).toBe('idle');
  });
});

describe('dispose flush (finding 4, wiring level)', () => {
  it('disposeAutosave PUTs the pending snapshot once', async () => {
    initAutosave(P1, 5);
    editDoc(1440);
    disposeAutosave();
    const puts = putCalls();
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe(`/api/projects/${P1}/timeline`);
    expect(puts[0].body.baseRevision).toBe(5);
    // The dead controller's timers must not fire a second PUT afterwards.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(putCalls()).toHaveLength(1);
  });
});
