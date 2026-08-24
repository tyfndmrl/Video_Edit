/**
 * ciSkipGuard — CI'da ATLANAN test = KIRMIZI kosum.
 *
 * Neden var (YÜKSEK denetim bulgusu): E2E'nin en değerli iki testi
 * (media-upload, export-flow) CI'da **her koşuda** atlanıyordu — ffmpeg kurulu
 * değildi ve VideoEdit.Worker hiç başlatılmıyordu. Her iki atlama da
 * `test.skip(...)` üzerinden "yumuşak" gerçekleşiyor, Playwright kırmızı
 * vermiyor, CI yeşil kalıyordu. Yani ürünün "medya koy, kes, çıkar" vaadinin
 * uçtan uca tek kanıtı aylarca hiç çalışmadan yeşil raporlandı.
 *
 * Atlama YOLLARI kaldırılmadı — yerel geliştirici ffmpeg/worker olmadan da
 * çalışabilmeli ve atlama gerekçesi net bir mesaj basıyor (support/media.ts,
 * support/library.ts). Bu muhafız yalnızca CI'da devreye girer ve o esnekliğin
 * CI'da bir daha "sessiz yeşil"e dönüşmesini engeller.
 *
 * Sözleşme: bir test atlandıysa koşumun sonucu 'failed' olur ve atlanan her
 * testin gerekçesi (annotation açıklaması) log'a basılır. Beklenen-başarısız
 * (`test.fail()`) testler atlama DEĞİLDİR ve buraya takılmaz.
 *
 * Kullanım (yalnız .github/workflows/ci.yml):
 *   playwright test --reporter=list,html,./e2e/support/ciSkipGuard.ts
 */
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
} from '@playwright/test/reporter';

/** Muhafızı kapatmak için kaçış kapısı — bilinçli bir karar gerektirir. */
const DISABLE_ENV = 'E2E_ALLOW_SKIPS';

export default class CiSkipGuard implements Reporter {
  private root: Suite | null = null;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.root = suite;
  }

  async onEnd(_result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    // Yerelde sessiz: muhafız CI içindir. (E2E_ALLOW_SKIPS=1 bilinçli kaçış.)
    if (!process.env.CI || process.env[DISABLE_ENV]) return undefined;

    const skipped = (this.root?.allTests() ?? []).filter((t) => t.outcome() === 'skipped');
    if (skipped.length === 0) return undefined;

    const lines = skipped.map(
      (t) => `  - ${t.titlePath().filter(Boolean).join(' › ')}\n      ${reasonOf(t)}`,
    );
    console.error(
      `\n::error::CI'da ${skipped.length} test ATLANDI — atlanan test kanıt üretmez, ` +
        'bu yüzden koşum KIRMIZI işaretlendi.\n' +
        'Tipik nedenler: ffmpeg kurulu değil (ci.yml "Install ffmpeg") ya da ' +
        'VideoEdit.Worker ayakta değil / çöktü (ci.yml "Worker\'i baslat" + worker.log).\n' +
        `${lines.join('\n')}\n`,
    );
    return { status: 'failed' };
  }
}

/** Atlama gerekçesi: skip/fixme annotation açıklaması (yoksa açık bir yer tutucu). */
function reasonOf(test: TestCase): string {
  const notes = [...test.annotations, ...test.results.flatMap((r) => r.annotations)]
    .filter((a) => a.type === 'skip' || a.type === 'fixme')
    .map((a) => a.description?.trim())
    .filter((d): d is string => !!d);
  return notes.length > 0
    ? [...new Set(notes)].join(' | ')
    : '(gerekçe belirtilmemiş — test.skip çağrısına bir mesaj ekleyin)';
}
