/**
 * useModalFocus — el yapımı (kütüphanesiz) modal overlay'ler için ORTAK odak
 * sözleşmesi. `aria-modal="true"` yazmak ekran okuyucuya "arka plan yok
 * sayılır" demektir; bu hook o sözün klavye tarafını TEK desende uygular.
 * ExportDialog, ShortcutsHelpOverlay ve ConflictDialog üçü de bunu kullanır;
 * davranış e2e'de gerçek klavyeyle ölçülür (a11y-smoke.spec.ts "modal odak
 * sözleşmesi" bölümü — "aria-modal yazan ama odak yönetmeyen overlay" YÜKSEK
 * denetim bulgusunun kapanışı).
 *
 * Üç davranış + bir opsiyon:
 *  1. AÇILIŞTA odak diyaloğun içine taşınır (ilk odaklanabilir öğe; hiç
 *     odaklanabilir öğe yoksa konteynerin kendisi — o durumda konteynere
 *     tabIndex={-1} vermek çağıranın sorumluluğudur).
 *  2. ODAK TUZAĞI: Tab / Shift+Tab uçlarda döngü yapar, odak konteynerin
 *     dışına çıkamaz. Keydown WINDOW'a değil overlay köküne bağlanır
 *     (onKeyDown): üst üste iki modal açılırsa (ör. export açıkken '?')
 *     tuşları yalnız ODAKLI olan işler, alttaki karışmaz.
 *  3. KAPANIŞTA odak, diyalog açılırken odaklı olan öğeye (tetikleyici düğme)
 *     geri verilir — kullanıcı kaldığı yerden devam eder.
 *  4. `onEscape` verilirse Escape overlay içindeyken diyaloğu kapatır ve
 *     olayı yutar (stopPropagation: merkezi kısayol dispatcher'ı aynı Escape'i
 *     bir daha işlemez). ConflictDialog Escape VERMEZ: tek güvenli çıkış
 *     "Sunucudaki sürümü yükle" düğmesidir, Escape ile kaçılamaz.
 *
 * StrictMode dayanıklılığı: effect cleanup'ı odağı tetikleyiciye GERİ verir,
 * yeniden koşan effect aynı tetikleyiciyi yeniden yakalar — dev'deki çift
 * mount net sonucu değiştirmez.
 *
 * Bilinen sınır (bilinçli): odaklı öğe diyalog açıkken `disabled` olursa
 * tarayıcı odağı body'ye düşürür ve kök-keydown tuzağı o anki Tab'ı görmez.
 * Ürün akışlarında bu yalnız submit sırasında (ms mertebesi) olabilir; window
 * capture listener'a geçmek bunu kapatır ama üst üste modal durumunu bozar.
 */
import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';

/** Tab sırasına girebilen öğeler (disabled hariç; tabindex=-1 hariç). */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Konteynerdeki görünür odaklanabilirler, DOM sırasıyla. */
function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    // display:none / boyutsuz öğeler Tab sırasında yoktur; tuzak da saymasın.
    (el) => el.getClientRects().length > 0,
  );
}

export interface ModalFocus {
  /** role="dialog" (veya alertdialog) taşıyan KUTUYA bağlanır. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Overlay'in KÖK (backdrop) div'ine bağlanır — Tab tuzağı + Escape. */
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}

export function useModalFocus(open: boolean, onEscape?: () => void): ModalFocus {
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** Diyalog açılırken odaklı olan öğe — kapanışta odak buna geri verilir. */
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (focusables(container)[0] ?? container).focus();
    return () => {
      const restore = restoreRef.current;
      restoreRef.current = null;
      // Tetikleyici DOM'dan kalktıysa (ör. proje kapandı) odağa dokunma.
      if (restore !== null && restore.isConnected) restore.focus();
    };
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && onEscape !== undefined) {
      e.preventDefault();
      e.stopPropagation(); // dispatcher'daki window listener'a ulaşmasın
      onEscape();
      return;
    }
    if (e.key !== 'Tab') return;
    const container = containerRef.current;
    if (container === null) return;
    const items = focusables(container);
    if (items.length === 0) {
      // İçeride gezilecek öğe yok: Tab'ı yut, odak konteynerde kalsın.
      e.preventDefault();
      container.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !container.contains(active)) {
      // Odak bir şekilde kutunun dışına düşmüş (ör. backdrop'a tıklama):
      // ilk Tab'da içeri geri al.
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && (active === first || active === container)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
    // Ara konumlarda tarayıcının doğal Tab sırası çalışır (müdahale yok).
  };

  return { containerRef, onKeyDown };
}
