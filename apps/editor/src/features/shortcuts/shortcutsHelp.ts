/**
 * shortcutsHelp — kısayol listesi overlay'inin açık/kapalı durumu + statik
 * içerik. '?' tuşu (dispatcher) ve TopBar'daki '?' butonu toggle eder.
 *
 * Liste dispatcher.ts'teki dispatch haritasından ELLE türetilmiş statik bir
 * envanterdir; dispatcher'a yeni kısayol eklenirse burası da güncellenmelidir.
 */
import { create } from 'zustand';

interface ShortcutsOverlayStore {
  open: boolean;
}

export const useShortcutsOverlayStore = create<ShortcutsOverlayStore>()(() => ({ open: false }));

export function toggleShortcutsOverlay(): void {
  useShortcutsOverlayStore.setState((s) => ({ open: !s.open }));
}

export function closeShortcutsOverlay(): void {
  useShortcutsOverlayStore.setState({ open: false });
}

export function isShortcutsOverlayOpen(): boolean {
  return useShortcutsOverlayStore.getState().open;
}

export interface ShortcutEntry {
  keys: string;
  label: string;
}

export interface ShortcutSection {
  title: string;
  entries: ShortcutEntry[];
}

/** dispatcher.ts haritasının Türkçe envanteri (statik). */
export const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    title: 'Oynatma',
    entries: [
      { keys: 'Space', label: 'Oynat / Duraklat' },
      { keys: 'J / K / L', label: 'Geri sar / Duraklat / Oynat (L tekrar: 2x…8x hız)' },
      { keys: '← / →', label: '1 kare geri / ileri' },
      { keys: 'Shift + ← / →', label: '1 saniye geri / ileri' },
      { keys: '↑ / ↓', label: 'Önceki / sonraki kesme noktası' },
      { keys: 'Home / End', label: 'Başa / sona git' },
    ],
  },
  {
    title: 'Düzenleme',
    entries: [
      { keys: 'C', label: "Playhead'de böl" },
      { keys: 'Q / W', label: "Klip başını / sonunu playhead'e kırp" },
      { keys: 'Delete / Backspace', label: 'Seçili klipleri sil (Shift: ripple)' },
      { keys: 'M', label: 'Marker ekle' },
      { keys: 'Ctrl + Z', label: 'Geri al' },
      { keys: 'Ctrl + Shift + Z / Ctrl + Y', label: 'Yinele' },
      { keys: 'Ctrl + A', label: 'Tüm klipleri seç' },
      { keys: 'Ctrl + C / X / V', label: 'Kopyala / Kes / Playhead\'e yapıştır' },
      { keys: 'Ctrl + D', label: 'Seçimi çoğalt' },
    ],
  },
  {
    title: 'Görünüm',
    entries: [
      { keys: 'S', label: 'Yapışma (snapping) aç/kapat' },
      { keys: '+ / -', label: 'Yakınlaştır / Uzaklaştır' },
      { keys: 'Shift + Z', label: 'Projeyi görünüme sığdır' },
      { keys: '?', label: 'Bu listeyi aç/kapat' },
    ],
  },
];
