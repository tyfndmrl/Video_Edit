/**
 * exports entity — API call shapes + the job status flow driving the polling
 * policy (queued -> running -> succeeded/failed/canceled) with a mocked
 * apiClient, matching the projectSession.test.ts mocking pattern.
 *
 * NOT: fixture şekli backend/src/VideoEdit.Contracts/ExportDtos.cs ile senkron
 * tutulmalı (camelCase alan adları: id, projectId, status, profile,
 * progressPercent, progressStage, error, downloadUrl, createdAt, startedAt,
 * completedAt; stage anahtarları VideoEdit.Worker/Jobs/ExportJob.cs'ten:
 * download/compile/render/probe/upload/done/disk-wait).
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
  EXPORTS_POLL_MS,
  cancelJob,
  exportsRefetchInterval,
  getJob,
  isJobActive,
  jobRefetchInterval,
  listProjectExports,
  startExport,
  type ExportJobDto,
  type ExportJobStatusDto,
} from './exports';

const PROJECT = '01890000-0000-7000-8000-0000000000b1';
const JOB = '01890000-0000-7000-8000-0000000000c1';

function job(status: ExportJobStatusDto, overrides: Partial<ExportJobDto> = {}): ExportJobDto {
  return {
    id: JOB,
    projectId: PROJECT,
    status,
    profile: '1080p',
    progressPercent: 0,
    progressStage: 'download',
    error: null,
    downloadUrl: null,
    createdAt: '2026-08-07T10:00:00+00:00',
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('API call shapes', () => {
  it('startExport POSTs the profile to the project exports endpoint', async () => {
    apiFetchMock.mockResolvedValueOnce({ jobId: JOB });
    const res = await startExport(PROJECT, '1080p');
    expect(res.jobId).toBe(JOB);
    expect(apiFetchMock).toHaveBeenCalledWith(`/api/projects/${PROJECT}/exports`, {
      method: 'POST',
      body: { profile: '1080p' },
    });
  });

  it('startExport defaults to the 1080p profile', async () => {
    apiFetchMock.mockResolvedValueOnce({ jobId: JOB });
    await startExport(PROJECT);
    expect(apiFetchMock.mock.calls[0][1]).toEqual({ method: 'POST', body: { profile: '1080p' } });
  });

  it('getJob GETs the job endpoint', async () => {
    apiFetchMock.mockResolvedValueOnce(job('running'));
    const res = await getJob(JOB);
    expect(res.status).toBe('running');
    expect(apiFetchMock).toHaveBeenCalledWith(`/api/jobs/${JOB}`);
  });

  it('cancelJob POSTs to the cancel endpoint (204 -> void)', async () => {
    apiFetchMock.mockResolvedValueOnce(undefined);
    await expect(cancelJob(JOB)).resolves.toBeUndefined();
    expect(apiFetchMock).toHaveBeenCalledWith(`/api/jobs/${JOB}/cancel`, { method: 'POST' });
  });

  it('listProjectExports GETs the paged list', async () => {
    apiFetchMock.mockResolvedValueOnce({ items: [], page: 2, pageSize: 10, totalCount: 0 });
    const res = await listProjectExports(PROJECT, 2, 10);
    expect(res.page).toBe(2);
    expect(apiFetchMock).toHaveBeenCalledWith(
      `/api/projects/${PROJECT}/exports?page=2&pageSize=10`,
    );
  });
});

describe('job status flow -> polling policy', () => {
  it('classifies queued/running as active, terminal states as not', () => {
    expect(isJobActive('queued')).toBe(true);
    expect(isJobActive('running')).toBe(true);
    expect(isJobActive('succeeded')).toBe(false);
    expect(isJobActive('failed')).toBe(false);
    expect(isJobActive('canceled')).toBe(false);
  });

  it('polls a job through queued -> running -> succeeded and then stops', async () => {
    apiFetchMock
      .mockResolvedValueOnce(job('queued', { progressStage: null }))
      .mockResolvedValueOnce(job('running', { progressPercent: 42, progressStage: 'render' }))
      .mockResolvedValueOnce(
        job('succeeded', {
          progressPercent: 100,
          progressStage: 'done',
          downloadUrl: 'https://r2/export.mp4',
          completedAt: '2026-08-07T10:05:00+00:00',
        }),
      );

    const first = await getJob(JOB);
    expect(jobRefetchInterval(first)).toBe(EXPORTS_POLL_MS);

    const second = await getJob(JOB);
    expect(second.progressPercent).toBe(42);
    expect(jobRefetchInterval(second)).toBe(EXPORTS_POLL_MS);

    const third = await getJob(JOB);
    expect(third.downloadUrl).toBe('https://r2/export.mp4');
    expect(jobRefetchInterval(third)).toBe(false); // terminal -> polling stops
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });

  it('a failed job stops polling and carries the backend error field', async () => {
    apiFetchMock.mockResolvedValueOnce(
      job('failed', { error: 'Render worker crashed', downloadUrl: null }),
    );
    const res = await getJob(JOB);
    expect(res.error).toBe('Render worker crashed');
    expect(jobRefetchInterval(res)).toBe(false);
  });

  it('no data yet -> no interval decision (initial fetch is query-driven)', () => {
    expect(jobRefetchInterval(undefined)).toBe(false);
  });
});

describe('export list polling policy', () => {
  it('polls at 2 s while ANY job is active', () => {
    expect(exportsRefetchInterval([job('succeeded'), job('queued')])).toBe(EXPORTS_POLL_MS);
    expect(exportsRefetchInterval([job('running')])).toBe(EXPORTS_POLL_MS);
  });

  it('stops when every job is terminal (or the list is empty/unknown)', () => {
    expect(exportsRefetchInterval([job('succeeded'), job('failed'), job('canceled')])).toBe(false);
    expect(exportsRefetchInterval([])).toBe(false);
    expect(exportsRefetchInterval(undefined)).toBe(false);
  });
});
