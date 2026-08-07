/**
 * uploadSessions recovery test — a failed IndexedDB open must NOT be cached
 * forever: the next call retries the open ('idb' is module-mocked here; the
 * happy-path tests against fake-indexeddb live in uploadSessions.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openDBMock = vi.hoisted(() => vi.fn());
vi.mock('idb', () => ({ openDB: openDBMock }));

const record = {
  assetId: 'asset-a',
  projectId: 'p1',
  fileName: 'clip.mp4',
  fileSize: 4,
  lastModified: 1,
  partSize: 4,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  vi.resetModules();
  openDBMock.mockReset();
  vi.stubGlobal('indexedDB', {}); // hasIndexedDb() gate
});

describe('uploadSessions — failed open is not cached', () => {
  it('retries openDB after a rejected open instead of replaying the rejection', async () => {
    const put = vi.fn(async () => {});
    openDBMock
      .mockRejectedValueOnce(new Error('open failed'))
      .mockResolvedValue({ put });

    const sessions = await import('./uploadSessions');

    await expect(sessions.saveUploadSession(record)).rejects.toThrow('open failed');
    // Second call must attempt a fresh open and succeed.
    await expect(sessions.saveUploadSession(record)).resolves.toBeUndefined();
    expect(openDBMock).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledWith('uploadSessions', record);
  });

  it('reuses one successful open across calls (no reset on success)', async () => {
    const put = vi.fn(async () => {});
    openDBMock.mockResolvedValue({ put });

    const sessions = await import('./uploadSessions');
    await sessions.saveUploadSession(record);
    await sessions.saveUploadSession(record);
    expect(openDBMock).toHaveBeenCalledTimes(1);
  });
});
