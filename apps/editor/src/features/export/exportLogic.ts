/**
 * exportLogic — pure presentation/mapping logic for the export UI.
 *
 * Kept DOM-free so it is unit-testable in the node vitest environment
 * (the repo has no testing-library; components stay thin over these).
 */
import {
  exportFrameGridIssues,
  frameGridIssueSummary,
  type TimelineDoc,
} from '@videoedit/timeline-schema';
import type { ExportJobStatusDto } from '../../entities/exports';
import type { AutosaveStatus } from '../../state/autosave';

// ---------------------------------------------------------------------------
// Frame-grid pre-flight (the compiler's gate, run before the request)
// ---------------------------------------------------------------------------

/**
 * Why this document cannot be exported yet, or null when it clears the export
 * compiler's frame-grid gate.
 *
 * The gate lives in the shared schema package (`exportFrameGridIssues`) and is
 * a verbatim replica of `ExportCompiler.Validate`. Running it HERE turns the
 * one failure mode the user cannot diagnose — a render job that comes back
 * "422 unsupported" minutes later — into a sentence in the dialog, before
 * anything is queued. Documents from older revisions (or from a project whose
 * fps was changed after the fact) are exactly the ones that trip it.
 */
export function exportFrameGridBlockReason(doc: TimelineDoc): string | null {
  const issues = exportFrameGridIssues(doc);
  return issues.length === 0 ? null : frameGridIssueSummary(issues);
}

// ---------------------------------------------------------------------------
// Autosave awareness (export must render the last SAVED document)
// ---------------------------------------------------------------------------

export type ExportAutosaveGate =
  /** Nothing unsaved — submit immediately. */
  | 'ready'
  /** Unsaved/saving changes — saveNow() must flush and settle before submit. */
  | 'flush'
  /** Autosave cannot persist (conflict/error) — submit is blocked. */
  | 'blocked';

/**
 * Decide what the ExportDialog submit must do given the autosave status.
 * `null` = autosave not initialized for this project (nothing to flush).
 */
export function exportAutosaveGate(status: AutosaveStatus | null): ExportAutosaveGate {
  switch (status) {
    case 'dirty':
    case 'saving':
      return 'flush';
    case 'conflict':
    case 'error':
      return 'blocked';
    default:
      // null | 'idle' | 'saved'
      return 'ready';
  }
}

/**
 * Blocking reason shown in the dialog when the gate is 'blocked'
 * (also covers a flush that ENDED in conflict/error). Null otherwise.
 */
export function exportBlockReason(status: AutosaveStatus | null): string | null {
  if (status === 'conflict') {
    return (
      'Kaydedilemeyen değişiklikler var — export sunucudaki son kaydedilen hali kullanır. ' +
      'Önce başka sekmedeki değişikliklerle olan çakışmayı çözün.'
    );
  }
  if (status === 'error') {
    return (
      'Kaydedilemeyen değişiklikler var — export sunucudaki son kaydedilen hali kullanır. ' +
      'Önce kaydetme hatasının giderilmesini bekleyin.'
    );
  }
  return null;
}

/** One-line last-save summary shown inside the open ExportDialog. */
export function autosaveSummary(status: AutosaveStatus | null): string {
  switch (status) {
    case 'idle':
      return 'Değişiklik yok — sunucudaki kayıt güncel.';
    case 'saved':
      return 'Tüm değişiklikler kaydedildi.';
    case 'dirty':
      return 'Kaydedilmemiş değişiklikler var — export başlatılırken kaydedilecek.';
    case 'saving':
      return 'Değişiklikler kaydediliyor…';
    case 'error':
      return 'Son kayıt başarısız oldu.';
    case 'conflict':
      return 'Belge başka bir sekmede değiştirildi.';
    default:
      return 'Kayıt durumu bilinmiyor.';
  }
}

// ---------------------------------------------------------------------------
// Start-export error mapping (POST /api/projects/{id}/exports)
// ---------------------------------------------------------------------------

export type ExportStartErrorKind =
  /** 422 — the document uses a feature the render pipeline does not support yet. */
  | 'unsupported'
  /**
   * 422 with an asset-fact code (see `ASSET_FACT_CODES`). NOT an unsupported
   * feature: the document conflicts with the user's own library, and saying
   * "unsupported feature" would send them looking in the wrong place.
   */
  | 'asset'
  /**
   * 503 — the server cannot serve this request right now (today: text layers cannot
   * be measured because the font install / text engine is missing). The document is
   * NOT at fault and the request is retryable once the server is fixed.
   */
  | 'unavailable'
  /** 429 — concurrent export limit reached (informational, not a failure). */
  | 'limit'
  /** anything else — generic failure. */
  | 'generic';

/**
 * Backend feature codes that mean "an asset is wrong", not "a feature is missing".
 *
 * This list MIRRORS `ExportEndpoints.AssetFactFeatures` on the server. The two are
 * kept in step by a guard that reads BOTH sources and compares them
 * (`ExportGateInventoryTests.TheClientAndServerAgreeOnWhichCodesMeanAnAssetProblem`),
 * because a code that drifts out of this set is not a crash — it is a wrong
 * sentence: the user is told to look for an unsupported feature when the real
 * problem is a file in their own library.
 */
const ASSET_FACT_CODES = new Set([
  'asset-missing',
  'source-out-of-range',
  'lut-asset-type',
  'asset-clip-type',
  'asset-failed',
]);

/** Extract the machine-readable `feature` extension from a ProblemDetails body. */
function problemFeature(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'feature' in body) {
    const feature = (body as { feature?: unknown }).feature;
    if (typeof feature === 'string' && feature.trim() !== '') return feature;
  }
  return null;
}

export interface ExportStartError {
  kind: ExportStartErrorKind;
  message: string;
}

/** Extract ProblemDetails.detail from an unknown error body. */
function problemDetail(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'detail' in body) {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.trim() !== '') return detail;
  }
  return null;
}

/**
 * Map a failed export start (HTTP status + ProblemDetails body) to the message
 * the dialog shows. 422 surfaces the backend's explanatory `detail` verbatim.
 */
export function mapExportError(status: number, body: unknown): ExportStartError {
  if (status === 422) {
    const detail = problemDetail(body);
    const feature = problemFeature(body);
    if (feature !== null && ASSET_FACT_CODES.has(feature)) {
      return {
        kind: 'asset',
        message: detail
          ? `Bu projedeki bir dosya dışa aktarılamıyor: ${detail}`
          : 'Bu projedeki bir dosya dışa aktarılamıyor.',
      };
    }
    return {
      kind: 'unsupported',
      message: detail
        ? `Bu proje henüz desteklenmeyen özellik içeriyor: ${detail}`
        : 'Bu proje henüz desteklenmeyen özellik içeriyor.',
    };
  }
  if (status === 503) {
    // The backend only answers 503 here when it can name the reason; surfacing the
    // detail verbatim is the whole point (a bare "try again" would hide a server
    // setup fault that retrying cannot fix).
    const detail = problemDetail(body);
    return {
      kind: 'unavailable',
      message: detail
        ? `Sunucu bu dışa aktarmayı şu an yapamıyor: ${detail}`
        : 'Sunucu bu dışa aktarmayı şu an yapamıyor. Bir süre sonra tekrar deneyin.',
    };
  }
  if (status === 429) {
    return {
      kind: 'limit',
      message:
        'Eşzamanlı dışa aktarma sınırına ulaşıldı. Devam eden bir dışa aktarma bitince yeniden deneyin.',
    };
  }
  return {
    kind: 'generic',
    message: `Dışa aktarma başlatılamadı (HTTP ${status}). Lütfen tekrar deneyin.`,
  };
}

// ---------------------------------------------------------------------------
// Job row presentation
// ---------------------------------------------------------------------------

/**
 * progressStage -> Turkish label. Stage keys come from the worker
 * (backend/src/VideoEdit.Worker/Jobs/ExportJob.cs): download, compile, render,
 * probe, upload, done, disk-wait. Unknown stages fall through verbatim;
 * null (worker has not reported yet) renders as empty.
 */
export function stageLabel(stage: string | null): string {
  switch (stage) {
    case null:
      return '';
    case 'download':
      return 'İndiriliyor';
    case 'compile':
      return 'Hazırlanıyor';
    case 'render':
      return 'Render';
    case 'probe':
      return 'Doğrulanıyor';
    case 'upload':
      return 'Yükleniyor';
    case 'disk-wait':
      return 'Disk bekleniyor';
    default:
      return stage;
  }
}

export function statusLabel(status: ExportJobStatusDto): string {
  switch (status) {
    case 'queued':
      return 'Sırada';
    case 'running':
      return 'Çalışıyor';
    case 'succeeded':
      return 'Tamamlandı';
    case 'failed':
      return 'Başarısız';
    case 'canceled':
      return 'İptal edildi';
  }
}

/** Badge tint classes per status (theme tokens from index.css). */
export function statusBadgeClass(status: ExportJobStatusDto): string {
  switch (status) {
    case 'queued':
      return 'text-fg-muted border-edge';
    case 'running':
      return 'text-amber-400 border-amber-400/40';
    case 'succeeded':
      return 'text-emerald-400 border-emerald-400/40';
    case 'failed':
      return 'text-danger border-danger/40';
    case 'canceled':
      return 'text-fg-muted border-edge';
  }
}

/** Clamp a backend progress percent into a paintable 0..100 integer. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
