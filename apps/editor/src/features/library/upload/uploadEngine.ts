/**
 * uploadEngine — browser -> R2 multipart upload engine (M1).
 *
 * DECISION: custom engine instead of Uppy (@uppy/aws-s3).
 * The backend contract (design 02 §1.3/§1.4 as implemented for M1) dictates a
 * fixed server-issued partSize (R2 requires all parts equal-sized) and a
 * batched presign endpoint (max 20 part numbers per request). Uppy computes
 * its own chunk sizes and signs parts one at a time, so adapting it means
 * fighting its internals while still owning retry/pause semantics — and the
 * engine must be unit-testable headlessly. ~350 lines of purpose-built code
 * wins over the Uppy dependency here.
 *
 * Behaviour (design 02 §1.4–1.5):
 * - Server-issued fixed partSize; parts sliced lazily via File.slice().
 * - 4 parallel part PUTs (browser per-origin connection budget).
 * - XHR (not fetch) for part PUTs — fetch still has no upload progress.
 * - Per-part retry: 3 attempts, exponential backoff; 403 -> re-presign.
 * - ETag response header collected per part (requires CORS ExposeHeaders:
 *   ["ETag"] on the bucket; a missing ETag fails fast with a clear message).
 * - Complete is sent with parts ordered by partNumber (contract requirement).
 * - pause(): aborts in-flight XHRs, keeps finished parts; resume() continues
 *   from the interrupted parts. cancel(): aborts + calls the abort endpoint.
 *
 * The engine is UI-independent: it talks to the backend through the UploadApi
 * port (implemented in uploadApi.ts) and to R2 through global XMLHttpRequest.
 */

// ---------------------------------------------------------------------------
// API port (backend contract)
// ---------------------------------------------------------------------------

export interface InitUploadRequest {
  fileName: string;
  sizeBytes: number;
  contentType: string;
}

export interface InitUploadResponse {
  assetId: string;
  uploadId: string;
  partSize: number;
  partCount: number;
}

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface UploadStatusResponse {
  uploadId: string;
  partSize: number;
  uploadedParts: { partNumber: number; size: number; etag: string }[];
}

export interface UploadApi {
  /** POST /api/projects/{projectId}/assets */
  initUpload(projectId: string, req: InitUploadRequest): Promise<InitUploadResponse>;
  /** POST /api/assets/{id}/parts/presign — max 20 partNumbers per request. */
  presignParts(assetId: string, partNumbers: number[]): Promise<PresignedPart[]>;
  /** POST /api/assets/{id}/complete — parts MUST be ordered by partNumber. */
  completeUpload(assetId: string, parts: CompletedPart[]): Promise<{ status: string }>;
  /** POST /api/assets/{id}/abort */
  abortUpload(assetId: string): Promise<void>;
  /** GET /api/assets/{id}/upload/status — cross-session resume (M6). */
  getUploadStatus(assetId: string): Promise<UploadStatusResponse>;
}

// ---------------------------------------------------------------------------
// Engine types
// ---------------------------------------------------------------------------

export type UploadPhase =
  | 'idle'
  | 'preparing' // init request in flight
  | 'uploading'
  | 'paused'
  | 'completing' // all parts done, complete request in flight
  | 'done'
  | 'aborted'
  | 'error';

export type UploadResult = { status: 'completed' } | { status: 'aborted' };

export interface UploadProgress {
  bytesUploaded: number;
  totalBytes: number;
  /** Moving average over the last few seconds; 0 until enough samples. */
  bytesPerSecond: number;
  /** Estimated seconds remaining; null while speed is unknown. */
  etaSeconds: number | null;
  partsCompleted: number;
  partCount: number;
}

export type UploadErrorCode =
  | 'init-failed'
  | 'presign-failed'
  | 'part-failed'
  | 'etag-missing'
  | 'complete-failed';

export class UploadError extends Error {
  constructor(
    readonly code: UploadErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'UploadError';
  }
}

export interface UploadEngineOptions {
  api: UploadApi;
  file: Blob;
  fileName: string;
  contentType: string;
  projectId: string;
  /** Parallel part PUTs. Default 4. */
  concurrency?: number;
  /** Attempts per part before the whole upload fails. Default 3. */
  maxAttemptsPerPart?: number;
  /** Base backoff delay; attempt n waits base * 2^(n-1) ms. Default 500. */
  backoffBaseMs?: number;
  /** Max partNumbers per presign request (API limit). Default 20. */
  presignBatchSize?: number;
  /** Min ms between non-forced progress emits. Default 100 (0 in tests). */
  progressThrottleMs?: number;
  onProgress?(progress: UploadProgress): void;
  onPhaseChange?(phase: UploadPhase): void;
  /** Fired as soon as the server has created the asset + multipart upload. */
  onCreated?(info: InitUploadResponse): void;
}

interface PartState {
  readonly partNumber: number; // 1-based
  readonly start: number;
  readonly end: number; // exclusive
  readonly size: number;
  etag: string | null;
  attempts: number;
  inFlightBytes: number;
}

/** Internal marker for non-2xx part PUT responses (drives 403 re-presign). */
class PartHttpError extends Error {
  constructor(
    readonly status: number,
    partNumber: number,
  ) {
    super(`Part ${partNumber} PUT failed with HTTP ${status}`);
    this.name = 'PartHttpError';
  }
}

/**
 * Internal marker for xhr.abort() rejections. Aborts are engine-initiated
 * (pause/cancel/fail) and must never be counted as a failed part attempt —
 * see the pause()->resume() micro-race handling in runPart().
 */
class PartAbortedError extends Error {
  constructor(partNumber: number) {
    super(`Part ${partNumber} upload aborted`);
    this.name = 'PartAbortedError';
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const TERMINAL_PHASES: readonly UploadPhase[] = ['done', 'aborted', 'error'];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class UploadEngine {
  private readonly opts: UploadEngineOptions;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly presignBatchSize: number;
  private readonly progressThrottleMs: number;

  private phaseValue: UploadPhase = 'idle';
  private parts: PartState[] = [];
  /** Part numbers waiting for a worker. Interrupted parts are unshifted to the front. */
  private queue: number[] = [];
  private urls = new Map<number, string>();
  private xhrs = new Map<number, XMLHttpRequest>();
  private backoffTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private presignInFlight: Promise<void> | null = null;
  private activeWorkers = 0;

  private assetIdValue: string | null = null;
  private uploadIdValue: string | null = null;
  private started = false;
  private settled = false;
  private completedBytes = 0;
  /** Set when cancel() arrives while the complete request is in flight. */
  private cancelRequested = false;
  /** The in-flight finish() run, so cancel() can await the complete outcome. */
  private finishPromise: Promise<void> | null = null;

  private lastEmitAt = 0;
  private samples: { t: number; bytes: number }[] = [];

  private readonly donePromise: Promise<UploadResult>;
  private resolveDone!: (result: UploadResult) => void;
  private rejectDone!: (err: Error) => void;

  constructor(opts: UploadEngineOptions) {
    this.opts = opts;
    this.concurrency = opts.concurrency ?? 4;
    this.maxAttempts = opts.maxAttemptsPerPart ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.presignBatchSize = opts.presignBatchSize ?? 20;
    this.progressThrottleMs = opts.progressThrottleMs ?? 100;
    this.donePromise = new Promise<UploadResult>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  get phase(): UploadPhase {
    return this.phaseValue;
  }

  /** Known once the init request has completed (see onCreated). */
  get assetId(): string | null {
    return this.assetIdValue;
  }

  get uploadId(): string | null {
    return this.uploadIdValue;
  }

  /**
   * Run the upload. Resolves { status: 'completed' } after the complete call
   * succeeds, { status: 'aborted' } after cancel(); rejects with UploadError
   * on failure. May only be called once per engine instance.
   */
  async start(): Promise<UploadResult> {
    if (this.started) throw new Error('UploadEngine.start() may only be called once');
    this.started = true;
    this.setPhase('preparing');

    let init: InitUploadResponse;
    try {
      init = await this.opts.api.initUpload(this.opts.projectId, {
        fileName: this.opts.fileName,
        sizeBytes: this.opts.file.size,
        contentType: this.opts.contentType,
      });
    } catch (err) {
      this.fail(new UploadError('init-failed', `Upload init failed: ${describe(err)}`, { cause: err }));
      return this.donePromise;
    }

    // cancel() while init was in flight: nothing exists server-side to abort
    // beyond the record init just created — abort it now, then settle.
    if (this.phaseValue === 'aborted') {
      try {
        await this.opts.api.abortUpload(init.assetId);
      } catch {
        // best effort
      }
      this.settle({ status: 'aborted' });
      return this.donePromise;
    }

    this.assetIdValue = init.assetId;
    this.uploadIdValue = init.uploadId;
    try {
      this.buildParts(init.partSize, init.partCount);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
      return this.donePromise;
    }
    this.opts.onCreated?.(init);

    // pause() during preparing leaves us parked in 'paused'; resume() pumps.
    if (this.phaseValue === 'preparing' || this.phaseValue === 'uploading') {
      this.setPhase('uploading');
      this.pump();
    }
    return this.donePromise;
  }

  /** Abort in-flight part PUTs and hold position. Finished parts are kept. */
  pause(): void {
    if (this.phaseValue !== 'preparing' && this.phaseValue !== 'uploading') return;
    this.setPhase('paused');
    this.flushBackoffTimersIntoQueue();
    // onabort fires -> runPart sees phase 'paused' and re-queues the part.
    for (const xhr of [...this.xhrs.values()]) xhr.abort();
  }

  /** Continue from the interrupted parts (same session). */
  resume(): void {
    if (this.phaseValue !== 'paused') return;
    this.setPhase('uploading');
    this.pump();
  }

  /** Abort everything and tell the server to AbortMultipartUpload. */
  async cancel(): Promise<void> {
    if (TERMINAL_PHASES.includes(this.phaseValue)) return;
    if (this.phaseValue === 'completing') {
      // The complete request is already in flight — the server may finish the
      // upload regardless of anything we do now. Wait for the outcome and
      // honor it: a successful complete wins (the asset exists; this is NOT
      // counted as a cancel), a failed complete falls through to the abort
      // path inside finish().
      this.cancelRequested = true;
      await this.finishPromise?.catch(() => {
        // finish() already settled/failed the engine; nothing more to do here
      });
      return;
    }
    const initPending = this.phaseValue === 'preparing' && this.assetIdValue === null;
    this.setPhase('aborted');
    this.clearBackoffTimers();
    for (const xhr of [...this.xhrs.values()]) xhr.abort();
    if (initPending) return; // start() finishes the abort once init resolves
    this.settle({ status: 'aborted' });
    try {
      if (this.assetIdValue) await this.opts.api.abortUpload(this.assetIdValue);
    } catch {
      // best effort — the 7-day bucket lifecycle sweeps leftovers
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildParts(partSize: number, partCount: number): void {
    if (!Number.isInteger(partSize) || partSize <= 0) {
      throw new UploadError('init-failed', `Server returned invalid partSize ${partSize}`);
    }
    const total = this.opts.file.size;
    const count = Math.max(1, partCount);
    this.parts = [];
    for (let i = 0; i < count; i++) {
      const start = i * partSize;
      const end = i === count - 1 ? total : Math.min(start + partSize, total);
      this.parts.push({
        partNumber: i + 1,
        start,
        end,
        size: Math.max(0, end - start),
        etag: null,
        attempts: 0,
        inFlightBytes: 0,
      });
    }
    this.queue = this.parts.map((p) => p.partNumber);
  }

  /** Start workers up to the concurrency limit; detect completion. */
  private pump(): void {
    if (this.phaseValue !== 'uploading') return;
    while (this.activeWorkers < this.concurrency && this.queue.length > 0) {
      const partNumber = this.queue.shift()!;
      this.activeWorkers++;
      void this.runPart(partNumber).finally(() => {
        this.activeWorkers--;
        this.pump();
      });
    }
    if (
      this.parts.length > 0 &&
      this.activeWorkers === 0 &&
      this.queue.length === 0 &&
      this.backoffTimers.size === 0 &&
      this.phaseValue === 'uploading'
    ) {
      void (this.finishPromise = this.finish());
    }
  }

  private async runPart(partNumber: number): Promise<void> {
    const part = this.parts[partNumber - 1]!;
    try {
      const url = await this.ensureUrl(partNumber);
      if (this.phaseValue !== 'uploading') {
        // paused/cancelled while waiting on presign
        if (this.phaseValue === 'paused') this.queue.unshift(partNumber);
        return;
      }
      part.etag = await this.putPart(part, url);
      part.inFlightBytes = 0;
      this.completedBytes += part.size;
      this.emitProgress(true);
    } catch (err) {
      part.inFlightBytes = 0;
      if (this.phaseValue === 'paused') {
        this.queue.unshift(partNumber); // resume restarts this part from scratch
        return;
      }
      if (this.phaseValue !== 'uploading') return; // aborted / already failed
      if (err instanceof PartAbortedError) {
        // pause()->resume() micro-race: the abort rejection of an in-flight
        // XHR can land AFTER resume() flipped the phase back to 'uploading'.
        // That is not a real failure — re-queue without burning an attempt
        // (otherwise paused parts creep toward maxAttempts and get failed).
        this.queue.unshift(partNumber);
        return;
      }
      if (err instanceof UploadError && err.code === 'etag-missing') {
        this.fail(err); // config error (CORS) — retrying cannot help
        return;
      }
      part.attempts += 1;
      if (part.attempts >= this.maxAttempts) {
        this.fail(
          new UploadError(
            'part-failed',
            `Part ${partNumber} failed after ${part.attempts} attempts: ${describe(err)}`,
            { cause: err },
          ),
        );
        return;
      }
      // Expired presigned URL. URLs are presigned in batches with identical
      // lifetimes, so when one has expired every other cached URL is expired
      // (or about to be) too — drop the whole cache, not just this part, so
      // the remaining parts do not each burn an attempt on a dead URL.
      if (err instanceof PartHttpError && err.status === 403) {
        this.urls.clear();
      }
      const delay = this.backoffBaseMs * 2 ** (part.attempts - 1);
      const timer = setTimeout(() => {
        this.backoffTimers.delete(partNumber);
        this.queue.unshift(partNumber);
        this.pump();
      }, delay);
      this.backoffTimers.set(partNumber, timer);
    }
  }

  /**
   * Return a presigned URL for the part, requesting a batch (<= 20) covering
   * every not-yet-signed unfinished part in one API call. Concurrent workers
   * share a single in-flight presign request.
   */
  private async ensureUrl(partNumber: number): Promise<string> {
    for (let round = 0; round < 3; round++) {
      const cached = this.urls.get(partNumber);
      if (cached) return cached;
      if (!this.presignInFlight) {
        const want = [
          partNumber,
          ...this.parts
            .filter((p) => p.etag === null && p.partNumber !== partNumber && !this.urls.has(p.partNumber))
            .map((p) => p.partNumber),
        ].slice(0, this.presignBatchSize);
        this.presignInFlight = this.opts.api
          .presignParts(this.assetIdValue!, want)
          .then((entries) => {
            for (const e of entries) this.urls.set(e.partNumber, e.url);
          })
          .finally(() => {
            this.presignInFlight = null;
          });
      }
      try {
        await this.presignInFlight;
      } catch (err) {
        throw new UploadError('presign-failed', `Presign failed: ${describe(err)}`, { cause: err });
      }
    }
    const url = this.urls.get(partNumber);
    if (url) return url;
    throw new UploadError('presign-failed', `Server did not return a URL for part ${partNumber}`);
  }

  /** PUT one part via XHR (upload progress + abortability). Resolves the ETag. */
  private putPart(part: PartState, url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.xhrs.set(part.partNumber, xhr);
      const cleanup = () => this.xhrs.delete(part.partNumber);
      xhr.open('PUT', url, true);
      if (xhr.upload) {
        xhr.upload.onprogress = (ev: ProgressEvent | { loaded: number }) => {
          part.inFlightBytes = Math.min(ev.loaded, part.size);
          this.emitProgress(false);
        };
      }
      xhr.onload = () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          const raw = xhr.getResponseHeader('ETag');
          if (!raw) {
            reject(
              new UploadError(
                'etag-missing',
                'Part uploaded but the ETag response header is unreadable. ' +
                  'The bucket CORS config must include ExposeHeaders: ["ETag"] ' +
                  '(R2/MinIO); without it the multipart upload cannot be completed.',
              ),
            );
            return;
          }
          resolve(raw.replaceAll('"', ''));
        } else {
          reject(new PartHttpError(xhr.status, part.partNumber));
        }
      };
      xhr.onerror = () => {
        cleanup();
        reject(new Error(`Network error while uploading part ${part.partNumber}`));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new PartAbortedError(part.partNumber));
      };
      xhr.send(this.opts.file.slice(part.start, part.end));
    });
  }

  private async finish(): Promise<void> {
    this.setPhase('completing');
    this.emitProgress(true);
    // Contract: parts ordered by partNumber.
    const completed: CompletedPart[] = this.parts
      .map((p) => {
        if (p.etag === null) {
          throw new Error(`Internal error: part ${p.partNumber} has no ETag at completion`);
        }
        return { partNumber: p.partNumber, etag: p.etag };
      })
      .sort((a, b) => a.partNumber - b.partNumber);
    try {
      await this.opts.api.completeUpload(this.assetIdValue!, completed);
    } catch (err) {
      if (this.phaseValue !== 'completing') return; // cancelled meanwhile
      if (this.cancelRequested) {
        // cancel() arrived while complete was in flight and complete failed:
        // honor the cancel instead of surfacing an error card.
        this.setPhase('aborted');
        this.settle({ status: 'aborted' });
        try {
          if (this.assetIdValue) await this.opts.api.abortUpload(this.assetIdValue);
        } catch {
          // best effort — the 7-day bucket lifecycle sweeps leftovers
        }
        return;
      }
      this.fail(new UploadError('complete-failed', `Complete failed: ${describe(err)}`, { cause: err }));
      return;
    }
    if (this.phaseValue !== 'completing') return;
    this.setPhase('done');
    this.settle({ status: 'completed' });
  }

  private fail(err: Error): void {
    if (TERMINAL_PHASES.includes(this.phaseValue)) return;
    this.setPhase('error');
    this.clearBackoffTimers();
    for (const xhr of [...this.xhrs.values()]) xhr.abort();
    if (!this.settled) {
      this.settled = true;
      this.rejectDone(err);
    }
  }

  private settle(result: UploadResult): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveDone(result);
  }

  private setPhase(phase: UploadPhase): void {
    if (this.phaseValue === phase) return;
    this.phaseValue = phase;
    this.opts.onPhaseChange?.(phase);
  }

  private clearBackoffTimers(): void {
    for (const timer of this.backoffTimers.values()) clearTimeout(timer);
    this.backoffTimers.clear();
  }

  /** Parts parked in backoff go back to the queue (used by pause). */
  private flushBackoffTimersIntoQueue(): void {
    for (const [partNumber, timer] of this.backoffTimers) {
      clearTimeout(timer);
      this.queue.unshift(partNumber);
    }
    this.backoffTimers.clear();
  }

  private emitProgress(force: boolean): void {
    if (!this.opts.onProgress) return;
    const now = Date.now();
    if (!force && now - this.lastEmitAt < this.progressThrottleMs) return;
    this.lastEmitAt = now;

    let inFlight = 0;
    let partsCompleted = 0;
    for (const p of this.parts) {
      if (p.etag !== null) partsCompleted++;
      else inFlight += p.inFlightBytes;
    }
    const totalBytes = this.opts.file.size;
    const bytesUploaded = Math.min(this.completedBytes + inFlight, totalBytes);

    this.samples.push({ t: now, bytes: bytesUploaded });
    while (this.samples.length > 1 && now - this.samples[0]!.t > 5000) this.samples.shift();
    let bytesPerSecond = 0;
    const first = this.samples[0]!;
    if (this.samples.length >= 2 && now > first.t) {
      bytesPerSecond = Math.max(0, ((bytesUploaded - first.bytes) / (now - first.t)) * 1000);
    }
    const remaining = totalBytes - bytesUploaded;
    const etaSeconds = bytesPerSecond > 1 ? remaining / bytesPerSecond : null;

    this.opts.onProgress({
      bytesUploaded,
      totalBytes,
      bytesPerSecond,
      etaSeconds,
      partsCompleted,
      partCount: this.parts.length,
    });
  }
}
