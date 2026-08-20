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
  exportFrameGridBlockReason,
  mapExportError,
  stageLabel,
  statusBadgeClass,
  statusLabel,
} from './exportLogic';
import type { TimelineDoc } from '@videoedit/timeline-schema';

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

  it('422 with an asset-fact code is NOT framed as an unsupported feature', () => {
    // These codes mean the document conflicts with the user's own library.
    // "Unsupported feature" would send them looking for a feature to remove instead of
    // a file to fix. The list is the server's `AssetFactFeatures` mirror; a backend
    // guard compares both sources so it cannot silently drift.
    for (const feature of [
      'asset-missing',
      'source-out-of-range',
      'lut-asset-type',
      'asset-clip-type',
      'asset-failed',
    ]) {
      const err = mapExportError(422, {
        status: 422,
        feature,
        detail: 'Timeline artık var olmayan bir dosyayı kullanıyor',
      });
      expect(err.kind).toBe('asset');
      expect(err.message).toBe(
        'Bu projedeki bir dosya dışa aktarılamıyor: Timeline artık var olmayan bir dosyayı kullanıyor',
      );
    }

    // Negative control: any other feature code keeps the unsupported-feature framing.
    expect(mapExportError(422, { feature: 'transform-scale', detail: 'x' }).kind).toBe(
      'unsupported',
    );
  });

  it('422 with a resource-ceiling code is NOT framed as an unsupported feature', () => {
    // These codes mean the document is valid and the feature IS supported — the project is
    // simply outside the exporter's resource window. "Unsupported feature" would send the
    // user hunting for a feature to remove instead of shortening the timeline / lowering fps.
    // Mirrors the server's `CeilingFeatures`; a backend guard compares both sources.
    for (const [feature, detail] of [
      ['timeline-too-long', 'Zaman çizelgesinin toplam süresi dışa aktarma tavanını aşıyor'],
      ['project-fps-out-of-range', 'Proje kare hızı kabul edilen aralığın dışında'],
    ] as const) {
      const err = mapExportError(422, { status: 422, feature, detail });
      expect(err.kind).toBe('ceiling');
      expect(err.message).toBe(`Bu proje dışa aktarma sınırlarının dışında: ${detail}`);
    }

    // Ceiling codes without a detail still keep their own framing.
    expect(mapExportError(422, { feature: 'timeline-too-long' }).message).toBe(
      'Bu proje dışa aktarma sınırlarının dışında.',
    );

    // Negative control: a neighbouring compiler code keeps the unsupported-feature framing.
    expect(mapExportError(422, { feature: 'transform-scale', detail: 'x' }).kind).toBe(
      'unsupported',
    );
  });

  it('422 with a bad-VALUE code is neither "unsupported" nor "ceiling"', () => {
    // Third sentence class. Both features ARE supported and the project is inside every
    // resource window — one field carries a value the exporter cannot use. Framing that as
    // "unsupported feature" hid a one-field fix behind a search for a missing feature.
    // Mirrors the server's `DocumentValueFeatures`; a backend guard compares both sources.
    for (const [feature, detail] of [
      ['project-background-color', "'settings.backgroundColor' geçersiz renk değeri taşıyor"],
      ['lut-asset', 'LUT efektinin assetId’si yok'],
    ] as const) {
      const err = mapExportError(422, { status: 422, feature, detail });
      expect(err.kind).toBe('value');
      expect(err.message).toBe(`Bu projedeki bir ayar geçersiz bir değer taşıyor: ${detail}`);
    }

    // Without a detail the framing survives.
    expect(mapExportError(422, { feature: 'project-background-color' }).message).toBe(
      'Bu projedeki bir ayar geçersiz bir değer taşıyor.',
    );

    // The three 422 classes stay distinct: neither of the other two sets answers 'value'.
    expect(mapExportError(422, { feature: 'asset-missing', detail: 'x' }).kind).toBe('asset');
    expect(mapExportError(422, { feature: 'timeline-too-long', detail: 'x' }).kind).toBe(
      'ceiling',
    );
    expect(mapExportError(422, { feature: 'transform-scale', detail: 'x' }).kind).toBe(
      'unsupported',
    );
  });

  it('503: server-side unavailability surfaces the detail (not a bare "try again")', () => {
    const err = mapExportError(503, {
      status: 503,
      feature: 'text-measure-unavailable',
      detail: 'Metin klibinin çizim kutusu ölçülemiyor (sunucuda font kurulumu eksik)',
    });
    expect(err.kind).toBe('unavailable');
    expect(err.message).toBe(
      'Sunucu bu dışa aktarmayı şu an yapamıyor: Metin klibinin çizim kutusu ölçülemiyor (sunucuda font kurulumu eksik)',
    );
    expect(mapExportError(503, undefined).message).toMatch(/şu an yapamıyor/);
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

// ---------------------------------------------------------------------------
// Frame-grid pre-flight (the gate that used to exist with no caller)
// ---------------------------------------------------------------------------

describe('exportFrameGridBlockReason', () => {
  const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
  const TRACK = '01890000-0000-7000-8000-000000000101';
  const CLIP = '01890000-0000-7000-8000-000000000201';

  function docWith(startUs: number, durationUs: number): TimelineDoc {
    return {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      settings: {
        width: 1920,
        height: 1080,
        fps: { num: 30, den: 1 },
        audioSampleRate: 48000,
        backgroundColor: '#000000',
      },
      tracks: [
        {
          id: TRACK,
          type: 'video',
          muted: false,
          hidden: false,
          locked: false,
          clips: [
            {
              id: CLIP,
              kind: 'video',
              assetId: '01890000-0000-7000-8000-00000000000a',
              timelineStartUs: startUs,
              timelineDurationUs: durationUs,
              sourceInUs: 0,
              sourceOutUs: durationUs,
              speed: { rate: 1 },
              audio: null,
              transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
              keyframes: {},
              effects: [],
              opacity: 1,
            },
          ],
        },
      ],
      markers: [],
    };
  }

  it('passes a document whose clip EDGES are on the grid (off-grid length and all)', () => {
    // Frame 1 -> frame 2 at 30 fps: 33_334 us long, which is not itself a grid
    // value. This is what a split produces and it must NOT be blocked.
    expect(exportFrameGridBlockReason(docWith(33_333, 33_334))).toBeNull();
  });

  it('explains an off-grid clip in Turkish instead of letting the render 422 it', () => {
    const reason = exportFrameGridBlockReason(docWith(33_333, 33_333));
    expect(reason).not.toBeNull();
    expect(reason).toContain('kare ızgarasına oturmuyor');
    expect(reason).toContain('66666'); // the offending edge
    expect(reason).toContain('66667'); // the nearest frame boundary
  });

  it('names the START when that is the edge that is off', () => {
    const reason = exportFrameGridBlockReason(docWith(1, 33_332));
    expect(reason).toContain('başlangıcı');
  });
});
