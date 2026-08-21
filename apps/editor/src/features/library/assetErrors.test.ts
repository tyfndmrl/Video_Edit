import { describe, expect, it } from 'vitest';
import { assetErrorLabel } from './assetErrors';

describe('assetErrorLabel', () => {
  it("bilinen kod Türkçe etiket + parantezde kod verir (e2e /invalid-lut/ eşleşmesi yaşar)", () => {
    expect(assetErrorLabel('invalid-lut')).toBe('Geçersiz .cube dosyası (invalid-lut)');
  });

  it('bilinmeyen kod olduğu gibi düşer — çeviri uydurulmaz', () => {
    expect(assetErrorLabel('unsupported-media')).toBe('unsupported-media');
    expect(assetErrorLabel('too-long')).toBe('too-long');
  });
});
