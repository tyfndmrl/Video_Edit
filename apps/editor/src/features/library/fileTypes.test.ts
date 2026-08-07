/**
 * fileTypes — uzantı whitelist'i backend contentType whitelist'iyle senkron
 * (AssetUploadValidation.ValidateInit: video/mp4, video/quicktime, video/webm,
 * audio/mpeg, audio/mp4, audio/wav, image/png, image/jpeg, image/webp).
 */
import { describe, expect, it } from 'vitest';
import {
  FILE_ACCEPT,
  SUPPORTED_EXTENSIONS,
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
