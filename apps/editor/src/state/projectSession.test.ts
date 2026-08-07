/**
 * projectSession — open/close/switch behavior around the docStore lock and
 * autosave lifecycle (M2 chief-architect findings 1, 4, 10).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineDoc } from '@videoedit/timeline-schema';

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
import { disposeAutosave, getAutosaveController, useAutosaveStore } from './autosave';
import { closeProject, openProject, useProjectSession } from './projectSession';

const P1 = '01890000-0000-7000-8000-0000000000a1';
const P2 = '01890000-0000-7000-8000-0000000000a2';

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

/** Marker mutation so the autosave controller has unsaved work. */
function dirtyTheDoc(): void {
  useDocStore.getState().mutate('marker', 'Marker', (d) => {
    d.markers.push({ id: '01890000-0000-7000-8000-00000000abcd', timeUs: 0 });
  });
}

function putCalls(): { path: string; options: { method?: string; body?: unknown } }[] {
  return apiFetchMock.mock.calls
    .filter(([, options]) => (options as { method?: string } | undefined)?.method === 'PUT')
    .map(([path, options]) => ({ path: path as string, options: options as never }));
}

beforeEach(() => {
  disposeAutosave();
  closeProject();
  apiFetchMock.mockReset();
  useDocStore.getState().setLocked(false);
  useDocStore.getState().loadDoc(createEmptyDoc(P1, { ...defaultProjectSettings }));
  useAutosaveStore.setState({
    projectId: null,
    status: 'idle',
    revision: 0,
    lastSavedAt: null,
    errorMessage: null,
    conflict: null,
  });
});

afterEach(() => {
  disposeAutosave();
  closeProject();
});

describe('openProject success', () => {
  it('loads the server doc, adopts the revision and unlocks', async () => {
    apiFetchMock.mockResolvedValueOnce(detailFor(P1, 7));
    await openProject(P1);

    const session = useProjectSession.getState();
    expect(session.status).toBe('ready');
    expect(session.projectId).toBe(P1);
    expect(useDocStore.getState().doc.projectId).toBe(P1);
    expect(useDocStore.getState().locked).toBe(false);
    expect(useDocStore.getState().history).toHaveLength(0);
    expect(useAutosaveStore.getState().projectId).toBe(P1);
    expect(useAutosaveStore.getState().revision).toBe(7);
    expect(getAutosaveController()).not.toBeNull();
  });

  it('LOCKS the docStore during the fetch window (mutations refused, finding 1c)', async () => {
    let resolveFetch!: (v: unknown) => void;
    apiFetchMock.mockReturnValueOnce(new Promise((r) => (resolveFetch = r)));

    const opening = openProject(P1);
    expect(useProjectSession.getState().status).toBe('loading');
    expect(useDocStore.getState().locked).toBe(true);
    expect(() => dirtyTheDoc()).toThrow(/locked/); // dev: loud
    expect(useDocStore.getState().history).toHaveLength(0);

    resolveFetch(detailFor(P1, 3));
    await opening;
    expect(useDocStore.getState().locked).toBe(false);
    expect(useProjectSession.getState().status).toBe('ready');
    dirtyTheDoc(); // works again after ready
    expect(useDocStore.getState().history).toHaveLength(1);
  });

  it('a superseded open is fully ignored (newer call owns the session)', async () => {
    let resolveSlow!: (v: unknown) => void;
    apiFetchMock.mockReturnValueOnce(new Promise((r) => (resolveSlow = r))); // P1 (slow)
    apiFetchMock.mockResolvedValueOnce(detailFor(P2, 9)); // P2 (fast)

    const slow = openProject(P1);
    await openProject(P2);
    expect(useProjectSession.getState().projectId).toBe(P2);
    expect(useProjectSession.getState().status).toBe('ready');

    resolveSlow(detailFor(P1, 5));
    await slow;
    // P1's late arrival must not clobber P2.
    expect(useProjectSession.getState().projectId).toBe(P2);
    expect(useDocStore.getState().doc.projectId).toBe(P2);
    expect(useAutosaveStore.getState().projectId).toBe(P2);
    expect(useAutosaveStore.getState().revision).toBe(9);
  });
});

describe('unsaved-work flush before dispose (finding 4)', () => {
  it('closeProject PUTs the pending snapshot for the OLD project', async () => {
    apiFetchMock.mockResolvedValueOnce(detailFor(P1, 5));
    await openProject(P1);
    apiFetchMock.mockResolvedValue({ revisionNumber: 6 }); // the flush PUT
    dirtyTheDoc();

    closeProject();
    const puts = putCalls();
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe(`/api/projects/${P1}/timeline`);
    const body = puts[0].options.body as { baseRevision: number; timeline: TimelineDoc };
    expect(body.baseRevision).toBe(5);
    expect(body.timeline.markers).toHaveLength(1); // the unsaved edit went out
    expect(getAutosaveController()).toBeNull();
  });

  it('switching projects flushes the old project before arming the new one', async () => {
    apiFetchMock.mockImplementation((path: string, options?: unknown) => {
      const method = (options as { method?: string } | undefined)?.method ?? 'GET';
      if (method === 'PUT') return Promise.resolve({ revisionNumber: 6 });
      if (path === `/api/projects/${P1}`) return Promise.resolve(detailFor(P1, 5));
      if (path === `/api/projects/${P2}`) return Promise.resolve(detailFor(P2, 11));
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });

    await openProject(P1);
    dirtyTheDoc();
    await openProject(P2);

    const puts = putCalls();
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe(`/api/projects/${P1}/timeline`);
    expect((puts[0].options.body as { baseRevision: number }).baseRevision).toBe(5);
    expect(useAutosaveStore.getState().projectId).toBe(P2);
    expect(useAutosaveStore.getState().revision).toBe(11);
  });
});

describe('openProject error path (finding 10)', () => {
  it('disposes the previous autosave and resets to an empty doc for the failed project', async () => {
    apiFetchMock.mockImplementation((path: string, options?: unknown) => {
      const method = (options as { method?: string } | undefined)?.method ?? 'GET';
      if (method === 'PUT') return Promise.resolve({ revisionNumber: 6 });
      if (path === `/api/projects/${P1}`) return Promise.resolve(detailFor(P1, 5));
      return Promise.reject(new Error('boom: server down'));
    });

    await openProject(P1);
    dirtyTheDoc();
    await openProject(P2); // fails

    const session = useProjectSession.getState();
    expect(session.status).toBe('error');
    expect(session.error).toMatch(/boom/);
    // Old project must NOT stay live behind the error screen:
    expect(getAutosaveController()).toBeNull();
    expect(useDocStore.getState().doc.projectId).toBe(P2); // fresh empty doc
    expect(useDocStore.getState().doc.tracks).toHaveLength(0);
    expect(useDocStore.getState().doc.markers).toHaveLength(0);
    expect(useDocStore.getState().history).toHaveLength(0);
    expect(useDocStore.getState().locked).toBe(false);
    // ...and its unsaved work was flushed on the way out (finding 4).
    const puts = putCalls();
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe(`/api/projects/${P1}/timeline`);
  });
});

describe('openProject with an open transaction (finding 1d)', () => {
  it('the server doc is queued behind the gesture and applied at commit', async () => {
    // Start a gesture BEFORE the project opens (openProject locks new
    // transactions, so begin it first — this models a drag racing the load).
    const tx = useDocStore.getState().beginTransaction('trim', 'Klip kırpıldı');
    tx.update((d) => void (d.settings.width = 800));

    apiFetchMock.mockResolvedValueOnce(detailFor(P1, 7));
    await openProject(P1);

    // Fetch landed mid-gesture: the doc is still the gesture's.
    expect(useProjectSession.getState().status).toBe('ready');
    expect(useDocStore.getState().doc.settings.width).toBe(800);

    tx.commit();
    // Queued server doc applied, gesture history wiped with it.
    expect(useDocStore.getState().doc.projectId).toBe(P1);
    expect(useDocStore.getState().doc.settings.width).toBe(1920);
    expect(useDocStore.getState().history).toHaveLength(0);
  });
});
