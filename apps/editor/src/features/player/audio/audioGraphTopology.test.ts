/**
 * Ölçer tap'inin YERLEŞİM muhafızı (rendering-semantics §8.3).
 *
 * BU DOSYA BİR DAVRANIŞ TESTİDİR — kaynak taraması DEĞİL. Aradaki fark bu
 * projede pahalıya öğrenildi: kaynak tarayan BEŞ ardışık sürüm "yeterli" ilan
 * edildi ve beşi de denetimde ÖLÇÜLEREK kör çıktı. Sırasıyla:
 *
 *  1. `buildMeterTap` GÖVDESİNİ taramak → `ensureContext`'te
 *     `this.meterTap?.connect(this.ctx.destination)` yeşil geçti.
 *  2. `destination` KELİMESİNİ taramak → `connectElement`'i
 *     `gain → meterTap → master` diye yönlendirip tap'i duyulan zincirin SERİ
 *     HALKASI yapmak yeşil geçti.
 *  3. `.connect(` KENAR ENVANTERİ → `this.master = tap;` (tek satır, içinde
 *     `.connect(` yok) tüm klipleri tap'e taşıyıp önizlemeyi SUSTURURKEN yeşil
 *     geçti.
 *  4. + ATAMA ENVANTERİ → aynı ihlal `this['master'] = tap;` yazılışıyla yeşil
 *     geçti (regex `this.master =` şeklini arıyordu).
 *  5. Aynı envanter → `master.disconnect();` (kenar EKLEME değil SİLME) yeşil
 *     geçti; süzgeç `disconnect`'i bilerek dışlıyordu.
 *
 * Ortak kök neden: kaynak taraması ancak SAYDIĞI YAZILIŞI savunur; grafın
 * kendisi hakkında hiçbir şey bilmez. Bu yüzden muhafız artık grafı KURUYOR:
 * sahte bir AudioContext `connect`/`disconnect` çağrılarını kaydediyor,
 * `ensureContext()` + `attachElement()` GERÇEKTEN koşuyor ve iddialar oluşan
 * graf üzerinde ERİŞİLEBİLİRLİK soruyor. Yazılış değişse de sonuç değişmez.
 *
 * KAPSAM — hâlâ sınırlı, ve sınırı burada yazılı:
 *   KANITLADIĞI:   AudioGraph'ın KURDUĞU grafta duyulan yol sağlam, tap yaprak.
 *   KANITLAMADIĞI: tarayıcının gerçekten ses çıkardığı. Sahte context ses
 *                  üretmez; bu düzenekte tarayıcı çıkışını yakalayan test
 *                  YOKTUR (`poc-bilinen-sinirlar.md` §2.9).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AudioGraph } from './audioGraph';

/** Kurulum SIRASI: hangi kenarın önce bağlandığını çivilemek için. */
let seq = 0;

interface Edge {
  readonly dst: FakeNode;
  /** Web Audio çıkış indeksi — splitter'da KANAL SEÇER, süs değildir. */
  readonly output: number;
  readonly seq: number;
}

/**
 * Kaydedilen graf düğümü. Sahtenin gerçek Web Audio'dan SAPMASI, muhafızın
 * yanlış şeyi kanıtlaması demektir; bu yüzden iki kural taklit ediliyor:
 *  - `connect(dst, output)` çıkış indeksini SAKLAR (sahte önce yok sayıyordu:
 *    `splitter.connect(right, 0)` yapıldığında 7/7 yeşil kalıyordu, oysa gerçek
 *    tarayıcıda sağ analyser SOL kanalı okur — denetimde ölçüldü).
 *  - `output >= numberOfOutputs` FIRLATIR (gerçek Chromium: "IndexSizeError…
 *    output index (1) exceeds number of outputs (1)"). Sahte önce kabul ediyordu,
 *    yani `createChannelSplitter(1)` ile önizlemenin HİÇ başlamadığı bir kurulum
 *    yeşil geçiyordu.
 */
class FakeNode {
  readonly edges: Edge[] = [];
  numberOfOutputs = 1;
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
  floatReads = 0;
  byteReads = 0;
  /** Bu analyser'ın "duyduğu" sabit örnek — L/R eşlemesini izlenebilir yapar. */
  signal = 0;
  #fftSize = 2048;
  #smoothing = 1;

  /** Gerçek API 2'nin kuvveti olmayan değeri REDDEDER (IndexSizeError). */
  set fftSize(v: number) {
    if (v < 32 || v > 32768 || (v & (v - 1)) !== 0) {
      throw new Error(`IndexSizeError: The value provided (${v}) is not a power of two.`);
    }
    this.#fftSize = v;
  }

  get fftSize(): number {
    return this.#fftSize;
  }

  /** Gerçek API [0,1] dışını REDDEDER. */
  set smoothingTimeConstant(v: number) {
    if (v < 0 || v > 1) {
      throw new Error(`IndexSizeError: The value provided (${v}) is outside the range [0, 1].`);
    }
    this.#smoothing = v;
  }

  get smoothingTimeConstant(): number {
    return this.#smoothing;
  }
  readonly gain = {
    value: 1,
    cancelScheduledValues(): void {},
    setValueAtTime(): void {},
    setValueCurveAtTime(): void {},
  };

  constructor(
    readonly label: string,
    numberOfOutputs = 1,
  ) {
    this.numberOfOutputs = numberOfOutputs;
  }

  get outs(): FakeNode[] {
    return this.edges.map((e) => e.dst);
  }

  connect(dst: FakeNode, output = 0): FakeNode {
    if (output >= this.numberOfOutputs) {
      throw new Error(
        `IndexSizeError: output index (${output}) exceeds number of outputs (${this.numberOfOutputs})`,
      );
    }
    this.edges.push({ dst, output, seq: seq++ });
    return dst;
  }

  /** Web Audio: argümansız `disconnect()` TÜM giden kenarları koparır. */
  disconnect(dst?: FakeNode): void {
    if (dst === undefined) {
      this.edges.length = 0;
      return;
    }
    const i = this.edges.findIndex((e) => e.dst === dst);
    if (i >= 0) this.edges.splice(i, 1);
  }

  /** `dst`'ye giden kenarın çıkış indeksi (yoksa -1). */
  outputTo(dst: FakeNode): number {
    return this.edges.find((e) => e.dst === dst)?.output ?? -1;
  }

  getFloatTimeDomainData(buf: Float32Array): void {
    this.floatReads++;
    buf.fill(this.signal);
  }

  getByteTimeDomainData(): void {
    this.byteReads++;
  }
}

class FakeContext {
  // Gerçek `destination`'ın ÇIKIŞI YOKTUR (DECISIONS: "taplamak imkânsız").
  readonly destination = new FakeNode('destination', 0);
  readonly created: FakeNode[] = [this.destination];
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;

  private make(label: string, numberOfOutputs = 1): FakeNode {
    const n = new FakeNode(label, numberOfOutputs);
    this.created.push(n);
    return n;
  }

  createGain(): FakeNode {
    return this.make('gain');
  }

  createChannelSplitter(numberOfOutputs: number): FakeNode {
    // Argüman SAKLANIR: gerçek API'de çıkış sayısını o belirler ve fazlasına
    // bağlanmak IndexSizeError fırlatır.
    return this.make('splitter', numberOfOutputs);
  }

  createAnalyser(): FakeNode {
    return this.make('analyser');
  }

  createMediaElementSource(): FakeNode {
    return this.make('source');
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async suspend(): Promise<void> {
    this.state = 'suspended';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }
}

let ctx: FakeContext | null = null;
const realAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

beforeEach(() => {
  ctx = null;
  seq = 0;
  (globalThis as { AudioContext?: unknown }).AudioContext = class {
    constructor() {
      ctx = new FakeContext();
      return ctx as unknown as AudioContext;
    }
  };
});

afterEach(() => {
  (globalThis as { AudioContext?: unknown }).AudioContext = realAudioContext;
});

/** Grafta `from`'dan `to`'ya giden bir yol var mı? (yönlü, döngüye dayanıklı) */
function reaches(from: FakeNode, to: FakeNode): boolean {
  const seen = new Set<FakeNode>();
  const queue: FakeNode[] = [from];
  while (queue.length > 0) {
    const node = queue.shift() as FakeNode;
    if (node === to) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    queue.push(...node.outs);
  }
  return false;
}

function inEdges(c: FakeContext, target: FakeNode): FakeNode[] {
  return c.created.filter((n) => n !== target && n.outs.includes(target));
}

/** İki klip elemanı bağlanmış, çalışır durumda bir graf kurar. */
async function buildGraph(): Promise<{
  graph: AudioGraph;
  c: FakeContext;
  clipGains: FakeNode[];
  analysers: FakeNode[];
}> {
  const graph = new AudioGraph();
  const elements = [{}, {}] as unknown as HTMLMediaElement[];
  graph.attachElement(elements[0]); // context'ten ÖNCE (pending yolu)
  await graph.ensureContext();
  graph.attachElement(elements[1]); // context'ten SONRA (doğrudan yol)
  const c = ctx as FakeContext;
  const sources = c.created.filter((n) => n.label === 'source');
  expect(sources, 'iki klip kaynağı da bağlanmalı').toHaveLength(2);
  const clipGains = sources.map((s) => {
    expect(s.outs, 'kaynak tam olarak bir gain’e bağlanır').toHaveLength(1);
    return s.outs[0];
  });
  return { graph, c, clipGains, analysers: c.created.filter((n) => n.label === 'analyser') };
}

describe('meter tap yerleşimi — KURULAN graf (§8.3)', () => {
  it('her klip kazancından `destination`’a bir yol VARDIR', async () => {
    // BAŞLIK KASITLI OLARAK "önizleme duyulur" DEMİYOR: erişilebilirlik ≠
    // duyulabilirlik. `master.gain.value = 0` (tam sessizlik) bu iddiayı yeşil
    // bırakır — denetimde ölçüldü. Kanıtlanan şey yolun VAR olmasıdır.
    const { c, clipGains } = await buildGraph();
    expect(clipGains).toHaveLength(2);
    for (const [i, g] of clipGains.entries()) {
      expect(
        reaches(g, c.destination),
        `Klip ${i} kazancından destination'a yol YOK — önizleme SESSİZ. ` +
          'Duyulan yol koptu ya da başka bir düğüme kaydı.',
      ).toBe(true);
    }
  });

  it('`destination`’a TEK düğüm bağlanır ve o düğüm kliplerin bağlandığı master’dır', async () => {
    const { c, clipGains } = await buildGraph();
    const incoming = inEdges(c, c.destination);
    expect(
      incoming.map((n) => n.label),
      "destination'ın gelen kenarları değişmiş — zincirin sonuna node eklenmiş olabilir (§8.3).",
    ).toEqual(['gain']);
    const master = incoming[0];
    for (const g of clipGains) {
      expect(
        g.outs.includes(master),
        'Klip kazancı, destination’a bağlı düğüme bağlanmıyor — bir düğüm ' +
          'diğerinin yerine geçmiş olabilir (ölçüldü: `this.master = tap;` bunu yapıyordu).',
      ).toBe(true);
    }
  });

  it('ölçer duyulan MİKSİ ölçer: klip kazancından analyser’lara yol VARDIR', async () => {
    const { clipGains, analysers } = await buildGraph();
    expect(analysers, 'stereo için İKİ analyser').toHaveLength(2);
    for (const a of analysers) {
      expect(
        reaches(clipGains[0], a),
        'Klip kazancından analyser’a yol yok — ölçer duyulan miksi DEĞİL başka şeyi ölçüyor.',
      ).toBe(true);
    }
  });

  it('analyser’lardan `destination`’a yol YOKTUR', async () => {
    // "Tap yapraktır" DEMİYOR: bu iddia analyser'ların yaprak olduğunu söyler.
    // Tap'in duyulan zincire girdi tarafından sokulmasını yukarıdaki master
    // iddiası yakalar (denetimde ölçüldü: o mutasyonda BU iddia yeşil kalıyor).
    const { c, analysers } = await buildGraph();
    for (const a of analysers) {
      expect(
        reaches(a, c.destination),
        'Analyser’dan destination’a yol VAR — tap duyulan zincire girmiş (§8.3 ihlali).',
      ).toBe(false);
      expect(a.outs, 'analyser çıkışı bağlanmamalı (yaprak).').toHaveLength(0);
    }
  });

  it('splitter KANALLARI ayırır: sol analyser çıkış 0’dan, sağ analyser çıkış 1’den', async () => {
    // Çıkış indeksi süs değil, KANAL SEÇER. `splitter.connect(right, 0)` yapılsa
    // sağ analyser SOL kanalın kopyasını okurdu ve `data-meter-db-r` kalıcı
    // olarak yalan söylerdi — mono fikstürlü e2e bunu AYIRT EDEMEZ (denetimde
    // gerçek Chromium'da ölçüldü: iki çıkış da -6,02 dBFS okuyor).
    const { c, analysers } = await buildGraph();
    const splitter = inEdges(c, analysers[0])[0];
    expect(splitter.numberOfOutputs, 'splitter STEREO kurulmalı').toBe(2);
    const outputs = analysers.map((a) => splitter.outputTo(a));
    expect(outputs, 'sol analyser çıkış 0, sağ analyser çıkış 1 olmalı').toEqual([0, 1]);
  });

  it('okunan L/R, splitter’ın 0 ve 1 numaralı çıkışlarına BU SIRAYLA karşılık gelir', async () => {
    // Kablolama doğru olsa bile RAPORLAMA ters olabilir: `analyserL`/`analyserR`
    // atamalarını ya da `readMeter()`'ın dönüşünü takas etmek, kanalları kalıcı
    // olarak yer değiştirir. Denetimde ölçüldü: her iki takas da 9/9 yeşil
    // geçiyordu ve MONO fikstürlü e2e bunu YAPI GEREĞİ ayırt edemez (L ve R
    // özdeş). Bu yüzden her analyser'a kendi sinyali veriliyor ve okunan
    // değerin hangi çıkıştan geldiği izleniyor.
    const { graph, c, analysers } = await buildGraph();
    const splitter = inEdges(c, analysers[0])[0];
    const fromOutput = (output: number): FakeNode => {
      const node = analysers.find((a) => splitter.outputTo(a) === output);
      expect(node, `splitter çıkış ${output} bir analyser'a bağlı değil`).toBeDefined();
      return node as FakeNode;
    };
    fromOutput(0).signal = 0.25;
    fromOutput(1).signal = 0.75;

    const reading = graph.readMeter();
    expect(reading, 'readMeter null dönmemeli').not.toBeNull();
    expect(
      reading?.peakL,
      'peakL, splitter’ın 0 numaralı (SOL) çıkışından beslenmeli — kanallar takas edilmiş.',
    ).toBeCloseTo(0.25, 6);
    expect(
      reading?.peakR,
      'peakR, splitter’ın 1 numaralı (SAĞ) çıkışından beslenmeli — kanallar takas edilmiş.',
    ).toBeCloseTo(0.75, 6);
  });

  it('duyulan yol tap’ten ÖNCE kurulur (§8.3 (a) — inşa SIRASI)', async () => {
    // Erişilebilirlik iddiaları oluşan grafa bakar; SIRA grafta görünmez.
    // (a) şartının duyulur bir sonucu yok ama sözleşmede yazılı, o yüzden
    // kenarların kurulma sırası ayrıca çivileniyor (denetim bulgusu: bu iddia
    // olmadan §8.3'ün "(a)-(d) sınanır" cümlesi (a) için yanlıştı).
    const { c } = await buildGraph();
    const master = inEdges(c, c.destination)[0];
    const toDestination = master.edges.find((e) => e.dst === c.destination);
    const tapEdge = master.edges.find((e) => e.dst !== c.destination);
    expect(toDestination, 'master → destination kenarı yok').toBeDefined();
    expect(tapEdge, 'master → tap kenarı yok').toBeDefined();
    expect(
      (toDestination as { seq: number }).seq < (tapEdge as { seq: number }).seq,
      'Tap, master destination’a bağlanmadan ÖNCE kurulmuş (§8.3 (a)).',
    ).toBe(true);
  });

  it('tap explicit STEREO’dur (§8.5 upmix; mono klipte sağ kanal ölmesin)', async () => {
    const { c, analysers } = await buildGraph();
    const splitter = inEdges(c, analysers[0])[0];
    expect(splitter?.label, 'analyser’ı besleyen düğüm splitter olmalı').toBe('splitter');
    const tap = inEdges(c, splitter)[0];
    expect(tap?.label, 'splitter’ı besleyen düğüm tap (gain) olmalı').toBe('gain');
    expect(tap.channelCount, 'tap.channelCount').toBe(2);
    expect(tap.channelCountMode, 'tap.channelCountMode').toBe('explicit');
    expect(tap.channelInterpretation, 'tap.channelInterpretation').toBe('speakers');
  });

  it('okuma ZAMAN-ALANI float verisiyle yapılır (byte veri 1.0 üstünü kırpar)', async () => {
    const { graph, analysers } = await buildGraph();
    expect(graph.readMeter(), 'çalışan context’te readMeter null dönmemeli').not.toBeNull();
    for (const a of analysers) {
      expect(a.floatReads, 'getFloatTimeDomainData çağrılmalı').toBeGreaterThan(0);
      expect(a.byteReads, 'getByteTimeDomainData ±1’e KIRPAR — klip mandalı yalan söylerdi').toBe(0);
    }
  });

  it('dispose grafı söker: hiçbir düğümün giden kenarı kalmaz', async () => {
    const { graph, c } = await buildGraph();
    graph.dispose();
    const leftovers = c.created.filter((n) => n.outs.length > 0).map((n) => n.label);
    expect(leftovers, 'dispose sonrası bağlı kalan düğüm — sızıntı.').toEqual([]);
  });
});
