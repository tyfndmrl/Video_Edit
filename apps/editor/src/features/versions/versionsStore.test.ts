/**
 * versionsStore — overlay open/close semantics, including the "cannot close
 * while a write action is running" rule (the editor is locked then; hiding the
 * panel would leave a frozen editor with no explanation).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeVersionsOverlay,
  isVersionsOverlayOpen,
  openVersionsOverlay,
  toggleVersionsOverlay,
  useVersionsStore,
} from './versionsStore';

beforeEach(() => {
  useVersionsStore.setState({ open: false, busy: null, error: null, notice: null });
});

describe('open/close', () => {
  it('opens and closes', () => {
    openVersionsOverlay();
    expect(isVersionsOverlayOpen()).toBe(true);
    closeVersionsOverlay();
    expect(isVersionsOverlayOpen()).toBe(false);
  });

  it('clears stale feedback when reopening', () => {
    useVersionsStore.setState({ error: 'eski hata', notice: 'eski bildirim' });
    openVersionsOverlay();
    expect(useVersionsStore.getState().error).toBeNull();
    expect(useVersionsStore.getState().notice).toBeNull();
  });

  it('toggles', () => {
    toggleVersionsOverlay();
    expect(isVersionsOverlayOpen()).toBe(true);
    toggleVersionsOverlay();
    expect(isVersionsOverlayOpen()).toBe(false);
  });
});

describe('busy guard', () => {
  it('refuses to close while a restore is running', () => {
    useVersionsStore.setState({ open: true, busy: 'restore' });
    closeVersionsOverlay();
    expect(isVersionsOverlayOpen()).toBe(true);
  });

  it('refuses to close while a checkpoint is running', () => {
    useVersionsStore.setState({ open: true, busy: 'checkpoint' });
    closeVersionsOverlay();
    expect(isVersionsOverlayOpen()).toBe(true);
  });

  it('toggle cannot close a busy panel either', () => {
    useVersionsStore.setState({ open: true, busy: 'restore' });
    toggleVersionsOverlay();
    expect(isVersionsOverlayOpen()).toBe(true);
  });

  it('closes once the action finishes', () => {
    useVersionsStore.setState({ open: true, busy: 'restore' });
    useVersionsStore.setState({ busy: null });
    closeVersionsOverlay();
    expect(isVersionsOverlayOpen()).toBe(false);
  });
});
