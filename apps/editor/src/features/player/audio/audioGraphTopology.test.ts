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

/** Kaydedilen graf düğümü: giden kenarları tutar, `disconnect` onları siler. */
class FakeNode {
  readonly outs: FakeNode[] = [];
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
  fftSize = 2048;
  smoothingTimeConstant = 1;
  floatReads = 0;
  byteReads = 0;
  readonly gain = {
    value: 1,
    cancelScheduledValues(): void {},
    setValueAtTime(): void {},
    setValueCurveAtTime(): void {},
  };

  constructor(readonly label: string) {}

  connect(dst: FakeNode): FakeNode {
    this.outs.push(dst);
    return dst;
  }

  /** Web Audio: argümansız `disconnect()` TÜM giden kenarları koparır. */
  disconnect(dst?: FakeNode): void {
    if (dst === undefined) {
      this.outs.length = 0;
      return;
    }
    const i = this.outs.indexOf(dst);
    if (i >= 0) this.outs.splice(i, 1);
  }

  getFloatTimeDomainData(): void {
    this.floatReads++;
  }

  getByteTimeDomainData(): void {
    this.byteReads++;
  }
}

class FakeContext {
  readonly destination = new FakeNode('destination');
  readonly created: FakeNode[] = [this.destination];
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;

  private make(label: string): FakeNode {
    const n = new FakeNode(label);
    this.created.push(n);
    return n;
  }

  createGain(): FakeNode {
    return this.make('gain');
  }

  createChannelSplitter(): FakeNode {
    return this.make('splitter');
  }

  createAnalyser(): FakeNode {
    return this.make('analyser');
  }

  createMediaElementSource(): FakeNode {
    return this.make('source');
  }

  createDynamicsCompressor(): FakeNode {
    return this.make('compressor');
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
  it('her klip kazancından `destination`’a bir yol VARDIR (önizleme duyulur)', async () => {
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

  it('analyser’lardan `destination`’a yol YOKTUR (tap yapraktır)', async () => {
    const { c, analysers } = await buildGraph();
    for (const a of analysers) {
      expect(
        reaches(a, c.destination),
        'Analyser’dan destination’a yol VAR — tap duyulan zincire girmiş (§8.3 ihlali).',
      ).toBe(false);
      expect(a.outs, 'analyser çıkışı bağlanmamalı (yaprak).').toHaveLength(0);
    }
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
