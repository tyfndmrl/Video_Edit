/**
 * previewSource — the preview's source-URL rule, per asset kind.
 *
 * The regression this pins down: the player read `proxyUrl` for EVERY asset,
 * but the worker deliberately produces no proxy for a still
 * (ProcessAssetJob.ProcessImageAsync — "Image için proxy ÜRETİLMEZ"), so the
 * URL was null, the image texture path returned early and photos/stickers were
 * drawn nowhere. Nothing in any store recorded the failure — hence this test.
 */
import { describe, expect, it } from 'vitest';
import { previewDerivative, previewSourceUrl, type PreviewSourceAsset } from './previewSource';

const PROXY = 'https://r2.example/proxy.mp4';
const POSTER = 'https://r2.example/poster.jpg';

function asset(partial: Partial<PreviewSourceAsset> = {}): PreviewSourceAsset {
  return { kind: 'video', status: 'ready', proxyUrl: PROXY, posterUrl: POSTER, ...partial };
}

describe('previewSourceUrl', () => {
  it('decodes the POSTER for an image asset (there is no image proxy)', () => {
    expect(previewSourceUrl(asset({ kind: 'image', proxyUrl: undefined }))).toBe(POSTER);
  });

  it('decodes the proxy for video and audio', () => {
    expect(previewSourceUrl(asset({ kind: 'video' }))).toBe(PROXY);
    expect(previewSourceUrl(asset({ kind: 'audio' }))).toBe(PROXY);
  });

  it('never lets a video fall back to its poster (a still frame is not playback)', () => {
    expect(previewSourceUrl(asset({ kind: 'video', proxyUrl: undefined }))).toBeNull();
  });

  it('returns null while the asset is not ready — derivatives do not exist yet', () => {
    for (const status of ['uploading', 'uploaded', 'processing', 'failed'] as const) {
      expect(previewSourceUrl(asset({ kind: 'image', status }))).toBeNull();
      expect(previewSourceUrl(asset({ kind: 'video', status }))).toBeNull();
    }
  });

  it('returns null for a ready image whose poster url has not arrived yet', () => {
    expect(previewSourceUrl(asset({ kind: 'image', posterUrl: undefined }))).toBeNull();
  });
});

describe('previewDerivative (the kind rule as data — shared with mediaUrls)', () => {
  it('maps image to poster, video/audio to proxy', () => {
    expect(previewDerivative('image')).toBe('poster');
    expect(previewDerivative('video')).toBe('proxy');
    expect(previewDerivative('audio')).toBe('proxy');
  });

  it('agrees with previewSourceUrl for every kind (one rule, not two copies)', () => {
    for (const kind of ['image', 'video', 'audio'] as const) {
      const url = previewSourceUrl(asset({ kind }));
      expect(url).toBe(previewDerivative(kind) === 'poster' ? POSTER : PROXY);
    }
  });
});
