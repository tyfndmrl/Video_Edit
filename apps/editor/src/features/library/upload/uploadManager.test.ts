/**
 * uploadManager tests — the glue layer: session persistence must be
 * best-effort (never poison a completed upload), the react-query invalidation
 * must land BEFORE the card is removed, and duplicate drops are rejected.
 *
 * uploadSessions and uploadApi are module-mocked; XHR auto-succeeds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../../app/queryClient';
import { useAssetStore } from '../../../state/assetStore';
import { startUpload, useUploadStore } from './uploadManager';
import { uploadApi } from './uploadApi';
import { deleteUploadSession, saveUploadSession } from './uploadSessions';

vi.mock('./uploadSessions', () => ({
  saveUploadSession: vi.fn(async () => {}),
  deleteUploadSession: vi.fn(async () => {}),
}));

vi.mock('./uploadApi', () => ({
  uploadApi: {
    initUpload: vi.fn(async (_projectId: string, req: { sizeBytes: number }) => ({
      assetId: 'asset-1',
      uploadId: 'upload-1',
      partSize: Math.max(1, req.sizeBytes),
      partCount: 1,
    })),
    presignParts: vi.fn(async (_assetId: string, partNumbers: number[]) =>
      partNumbers.map((n) => ({ partNumber: n, url: `https://r2.test/part-${n}` })),
    ),
    completeUpload: vi.fn(async () => ({ status: 'uploaded' })),
    abortUpload: vi.fn(async () => {}),
    getUploadStatus: vi.fn(async () => ({ uploadId: 'upload-1', partSize: 1, uploadedParts: [] })),
  },
}));

/** XHR stub whose part PUTs succeed on the next microtask. */
class AutoSuccessXhr {
  readonly upload = { onprogress: null as null | ((ev: { loaded: number }) => void) };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 200;
  open(): void {}
  setRequestHeader(): void {}
  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'etag' ? '"etag-1"' : null;
  }
  send(): void {
    queueMicrotask(() => this.onload?.());
  }
  abort(): void {
    this.onabort?.();
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitFor(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function makeFile(name = 'clip.mp4', lastModified = 1_700_000_000_000): File {
  return new File([new Uint8Array(4)], name, { type: 'video/mp4', lastModified });
}

const deleteSessionMock = vi.mocked(deleteUploadSession);
const saveSessionMock = vi.mocked(saveUploadSession);
const initUploadMock = vi.mocked(uploadApi.initUpload);

beforeEach(() => {
  vi.stubGlobal('XMLHttpRequest', AutoSuccessXhr as unknown as typeof XMLHttpRequest);
  useUploadStore.setState({ items: new Map() });
  useAssetStore.setState({ assets: new Map() });
  deleteSessionMock.mockClear();
  deleteSessionMock.mockImplementation(async () => {});
  saveSessionMock.mockClear();
  initUploadMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadManager — success path resilience', () => {
  it('follows the completed flow even when deleteUploadSession rejects', async () => {
    deleteSessionMock.mockRejectedValueOnce(new Error('IndexedDB is broken'));
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const localId = startUpload(makeFile(), 'p1');
    expect(localId).not.toBeNull();

    await waitFor(() => useUploadStore.getState().items.size === 0, 'card handed off');
    // completed flow, not the error flow:
    expect(useAssetStore.getState().assets.get('asset-1')?.status).toBe('uploaded');
    expect(useAssetStore.getState().assets.get('asset-1')?.progress).toBe(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects', 'p1', 'assets'] });
    expect(deleteSessionMock).toHaveBeenCalledWith('asset-1');
  });

  it('does not fail the upload when saveUploadSession rejects', async () => {
    saveSessionMock.mockRejectedValueOnce(new Error('quota exceeded'));
    startUpload(makeFile(), 'p1');
    await waitFor(() => useUploadStore.getState().items.size === 0, 'card handed off');
    expect(useAssetStore.getState().assets.get('asset-1')?.status).toBe('uploaded');
  });

  it('awaits invalidateQueries BEFORE removing the card (no gap/double-render)', async () => {
    let resolveInvalidate!: () => void;
    const invalidateSpy = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveInvalidate = resolve;
          }),
      );

    const localId = startUpload(makeFile(), 'p1')!;
    await waitFor(() => invalidateSpy.mock.calls.length === 1, 'invalidate call');

    // While the refetch is pending the card must still be visible.
    await tick();
    await tick();
    expect(useUploadStore.getState().items.has(localId)).toBe(true);

    resolveInvalidate();
    await waitFor(() => !useUploadStore.getState().items.has(localId), 'card removed');
  });
});

describe('uploadManager — duplicate drops', () => {
  it('rejects a second drop of the same active file and flags the existing card', async () => {
    // Keep the first upload parked in 'preparing' so it stays active.
    initUploadMock.mockImplementationOnce(() => new Promise(() => {}));
    const first = startUpload(makeFile('dup.mp4', 42), 'p1');
    expect(first).not.toBeNull();

    const second = startUpload(makeFile('dup.mp4', 42), 'p1');
    expect(second).toBeNull();
    expect(useUploadStore.getState().items.size).toBe(1);
    expect(useUploadStore.getState().items.get(first!)?.warning).toMatch(/zaten yükleniyor/i);

    // A DIFFERENT file (same name/size, different lastModified) is accepted.
    const third = startUpload(makeFile('dup.mp4', 43), 'p1');
    expect(third).not.toBeNull();
    expect(useUploadStore.getState().items.size).toBe(2);
  });
});
