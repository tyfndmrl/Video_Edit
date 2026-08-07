import { describe, expect, it } from 'vitest';
import { MOVE_CONFLICT_MESSAGE, WARNING_TTL_MS, opFailureMessage } from './feedback';

describe('opFailureMessage', () => {
  it('explains the overlap rejection that used to be silent', () => {
    expect(opFailureMessage('overlaps an existing clip')).toBe(MOVE_CONFLICT_MESSAGE);
    expect(MOVE_CONFLICT_MESSAGE).toContain('çakışıyor');
  });

  it('translates the other timelineOps reasons', () => {
    expect(opFailureMessage('track is locked')).toBe('Track kilitli');
    expect(opFailureMessage('clipboard empty')).toBe('Pano boş');
    expect(opFailureMessage('cannot delete the last video track')).toBe(
      'Son video track silinemez',
    );
  });

  it('falls back to a generic message for unknown/absent reasons', () => {
    expect(opFailureMessage('some brand new reason')).toBe('İşlem uygulanamadı');
    expect(opFailureMessage(null)).toBe('İşlem uygulanamadı');
    expect(opFailureMessage(undefined)).toBe('İşlem uygulanamadı');
    expect(opFailureMessage('')).toBe('İşlem uygulanamadı');
  });

  it('keeps the warning short-lived (2 s)', () => {
    expect(WARNING_TTL_MS).toBe(2000);
  });
});
