/**
 * uploadSessions tests — run against fake-indexeddb (no browser needed).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  deleteUploadSession,
  getUploadSession,
  listUploadSessions,
  saveUploadSession,
  type UploadSessionRecord,
} from './uploadSessions';

function record(overrides: Partial<UploadSessionRecord>): UploadSessionRecord {
  return {
    assetId: 'asset-a',
    projectId: 'project-1',
    fileName: 'clip.mp4',
    fileSize: 1024,
    lastModified: 1700000000000,
    partSize: 64 * 1024 * 1024,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('uploadSessions', () => {
  it('saves, lists (per project, newest first), gets and deletes sessions', async () => {
    await saveUploadSession(record({ assetId: 'asset-a', projectId: 'p1', updatedAt: 1 }));
    await saveUploadSession(record({ assetId: 'asset-b', projectId: 'p1', updatedAt: 5 }));
    await saveUploadSession(record({ assetId: 'asset-c', projectId: 'p2', updatedAt: 3 }));

    const p1 = await listUploadSessions('p1');
    expect(p1.map((r) => r.assetId)).toEqual(['asset-b', 'asset-a']);

    const all = await listUploadSessions();
    expect(all.map((r) => r.assetId)).toEqual(['asset-b', 'asset-c', 'asset-a']);

    const got = await getUploadSession('asset-c');
    expect(got?.projectId).toBe('p2');

    // upsert semantics: same assetId overwrites
    await saveUploadSession(record({ assetId: 'asset-a', projectId: 'p1', updatedAt: 9 }));
    expect((await listUploadSessions('p1')).map((r) => r.assetId)).toEqual(['asset-a', 'asset-b']);

    await deleteUploadSession('asset-a');
    await deleteUploadSession('asset-b');
    await deleteUploadSession('asset-c');
    expect(await listUploadSessions()).toEqual([]);
    expect(await getUploadSession('asset-a')).toBeUndefined();
  });
});
