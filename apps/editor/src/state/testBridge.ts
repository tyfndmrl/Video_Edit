/**
 * DEV-only test köprüsü: `window.__videoeditTest`.
 *
 * NEDEN VAR (M4 denetimi, yüksek bulgu): E2E testleri bir jestin SONUCUNU
 * doğrulamak için store'ları okumak zorunda (canvas timeline'ın seçili klip,
 * zoom, scroll durumu için DOM'da okunabilir bir gösterge yok). Bunun tek yolu
 * uygulamanın KULLANDIĞI store örneğine erişmekti; test tarafı bunu Vite'ın
 * modül grafiğinden (`import('/src/state/docStore.ts?t=...')`) çözüyordu ve
 * doğru URL'yi tarayıcının Resource Timing tamponundan buluyordu. O tampon
 * VARSAYILAN 250 kayıtla sınırlıdır: uzun bir oturumda ilgili kayıt düşer,
 * köprü damgasız yola döner ve AYRI bir modül örneği (bomboş bir store) okur.
 * Tek savunma hattıydı.
 *
 * Bu modül ikinci savunma hattıdır: uygulama, kullandığı store örneklerini
 * DEV'de doğrudan yayımlar; köprü önce buna bakar, tarayıcı tamponuna hiç
 * ihtiyaç kalmaz.
 *
 * Üretimde YOKTUR: `import.meta.env.DEV` guard'ı Vite tarafından `false` ile
 * değiştirilir ve gövde ölü kod olarak elenir (CI'daki "Build editor" adımı
 * bu dosyanın production derlemesini kırmadığını da doğrular). Kancanın
 * yaptığı tek şey zaten bundle'da bulunan singleton store'lara bir referans
 * vermek; yeni bir yetki ya da yazma yolu AÇMAZ (okuma testin işi, etkileşim
 * daima gerçek fare/klavyedir).
 */
import { useDocStore } from './docStore';
import { useEditorStore } from './editorStore';
import { useProjectSession } from './projectSession';

/** `window.__videoeditTest` sözleşmesi — e2e/support/appBridge.ts tüketicisi. */
export interface VideoEditTestHook {
  /** Sözleşme sürümü: köprü uyumsuz bir kancayı sessizce kabul etmesin. */
  version: 1;
  docStore: typeof useDocStore;
  editorStore: typeof useEditorStore;
  projectSession: typeof useProjectSession;
}

export function installTestBridge(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === 'undefined') return;
  (window as unknown as { __videoeditTest?: VideoEditTestHook }).__videoeditTest = {
    version: 1,
    docStore: useDocStore,
    editorStore: useEditorStore,
    projectSession: useProjectSession,
  };
}

