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
import { projectAssetsQueryKey, quotaQueryKey } from '../../../entities/assets';
import { useAssetStore, type AssetKind } from '../../../state/assetStore';
import { contentTypeForFileName } from '../fileTypes';
import { uploadApi } from './uploadApi';
import {
  UploadEngine,
  type UploadPhase,
  type UploadProgress,
} from './uploadEngine';
import { uploadErrorMessage } from './uploadErrors';
import { deleteUploadSession, saveUploadSession } from './uploadSessions';

export interface UploadItem {
  /** Client-side id of the upload card (assetId is unknown until init returns). */
  localId: string;
  /** Server asset id, set once the init call has completed. */
  assetId: string | null;
  projectId: string;
  fileName: string;
  totalBytes: number;
  /** File.lastModified — part of the duplicate-drop identity. */
  lastModified: number;
  phase: UploadPhase;
  progress: UploadProgress | null;
  errorMessage: string | null;
  /** Transient notice on the card (e.g. duplicate drop rejected). */
  warning: string | null;
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
  if (contentType === 'application/x-cube-lut') return 'lut';
  return 'video';
}

const ACTIVE_PHASES: readonly UploadPhase[] = ['idle', 'preparing', 'uploading', 'paused', 'completing'];

/** Card of an active upload of the same file (name+size+lastModified+project), if any. */
function findActiveDuplicate(file: File, projectId: string): UploadItem | null {
  for (const item of useUploadStore.getState().items.values()) {
    if (
      item.projectId === projectId &&
      item.fileName === file.name &&
      item.totalBytes === file.size &&
      item.lastModified === file.lastModified &&
      ACTIVE_PHASES.includes(item.phase)
    ) {
      return item;
    }
  }
  return null;
}

/** Show a transient warning on a card; auto-clears after a few seconds. */
function flashWarning(localId: string, message: string): void {
  useUploadStore.getState().patch(localId, { warning: message });
  setTimeout(() => {
    const current = useUploadStore.getState().items.get(localId);
    if (current?.warning === message) {
      useUploadStore.getState().patch(localId, { warning: null });
    }
  }, 4000);
}

/**
 * Kick off a multipart upload for a picked/dropped file. Returns the card id,
 * or null when the same file is already actively uploading to the project
 * (duplicate drops are rejected with a warning on the existing card).
 */
export function startUpload(file: File, projectId: string): string | null {
  const duplicate = findActiveDuplicate(file, projectId);
  if (duplicate) {
    flashWarning(duplicate.localId, 'Bu dosya zaten yükleniyor.');
    return null;
  }

  const localId = crypto.randomUUID();
  // Tip UZANTIDAN türetilir, `File.type`'tan DEĞİL: tarayıcı/işletim sistemi aynı
  // dosya için whitelist dışı bir MIME bildirebiliyor (ölçüldü: Chromium/Windows
  // `.m4a` → `audio/x-m4a` → yükleme sunucuda reddediliyordu). Gerekçe ve eşleme:
  // fileTypes.EXTENSION_CONTENT_TYPES. Uzantı tanınmıyorsa (bu kapıya normalde
  // gelinmez, isSupportedMediaFile önce eler) tarayıcının dediğine düşülür.
  const contentType = contentTypeForFileName(file.name) ?? file.type ?? 'application/octet-stream';
  const store = useUploadStore.getState();

  store.upsert({
    localId,
    assetId: null,
    projectId,
    fileName: file.name,
    totalBytes: file.size,
    lastModified: file.lastModified,
    phase: 'idle',
    progress: null,
    errorMessage: null,
    warning: null,
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
      // Best-effort: a broken IndexedDB must not affect the upload itself.
      saveUploadSession({
        assetId: info.assetId,
        projectId,
        fileName: file.name,
        fileSize: file.size,
        lastModified: file.lastModified,
        partSize: info.partSize,
        createdAt: now,
        updatedAt: now,
      }).catch(() => {
        // no session record -> no cross-session resume entry; upload unaffected
      });
    },
  });
  engines.set(localId, engine);

  // Two-argument then(): the rejection handler catches ONLY engine failures.
  // Errors thrown by the success handler must never repaint a completed
  // upload as failed — every session/cache side effect in it is best-effort.
  void engine.start().then(
    async (result) => {
      engines.delete(localId);
      const assetId = engine.assetId;
      if (result.status === 'completed' && assetId) {
        try {
          await deleteUploadSession(assetId);
        } catch {
          // orphan record stays listed as "interrupted"; user can discard it
        }
        useAssetStore.getState().updateAsset(assetId, { status: 'uploaded', progress: 1 });
        // Refresh the server list BEFORE removing the card so the asset never
        // double-renders or disappears while the refetch is in flight.
        try {
          await queryClient.invalidateQueries({ queryKey: projectAssetsQueryKey(projectId) });
          // Kullanılan alan değişti: başlıktaki kota göstergesi yalan söylemesin.
          void queryClient.invalidateQueries({ queryKey: quotaQueryKey });
        } catch {
          // refetch errors surface through the query state itself
        }
        useUploadStore.getState().remove(localId); // hand the card off to the server list
        files.delete(localId);
      } else {
        // aborted (user cancel): server record is gone, clean everything up
        if (assetId) {
          try {
            await deleteUploadSession(assetId);
          } catch {
            // best effort — stale record is discardable from the UI
          }
          useAssetStore.getState().removeAsset(assetId);
        }
        useUploadStore.getState().remove(localId);
        files.delete(localId);
        // İptal edilen yükleme sunucuda soft-delete edilir → kotadan düşer.
        void queryClient.invalidateQueries({ queryKey: quotaQueryKey });
      }
    },
    (err: unknown) => {
      engines.delete(localId);
      // ApiError.body'deki ProblemDetails içeriği kartta ham "HTTP 400" yerine
      // anlaşılır mesaj olarak gösterilir (uploadErrors.ts).
      const message = uploadErrorMessage(err);
      useUploadStore.getState().patch(localId, { phase: 'error', errorMessage: message });
      // Kota reddi mesajı göstergeye yönlendirir — o gösterge TAZE olmalı.
      void queryClient.invalidateQueries({ queryKey: quotaQueryKey });
      const assetId = engine.assetId;
      if (assetId) {
        useAssetStore.getState().updateAsset(assetId, {
          status: 'failed',
          errorCode: 'upload_failed',
        });
      }
      // Session record is intentionally KEPT: parts already in R2 stay
      // resumable for 7 days (cross-session resume arrives in M6).
    },
  );

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
