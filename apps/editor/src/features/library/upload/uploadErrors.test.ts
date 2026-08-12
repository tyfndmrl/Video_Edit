/**
 * uploadErrors — kota reddi kullanıcıyı GÖSTERGEYE ve somut bir çözüme
 * yönlendirmeli. Ham "Storage quota exceeded (max 21474836480 bytes per user)."
 * başlığı bir kullanıcı mesajı değildir.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../entities/apiClient';
import { UploadError } from './uploadEngine';
import { quotaRejectionMessage, uploadErrorMessage } from './uploadErrors';

function initError(status: number, title: string): UploadError {
  const api = new ApiError(status, '/api/projects/p/assets', `HTTP ${status}`, { title });
  return new UploadError('init-failed', 'Yükleme başlatılamadı', { cause: api });
}

describe('quotaRejectionMessage', () => {
  it('403 -> kota göstergesine yönlendirir', () => {
    const message = quotaRejectionMessage(403, 'Storage quota exceeded');
    expect(message).toContain('kota göstergesine');
    expect(message).toContain('silin');
  });

  it('429 -> eşzamanlı yükleme sınırı', () => {
    const message = quotaRejectionMessage(429, 'Too many concurrent uploads (max 5).');
    expect(message).toContain('Aynı anda çok fazla yükleme');
    expect(message).toContain('Too many concurrent uploads (max 5).');
  });

  it('diğer statüler kota mesajı üretmez', () => {
    expect(quotaRejectionMessage(400, 'bad request')).toBeNull();
    expect(quotaRejectionMessage(500, null)).toBeNull();
  });
});

describe('uploadErrorMessage', () => {
  it('init 403 kota reddini Türkçe yönlendirmeye çevirir', () => {
    const message = uploadErrorMessage(
      initError(403, 'Storage quota exceeded (max 21474836480 bytes per user).'),
    );
    expect(message).toContain('kota göstergesine');
    expect(message).not.toContain('bytes per user');
  });

  it('kota DIŞI hatalarda sunucu detayını korur', () => {
    const message = uploadErrorMessage(
      initError(400, 'contentType desteklenmiyor: video/x-matroska'),
    );
    expect(message).toBe('Yükleme başlatılamadı: contentType desteklenmiyor: video/x-matroska');
  });

  it('init DIŞI adımdaki 403 kotaya yorulmaz', () => {
    const api = new ApiError(403, '/api/assets/x/complete', 'HTTP 403', { title: 'Forbidden' });
    const err = new UploadError('complete-failed', 'Yükleme tamamlanamadı', { cause: api });
    const message = uploadErrorMessage(err);
    expect(message).toBe('Yükleme tamamlanamadı: Forbidden');
  });
});
