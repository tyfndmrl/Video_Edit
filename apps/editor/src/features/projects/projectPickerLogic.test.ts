/**
 * projectPickerLogic — liste -> seçim akışının DOM'suz kısımları:
 * URL parametre üretimi, store senkronu (aç/kapat) ve ad doğrulaması.
 * (node ortamı: window yok -> history.replaceState senkronu sessizce atlanır.)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from '../../state/editorStore';
import {
  PROJECT_NAME_MAX_LENGTH,
  formatUpdatedAt,
  openProjectInEditor,
  projectSearchString,
  returnToProjectPicker,
  validateProjectName,
} from './projectPickerLogic';

const PROJECT = '01890000-0000-7000-8000-0000000000e1';
const OTHER = '01890000-0000-7000-8000-0000000000e2';

beforeEach(() => {
  useEditorStore.getState().setActiveProjectId(null);
});

describe('projectSearchString', () => {
  it('adds ?project= to an empty search', () => {
    expect(projectSearchString('', PROJECT)).toBe(`?project=${PROJECT}`);
  });

  it('replaces an existing project id and keeps other params', () => {
    // URLSearchParams.set mevcut anahtarın konumunu korur.
    expect(projectSearchString(`?project=${OTHER}&foo=1`, PROJECT)).toBe(
      `?project=${PROJECT}&foo=1`,
    );
  });

  it('removes the param when projectId is null (empty string when nothing remains)', () => {
    expect(projectSearchString(`?project=${PROJECT}`, null)).toBe('');
    expect(projectSearchString(`?project=${PROJECT}&foo=1`, null)).toBe('?foo=1');
  });
});

describe('open / return flow', () => {
  it('openProjectInEditor sets the active project id (EditorBoot opens the session)', () => {
    openProjectInEditor(PROJECT);
    expect(useEditorStore.getState().activeProjectId).toBe(PROJECT);
  });

  it('returnToProjectPicker clears the active project id (EditorBoot closes the session)', () => {
    openProjectInEditor(PROJECT);
    returnToProjectPicker();
    expect(useEditorStore.getState().activeProjectId).toBeNull();
  });

  it('selecting another project switches the id', () => {
    openProjectInEditor(PROJECT);
    openProjectInEditor(OTHER);
    expect(useEditorStore.getState().activeProjectId).toBe(OTHER);
  });
});

describe('validateProjectName', () => {
  it('trims and accepts a normal name', () => {
    expect(validateProjectName('  Tanıtım filmi  ')).toEqual({ ok: true, name: 'Tanıtım filmi' });
  });

  it('rejects empty / whitespace-only names', () => {
    expect(validateProjectName('').ok).toBe(false);
    expect(validateProjectName('   ').ok).toBe(false);
  });

  it('rejects names above the backend limit (200), accepts exactly 200', () => {
    expect(validateProjectName('a'.repeat(PROJECT_NAME_MAX_LENGTH)).ok).toBe(true);
    const tooLong = validateProjectName('a'.repeat(PROJECT_NAME_MAX_LENGTH + 1));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error).toContain('200');
  });
});

describe('formatUpdatedAt', () => {
  it('renders a parseable ISO date as non-empty text', () => {
    expect(formatUpdatedAt('2026-08-07T11:30:00+00:00')).not.toBe('—');
    expect(formatUpdatedAt('2026-08-07T11:30:00+00:00').length).toBeGreaterThan(0);
  });

  it('renders an unparseable date as an em dash', () => {
    expect(formatUpdatedAt('not-a-date')).toBe('—');
  });
});
