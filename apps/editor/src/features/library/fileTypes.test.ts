/**
 * fileTypes — uzantı whitelist'i backend contentType whitelist'iyle senkron
 * (AssetUploadValidation.ValidateInit: video/mp4, video/quicktime, video/webm,
 * audio/mpeg, audio/mp4, audio/wav, image/png, image/jpeg, image/webp).
 */
import { describe, expect, it } from 'vitest';
import {
  FILE_ACCEPT,
  SUPPORTED_EXTENSIONS,
  contentTypeForFileName,
  fileExtension,
  isSupportedMediaFile,
  unsupportedFileMessage,
} from './fileTypes';

describe('fileExtension', () => {
  it('lowercases the extension including the dot', () => {
    expect(fileExtension('Video.MP4')).toBe('.mp4');
    expect(fileExtension('song.M4A')).toBe('.m4a');
  });

  it('takes only the last segment of multi-dot names', () => {
    expect(fileExtension('archive.tar.gz')).toBe('.gz');
    expect(fileExtension('clip.final.mov')).toBe('.mov');
  });

  it('returns empty for no/hidden/trailing-dot names', () => {
    expect(fileExtension('README')).toBe('');
    expect(fileExtension('.gitignore')).toBe('');
    expect(fileExtension('weird.')).toBe('');
  });
});

describe('isSupportedMediaFile', () => {
  it('accepts every whitelisted extension (case-insensitively)', () => {
    for (const ext of SUPPORTED_EXTENSIONS) {
      expect(isSupportedMediaFile(`file${ext}`), ext).toBe(true);
      expect(isSupportedMediaFile(`FILE${ext.toUpperCase()}`), ext).toBe(true);
    }
  });

  it('rejects formats outside the backend whitelist', () => {
    for (const name of ['movie.mkv', 'clip.avi', 'audio.flac', 'notes.txt', 'anim.gif', 'noext']) {
      expect(isSupportedMediaFile(name), name).toBe(false);
    }
  });
});

describe('FILE_ACCEPT', () => {
  it('is the comma-joined whitelist for the file input accept attribute', () => {
    expect(FILE_ACCEPT).toBe('.mp4,.mov,.webm,.mp3,.m4a,.wav,.png,.jpg,.jpeg,.webp');
  });
});

describe('contentTypeForFileName', () => {
  /** backend UploadRules.ContentTypeKinds — sunucunun kabul ettiği TAM küme. */
  const BACKEND_WHITELIST = [
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'audio/mpeg',
    'audio/mp4',
    'audio/wav',
    'image/png',
    'image/jpeg',
    'image/webp',
  ];

  it('maps EVERY supported extension to a type the backend accepts', () => {
    // Kapı uzantıyı kabul edip gönderilen tip whitelist dışı kalırsa yükleme daha
    // ilk adımda sunucuda düşer — ölçülen kusur tam olarak buydu (.m4a).
    for (const ext of SUPPORTED_EXTENSIONS) {
      const contentType = contentTypeForFileName(`sarki${ext}`);
      expect(contentType, ext).not.toBeNull();
      expect(BACKEND_WHITELIST, `${ext} -> ${String(contentType)}`).toContain(contentType);
    }
  });

  it('does not trust the browser MIME for .m4a (measured: Chromium/Windows says audio/x-m4a)', () => {
    expect(contentTypeForFileName('muzik.m4a')).toBe('audio/mp4');
    expect(contentTypeForFileName('MUZIK.M4A')).toBe('audio/mp4');
  });

  it('returns null outside the whitelist (that file never reaches upload)', () => {
    expect(contentTypeForFileName('movie.mkv')).toBeNull();
    expect(contentTypeForFileName('README')).toBeNull();
  });
});

describe('unsupportedFileMessage', () => {
  it('names the offending extension and lists the supported families in Turkish', () => {
    const msg = unsupportedFileMessage('movie.mkv');
    expect(msg).toContain('Desteklenmeyen format: .mkv');
    expect(msg).toContain('MP4/MOV/WebM');
    expect(msg).toContain('MP3/M4A/WAV');
    expect(msg).toContain('PNG/JPG/WebP');
  });

  it('handles extensionless files', () => {
    expect(unsupportedFileMessage('README')).toContain('uzantısız dosya');
  });
});
