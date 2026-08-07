/**
 * exportLogic — the DOM-free presentation logic behind ExportDialog and
 * ExportJobsCard (the repo has no testing-library; components stay thin over
 * these functions).
 */
import { describe, expect, it } from 'vitest';
import {
  autosaveSummary,
  clampPercent,
  exportAutosaveGate,
  exportBlockReason,
  mapExportError,
  stageLabel,
  statusBadgeClass,
  statusLabel,
} from './exportLogic';

describe('mapExportError (ExportDialog message)', () => {
  it('422: surfaces the ProblemDetails detail in the unsupported-feature message', () => {
    const err = mapExportError(422, {
      type: 'https://videoedit.dev/errors/unsupported-feature',
      title: 'Unsupported feature',
      status: 422,
      detail: 'Keyframe animasyonları henüz render edilemiyor',
    });
    expect(err.kind).toBe('unsupported');
    expect(err.message).toBe(
      'Bu proje henüz desteklenmeyen özellik içeriyor: Keyframe animasyonları henüz render edilemiyor',
    );
  });

  it('422 without a usable detail falls back to the generic unsupported text', () => {
    expect(mapExportError(422, undefined).message).toBe(
      'Bu proje henüz desteklenmeyen özellik içeriyor.',
    );
    expect(mapExportError(422, { detail: '' }).message).toBe(
      'Bu proje henüz desteklenmeyen özellik içeriyor.',
    );
    expect(mapExportError(422, { detail: 42 }).kind).toBe('unsupported');
    expect(mapExportError(422, 'not-json').message).toBe(
      'Bu proje henüz desteklenmeyen özellik içeriyor.',
    );
  });

  it('429: concurrent-limit info (not styled as an error)', () => {
    const err = mapExportError(429, { title: 'Too many requests' });
    expect(err.kind).toBe('limit');
    expect(err.message).toMatch(/Eşzamanlı dışa aktarma sınırı/);
  });

  it('other statuses: generic failure with the HTTP status', () => {
    const err = mapExportError(500, undefined);
    expect(err.kind).toBe('generic');
    expect(err.message).toContain('HTTP 500');
  });
});

describe('stage / status labels', () => {
  // Stage anahtarları backend/src/VideoEdit.Worker/Jobs/ExportJob.cs ile
  // senkron tutulmalı (download/compile/render/probe/upload/done/disk-wait).
  it('maps the known worker progress stages to Turkish', () => {
    expect(stageLabel('download')).toBe('İndiriliyor');
    expect(stageLabel('compile')).toBe('Hazırlanıyor');
    expect(stageLabel('render')).toBe('Render');
    expect(stageLabel('probe')).toBe('Doğrulanıyor');
    expect(stageLabel('upload')).toBe('Yükleniyor');
    expect(stageLabel('disk-wait')).toBe('Disk bekleniyor');
  });

  it('passes unknown stages through verbatim (forward compatibility)', () => {
    expect(stageLabel('muxing')).toBe('muxing');
    expect(stageLabel('done')).toBe('done');
  });

  it('renders a null stage (worker has not reported yet) as empty', () => {
    expect(stageLabel(null)).toBe('');
  });

  it('labels every job status', () => {
    expect(statusLabel('queued')).toBe('Sırada');
    expect(statusLabel('running')).toBe('Çalışıyor');
    expect(statusLabel('succeeded')).toBe('Tamamlandı');
    expect(statusLabel('failed')).toBe('Başarısız');
    expect(statusLabel('canceled')).toBe('İptal edildi');
  });

  it('tints failure states with the danger token', () => {
    expect(statusBadgeClass('failed')).toContain('text-danger');
    expect(statusBadgeClass('succeeded')).toContain('emerald');
  });
});

describe('exportAutosaveGate (submit must use the last SAVED document)', () => {
  it('ready when nothing is unsaved (or autosave is not initialized)', () => {
    expect(exportAutosaveGate('idle')).toBe('ready');
    expect(exportAutosaveGate('saved')).toBe('ready');
    expect(exportAutosaveGate(null)).toBe('ready');
  });

  it('flush when there are unsaved or in-flight changes', () => {
    expect(exportAutosaveGate('dirty')).toBe('flush');
    expect(exportAutosaveGate('saving')).toBe('flush');
  });

  it('blocked when autosave cannot persist (conflict / error)', () => {
    expect(exportAutosaveGate('conflict')).toBe('blocked');
    expect(exportAutosaveGate('error')).toBe('blocked');
  });

  it('block reasons explain that the export would use the last saved server copy', () => {
    expect(exportBlockReason('conflict')).toContain(
      'Kaydedilemeyen değişiklikler var — export sunucudaki son kaydedilen hali kullanır',
    );
    expect(exportBlockReason('conflict')).toContain('çakışma');
    expect(exportBlockReason('error')).toContain(
      'Kaydedilemeyen değişiklikler var — export sunucudaki son kaydedilen hali kullanır',
    );
    expect(exportBlockReason('error')).toContain('kaydetme hata');
  });

  it('no block reason for non-blocking states', () => {
    expect(exportBlockReason('idle')).toBeNull();
    expect(exportBlockReason('saved')).toBeNull();
    expect(exportBlockReason('dirty')).toBeNull();
    expect(exportBlockReason('saving')).toBeNull();
    expect(exportBlockReason(null)).toBeNull();
  });
});

describe('autosaveSummary (last-save info line in the open dialog)', () => {
  it('describes every autosave status', () => {
    expect(autosaveSummary('idle')).toBe('Değişiklik yok — sunucudaki kayıt güncel.');
    expect(autosaveSummary('saved')).toBe('Tüm değişiklikler kaydedildi.');
    expect(autosaveSummary('dirty')).toBe(
      'Kaydedilmemiş değişiklikler var — export başlatılırken kaydedilecek.',
    );
    expect(autosaveSummary('saving')).toBe('Değişiklikler kaydediliyor…');
    expect(autosaveSummary('error')).toBe('Son kayıt başarısız oldu.');
    expect(autosaveSummary('conflict')).toBe('Belge başka bir sekmede değiştirildi.');
  });

  it('handles a project without autosave wiring', () => {
    expect(autosaveSummary(null)).toBe('Kayıt durumu bilinmiyor.');
  });
});

describe('clampPercent', () => {
  it('clamps into 0..100 and rounds', () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(41.6)).toBe(42);
    expect(clampPercent(150)).toBe(100);
  });

  it('treats non-finite input as 0', () => {
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
