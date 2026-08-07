/**
 * uploadManager — glue between UploadEngine instances and the UI/stores.
 *
 * - useUploadStore: zustand view-model of active upload cards (progress,
 *   phase, errors) that LibraryPanel renders.
 * - Keeps assetStore in sync (uploading placeholder -> uploaded / failed).
 * - Persists/clears IndexedDB upload sessions (uploadSessions.ts).
 * - Invalidates the react-query asset list when an upload lands.
 *
 * Engines themselves are NOT stored in zustand (non-serializable, mutable);
 * they live in a module map keyed by the card's localId.
 */
import { create } from 'zustand';
import { queryClient } from '../../../app/queryClient';
import { projectAssetsQueryKey } from '../../../entities/assets';
import { useAssetStore, type AssetKind } from '../../../state/assetStore';
import { uploadApi } from './uploadApi';
import {
  UploadEngine,
  type UploadPhase,
  type UploadProgress,
} from './uploadEngine';
import { deleteUploadSession, saveUploadSession } from './uploadSessions';

export interface UploadItem {
  /** Client-side id of the upload card (assetId is unknown until init returns). */
  localId: string;
  /** Server asset id, set once the init call has completed. */
  assetId: string | null;
  projectId: string;
  fileName: string;
  totalBytes: number;
  phase: UploadPhase;
  progress: UploadProgress | null;
  errorMessage: string | null;
}

interface UploadStore {
  /** localId -> item, in insertion order. */
  items: Map<string, UploadItem>;
  upsert(item: UploadItem): void;
  patch(localId: string, patch: Partial<Omit<UploadItem, 'localId'>>): void;
  remove(localId: string): void;
}

export const useUploadStore = create<UploadStore>()((set) => ({
  items: new Map<string, UploadItem>(),
  upsert: (item) =>
    set((s) => {
      const next = new Map(s.items);
      next.set(item.localId, item);
      return { items: next };
    }),
  patch: (localId, patch) =>
    set((s) => {
      const current = s.items.get(localId);
      if (!current) return s;
      const next = new Map(s.items);
      next.set(localId, { ...current, ...patch });
      return { items: next };
    }),
  remove: (localId) =>
    set((s) => {
      if (!s.items.has(localId)) return s;
      const next = new Map(s.items);
      next.delete(localId);
      return { items: next };
    }),
}));

const engines = new Map<string, UploadEngine>();
/** Original File handles, kept so a failed upload can be retried in-session. */
const files = new Map<string, File>();

function kindFromContentType(contentType: string): AssetKind {
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('image/')) return 'image';
  return 'video';
}

/** Kick off a multipart upload for a picked/dropped file. Returns the card id. */
export function startUpload(file: File, projectId: string): string {
  const localId = crypto.randomUUID();
  const contentType = file.type || 'application/octet-stream';
  const store = useUploadStore.getState();

  store.upsert({
    localId,
    assetId: null,
    projectId,
    fileName: file.name,
    totalBytes: file.size,
    phase: 'idle',
    progress: null,
    errorMessage: null,
  });
  files.set(localId, file);

  const engine = new UploadEngine({
    api: uploadApi,
    file,
    fileName: file.name,
    contentType,
    projectId,
    onPhaseChange: (phase) => useUploadStore.getState().patch(localId, { phase }),
    onProgress: (progress) => {
      useUploadStore.getState().patch(localId, { progress });
      const assetId = engine.assetId;
      if (assetId) {
        useAssetStore.getState().updateAsset(assetId, {
          progress: progress.totalBytes > 0 ? progress.bytesUploaded / progress.totalBytes : 0,
        });
      }
    },
    onCreated: (info) => {
      useUploadStore.getState().patch(localId, { assetId: info.assetId });
      useAssetStore.getState().upsertAsset({
        id: info.assetId,
        kind: kindFromContentType(contentType),
        name: file.name,
        status: 'uploading',
        progress: 0,
      });
      const now = Date.now();
      void saveUploadSession({
        assetId: info.assetId,
        projectId,
        fileName: file.name,
        fileSize: file.size,
        lastModified: file.lastModified,
        partSize: info.partSize,
        createdAt: now,
        updatedAt: now,
      });
    },
  });
  engines.set(localId, engine);

  void engine
    .start()
    .then(async (result) => {
      engines.delete(localId);
      const assetId = engine.assetId;
      if (result.status === 'completed' && assetId) {
        await deleteUploadSession(assetId);
        useAssetStore.getState().updateAsset(assetId, { status: 'uploaded', progress: 1 });
        useUploadStore.getState().remove(localId); // hand the card off to the server list
        files.delete(localId);
        void queryClient.invalidateQueries({ queryKey: projectAssetsQueryKey(projectId) });
      } else {
        // aborted (user cancel): server record is gone, clean everything up
        if (assetId) {
          await deleteUploadSession(assetId);
          useAssetStore.getState().removeAsset(assetId);
        }
        useUploadStore.getState().remove(localId);
        files.delete(localId);
      }
    })
    .catch((err: unknown) => {
      engines.delete(localId);
      const message = err instanceof Error ? err.message : String(err);
      useUploadStore.getState().patch(localId, { phase: 'error', errorMessage: message });
      const assetId = engine.assetId;
      if (assetId) {
        useAssetStore.getState().updateAsset(assetId, {
          status: 'failed',
          errorCode: 'upload_failed',
        });
      }
      // Session record is intentionally KEPT: parts already in R2 stay
      // resumable for 7 days (cross-session resume arrives in M6).
    });

  return localId;
}

export function pauseUpload(localId: string): void {
  engines.get(localId)?.pause();
}

export function resumeUpload(localId: string): void {
  engines.get(localId)?.resume();
}

/** User cancel: abort in-flight parts + AbortMultipartUpload server-side. */
export function cancelUpload(localId: string): void {
  const engine = engines.get(localId);
  if (engine) {
    void engine.cancel();
  } else {
    // no live engine (e.g. errored card being dismissed)
    useUploadStore.getState().remove(localId);
    files.delete(localId);
  }
}

/** Retry a failed upload from scratch with the original File handle. */
export function retryUpload(localId: string): string | null {
  const item = useUploadStore.getState().items.get(localId);
  const file = files.get(localId);
  if (!item || !file || item.phase !== 'error') return null;
  useUploadStore.getState().remove(localId);
  files.delete(localId);
  return startUpload(file, item.projectId);
}

/** Dismiss an errored card without retrying (session record stays for M6 resume). */
export function dismissUpload(localId: string): void {
  const item = useUploadStore.getState().items.get(localId);
  if (!item || item.phase !== 'error') return;
  useUploadStore.getState().remove(localId);
  files.delete(localId);
}
