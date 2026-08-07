/**
 * uploadEngine tests — headless: XMLHttpRequest is replaced with a scriptable
 * mock and the UploadApi port with an in-memory fake. Covers part splitting,
 * presign batching, ordered complete, retry/backoff, 403 re-presign, ETag
 * handling, pause/resume and cancel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UploadEngine,
  UploadError,
  type CompletedPart,
  type InitUploadResponse,
  type UploadApi,
  type UploadEngineOptions,
  type UploadProgress,
} from './uploadEngine';

// ---------------------------------------------------------------------------
// XHR mock
// ---------------------------------------------------------------------------

class MockXhr {
  static instances: MockXhr[] = [];

  method = '';
  url = '';
  body: Blob | null = null;
  status = 0;
  aborted = false;
  readonly upload: { onprogress: ((ev: { loaded: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private responseHeaders = new Map<string, string>();

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(): void {}

  getResponseHeader(name: string): string | null {
    return this.responseHeaders.get(name.toLowerCase()) ?? null;
  }

  send(body: unknown): void {
    this.body = body as Blob;
    MockXhr.instances.push(this);
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  // ---- test drivers ----
  succeed(etag: string | null): void {
    this.status = 200;
    if (etag !== null) this.responseHeaders.set('etag', `"${etag}"`);
    this.onload?.();
  }

  respondStatus(status: number): void {
    this.status = status;
    this.onload?.();
  }

  failNetwork(): void {
    this.onerror?.();
  }

  progress(loaded: number): void {
    this.upload.onprogress?.({ loaded });
  }
}

// ---------------------------------------------------------------------------
// Fake API
// ---------------------------------------------------------------------------

interface FakeApi {
  api: UploadApi;
  calls: {
    presign: number[][];
    complete: CompletedPart[][];
    abortCount: number;
  };
}

function makeApi(init: Partial<InitUploadResponse> = {}): FakeApi {
  const calls: FakeApi['calls'] = { presign: [], complete: [], abortCount: 0 };
  let presignSeq = 0;
  const api: UploadApi = {
    initUpload: async (_projectId, req) => {
      const partSize = init.partSize ?? 4;
      return {
        assetId: init.assetId ?? 'asset-1',
        uploadId: init.uploadId ?? 'upload-1',
        partSize,
        partCount: init.partCount ?? Math.max(1, Math.ceil(req.sizeBytes / partSize)),
      };
    },
    presignParts: async (_assetId, partNumbers) => {
      calls.presign.push([...partNumbers]);
      presignSeq++;
      return partNumbers.map((n) => ({
        partNumber: n,
        url: `https://r2.test/part-${n}?sig=${presignSeq}`,
      }));
    },
    completeUpload: async (_assetId, parts) => {
      calls.complete.push(parts.map((p) => ({ ...p })));
      return { status: 'uploaded' };
    },
    abortUpload: async () => {
      calls.abortCount++;
    },
    getUploadStatus: async () => ({ uploadId: 'upload-1', partSize: 4, uploadedParts: [] }),
  };
  return { api, calls };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitFor(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function makeFile(size: number): Blob {
  return new Blob([new Uint8Array(size)]);
}

function makeEngine(api: UploadApi, size: number, overrides: Partial<UploadEngineOptions> = {}) {
  return new UploadEngine({
    api,
    file: makeFile(size),
    fileName: 'clip.mp4',
    contentType: 'video/mp4',
    projectId: 'project-1',
    concurrency: 2,
    backoffBaseMs: 1,
    progressThrottleMs: 0,
    ...overrides,
  });
}

beforeEach(() => {
  MockXhr.instances = [];
  vi.stubGlobal('XMLHttpRequest', MockXhr as unknown as typeof XMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('uploadEngine — part splitting & complete', () => {
  it('splits the file by server partSize, uploads in parallel and completes with ordered parts', async () => {
    const { api, calls } = makeApi({ partSize: 4 });
    const progress: UploadProgress[] = [];
    const engine = makeEngine(api, 10, { onProgress: (p) => progress.push(p) });

    const done = engine.start();
    await waitFor(() => MockXhr.instances.length === 2, 'first two part PUTs');

    // 10 bytes / partSize 4 -> parts of 4, 4, 2; concurrency 2 -> parts 1+2 in flight
    const [x1, x2] = MockXhr.instances as [MockXhr, MockXhr];
    expect(x1.method).toBe('PUT');
    expect(x1.body!.size).toBe(4);
    expect(x2.body!.size).toBe(4);
    // one presign batch covering every part
    expect(calls.presign).toEqual([[1, 2, 3]]);

    // finish out of order: part 2 first
    x2.succeed('etag-2');
    await waitFor(() => MockXhr.instances.length === 3, 'third part PUT');
    const x3 = MockXhr.instances[2]!;
    expect(x3.body!.size).toBe(2);
    x1.succeed('etag-1');
    x3.succeed('etag-3');

    const result = await done;
    expect(result).toEqual({ status: 'completed' });
    expect(engine.phase).toBe('done');
    expect(engine.assetId).toBe('asset-1');
    // complete called once, parts ordered by partNumber regardless of finish order
    expect(calls.complete).toEqual([
      [
        { partNumber: 1, etag: 'etag-1' },
        { partNumber: 2, etag: 'etag-2' },
        { partNumber: 3, etag: 'etag-3' },
      ],
    ]);
    // progress reached 100%
    const last = progress.at(-1)!;
    expect(last.bytesUploaded).toBe(10);
    expect(last.totalBytes).toBe(10);
    expect(last.partsCompleted).toBe(3);
    expect(last.partCount).toBe(3);
  });

  it('batches presign requests at 20 part numbers per call', async () => {
    const { api, calls } = makeApi({ partSize: 1 });
    const engine = makeEngine(api, 25, { concurrency: 1 });
    const done = engine.start();

    for (let i = 1; i <= 25; i++) {
      await waitFor(() => MockXhr.instances.length === i, `part PUT #${i}`);
      MockXhr.instances[i - 1]!.succeed(`etag-${i}`);
    }
    await done;

    expect(calls.presign.length).toBe(2);
    expect(calls.presign[0]!.length).toBe(20);
    expect(calls.presign[0]).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(calls.presign[1]).toEqual([21, 22, 23, 24, 25]);
    expect(calls.complete[0]!.length).toBe(25);
  });
});

describe('uploadEngine — retry & re-presign', () => {
  it('retries a failed part with backoff and succeeds within 3 attempts', async () => {
    const { api, calls } = makeApi({ partSize: 4 });
    const engine = makeEngine(api, 4, { concurrency: 1 });
    const done = engine.start();

    await waitFor(() => MockXhr.instances.length === 1, 'attempt 1');
    MockXhr.instances[0]!.failNetwork();
    await waitFor(() => MockXhr.instances.length === 2, 'attempt 2');
    MockXhr.instances[1]!.failNetwork();
    await waitFor(() => MockXhr.instances.length === 3, 'attempt 3');
    MockXhr.instances[2]!.succeed('etag-1');

    const result = await done;
    expect(result.status).toBe('completed');
    expect(MockXhr.instances.length).toBe(3);
    expect(calls.complete).toEqual([[{ partNumber: 1, etag: 'etag-1' }]]);
  });

  it('fails the upload after 3 attempts on the same part', async () => {
    const { api, calls } = makeApi({ partSize: 4 });
    const engine = makeEngine(api, 4, { concurrency: 1 });
    const done = engine.start();
    // observe rejection immediately so no unhandled rejection is reported
    const outcome = done.then(
      () => 'resolved' as const,
      (err: unknown) => err,
    );

    for (let i = 1; i <= 3; i++) {
      await waitFor(() => MockXhr.instances.length === i, `attempt ${i}`);
      MockXhr.instances[i - 1]!.failNetwork();
    }

    const err = await outcome;
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe('part-failed');
    expect((err as UploadError).message).toMatch(/after 3 attempts/);
    expect(engine.phase).toBe('error');
    expect(calls.complete).toHaveLength(0);
    // a failed upload is NOT auto-aborted: parts stay resumable server-side
    expect(calls.abortCount).toBe(0);
  });

  it('re-presigns the part URL after a 403 (expired presigned URL)', async () => {
    const { api, calls } = makeApi({ partSize: 4 });
    const engine = makeEngine(api, 4, { concurrency: 1 });
    const done = engine.start();

    await waitFor(() => MockXhr.instances.length === 1, 'attempt 1');
    const firstUrl = MockXhr.instances[0]!.url;
    MockXhr.instances[0]!.respondStatus(403);

    await waitFor(() => MockXhr.instances.length === 2, 'attempt 2');
    const secondUrl = MockXhr.instances[1]!.url;
    expect(calls.presign.length).toBe(2);
    expect(calls.presign[1]).toEqual([1]);
    expect(secondUrl).not.toBe(firstUrl);

    MockXhr.instances[1]!.succeed('etag-1');
    const result = await done;
    expect(result.status).toBe('completed');
  });

  it('drops EVERY cached presigned URL after a 403 — the whole batch expires together', async () => {
    const { api, calls } = makeApi({ partSize: 4 });
    const engine = makeEngine(api, 8, { concurrency: 1 });
    const done = engine.start();

    // one presign batch [1, 2], all URLs carry sig=1
    await waitFor(() => MockXhr.instances.length === 1, 'part 1 attempt 1');
    expect(calls.presign).toEqual([[1, 2]]);
    expect(MockXhr.instances[0]!.url).toContain('sig=1');
    MockXhr.instances[0]!.respondStatus(403);

    // The next PUT (part 2, or part 1's retry — worker order is timing
    // dependent) must trigger ONE fresh presign batch covering BOTH parts:
    // part 2 must not burn an attempt on its equally-expired sig=1 URL.
    await waitFor(() => MockXhr.instances.length === 2, 'next part PUT');
    expect(calls.presign).toHaveLength(2);
    expect([...calls.presign[1]!].sort()).toEqual([1, 2]);
    expect(MockXhr.instances[1]!.url).toContain('sig=2');
    MockXhr.instances[1]!.succeed('etag-a');

    await waitFor(() => MockXhr.instances.length === 3, 'remaining part PUT');
    expect(MockXhr.instances[2]!.url).toContain('sig=2');
    MockXhr.instances[2]!.succeed('etag-b');

    const result = await done;
    expect(result.status).toBe('completed');
    expect(calls.presign).toHaveLength(2); // batch 2 served both remaining parts
  });

  it('fails fast with a CORS hint when the ETag header is unreadable', async () => {
    const { api, calls } = makeApi({ partSize: 4 });
    const engine = makeEngine(api, 4, { concurrency: 1 });
    const done = engine.start();
    const outcome = done.then(
      () => 'resolved' as const,
      (err: unknown) => err,
    );

    await waitFor(() => MockXhr.instances.length === 1, 'part PUT');
    MockXhr.instances[0]!.succeed(null); // 200 but no ETag header exposed

    const err = await outcome;
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe('etag-missing');
    expect((err as UploadError).message).toMatch(/ExposeHeaders/);
    // no silent retry — this is a configuration error
    expect(MockXhr.instances.length).toBe(1);
    expect(calls.complete).toHaveLength(0);
  });
});

describe('uploadEngine — pause / resume / cancel', () => {
  it('pause aborts in-flight parts, resume restarts them and keeps finished parts', async () => {
    const { api, calls } = makeApi({ partSize: 4 });
    const progress: UploadProgress[] = [];
    const phases: string[] = [];
    const engine = makeEngine(api, 12, {
      concurrency: 1,
      onProgress: (p) => progress.push(p),
      onPhaseChange: (p) => phases.push(p),
    });
    const done = engine.start();

    await waitFor(() => MockXhr.instances.length === 1, 'part 1 PUT');
    MockXhr.instances[0]!.succeed('etag-1');
    await waitFor(() => MockXhr.instances.length === 2, 'part 2 PUT');
    const x2 = MockXhr.instances[1]!;
    x2.progress(2);
    // completed part bytes + in-flight bytes
    expect(progress.at(-1)!.bytesUploaded).toBe(6);

    engine.pause();
    expect(engine.phase).toBe('paused');
    expect(x2.aborted).toBe(true);
    await tick();
    await tick();
    expect(MockXhr.instances.length).toBe(2); // nothing new while paused

    engine.resume();
    await waitFor(() => MockXhr.instances.length === 3, 'part 2 restart');
    const x2b = MockXhr.instances[2]!;
    expect(x2b.url).toContain('part-2'); // resumes from the interrupted part
    expect(x2b.body!.size).toBe(4); // restarted from the beginning of the part
    x2b.succeed('etag-2');
    await waitFor(() => MockXhr.instances.length === 4, 'part 3 PUT');
    MockXhr.instances[3]!.succeed('etag-3');

    const result = await done;
    expect(result.status).toBe('completed');
    // part 1 was uploaded exactly once
    const urls = MockXhr.instances.map((x) => new URL(x.url).pathname);
    expect(urls).toEqual(['/part-1', '/part-2', '/part-2', '/part-3']);
    expect(calls.complete).toEqual([
      [
        { partNumber: 1, etag: 'etag-1' },
        { partNumber: 2, etag: 'etag-2' },
        { partNumber: 3, etag: 'etag-3' },
      ],
    ]);
    expect(phases).toEqual(['preparing', 'uploading', 'paused', 'uploading', 'completing', 'done']);
  });

  it('cancel aborts in-flight parts and calls the abort endpoint', async () => {
    const { api, calls } = makeApi({ partSize: 4 });
    const engine = makeEngine(api, 12, { concurrency: 1 });
    const done = engine.start();

    await waitFor(() => MockXhr.instances.length === 1, 'part 1 PUT');
    const x1 = MockXhr.instances[0]!;
    await engine.cancel();

    expect(x1.aborted).toBe(true);
    const result = await done;
    expect(result).toEqual({ status: 'aborted' });
    expect(engine.phase).toBe('aborted');
    expect(calls.abortCount).toBe(1);
    expect(calls.complete).toHaveLength(0);
    await tick();
    expect(MockXhr.instances.length).toBe(1); // no further uploads
  });

  it('a pause->resume race does not burn part attempts (abort rejections are not failures)', async () => {
    const { api } = makeApi({ partSize: 4 });
    // maxAttemptsPerPart 1: if the abort rejection were counted as a failed
    // attempt, the upload would fail immediately instead of completing.
    const engine = makeEngine(api, 4, { concurrency: 1, maxAttemptsPerPart: 1 });
    const done = engine.start();
    await waitFor(() => MockXhr.instances.length === 1, 'part PUT');

    // pause() aborts the XHR; resume() runs before the abort rejection is
    // processed, so the rejection lands while phase is 'uploading' again.
    engine.pause();
    engine.resume();

    await waitFor(() => MockXhr.instances.length === 2, 'part restart');
    MockXhr.instances[1]!.succeed('etag-1');
    const result = await done;
    expect(result.status).toBe('completed');
    expect(engine.phase).toBe('done');
  });

  it('cancel during completing waits for the complete outcome and settles completed on success', async () => {
    const { api, calls } = makeApi({ partSize: 4 });
    let resolveComplete!: () => void;
    const realComplete = api.completeUpload;
    api.completeUpload = (assetId, parts) =>
      new Promise((resolve) => {
        resolveComplete = () => resolve(realComplete(assetId, parts));
      });
    const engine = makeEngine(api, 4, { concurrency: 1 });
    const done = engine.start();
    await waitFor(() => MockXhr.instances.length === 1, 'part PUT');
    MockXhr.instances[0]!.succeed('etag-1');
    await waitFor(() => engine.phase === 'completing', 'completing phase');

    const cancelled = engine.cancel();
    await tick();
    expect(engine.phase).toBe('completing'); // cancel parked on the complete outcome

    resolveComplete();
    await cancelled;
    const result = await done;
    expect(result).toEqual({ status: 'completed' }); // NOT counted as a cancel
    expect(engine.phase).toBe('done');
    expect(calls.complete).toHaveLength(1);
    expect(calls.abortCount).toBe(0);
  });

  it('cancel during completing settles aborted when the complete request fails', async () => {
    const { api, calls } = makeApi({ partSize: 4 });
    let rejectComplete!: (err: Error) => void;
    api.completeUpload = () =>
      new Promise((_resolve, reject) => {
        rejectComplete = reject;
      });
    const engine = makeEngine(api, 4, { concurrency: 1 });
    const done = engine.start();
    await waitFor(() => MockXhr.instances.length === 1, 'part PUT');
    MockXhr.instances[0]!.succeed('etag-1');
    await waitFor(() => engine.phase === 'completing', 'completing phase');

    const cancelled = engine.cancel();
    rejectComplete(new Error('boom'));
    await cancelled;

    const result = await done; // resolves aborted — no error card for a user cancel
    expect(result).toEqual({ status: 'aborted' });
    expect(engine.phase).toBe('aborted');
    await waitFor(() => calls.abortCount === 1, 'abort endpoint call');
  });

  it('cancel during init still aborts the created upload server-side', async () => {
    const { api, calls } = makeApi({ partSize: 4 });
    const engine = makeEngine(api, 4);
    const done = engine.start();
    // phase 'preparing': init response not yet processed
    void engine.cancel();
    const result = await done;
    expect(result).toEqual({ status: 'aborted' });
    await waitFor(() => calls.abortCount === 1, 'abort endpoint call');
    expect(MockXhr.instances.length).toBe(0); // no part was ever sent
  });
});
