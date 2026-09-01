/**
 * shuttle birim testleri — fake timer'larla (setInterval + Date birlikte
 * sarılır; döngü delta'yı Date.now'dan aldığı için ikisi aynı saatte akmalı).
 *
 * Kanıtlanan sözleşmeler:
 *  - HIZ DÜRÜSTLÜĞÜ: 1000 ms'de ~1 saniye gerilenir (±1 kare) — iç float
 *    akümülatör store'un kare-yapışık değerinden yeniden hesaplamadığı için
 *    yuvarlanma-stall'ı yoktur.
 *  - Her store yazımı proje kare ızgarasındadır.
 *  - BOF kelepçesi: başlangıca varınca TAM 0 yazılır, metronom durur,
 *    shuttleRate null olur.
 *  - DIŞ user seek (scrub/ok/Home eşdeğeri: dışarıdan setPlayheadUs) shuttle'ı
 *    iptal eder ve kullanıcının hedefi AYNEN kalır.
 *  - isPlaying true olunca shuttle kendini iptal eder (playhead sahibi motor).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOnFrameGrid } from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { SHUTTLE_TICK_MS, startOrBumpShuttle, stopShuttle, useTransportStore } from './shuttle';

const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const US = 1_000_000;
/** 30 fps'te bir kare (yukarı yuvarlanmış üst sınır). */
const FRAME_US = Math.ceil(US / 30);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
  });
  useDocStore.getState().setLocked(false);
  useDocStore.getState().loadDoc(createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }));
  const editor = useEditorStore.getState();
  editor.setIsPlaying(false);
  editor.setPlayheadUs(0);
});

afterEach(() => {
  stopShuttle();
  useTransportStore.setState({ forwardRate: 1, shuttleRate: null });
  vi.useRealTimers();
});

describe('shuttle — hız dürüstlüğü ve kare ızgarası', () => {
  it('1000 ms\'de ~1 saniye geriler (±1 kare) ve her yazım kare ızgarasındadır', () => {
    const editor = useEditorStore.getState();
    editor.setPlayheadUs(12 * US);

    const writes: number[] = [];
    const unsub = useEditorStore.subscribe((state, prev) => {
      if (state.playheadUs !== prev.playheadUs) writes.push(state.playheadUs);
    });

    startOrBumpShuttle();
    expect(useTransportStore.getState().shuttleRate).toBe(1);
    vi.advanceTimersByTime(1000);
    unsub();

    const playhead = useEditorStore.getState().playheadUs;
    expect(
      Math.abs(playhead - 11 * US),
      `1000 ms sonra ~11 sn beklenirdi, ölçülen ${playhead} µs`,
    ).toBeLessThanOrEqual(FRAME_US);

    // Döngü gerçekten metronom hızında yazdı (tek toplu sıçrama değil).
    expect(writes.length).toBeGreaterThan(10);
    const fps = useDocStore.getState().doc.settings.fps;
    for (const w of writes) {
      expect(isOnFrameGrid(w, fps), `yazım kare ızgarasında değil: ${w} µs`).toBe(true);
    }
  });
});

describe('shuttle — BOF kelepçesi', () => {
  it('başlangıca varınca TAM 0 yazar, durur ve shuttleRate null olur', () => {
    const editor = useEditorStore.getState();
    editor.setPlayheadUs(200_000); // 30 fps'te 6. kare — ızgarada

    startOrBumpShuttle();
    vi.advanceTimersByTime(1000);

    expect(useEditorStore.getState().playheadUs).toBe(0);
    expect(useTransportStore.getState().shuttleRate).toBeNull();

    // Metronom GERÇEKTEN durdu: bir saniye daha akıt, hiçbir yazım olmasın.
    const writes: number[] = [];
    const unsub = useEditorStore.subscribe((state, prev) => {
      if (state.playheadUs !== prev.playheadUs) writes.push(state.playheadUs);
    });
    vi.advanceTimersByTime(1000);
    unsub();
    expect(writes).toEqual([]);
    expect(useEditorStore.getState().playheadUs).toBe(0);
  });
});

describe('shuttle — iptal kuralları', () => {
  it('dış user seek shuttle\'ı iptal eder; kullanıcının hedefi AYNEN kalır', () => {
    const editor = useEditorStore.getState();
    editor.setPlayheadUs(10 * US);

    startOrBumpShuttle();
    vi.advanceTimersByTime(10 * SHUTTLE_TICK_MS);
    expect(useEditorStore.getState().playheadUs).toBeLessThan(10 * US);

    // DIŞ seek: timeline scrub / ok tuşu / Home hepsi bu yoldan geçer
    // (source 'user' → userSeekSeq bump) — ayrı bir iptal kancası gerekmez.
    useEditorStore.getState().setPlayheadUs(5 * US);
    vi.advanceTimersByTime(2 * SHUTTLE_TICK_MS);

    expect(useTransportStore.getState().shuttleRate).toBeNull();
    expect(useEditorStore.getState().playheadUs).toBe(5 * US);
  });

  it('isPlaying true olunca shuttle kendini iptal eder ve playhead\'e dokunmaz', () => {
    const editor = useEditorStore.getState();
    editor.setPlayheadUs(10 * US);

    startOrBumpShuttle();
    vi.advanceTimersByTime(10 * SHUTTLE_TICK_MS);

    useEditorStore.getState().setIsPlaying(true);
    const frozen = useEditorStore.getState().playheadUs;
    vi.advanceTimersByTime(2 * SHUTTLE_TICK_MS);

    expect(useTransportStore.getState().shuttleRate).toBeNull();
    expect(useEditorStore.getState().playheadUs).toBe(frozen);
  });
});
