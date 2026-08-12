/**
 * ErrorBoundary — render/commit sırasında fırlayan bir hata BEYAZ EKRAN
 * üretmesin.
 *
 * Neden var: React 18+ bir hata sınırı yoksa hatayı yakalayan bileşen
 * bulamayınca KÖK AĞACI tamamen söker (`#root` boşalır). Kullanıcı bunu
 * "uygulama açılmıyor" olarak yaşar; ekranda hiçbir gerekçe, hiçbir çıkış
 * yolu yoktur. Somut vaka: WebGL2 desteklemeyen bir makinede oynatıcı motoru
 * kurulumu fırlatıyordu (`compositor.ts` — "WebGL2 is not available"), effect
 * içinden fırlayan bu hata boundary yokluğunda TÜM editörü söküyordu.
 *
 * Sözleşme:
 *  - Sessiz kalmaz: hata Türkçe bir panelle, gerekçesiyle gösterilir.
 *  - Detay saklanmaz ama gürültü de yapmaz: yığın izi <details> içinde,
 *    katlanmış olarak durur (hata raporuna kopyalanabilsin).
 *  - Çıkış yolu vardır: "Yeniden dene" alt ağacı TAZE bir `key` ile yeniden
 *    kurar (geçici bir hataysa sayfa yenilemeye gerek kalmaz); "Sayfayı
 *    yenile" tam yeniden yükleme yapar.
 */
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
  /** "Yeniden dene" sayacı — alt ağacın remount `key`'i. */
  attempt: number;
}

/** Hata nesnesini panele yazılabilir tek satıra indirger (throw edilen her şey Error değildir). */
function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  return new Error(typeof thrown === 'string' ? thrown : JSON.stringify(thrown));
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null, attempt: 0 };

  static getDerivedStateFromError(thrown: unknown): Partial<State> {
    return { error: toError(thrown) };
  }

  override componentDidCatch(thrown: unknown, info: ErrorInfo): void {
    // Konsol kaydı ŞART: panel özetler, hata ayıklayan kişi tam izi burada bulur.
    console.error('[VideoEdit] Yakalanan uygulama hatası:', thrown, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private readonly retry = (): void => {
    this.setState((s) => ({ error: null, componentStack: null, attempt: s.attempt + 1 }));
  };

  private readonly reload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { error, componentStack, attempt } = this.state;
    if (error === null) {
      // Fragment + key: "Yeniden dene" alt ağacı sıfırdan kurar, fazladan DOM yok.
      return <Fragment key={attempt}>{this.props.children}</Fragment>;
    }

    const detail = [error.stack ?? `${error.name}: ${error.message}`, componentStack]
      .filter((part): part is string => Boolean(part))
      .join('\n');

    return (
      <div
        data-testid="app-error-boundary"
        role="alert"
        className="flex h-full w-full items-center justify-center overflow-auto bg-surface-0 p-6 text-fg"
      >
        <div className="w-full max-w-2xl rounded-lg border border-edge bg-surface-1 p-6 shadow-lg">
          <h1 className="text-lg font-semibold text-fg">Uygulama beklenmedik bir hatayla durdu</h1>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            Editör bu ekranı çizerken bir hata oluştu ve arayüz güvenli biçimde durduruldu.
            Projeniz sunucuda kayıtlıdır — son otomatik kayıttan sonrası kaybolabilir.
            Önce “Yeniden dene”yi kullanın; sorun sürerse aşağıdaki teknik detayı kopyalayıp
            hata bildirimine ekleyin.
          </p>
          <p
            data-testid="app-error-message"
            className="mt-3 rounded border border-edge bg-surface-2 px-3 py-2 font-mono text-xs break-words text-fg"
          >
            {error.message}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              data-testid="app-error-retry"
              onClick={this.retry}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-black hover:opacity-90"
            >
              Yeniden dene
            </button>
            <button
              type="button"
              data-testid="app-error-reload"
              onClick={this.reload}
              className="rounded border border-edge px-3 py-1.5 text-sm text-fg hover:bg-surface-3"
            >
              Sayfayı yenile
            </button>
          </div>
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-fg-muted select-none">
              Teknik detay (yığın izi)
            </summary>
            <pre
              data-testid="app-error-detail"
              className="mt-2 max-h-64 overflow-auto rounded border border-edge bg-surface-2 p-3 font-mono text-[11px] leading-snug whitespace-pre-wrap text-fg-muted"
            >
              {detail}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
