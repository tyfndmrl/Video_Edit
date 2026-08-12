/**
 * versionsLogic — pure presentation/decision logic for the version history UI.
 *
 * Kept DOM-free so it is unit-testable in the editor's node vitest environment
 * (vite.config.ts collects `src/**\/*.test.ts` only, no DOM) — the same split as
 * features/export/exportLogic.ts and features/history/historyLogic.ts.
 */
import type { RevisionMetaDto } from '../../entities/versions';
import { CHECKPOINT_LABEL_MAX } from '../../entities/versions';
import type { AutosaveStatus } from '../../state/autosave';

// ---------------------------------------------------------------------------
// Revision kind presentation
// ---------------------------------------------------------------------------

/**
 * RevisionKind -> Turkish label. Kinds come from the backend enum
 * (VideoEdit.Domain/Enums.cs: Auto, Checkpoint, PreRestore). An unknown kind
 * renders verbatim rather than disappearing — a new server-side kind must be
 * visible, not silently mislabelled.
 */
export function revisionKindLabel(kind: string): string {
  switch (kind) {
    case 'Auto':
      return 'Otomatik';
    case 'Checkpoint':
      return 'Kayıt noktası';
    case 'PreRestore':
      return 'Geri dönüş öncesi';
    default:
      return kind;
  }
}

/** Badge tint per kind (theme tokens from index.css). */
export function revisionKindBadgeClass(kind: string): string {
  switch (kind) {
    case 'Checkpoint':
      return 'text-accent border-accent/40';
    case 'PreRestore':
      return 'text-amber-400 border-amber-400/40';
    default:
      // 'Auto' and anything unknown.
      return 'text-fg-muted border-edge';
  }
}

/**
 * `DD.MM.YYYY HH:MM` in the viewer's local time.
 *
 * Hand-formatted (not toLocaleString) so the output is stable across
 * runtimes/ICU builds — the same reason historyLogic.formatHistoryTime pads by
 * hand. An unparseable timestamp falls back to the raw string.
 */
export function formatRevisionTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

export interface VersionRow {
  /** Revision id (Guid) — React key. */
  id: string;
  revisionNumber: number;
  kind: string;
  kindLabel: string;
  badgeClass: string;
  /** User-supplied checkpoint label, or '' when none. */
  label: string;
  /** `DD.MM.YYYY HH:MM` local. */
  time: string;
  /**
   * This revision is the project's CURRENT SAVED state. Note it says nothing
   * about unsaved local edits — the autosave chip owns that signal.
   */
  current: boolean;
}

/**
 * Rows for the panel, newest first.
 *
 * The server already orders by revisionNumber DESC; sorting again here keeps
 * the panel correct if a caller ever merges pages out of order, and costs
 * nothing at page sizes of 50.
 */
export function buildVersionRows(
  items: RevisionMetaDto[],
  currentRevision: number | null,
): VersionRow[] {
  return [...items]
    .sort((a, b) => b.revisionNumber - a.revisionNumber)
    .map((item) => ({
      id: item.id,
      revisionNumber: item.revisionNumber,
      kind: item.kind,
      kindLabel: revisionKindLabel(item.kind),
      badgeClass: revisionKindBadgeClass(item.kind),
      label: item.label?.trim() ?? '',
      time: formatRevisionTimestamp(item.createdAt),
      current: currentRevision !== null && item.revisionNumber === currentRevision,
    }));
}

/** Accessible description of what restoring a given row does. */
export function restoreRowHint(row: VersionRow): string {
  if (row.current) {
    return `${row.revisionNumber} numaralı sürüm sunucudaki güncel kayıt — geri dönmek yalnız kaydedilmemiş değişiklikleri geri alır.`;
  }
  return `Dokümanı ${row.revisionNumber} numaralı sürümün haline döndürür.`;
}

// ---------------------------------------------------------------------------
// Autosave gate (checkpoint + restore)
// ---------------------------------------------------------------------------

export type VersionAction = 'checkpoint' | 'restore';

export type VersionActionGate =
  /** Server copy is current — go straight to the API call. */
  | 'ready'
  /** Unsaved/saving changes — saveNow() must flush and settle first. */
  | 'flush'
  /** Autosave cannot persist (conflict/error) — the action is refused. */
  | 'blocked';

/**
 * What must happen before a checkpoint/restore call, given autosave's status.
 * `null` = autosave is not initialized for this project (nothing to flush).
 *
 * Why BOTH actions flush first:
 * - checkpoint snapshots the SERVER's current document, so unsaved work would
 *   simply not be in the checkpoint;
 * - restore makes the server snapshot the current document as PreRestore — the
 *   ONLY recovery path after the document is replaced. Unflushed work would be
 *   absent from that snapshot too, i.e. destroyed with no way back.
 *
 * Why conflict/error BLOCK: the document was changed elsewhere (conflict) or
 * cannot be persisted (error). Restoring on top of either silently discards
 * work that has no server-side copy. The 409 dialog / retry must come first.
 */
export function versionActionGate(status: AutosaveStatus | null): VersionActionGate {
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
 * Why the action is refused (also covers a flush that ENDED in conflict/error).
 * Null when the status does not block.
 */
export function versionActionBlockReason(
  status: AutosaveStatus | null,
  action: VersionAction,
): string | null {
  const what = action === 'restore' ? 'Geri dönme' : 'Kayıt noktası oluşturma';
  if (status === 'conflict') {
    return (
      `${what} işlemi durduruldu: doküman başka bir sekmede değiştirildi. ` +
      'Önce çakışmayı çözün (sunucudaki sürümü yükleyin), sonra tekrar deneyin.'
    );
  }
  if (status === 'error') {
    return (
      `${what} işlemi durduruldu: kaydedilmemiş değişiklikler sunucuya yazılamıyor. ` +
      'Bu haldeyken devam etmek o değişiklikleri kurtarılamaz biçimde silerdi.'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Checkpoint label
// ---------------------------------------------------------------------------

export type LabelValidation =
  | { ok: true; label: string | null }
  | { ok: false; message: string };

/**
 * Trim + length-check the checkpoint label. Empty means "no label" (the
 * backend accepts null). The 200-character cap mirrors the server's
 * ValidationProblem so the user is told before the round trip.
 */
export function normalizeCheckpointLabel(raw: string): LabelValidation {
  const label = raw.trim();
  if (label.length > CHECKPOINT_LABEL_MAX) {
    return {
      ok: false,
      message: `Etiket en fazla ${CHECKPOINT_LABEL_MAX} karakter olabilir (şu an ${label.length}).`,
    };
  }
  return { ok: true, label: label.length === 0 ? null : label };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map a failed checkpoint/restore call (HTTP status) to the message shown in
 * the panel. 404 = the project or revision is gone; 409 = the project changed
 * concurrently (backend's DbUpdateConcurrencyException branch).
 */
export function mapVersionActionError(status: number, action: VersionAction): string {
  if (status === 404) {
    return action === 'restore'
      ? 'Dönülmek istenen sürüm bulunamadı — liste yenilendi.'
      : 'Proje bulunamadı — kayıt noktası oluşturulamadı.';
  }
  if (status === 409) {
    return 'Proje aynı anda başka bir yerden değiştirildi. Sayfayı yenileyip tekrar deneyin.';
  }
  if (status === 422 || status === 400) {
    return 'İstek sunucu tarafından reddedildi (geçersiz etiket ya da sürüm numarası).';
  }
  return action === 'restore'
    ? `Sürüme dönülemedi (HTTP ${status}). Doküman değişmedi.`
    : `Kayıt noktası oluşturulamadı (HTTP ${status}).`;
}

/** Success notice after a restore. */
export function restoreSuccessNotice(revisionNumber: number, newRevision: number): string {
  return (
    `${revisionNumber} numaralı sürüme dönüldü (yeni revizyon ${newRevision}). ` +
    'Önceki hal "Geri dönüş öncesi" olarak listede duruyor; geri alma geçmişi temizlendi.'
  );
}

/** Success notice after a manual checkpoint. */
export function checkpointSuccessNotice(revisionNumber: number, label: string | null): string {
  const named = label === null ? '' : ` — "${label}"`;
  return `Kayıt noktası oluşturuldu: ${revisionNumber} numaralı sürüm${named}.`;
}
