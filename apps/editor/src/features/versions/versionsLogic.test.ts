/**
 * versionsLogic — pure row model, gate and message derivations for the version
 * history UI (features/export/exportLogic.test.ts pattern).
 */
import { describe, expect, it } from 'vitest';
import type { RevisionMetaDto } from '../../entities/versions';
import {
  buildVersionRows,
  checkpointSuccessNotice,
  formatRevisionTimestamp,
  mapVersionActionError,
  normalizeCheckpointLabel,
  restoreRowHint,
  restoreSuccessNotice,
  revisionKindLabel,
  versionActionBlockReason,
  versionActionGate,
} from './versionsLogic';

function revision(
  revisionNumber: number,
  kind: string,
  label: string | null = null,
  createdAt = '2026-08-11T10:00:00+00:00',
): RevisionMetaDto {
  return {
    id: `rev-${revisionNumber}`,
    revisionNumber,
    kind,
    label,
    createdBy: 'user-1',
    createdAt,
  };
}

describe('revisionKindLabel', () => {
  it('maps the three backend kinds', () => {
    expect(revisionKindLabel('Auto')).toBe('Otomatik');
    expect(revisionKindLabel('Checkpoint')).toBe('Kayıt noktası');
    expect(revisionKindLabel('PreRestore')).toBe('Geri dönüş öncesi');
  });

  it('renders an unknown kind verbatim instead of hiding it', () => {
    expect(revisionKindLabel('SomethingNew')).toBe('SomethingNew');
  });
});

describe('formatRevisionTimestamp', () => {
  it('formats as DD.MM.YYYY HH:MM in local time', () => {
    // Constructed locally so the expectation is timezone independent.
    const d = new Date(2026, 7, 9, 4, 5); // 9 Aug 2026, 04:05 local
    expect(formatRevisionTimestamp(d.toISOString())).toBe('09.08.2026 04:05');
  });

  it('falls back to the raw string for an unparseable timestamp', () => {
    expect(formatRevisionTimestamp('not-a-date')).toBe('not-a-date');
  });
});

describe('buildVersionRows', () => {
  it('orders newest first and marks the current saved revision', () => {
    const rows = buildVersionRows(
      [revision(1, 'Auto'), revision(3, 'PreRestore'), revision(2, 'Checkpoint', ' ilk kesim ')],
      2,
    );

    expect(rows.map((r) => r.revisionNumber)).toEqual([3, 2, 1]);
    expect(rows.map((r) => r.current)).toEqual([false, true, false]);
    // Labels are trimmed; a missing label becomes ''.
    expect(rows[1]!.label).toBe('ilk kesim');
    expect(rows[0]!.label).toBe('');
    expect(rows[1]!.kindLabel).toBe('Kayıt noktası');
  });

  it('marks nothing current when the revision is unknown (other project)', () => {
    const rows = buildVersionRows([revision(1, 'Auto'), revision(2, 'Auto')], null);
    expect(rows.some((r) => r.current)).toBe(false);
  });

  it('returns [] for an empty list (panel shows the empty state)', () => {
    expect(buildVersionRows([], 5)).toEqual([]);
  });

  it('does not mutate the caller array', () => {
    const items = [revision(1, 'Auto'), revision(2, 'Auto')];
    buildVersionRows(items, null);
    expect(items.map((r) => r.revisionNumber)).toEqual([1, 2]);
  });
});

describe('restoreRowHint', () => {
  it('warns that restoring the current revision only drops unsaved work', () => {
    const [row] = buildVersionRows([revision(4, 'Auto')], 4);
    expect(restoreRowHint(row!)).toMatch(/güncel kayıt/i);
  });

  it('describes the target revision otherwise', () => {
    const [row] = buildVersionRows([revision(4, 'Auto')], 9);
    expect(restoreRowHint(row!)).toMatch(/4 numaralı sürümün haline/);
  });
});

describe('versionActionGate', () => {
  it('flushes unsaved work first', () => {
    expect(versionActionGate('dirty')).toBe('flush');
    expect(versionActionGate('saving')).toBe('flush');
  });

  it('blocks when autosave cannot persist', () => {
    expect(versionActionGate('conflict')).toBe('blocked');
    expect(versionActionGate('error')).toBe('blocked');
  });

  it('is ready when there is nothing to save', () => {
    expect(versionActionGate('idle')).toBe('ready');
    expect(versionActionGate('saved')).toBe('ready');
    expect(versionActionGate(null)).toBe('ready');
  });
});

describe('versionActionBlockReason', () => {
  it('names the conflict resolution path', () => {
    const reason = versionActionBlockReason('conflict', 'restore');
    expect(reason).toMatch(/Geri dönme/);
    expect(reason).toMatch(/çakışma/i);
  });

  it('explains the data loss risk on a save error', () => {
    const reason = versionActionBlockReason('error', 'checkpoint');
    expect(reason).toMatch(/Kayıt noktası oluşturma/);
    expect(reason).toMatch(/kurtarılamaz/);
  });

  it('is null for non-blocking statuses', () => {
    expect(versionActionBlockReason('dirty', 'restore')).toBeNull();
    expect(versionActionBlockReason('saved', 'restore')).toBeNull();
    expect(versionActionBlockReason(null, 'checkpoint')).toBeNull();
  });
});

describe('normalizeCheckpointLabel', () => {
  it('trims and keeps a real label', () => {
    expect(normalizeCheckpointLabel('  müzik öncesi  ')).toEqual({
      ok: true,
      label: 'müzik öncesi',
    });
  });

  it('turns whitespace-only into null (backend accepts null)', () => {
    expect(normalizeCheckpointLabel('   ')).toEqual({ ok: true, label: null });
    expect(normalizeCheckpointLabel('')).toEqual({ ok: true, label: null });
  });

  it('rejects labels over the backend 200-character cap before the round trip', () => {
    const result = normalizeCheckpointLabel('x'.repeat(201));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/200/);
  });

  it('accepts exactly 200 characters', () => {
    expect(normalizeCheckpointLabel('x'.repeat(200)).ok).toBe(true);
  });
});

describe('mapVersionActionError', () => {
  it('explains 404 per action', () => {
    expect(mapVersionActionError(404, 'restore')).toMatch(/sürüm bulunamadı/i);
    expect(mapVersionActionError(404, 'checkpoint')).toMatch(/proje bulunamadı/i);
  });

  it('explains the concurrent-modification 409', () => {
    expect(mapVersionActionError(409, 'restore')).toMatch(/aynı anda/i);
  });

  it('states that the document is unchanged on a generic restore failure', () => {
    expect(mapVersionActionError(500, 'restore')).toMatch(/Doküman değişmedi/);
  });
});

describe('success notices', () => {
  it('names both the source and the new revision after a restore', () => {
    const notice = restoreSuccessNotice(2, 4);
    expect(notice).toMatch(/2 numaralı sürüme dönüldü/);
    expect(notice).toMatch(/yeni revizyon 4/);
    expect(notice).toMatch(/geçmişi temizlendi/i);
  });

  it('includes the label when one was given', () => {
    expect(checkpointSuccessNotice(3, 'ilk kesim')).toMatch(/"ilk kesim"/);
    expect(checkpointSuccessNotice(3, null)).not.toMatch(/"/);
  });
});
