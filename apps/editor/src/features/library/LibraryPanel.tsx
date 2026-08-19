/**
 * Media library panel (M1): file picking + drag-drop upload, active upload
 * cards (progress / speed / ETA, pause-resume-cancel), interrupted-session
 * badge, and the project asset list with status badges (react-query, 3 s
 * polling while the server is processing — SignalR replaces this in M1-B).
 *
 * M6 adds library MANAGEMENT: the storage quota indicator in the header and
 * per-asset delete (right click / ⋯ menu -> usage lookup -> confirmation,
 * AssetDeleteDialog).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useProjectAssets, useQuota, type AssetDto } from '../../entities/assets';
import { useEditorStore } from '../../state/editorStore';
import { openProject, useProjectSession } from '../../state/projectSession';
import { addAssetToTimelineAtPlayhead } from './addToTimeline';
import { addStickerAtPlayhead } from '../text/overlayActions';
import { FILE_ACCEPT, isSupportedMediaFile, unsupportedFileMessage } from './fileTypes';
import { syncServerAssets, toAssetKind } from './assetSync';
import { IMAGE_DEFAULT_DURATION_US } from '../../state/timelineOps';
import {
  cancelLibraryDrag,
  endLibraryDrag,
  startLibraryDrag,
  updateLibraryDrag,
  useLibraryDndStore,
  type LibraryDragPayload,
} from '../timeline/libraryDnd';
import { formatBytes, formatDurationUs, formatEta, formatSpeed } from './format';
import { AssetDeleteDialog } from './AssetDeleteDialog';
import { adoptServerAssetList, resetAssetPresence } from './missingMedia';
import { quotaView } from './quotaModel';
import { uploadApi } from './upload/uploadApi';
import {
  cancelUpload,
  dismissUpload,
  pauseUpload,
  resumeUpload,
  retryUpload,
  startUpload,
  useUploadStore,
  type UploadItem,
} from './upload/uploadManager';
import {
  deleteUploadSession,
  listUploadSessions,
  type UploadSessionRecord,
} from './upload/uploadSessions';

export function LibraryPanel() {
  const projectId = useEditorStore((s) => s.activeProjectId);
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-edge bg-surface-2 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Kitaplık
          </span>
          {projectId !== null && <QuotaIndicator />}
        </div>
      </header>
      {projectId === null ? <NoProject /> : <LibraryContent projectId={projectId} />}
    </div>
  );
}

/**
 * Depolama kotası göstergesi — kullanılan/toplam + yüzde, %90 üstünde uyarı
 * rengi. Upload reddi bu göstergeye yönlendirir (upload/uploadErrors.ts), o
 * yüzden gösterge sunucunun kota tanımıyla AYNI sayıyı okur (GET /api/quota).
 *
 * Kota okunamıyorsa gösterge yazılmaz: kitaplığın geri kalanı (yükleme, silme)
 * çalışmaya devam etmeli, uydurma bir sayı göstermektense hiç göstermemeli.
 */
function QuotaIndicator() {
  const quota = useQuota();
  if (!quota.data) return null;
  const view = quotaView(quota.data);
  const tone =
    view.level === 'full'
      ? 'text-danger'
      : view.level === 'warn'
        ? 'text-amber-400'
        : 'text-fg-muted';
  const barTone =
    view.level === 'full' ? 'bg-danger' : view.level === 'warn' ? 'bg-amber-400' : 'bg-accent';

  return (
    <span
      className="flex min-w-0 shrink-0 items-center gap-1.5"
      data-testid="library-quota"
      title={view.title}
    >
      <span className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-surface-3">
        <span
          className={`block h-full rounded-full ${barTone}`}
          style={{ width: `${view.barPercent}%` }}
        />
      </span>
      <span className={`text-[10px] font-semibold whitespace-nowrap ${tone}`}>
        {view.usedLabel} · %{view.percent}
      </span>
    </span>
  );
}

function NoProject() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-4 text-center text-sm text-fg-muted">
      <span>Proje seçilmedi</span>
      <span className="text-xs">Medya yüklemek ve görmek için bir proje açın.</span>
    </div>
  );
}

function LibraryContent({ projectId }: { projectId: string }) {
  // Oturum durumu: 'error' -> DropZone yerine retry'lı hata bloğu; 'ready'
  // değilken DropZone kapalı (timeline'daki +V/+A guard'ıyla aynı şart).
  const sessionStatus = useProjectSession((s) => s.status);
  const sessionError = useProjectSession((s) => s.error);
  const uploadsMap = useUploadStore((s) => s.items);
  const uploads = useMemo(
    () => [...uploadsMap.values()].filter((u) => u.projectId === projectId),
    [uploadsMap, projectId],
  );
  const activeAssetIds = useMemo(
    () => new Set(uploads.map((u) => u.assetId).filter((id): id is string => id !== null)),
    [uploads],
  );

  // ---- interrupted uploads from previous sessions (IndexedDB) ----
  const [sessions, setSessions] = useState<UploadSessionRecord[]>([]);
  const uploadCount = uploads.length;
  useEffect(() => {
    let cancelled = false;
    void listUploadSessions(projectId).then((records) => {
      if (!cancelled) setSessions(records);
    });
    return () => {
      cancelled = true;
    };
    // re-check when an upload starts/finishes (not on every progress tick)
  }, [projectId, uploadCount]);
  // Hide sessions whose upload is active in THIS tab: match by assetId, and —
  // for uploads whose init has not returned yet (assetId still null) — by the
  // file identity the session record stores. Prevents the same upload showing
  // both as a live card and as an "interrupted" entry.
  const pendingSessions = useMemo(
    () =>
      sessions.filter(
        (r) =>
          !activeAssetIds.has(r.assetId) &&
          !uploads.some(
            (u) =>
              u.assetId === null &&
              u.fileName === r.fileName &&
              u.totalBytes === r.fileSize &&
              u.lastModified === r.lastModified,
          ),
      ),
    [sessions, activeAssetIds, uploads],
  );

  const discardSession = useCallback(async (assetId: string) => {
    try {
      await uploadApi.abortUpload(assetId); // free the server-side multipart upload
    } catch {
      // best effort — the 7-day lifecycle sweeps it anyway
    }
    await deleteUploadSession(assetId);
    setSessions((prev) => prev.filter((r) => r.assetId !== assetId));
  }, []);

  // ---- server asset list (react-query) + assetStore sync ----
  const assetsQuery = useProjectAssets(projectId);

  // Proje değişimi: "hangi asset'ler var" damgası ÖNCEKİ projenin listesiyle
  // konuşamaz (missingMedia.ts) — yeni liste gelene kadar eksiklik iddiası yok.
  // Layout effect: yeni projenin dokümanı boyanmadan ÖNCE düşsün.
  useLayoutEffect(() => {
    resetAssetPresence();
    return () => resetAssetPresence();
  }, [projectId]);

  useEffect(() => {
    const data = assetsQuery.data;
    if (!data) return;
    // MERGE into the store — presigned URL fields are owned by the media-urls
    // sync and must survive the 3 s poll (see assetSync.ts).
    syncServerAssets(data.items);
    // Deleted media: the poll is the only place that can tell "this asset is
    // gone" apart from "this asset is not loaded yet" — and ONLY when the page
    // covers the whole list (missingMedia.ts).
    adoptServerAssetList(
      projectId,
      data.items.map((dto) => dto.id),
      data.items.length >= data.totalCount,
    );
  }, [assetsQuery.data, projectId]);

  // ---- delete flow: row menu -> usage lookup -> confirmation ----
  const [menu, setMenu] = useState<{ asset: AssetDto; x: number; y: number } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssetDto | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const serverAssets = useMemo(
    () => (assetsQuery.data?.items ?? []).filter((dto) => !activeAssetIds.has(dto.id)),
    [assetsQuery.data, activeAssetIds],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 p-3 pb-0">
        {sessionStatus === 'error' ? (
          <SessionErrorNotice projectId={projectId} message={sessionError} />
        ) : (
          <DropZone projectId={projectId} disabled={sessionStatus !== 'ready'} />
        )}
      </div>

      {pendingSessions.length > 0 && (
        <div className="shrink-0 px-3 pt-3">
          <PendingSessionsNotice sessions={pendingSessions} onDiscard={discardSession} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {uploads.length > 0 && (
          <section className="mb-3">
            <SectionTitle>
              Yükleniyor
              <CountBadge count={uploads.length} />
            </SectionTitle>
            <ul className="flex flex-col gap-2">
              {uploads.map((item) => (
                <li key={item.localId}>
                  <UploadCard item={item} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <SectionTitle>
            Medya
            {assetsQuery.data && <CountBadge count={assetsQuery.data.totalCount} />}
          </SectionTitle>
          {assetsQuery.isLoading && <p className="py-2 text-xs text-fg-muted">Medya listesi yükleniyor…</p>}
          {assetsQuery.isError && (
            <div className="flex items-center gap-2 py-2 text-xs text-danger">
              <span>Medya listesi yüklenemedi.</span>
              <button
                type="button"
                className="rounded border border-edge px-2 py-0.5 text-fg-muted hover:bg-surface-3 hover:text-fg"
                onClick={() => void assetsQuery.refetch()}
              >
                Tekrar dene
              </button>
            </div>
          )}
          {assetsQuery.isSuccess && serverAssets.length === 0 && uploads.length === 0 && (
            <p className="py-2 text-xs text-fg-muted">Henüz medya yok — dosyaları yukarıya bırakın.</p>
          )}
          <ul className="flex flex-col gap-1.5">
            {serverAssets.map((dto) => (
              <li key={dto.id}>
                <AssetRow
                  dto={dto}
                  onRequestMenu={(asset, x, y) => setMenu({ asset, x, y })}
                />
              </li>
            ))}
          </ul>
        </section>
      </div>

      {menu !== null && (
        <AssetContextMenu
          x={menu.x}
          y={menu.y}
          fileName={menu.asset.fileName}
          onDelete={() => {
            setDeleteTarget(menu.asset);
            closeMenu();
          }}
          onClose={closeMenu}
        />
      )}
      {deleteTarget !== null && (
        <AssetDeleteDialog
          asset={deleteTarget}
          projectId={projectId}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      <LibraryDragGhost />
    </div>
  );
}

/**
 * Asset satırının sağ tık / ⋯ menüsü. Tek eylem taşır (Sil) ama menü olarak
 * durur: silme yıkıcıdır ve satırın üstünde duran çıplak bir çöp kutusu ikonu,
 * sürükle-bırak jestinin ortasında yanlışlıkla tıklanmaya açıktır.
 */
function AssetContextMenu({
  x,
  y,
  fileName,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  fileName: string;
  onDelete(): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(6, Math.min(x, window.innerWidth - rect.width - 6)),
      top: Math.max(6, Math.min(y, window.innerHeight - rect.height - 6)),
    });
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation(); // global kısayol dispatcher'ına sızmasın
      onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('wheel', onClose, { capture: true, passive: true });
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('wheel', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${fileName} işlemleri`}
      data-testid="library-context-menu"
      className="fixed z-50 min-w-[10rem] rounded-md border border-edge bg-surface-2 py-1 shadow-xl"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        data-testid="library-menu-delete"
        className="flex w-full items-center px-3 py-1 text-left text-xs text-danger outline-none hover:bg-surface-3 focus-visible:bg-surface-3"
        onClick={onDelete}
      >
        Sil
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pointer drag source: ready assets are draggable onto the canvas timeline
// (custom pointer DnD — HTML5 DnD does not play with canvas, design 01 §3.3).
// ---------------------------------------------------------------------------

function useAssetDragSource(dto: AssetDto) {
  const stateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
    payload: LibraryDragPayload;
  } | null>(null);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || dto.status !== 'ready') return;
      const durationUs =
        dto.kind === 'image' ? IMAGE_DEFAULT_DURATION_US : dto.durationMicros;
      if (durationUs === undefined || durationUs <= 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      stateRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
        payload: {
          assetId: dto.id,
          kind: toAssetKind(dto.kind),
          name: dto.fileName,
          durationUs,
        },
      };
    },
    [dto],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const s = stateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    if (!s.dragging) {
      if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < 5) return;
      s.dragging = true;
      startLibraryDrag(s.payload, e.clientX, e.clientY);
    } else {
      updateLibraryDrag(e.clientX, e.clientY);
    }
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const s = stateRef.current;
    stateRef.current = null;
    if (s?.dragging) endLibraryDrag(e.clientX, e.clientY);
  }, []);

  const onPointerCancel = useCallback(() => {
    const s = stateRef.current;
    stateRef.current = null;
    if (s?.dragging) cancelLibraryDrag();
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}

/** Floating card following the cursor while dragging an asset. */
function LibraryDragGhost() {
  const drag = useLibraryDndStore((s) => s.drag);
  if (!drag) return null;
  return (
    <div
      className="pointer-events-none fixed z-50 rounded border border-accent bg-surface-2/95 px-2 py-1 text-xs text-fg shadow-lg"
      style={{ left: drag.clientX + 10, top: drag.clientY + 8, maxWidth: 220 }}
    >
      <span className="truncate">{drag.name}</span>
      <span className="ml-1.5 text-[10px] text-fg-muted">{formatDurationUs(drag.durationUs)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload drop zone
// ---------------------------------------------------------------------------

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

/** Proje açma hatası: DropZone yerine gösterilen, openProject'i yeniden çağıran blok. */
function SessionErrorNotice({ projectId, message }: { projectId: string; message: string | null }) {
  return (
    <div className="rounded border border-danger/40 bg-danger/10 px-2.5 py-2">
      <p className="text-xs font-semibold text-danger">Proje yüklenemedi.</p>
      {message && <p className="mt-0.5 text-[11px] leading-snug break-words text-fg-muted">{message}</p>}
      <button
        type="button"
        className="mt-1.5 rounded border border-edge px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface-3 hover:text-fg"
        onClick={() => void openProject(projectId)}
      >
        Tekrar dene
      </button>
    </div>
  );
}

function DropZone({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  /** Desteklenmeyen dosyalar için Türkçe hatalar (sonraki drop/seçimde sıfırlanır). */
  const [rejections, setRejections] = useState<string[]>([]);
  const dragDepth = useRef(0);

  const acceptFiles = useCallback(
    (fileList: FileList | null) => {
      if (disabled || !fileList) return;
      const rejected: string[] = [];
      for (const file of Array.from(fileList)) {
        // Uzantı whitelist'i backend contentType whitelist'iyle eşleşir
        // (fileTypes.ts) — desteklenmeyen dosya kart açılmadan reddedilir.
        if (!isSupportedMediaFile(file.name)) {
          rejected.push(unsupportedFileMessage(file.name));
          continue;
        }
        startUpload(file, projectId);
      }
      setRejections(rejected);
    },
    [projectId, disabled],
  );

  return (
    <div>
      <div
        className={`flex flex-col items-center gap-1.5 rounded border border-dashed px-3 py-4 text-center transition-colors ${
          disabled
            ? 'border-edge bg-surface-2/30 opacity-50'
            : dragOver
              ? 'border-accent bg-accent/10'
              : 'border-edge bg-surface-2/50'
        }`}
        onDragEnter={(e) => {
          if (disabled || !hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current += 1;
          setDragOver(true);
        }}
        onDragOver={(e) => {
          if (!disabled && hasFiles(e)) e.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        }}
        onDrop={(e) => {
          if (disabled) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragOver(false);
          acceptFiles(e.dataTransfer.files);
        }}
      >
        <span className="text-xs text-fg-muted">
          {disabled ? 'Proje yükleniyor…' : 'Medyayı buraya bırakın veya'}
        </span>
        <button
          type="button"
          disabled={disabled}
          className="rounded bg-accent px-3 py-1 text-xs font-semibold text-surface-0 hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
          onClick={() => inputRef.current?.click()}
        >
          Dosya seç
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept={FILE_ACCEPT}
          onChange={(e) => {
            acceptFiles(e.target.files);
            e.target.value = ''; // allow re-picking the same file
          }}
        />
      </div>
      {rejections.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {rejections.map((message) => (
            <li key={message} className="text-[11px] leading-snug break-words text-danger">
              {message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interrupted sessions (browser was closed mid-upload)
// ---------------------------------------------------------------------------

function PendingSessionsNotice({
  sessions,
  onDiscard,
}: {
  sessions: UploadSessionRecord[];
  onDiscard: (assetId: string) => Promise<void>;
}) {
  return (
    <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500/20 px-1 text-[10px]">
          {sessions.length}
        </span>
        Yarım kalan yükleme{sessions.length > 1 ? 'ler' : ''}
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-fg-muted">
        Tarayıcı yeniden açıldıktan sonra devam ettirme ileri bir milestone'da gelecek; yarım kalan
        yüklemeler sunucuda 7 gün saklanır.
      </p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {sessions.map((s) => (
          <li key={s.assetId} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="truncate text-fg" title={s.fileName}>
              {s.fileName}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-fg-muted">
              {formatBytes(s.fileSize)}
              <button
                type="button"
                className="rounded border border-edge px-1.5 py-0.5 hover:bg-surface-3 hover:text-fg"
                onClick={() => void onDiscard(s.assetId)}
                title="Yarım kalan yüklemeyi iptal et ve bu kaydı kaldır"
              >
                Sil
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload card
// ---------------------------------------------------------------------------

const PHASE_LABELS: Record<UploadItem['phase'], string> = {
  idle: 'Başlatılıyor…',
  preparing: 'Başlatılıyor…',
  uploading: 'Yükleniyor',
  paused: 'Duraklatıldı',
  completing: 'Tamamlanıyor…',
  done: 'Tamamlandı',
  aborted: 'İptal edildi',
  error: 'Başarısız',
};

function UploadCard({ item }: { item: UploadItem }) {
  const p = item.progress;
  const pct = p && p.totalBytes > 0 ? Math.min(100, (p.bytesUploaded / p.totalBytes) * 100) : 0;
  const isError = item.phase === 'error';
  const canPause = item.phase === 'uploading' || item.phase === 'preparing' || item.phase === 'idle';
  const canResume = item.phase === 'paused';
  // No Cancel while 'completing': the complete request is already in flight and
  // the server may finish the upload regardless — cancelling here is a lie.
  const canCancel =
    item.phase !== 'error' &&
    item.phase !== 'done' &&
    item.phase !== 'aborted' &&
    item.phase !== 'completing';

  return (
    <div className="rounded border border-edge bg-surface-2 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-fg" title={item.fileName}>
          {item.fileName}
        </span>
        <span className={`shrink-0 text-[11px] ${isError ? 'text-danger' : 'text-fg-muted'}`}>
          {PHASE_LABELS[item.phase]}
        </span>
      </div>

      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className={`h-full rounded-full transition-[width] duration-200 ${
            isError ? 'bg-danger' : item.phase === 'paused' ? 'bg-fg-muted' : 'bg-accent'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {item.warning && (
        <p className="mt-1 text-[11px] leading-snug break-words text-amber-400">{item.warning}</p>
      )}

      {isError ? (
        <p className="mt-1 text-[11px] leading-snug break-words text-danger" title={item.errorMessage ?? undefined}>
          {item.errorMessage ?? 'Yükleme başarısız'}
        </p>
      ) : (
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-fg-muted">
          <span>
            {p ? `${formatBytes(p.bytesUploaded)} / ${formatBytes(p.totalBytes)}` : formatBytes(item.totalBytes)}
          </span>
          <span className="shrink-0">
            {item.phase === 'uploading' && p
              ? `${formatSpeed(p.bytesPerSecond)} · ${formatEta(p.etaSeconds)} kaldı · ${Math.floor(pct)}%`
              : `${Math.floor(pct)}%`}
          </span>
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-1.5">
        {canPause && <CardButton onClick={() => pauseUpload(item.localId)}>Duraklat</CardButton>}
        {canResume && <CardButton onClick={() => resumeUpload(item.localId)}>Devam et</CardButton>}
        {canCancel && <CardButton onClick={() => cancelUpload(item.localId)}>İptal</CardButton>}
        {isError && (
          <>
            <CardButton onClick={() => retryUpload(item.localId)}>Tekrar dene</CardButton>
            <CardButton onClick={() => dismissUpload(item.localId)}>Kapat</CardButton>
          </>
        )}
      </div>
    </div>
  );
}

function CardButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      className="rounded border border-edge px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface-3 hover:text-fg"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Asset list
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<string, string> = {
  video: 'VID',
  audio: 'AUD',
  image: 'IMG',
};

function AssetRow({
  dto,
  onRequestMenu,
}: {
  dto: AssetDto;
  onRequestMenu(asset: AssetDto, x: number, y: number): void;
}) {
  const dragHandlers = useAssetDragSource(dto);
  const sessionReady = useProjectSession((s) => s.status) === 'ready';
  const meta: string[] = [];
  if (dto.status === 'ready') {
    if (dto.durationMicros !== undefined) meta.push(formatDurationUs(dto.durationMicros));
    if (dto.width && dto.height) meta.push(`${dto.width}×${dto.height}`);
  }
  meta.push(formatBytes(dto.sizeBytes));
  if (dto.status === 'failed' && dto.errorCode) meta.push(dto.errorCode);

  return (
    <div
      className={`flex items-center gap-2 rounded border border-edge bg-surface-2 px-2 py-1.5 hover:bg-surface-3 ${
        dto.status === 'ready' ? 'cursor-grab touch-none select-none' : ''
      }`}
      {...dragHandlers}
      // Çift tık: DnD'nin yedek yolu — playhead'e (çakışıyorsa proje sonuna) ekler.
      onDoubleClick={dto.status === 'ready' ? () => addAssetToTimelineAtPlayhead(dto.id) : undefined}
      // Sağ tık: satırın işlem menüsü (Sil). Tarayıcı menüsü bastırılır.
      onContextMenu={(e) => {
        e.preventDefault();
        onRequestMenu(dto, e.clientX, e.clientY);
      }}
      title={dto.status === 'ready' ? "Timeline'a sürükleyin · Çift tık: timeline'a ekle" : undefined}
    >
      <span className="flex h-8 w-10 shrink-0 items-center justify-center rounded bg-surface-3 text-[9px] font-bold tracking-wider text-fg-muted">
        {KIND_LABELS[dto.kind] ?? 'MED'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-fg" title={dto.fileName}>
          {dto.fileName}
        </div>
        <div className="truncate text-[11px] text-fg-muted">{meta.join(' · ')}</div>
      </div>
      {/*
        Sticker = aynı görsel asset, overlay track'e ve StickerClip olarak.
        Görselin "video katmanı" mı yoksa "çıkartma" mı olduğunu dosya değil
        KULLANICI belirler, o yüzden ayrı bir düğme (çift tık hâlâ video
        track'ine ekler). pointerdown durdurulur: satırın sürükleme kaynağı bu
        tıklamayı hayalet sürüklemeye çevirmesin.

        ÇİFT TIK KORUMASI: satırın kendi title'ı "Çift tık: timeline'a ekle"
        diyerek bu jesti DAVET ediyor ve düğme satırın ORTASINDA duruyor
        (ölçüldü: 255 px genişlikte satırın orta ekseni düğmenin kutusuna
        düşüyor). Çift tıkta tarayıcı İKİ ayrı `click` üretir — `onDoubleClick`
        yalnız yayılımı durduğu için ikisi de buraya geliyordu ve İKİ çıkartma
        ekleniyordu (ölçüldü: Δ2). `detail` tıklama SAYACIdır; jestin ikinci ve
        sonraki tıklamaları tek bir eyleme katlanır.
      */}
      {dto.kind === 'image' && dto.status === 'ready' && (
        <button
          type="button"
          data-testid="asset-add-sticker"
          title="Çıkartma olarak overlay katmanına ekle"
          disabled={!sessionReady}
          className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-[10px] text-fg-muted hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (e.detail > 1) return;
            addStickerAtPlayhead(dto.id);
          }}
        >
          Sticker
        </button>
      )}
      <StatusBadge dto={dto} />
      {/*
        Sağ tıkı bulamayan kullanıcı için görünür kapı. pointerdown durdurulur:
        satırın sürükleme kaynağı bu tıklamayı hayalet sürüklemeye çevirmesin.
        Menü, düğmenin ALTINDAN açılır (imleç konumu değil) — düğmeye basan
        kullanıcı menüyü orada bekler.
      */}
      <button
        type="button"
        data-testid="asset-menu-button"
        aria-label={`${dto.fileName} işlemleri`}
        title="Medya işlemleri (sağ tık da olur)"
        className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-[11px] leading-none text-fg-muted hover:bg-surface-3 hover:text-fg"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          onRequestMenu(dto, rect.left, rect.bottom + 2);
        }}
      >
        ⋯
      </button>
    </div>
  );
}

function StatusBadge({ dto }: { dto: AssetDto }) {
  switch (dto.status) {
    case 'uploading':
      return <Badge className="border-accent/40 text-accent">Yükleniyor</Badge>;
    case 'uploaded':
      return <Badge className="border-sky-400/40 text-sky-400">Sırada</Badge>;
    case 'processing': {
      const pct = dto.progress !== undefined ? ` %${Math.round(dto.progress * 100)}` : '';
      return <Badge className="border-amber-400/40 text-amber-400">{`İşleniyor${pct}`}</Badge>;
    }
    case 'ready':
      return <Badge className="border-emerald-400/40 text-emerald-400">Hazır</Badge>;
    case 'failed':
      return (
        <Badge className="border-danger/40 text-danger" title={dto.errorCode}>
          Başarısız
        </Badge>
      );
  }
}

function Badge({
  className,
  title,
  children,
}: {
  className: string;
  title?: string;
  children: string;
}) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${className}`}
      title={title}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
      {children}
    </h3>
  );
}

function CountBadge({ count }: { count: number }) {
  return (
    <span className="rounded-full bg-surface-3 px-1.5 py-px text-[10px] font-semibold text-fg-muted">
      {count}
    </span>
  );
}
