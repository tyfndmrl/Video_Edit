/**
 * versionsActions — checkpoint/restore flows against the REAL docStore,
 * autosave controller and projectSession (only the HTTP layer is mocked), so
 * the lock window, the flush ordering and the undo-history clear are exercised
 * end to end. Same mocking shape as state/projectSession.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineDoc } from '@videoedit/timeline-schema';

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn<(path: string, options?: unknown) => Promise<unknown>>(),
}));

vi.mock('../../entities/apiClient', () => {
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

import { ApiError } from '../../entities/apiClient';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../state/docStore';
import { disposeAutosave, useAutosaveStore } from '../../state/autosave';
import { closeProject, openProject } from '../../state/projectSession';
import { createProjectCheckpoint, restoreProjectRevision } from './versionsActions';
import { useVersionsStore } from './versionsStore';

const P1 = '01890000-0000-7000-8000-0000000000a1';
const P2 = '01890000-0000-7000-8000-0000000000a2';
const MARKER_LOCAL = '01890000-0000-7000-8000-00000000aaaa';
const MARKER_RESTORED = '01890000-0000-7000-8000-00000000bbbb';

function docWithMarker(projectId: string, markerId: string): TimelineDoc {
  const doc = createEmptyDoc(projectId, { ...defaultProjectSettings });
  doc.markers.push({ id: markerId, timeUs: 0 });
  return doc;
}

function detailFor(projectId: string, revisionNumber: number, timeline?: TimelineDoc) {
  return {
    id: projectId,
    name: `Project ${projectId}`,
    revisionNumber,
    fpsNum: 30,
    fpsDen: 1,
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    timeline: timeline ?? createEmptyDoc(projectId, { ...defaultProjectSettings }),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Call {
  path: string;
  method: string;
  body: unknown;
}

/** Every apiFetch call in order — lets tests assert flush-BEFORE-action. */
let calls: Call[] = [];
/** Server revision counter; PUT/restore bump it like the real backend does. */
let serverRevision = 0;
/** Overrides for a specific route (deferred promises / failures). */
let restoreHandler: ((body: unknown) => Promise<unknown>) | null = null;
let putHandler: ((body: unknown) => Promise<unknown>) | null = null;
let checkpointHandler: ((body: unknown) => Promise<unknown>) | null = null;

function installRouter(): void {
  apiFetchMock.mockImplementation((path: string, options?: unknown) => {
    const opts = options as { method?: string; body?: unknown } | undefined;
    const method = opts?.method ?? 'GET';
    calls.push({ path, method, body: opts?.body });

    if (method === 'GET' && /^\/api\/projects\/[^/]+$/.test(path)) {
      const projectId = path.split('/').pop() as string;
      return Promise.resolve(detailFor(projectId, serverRevision));
    }
    if (method === 'PUT' && path.endsWith('/timeline')) {
      if (putHandler) return putHandler(opts?.body);
      serverRevision += 1;
      return Promise.resolve({ revisionNumber: serverRevision });
    }
    if (method === 'POST' && path.endsWith('/restore')) {
      if (restoreHandler) return restoreHandler(opts?.body);
      serverRevision += 1;
      return Promise.resolve({
        revisionNumber: serverRevision,
        timeline: docWithMarker(P1, MARKER_RESTORED),
      });
    }
    if (method === 'POST' && path.endsWith('/revisions')) {
      if (checkpointHandler) return checkpointHandler(opts?.body);
      return Promise.resolve({
        id: 'rev-1',
        revisionNumber: serverRevision,
        kind: 'Checkpoint',
        label: (opts?.body as { label?: string | null } | undefined)?.label ?? null,
        createdBy: 'user-1',
        createdAt: '2026-08-11T10:00:00+00:00',
      });
    }
    return Promise.reject(new Error(`Unrouted ${method} ${path}`));
  });
}

/** Local edit so autosave has unsaved work (and the undo history is non-empty). */
function dirtyTheDoc(markerId = MARKER_LOCAL): void {
  useDocStore.getState().mutate('marker', 'Marker', (d) => {
    d.markers.push({ id: markerId, timeUs: 0 });
  });
}

function markerIds(): string[] {
  return useDocStore.getState().doc.markers.map((m) => m.id);
}

function callsTo(suffix: string): Call[] {
  return calls.filter((c) => c.path.endsWith(suffix));
}

beforeEach(async () => {
  disposeAutosave();
  closeProject();
  apiFetchMock.mockReset();
  calls = [];
  serverRevision = 1;
  restoreHandler = null;
  putHandler = null;
  checkpointHandler = null;
  useVersionsStore.setState({ open: true, busy: null, error: null, notice: null });
  useDocStore.getState().setLocked(false);
  installRouter();
  await openProject(P1);
  calls = [];
});

afterEach(() => {
  // Kills the autosave debounce/retry timers so a failed save's 5 s retry does
  // not fire into the next test.
  disposeAutosave();
  closeProject();
  useDocStore.getState().setLocked(false);
});

describe('restoreProjectRevision — happy path', () => {
  it('flushes unsaved work, restores, replaces the doc and clears the undo history', async () => {
    dirtyTheDoc();
    expect(useDocStore.getState().history.length).toBe(1);
    expect(useAutosaveStore.getState().status).toBe('dirty');

    const ok = await restoreProjectRevision(P1, 1);

    expect(ok).toBe(true);
    // Ordering is the whole point: the PUT must land BEFORE the restore, or the
    // PreRestore snapshot the server takes would miss the unsaved work.
    const order = calls.map((c) => `${c.method} ${c.path.replace(`/api/projects/${P1}`, '')}`);
    expect(order).toEqual(['PUT /timeline', 'POST /restore']);
    expect(callsTo('/restore')[0]!.body).toEqual({ revisionNumber: 1 });

    // Server document adopted…
    expect(markerIds()).toEqual([MARKER_RESTORED]);
    // …undo history cleared (loadDoc semantics)…
    expect(useDocStore.getState().history).toEqual([]);
    expect(useDocStore.getState().cursor).toBe(0);
    // …autosave re-based on the NEW revision, not dirty.
    expect(useAutosaveStore.getState().revision).toBe(serverRevision);
    expect(useAutosaveStore.getState().status).toBe('idle');
    // …and the editor is usable again.
    expect(useDocStore.getState().locked).toBe(false);

    const ui = useVersionsStore.getState();
    expect(ui.busy).toBeNull();
    expect(ui.error).toBeNull();
    expect(ui.notice).toMatch(/1 numaralı sürüme dönüldü/);
  });

  it('skips the flush when there is nothing unsaved', async () => {
    await restoreProjectRevision(P1, 1);
    expect(callsTo('/timeline')).toHaveLength(0);
    expect(callsTo('/restore')).toHaveLength(1);
  });
});

describe('restoreProjectRevision — the editor is locked for the whole operation', () => {
  it('locks the document store until the server document is adopted', async () => {
    const gate = deferred<unknown>();
    restoreHandler = () => gate.promise;

    dirtyTheDoc();
    const pending = restoreProjectRevision(P1, 1);
    // Let the flush PUT settle so we are parked on the restore request.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(useDocStore.getState().locked).toBe(true);
    expect(useVersionsStore.getState().busy).toBe('restore');
    // The lock is not decorative: doc mutations are refused (throws in DEV).
    expect(() => dirtyTheDoc('01890000-0000-7000-8000-00000000cccc')).toThrow(/locked/i);
    expect(() => useDocStore.getState().undo()).toThrow(/locked/i);

    serverRevision += 1;
    gate.resolve({ revisionNumber: serverRevision, timeline: docWithMarker(P1, MARKER_RESTORED) });
    await pending;

    expect(useDocStore.getState().locked).toBe(false);
  });

  it('releases the lock when the restore request fails, leaving the doc untouched', async () => {
    restoreHandler = () => Promise.reject(new ApiError(500, '/restore', 'boom'));
    dirtyTheDoc();
    const before = markerIds();

    const ok = await restoreProjectRevision(P1, 1);

    expect(ok).toBe(false);
    expect(markerIds()).toEqual(before);
    expect(useDocStore.getState().locked).toBe(false);
    expect(useVersionsStore.getState().busy).toBeNull();
    expect(useVersionsStore.getState().error).toMatch(/Doküman değişmedi/);
  });

  it('refuses a second restore while one is in flight', async () => {
    const gate = deferred<unknown>();
    restoreHandler = () => gate.promise;

    const first = restoreProjectRevision(P1, 1);
    await Promise.resolve();
    const second = await restoreProjectRevision(P1, 1);

    expect(second).toBe(false);
    serverRevision += 1;
    gate.resolve({ revisionNumber: serverRevision, timeline: docWithMarker(P1, MARKER_RESTORED) });
    await first;
    expect(callsTo('/restore')).toHaveLength(1);
  });
});

describe('restoreProjectRevision — autosave gate', () => {
  it('refuses while a 409 conflict is unresolved (and never calls restore)', async () => {
    // Real path into 'conflict': the flush PUT comes back 409.
    putHandler = () =>
      Promise.reject(
        new ApiError(409, '/timeline', 'conflict', {
          revisionNumber: 99,
          timeline: createEmptyDoc(P1, { ...defaultProjectSettings }),
        }),
      );
    dirtyTheDoc();
    await restoreProjectRevision(P1, 1); // first attempt drives autosave into 'conflict'
    expect(useAutosaveStore.getState().status).toBe('conflict');
    calls = [];

    const ok = await restoreProjectRevision(P1, 1);

    expect(ok).toBe(false);
    expect(callsTo('/restore')).toHaveLength(0);
    expect(useVersionsStore.getState().error).toMatch(/başka bir sekmede değiştirildi/);
    expect(useDocStore.getState().locked).toBe(false);
  });

  it('refuses when the flush itself fails (unsaved work would be destroyed)', async () => {
    putHandler = () => Promise.reject(new ApiError(500, '/timeline', 'boom'));
    dirtyTheDoc();

    const ok = await restoreProjectRevision(P1, 1);

    expect(ok).toBe(false);
    expect(callsTo('/restore')).toHaveLength(0);
    expect(useVersionsStore.getState().error).toMatch(/kurtarılamaz/);
    expect(useDocStore.getState().locked).toBe(false);
  });
});

describe('restoreProjectRevision — superseded operation', () => {
  it('does not adopt a stale document after the project changed', async () => {
    const gate = deferred<unknown>();
    restoreHandler = () => gate.promise;

    const pending = restoreProjectRevision(P1, 1);
    await Promise.resolve();
    await Promise.resolve();

    // The user goes back to the picker mid-restore.
    closeProject();
    await openProject(P2);
    const afterSwitch = markerIds();

    gate.resolve({ revisionNumber: 42, timeline: docWithMarker(P1, MARKER_RESTORED) });
    const ok = await pending;

    expect(ok).toBe(false);
    // P1's restored document must NOT land on top of P2's.
    expect(markerIds()).toEqual(afterSwitch);
    expect(useAutosaveStore.getState().revision).not.toBe(42);
    expect(useVersionsStore.getState().busy).toBeNull();
  });
});

describe('createProjectCheckpoint', () => {
  it('flushes first so the checkpoint captures what the user sees', async () => {
    dirtyTheDoc();

    const ok = await createProjectCheckpoint(P1, '  ilk kesim  ');

    expect(ok).toBe(true);
    const order = calls.map((c) => `${c.method} ${c.path.replace(`/api/projects/${P1}`, '')}`);
    expect(order).toEqual(['PUT /timeline', 'POST /revisions']);
    expect(callsTo('/revisions')[0]!.body).toEqual({ label: 'ilk kesim' });
    expect(useVersionsStore.getState().notice).toMatch(/"ilk kesim"/);
  });

  it('sends null for an empty label', async () => {
    await createProjectCheckpoint(P1, '   ');
    expect(callsTo('/revisions')[0]!.body).toEqual({ label: null });
  });

  it('rejects an over-long label without any request', async () => {
    const ok = await createProjectCheckpoint(P1, 'x'.repeat(201));
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(useVersionsStore.getState().error).toMatch(/200/);
  });

  it('does NOT touch the document (no lock, no history clear)', async () => {
    dirtyTheDoc();
    const before = markerIds();

    await createProjectCheckpoint(P1, 'etiket');

    expect(markerIds()).toEqual(before);
    expect(useDocStore.getState().history.length).toBe(1);
    expect(useDocStore.getState().locked).toBe(false);
  });

  it('reports a failed checkpoint', async () => {
    checkpointHandler = () => Promise.reject(new ApiError(404, '/revisions', 'gone'));
    const ok = await createProjectCheckpoint(P1, 'etiket');
    expect(ok).toBe(false);
    expect(useVersionsStore.getState().error).toMatch(/Proje bulunamadı/);
  });
});
