/**
 * projects entity — API çağrı şekilleri (mock apiFetch, exports.test.ts
 * deseni). Fixture alanları backend/src/VideoEdit.Contracts/ProjectDtos.cs
 * ProjectSummaryDto ile senkron tutulmalı (camelCase).
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
  NEW_PROJECT_DEFAULTS,
  createProject,
  listProjects,
  type ProjectSummaryDto,
} from './projects';

const PROJECT = '01890000-0000-7000-8000-0000000000d1';

function summary(overrides: Partial<ProjectSummaryDto> = {}): ProjectSummaryDto {
  return {
    id: PROJECT,
    name: 'Tanıtım filmi',
    revisionNumber: 3,
    fpsNum: 30,
    fpsDen: 1,
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    createdAt: '2026-08-07T10:00:00+00:00',
    updatedAt: '2026-08-07T11:30:00+00:00',
    ...overrides,
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('listProjects', () => {
  it('GETs the paged list with defaults (page 1, pageSize 50)', async () => {
    apiFetchMock.mockResolvedValueOnce({ items: [summary()], page: 1, pageSize: 50, totalCount: 1 });
    const res = await listProjects();
    expect(res.items).toHaveLength(1);
    expect(res.items[0].name).toBe('Tanıtım filmi');
    expect(apiFetchMock).toHaveBeenCalledWith('/api/projects?page=1&pageSize=50');
  });

  it('passes explicit paging through', async () => {
    apiFetchMock.mockResolvedValueOnce({ items: [], page: 2, pageSize: 10, totalCount: 12 });
    const res = await listProjects(2, 10);
    expect(res.totalCount).toBe(12);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/projects?page=2&pageSize=10');
  });
});

describe('createProject', () => {
  it('POSTs the name together with the 1080p30/48kHz defaults', async () => {
    apiFetchMock.mockResolvedValueOnce(summary({ revisionNumber: 0 }));
    const res = await createProject('Tanıtım filmi');
    expect(res.id).toBe(PROJECT);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/projects', {
      method: 'POST',
      body: {
        name: 'Tanıtım filmi',
        fpsNum: 30,
        fpsDen: 1,
        width: 1920,
        height: 1080,
        audioSampleRate: 48000,
      },
    });
  });

  it('defaults stay in sync with the backend contract values', () => {
    expect(NEW_PROJECT_DEFAULTS).toEqual({
      fpsNum: 30,
      fpsDen: 1,
      width: 1920,
      height: 1080,
      audioSampleRate: 48000,
    });
  });
});
