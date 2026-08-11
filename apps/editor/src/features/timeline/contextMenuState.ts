/**
 * contextMenuState — "timeline sağ tık menüsü açık mı" tek bayrağı.
 *
 * Neden ayrı bir modül: menü açıkken global klavye dispatcher'ı SUSMALIDIR.
 * Menü DOM overlay'i window'da yalnız Escape'i yakalıyordu; Delete / c /
 * ArrowDown gibi tuşlar menünün altından geçip dokümanı ve playhead'i
 * değiştiriyordu (menü hâlâ açık ve artık bayat bir hedefi gösterirken).
 * ShortcutsHelpOverlay'deki "modal açık" deseninin aynısı, tersine bağımlılık
 * olmadan: dispatcher bu modülü okur, TimelineContextMenu mount/unmount'ta
 * yazar (bayrak menünün YAŞAM SÜRESİYLE birebir — kapanma yolu ne olursa olsun
 * (Escape, dışarı tık, tekerlek, resize, blur, eylem seçimi) temizlenir).
 */
let open = false;

/** Menü mount edildi/kaldırıldı. */
export function setTimelineMenuOpen(next: boolean): void {
  open = next;
}

/** Global kısayolların pasif kalması gerekiyor mu. */
export function isTimelineMenuOpen(): boolean {
  return open;
}
