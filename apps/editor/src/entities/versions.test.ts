/**
 * versions entity — API call shapes against a mocked apiClient (same pattern as
 * exports.test.ts / projectSession.test.ts).
 *
 * NOT: fixture şekli backend/src/VideoEdit.Contracts/ProjectDtos.cs ile senkron
 * tutulmalı (camelCase: id, revisionNumber, kind, label, createdBy, createdAt;
 * kind değerleri VideoEdit.Domain/Enums.cs'ten: Auto/Checkpoint/PreRestore).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn<(path: string, options?: unknown) => Promise<unknown>>(),
}));

vi.mock('./apiClient', () => {
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

import {
  CHECKPOINT_LABEL_MAX,
  createCheckpoint,
  getRevision,
  listRevisions,
  projectRevisionsQueryKey,
  restoreRevision,
  type RevisionMetaDto,
} from './versions';

const PROJECT = '01890000-0000-7000-8000-0000000000d1';

function revision(revisionNumber: number, kind: string, label: string | null = null): RevisionMetaDto {
  return {
    id: `01890000-0000-7000-8000-00000000e${revisionNumber.toString().padStart(3, '0')}`,
    revisionNumber,
    kind,
    label,
    createdBy: '01890000-0000-7000-8000-0000000000f1',
    createdAt: '2026-08-11T10:00:00+00:00',
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('API call shapes', () => {
  it('listRevisions GETs the paged revisions endpoint', async () => {
    apiFetchMock.mockResolvedValueOnce({
      items: [revision(2, 'Checkpoint', 'ilk kesim'), revision(1, 'Auto')],
      page: 1,
      pageSize: 50,
      totalCount: 2,
    });

    const res = await listRevisions(PROJECT);

    expect(apiFetchMock).toHaveBeenCalledWith(
      `/api/projects/${PROJECT}/revisions?page=1&pageSize=50`,
    );
    expect(res.items.map((r) => r.revisionNumber)).toEqual([2, 1]);
    expect(res.items[0]!.kind).toBe('Checkpoint');
  });

  it('listRevisions passes paging through', async () => {
    apiFetchMock.mockResolvedValueOnce({ items: [], page: 3, pageSize: 10, totalCount: 0 });
    await listRevisions(PROJECT, 3, 10);
    expect(apiFetchMock).toHaveBeenCalledWith(
      `/api/projects/${PROJECT}/revisions?page=3&pageSize=10`,
    );
  });

  it('getRevision GETs a single revision (timeline included)', async () => {
    apiFetchMock.mockResolvedValueOnce({ ...revision(7, 'Auto'), timeline: { schemaVersion: 1 } });
    const res = await getRevision(PROJECT, 7);
    expect(apiFetchMock).toHaveBeenCalledWith(`/api/projects/${PROJECT}/revisions/7`);
    expect(res.timeline).toEqual({ schemaVersion: 1 });
  });

  it('createCheckpoint POSTs the label', async () => {
    apiFetchMock.mockResolvedValueOnce(revision(4, 'Checkpoint', 'müzik öncesi'));
    const res = await createCheckpoint(PROJECT, 'müzik öncesi');
    expect(apiFetchMock).toHaveBeenCalledWith(`/api/projects/${PROJECT}/revisions`, {
      method: 'POST',
      body: { label: 'müzik öncesi' },
    });
    expect(res.revisionNumber).toBe(4);
  });

  it('createCheckpoint sends null for an absent label (backend accepts null)', async () => {
    apiFetchMock.mockResolvedValueOnce(revision(5, 'Checkpoint'));
    await createCheckpoint(PROJECT, null);
    expect(apiFetchMock).toHaveBeenCalledWith(`/api/projects/${PROJECT}/revisions`, {
      method: 'POST',
      body: { label: null },
    });
  });

  it('restoreRevision POSTs the target revision and returns the NEW state', async () => {
    apiFetchMock.mockResolvedValueOnce({ revisionNumber: 9, timeline: { schemaVersion: 1 } });
    const res = await restoreRevision(PROJECT, 4);
    expect(apiFetchMock).toHaveBeenCalledWith(`/api/projects/${PROJECT}/restore`, {
      method: 'POST',
      body: { revisionNumber: 4 },
    });
    // The response revision is the POST-restore revision (server bumps it), not
    // the requested one — the client must adopt THIS number.
    expect(res.revisionNumber).toBe(9);
  });
});

describe('query key', () => {
  it('is scoped per project', () => {
    expect(projectRevisionsQueryKey(PROJECT)).toEqual(['projects', PROJECT, 'revisions']);
    expect(projectRevisionsQueryKey('other')).not.toEqual(projectRevisionsQueryKey(PROJECT));
  });
});

describe('contract constants', () => {
  it('mirrors the backend label cap', () => {
    // ProjectEndpoints.CreateCheckpoint: label is { Length: > 200 } -> 400.
    expect(CHECKPOINT_LABEL_MAX).toBe(200);
  });
});
