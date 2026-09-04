/**
 * Structural guard for the meter tap's PLACEMENT (rendering-semantics §8.3).
 *
 * WHY A SOURCE SCAN AND NOT A BEHAVIOUR TEST — an honesty note, because the
 * review that produced this file killed the previous "proof":
 *
 * `audio-parity.spec.ts` was cited as evidence that the audible chain did not
 * change. It is not: that spec deliberately does NOT use AudioGraph (its own
 * header says so — `createMediaElementSource` does not exist on an
 * OfflineAudioContext), it rebuilds the topology in the page. It was MEASURED
 * during review that setting the real `master.gain` to 0 — total silence —
 * leaves that spec green with bit-identical numbers. So it can prove nothing
 * about this file.
 *
 * A true behavioural test would need to capture the browser's audio output,
 * which the harness cannot do. What CAN be pinned mechanically is the property
 * the §8.3 argument rests on: the tap is a LEAF hanging off `master`, added
 * AFTER `master` is already wired to `destination`, and nothing inside the tap
 * ever reaches `destination`. Web Audio guarantees a fan-out does not alter
 * what the other branch receives; this guard keeps the code inside that
 * guarantee.
 *
 * SCOPE -- READ THIS BEFORE TRUSTING THE FILE. This is a SOURCE SCAN. It pins
 * the graph AS WRITTEN in this file: which edges exist (the connect inventory)
 * and which nodes the two graph-defining fields are bound to (the assignment
 * inventory). It CANNOT execute the graph, and no test in this harness can
 * capture the browser's audible output. So the honest claim is narrow:
 *
 *   PROVEN:     the source of this file still spells out the §8.3 topology.
 *   NOT PROVEN: that the running preview is audible, or that the tap is
 *               inaudible. Nothing here listens.
 *
 * That narrowness is stated because THREE successively wider versions of this
 * guard were each declared sufficient and each MEASURED blind in review:
 *
 *  1. A scan of the `buildMeterTap` BODY. Blind to
 *     `this.meterTap?.connect(this.ctx.destination)` in ensureContext.
 *  2. A file-wide scan of the word `destination`. Defended only the OUTPUT
 *     side; blind to rewiring connectElement as `gain -> meterTap -> master`,
 *     which makes the tap a SERIAL LINK of the audible chain.
 *  3. The connect inventory alone. It pins edges BETWEEN IDENTIFIERS, not what
 *     an identifier points at: `this.master = tap;` (one line, no `.connect(`
 *     at all) silently rebinds every clip onto the tap, leaves the real master
 *     receiving nothing -- preview goes SILENT while the meter still shows a
 *     mix -- and all six assertions stayed green, along with 1546 unit tests
 *     and the real-input meter e2e.
 *
 * Hence the assignment inventory below. It closes case 3; it does not turn a
 * source scan into a behavioural one, and this comment must not be rewritten
 * to suggest otherwise.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'audioGraph.ts'), 'utf8');

function bodyOf(fnName: string): string {
  const start = SRC.indexOf(`private ${fnName}(`);
  expect(start, `${fnName} kaynakta bulunamadı — muhafız kör kaldı.`).toBeGreaterThan(-1);
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(open, i + 1);
    }
  }
  throw new Error(`${fnName} gövdesi kapanmadı`);
}

/** Yorumlar SİLİNMİŞ kaynak: iddia düzyazıyla karşılanamasın. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('meter tap yerleşimi (§8.3 yaprak sözleşmesi)', () => {
  it('bağlantı ENVANTERİ birebir: izin verilen graf dışında kenar YOK', () => {
    // YÜK TAŞIYAN iddia. Yasak bir şekli adlandırmak yerine İZİN VERİLEN grafı
    // adlandırır: duyulan zincir (source -> gain -> master -> destination) artı
    // master'dan sarkan YAPRAK tap (master -> tap -> splitter -> L/R).
    // Bir kenar eklenirse -- çıkış tarafında, girdi tarafında, takma adla, fark
    // etmez -- liste tutmaz ve test kırmızıya döner. Listeyi güncellemek
    // BİLİNÇLİ bir eylemdir; §8.3'ü yeniden okumadan yapılmamalıdır.
    const edges = CODE.split('\n')
      .map((l) => l.trim())
      .filter((l) => /(?<!dis)\.connect\(/.test(l));
    expect(edges, 'audioGraph bağlantı grafı değişmiş — §8.3 sözleşmesini yeniden oku.').toEqual([
      'source.connect(gain);',
      'gain.connect(this.master);',
      'this.master.connect(this.ctx.destination);',
      'master.connect(tap);',
      'tap.connect(splitter);',
      'splitter.connect(left, 0);',
      'splitter.connect(right, 1);',
    ]);
  });

  it('ATAMA envanteri: grafı tanımlayan alanlar başka düğüme bağlanamaz', () => {
    // Kenar envanteri kenarları çiviler, KİMLİKLERİ değil. `this.master = tap;`
    // tek satırdır, içinde `.connect(` YOKTUR ve tüm klipleri sessizce tap'in
    // üstüne taşır: gerçek master hiçbir şey almaz (önizleme SUSAR), ölçer ise
    // miksi göstermeye devam eder. Denetimde ölçüldü — altı iddia da, 1546
    // birim testi de, gerçek girdili ölçer e2e'si de yeşil kalmıştı.
    const assignments = CODE.split('\n')
      .map((l) => l.trim())
      .filter((l) => /^this\.(master|meterTap)\s*=/.test(l));
    expect(
      assignments,
      'Grafı tanımlayan alanların atamaları değişmiş — bir düğüm başkasının yerine geçiyor olabilir.',
    ).toEqual([
      'this.master = this.ctx.createGain();',
      'this.meterTap = tap;',
      'this.meterTap = null;',
      'this.master = null;',
    ]);
  });

  it('ÇALIŞAN kodda `destination` TEK satırda geçer: master’ın kendi bağlantısı', () => {
    // Bu dosyanın YÜK TAŞIYAN iddiası. Gövde taraması yetmiyordu: tap'in çıkışı
    // başka bir metottan da (ör. ensureContext) destination'a bağlanabilir ve
    // eski muhafız bunu göremiyordu — denetimde ÖLÇÜLDÜ, dört iddia da yeşil
    // kalmıştı. Yerel bir takma ad üzerinden bağlamak da ikinci bir satır
    // doğurur, o yüzden bu iddia takma adı da yakalar.
    const lines = CODE.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('destination'));
    expect(
      lines,
      'destination’a giden TEK bağlantı master’ınki olmalı — tap yaprak kalmalı (§8.3).',
    ).toEqual(['this.master.connect(this.ctx.destination);']);
  });

  it('master ÖNCE destination’a bağlanır, tap ondan SONRA kurulur', () => {
    const toDestination = SRC.indexOf('this.master.connect(this.ctx.destination)');
    const buildTap = SRC.indexOf('this.buildMeterTap(');
    expect(toDestination, 'master → destination bağlantısı kayboldu.').toBeGreaterThan(-1);
    expect(buildTap, 'buildMeterTap çağrısı kayboldu.').toBeGreaterThan(-1);
    expect(
      toDestination,
      'Duyulan yol (master → destination) tap KURULMADAN ÖNCE bağlanmalı: ' +
        'tap bir yaprak dal, zincirin halkası değil.',
    ).toBeLessThan(buildTap);
  });

  it('tap gövdesi destination’a HİÇ dokunmaz (seri node yasağı)', () => {
    const body = bodyOf('buildMeterTap');
    expect(
      body.includes('destination'),
      'buildMeterTap içinde `destination` geçiyor — tap duyulan zincire giriyor olabilir.',
    ).toBe(false);
  });

  it('analyser çıkışları bağlanmaz (yaprak kalır)', () => {
    const body = bodyOf('buildMeterTap');
    // Bağlantı zinciri tam olarak: master→tap, tap→splitter, splitter→(L,R).
    const connects = [...body.matchAll(/(\w+)\.connect\(/g)].map((m) => m[1]);
    expect(connects.sort(), 'Tap içindeki bağlantı zinciri değişmiş.').toEqual(
      ['master', 'splitter', 'splitter', 'tap'].sort(),
    );
    for (const leaf of ['left', 'right']) {
      expect(
        body.includes(`${leaf}.connect(`),
        `${leaf} analyser'ı bir yere bağlanmış — yaprak olmaktan çıkmış.`,
      ).toBe(false);
    }
  });

  it('okuma zaman-alanı verisinden yapılır (byte veri 1.0 üstünü kırpar)', () => {
    // getByteTimeDomainData ±1'e kırpar; limitersiz önizlemede 0 dBFS üstü tepe
    // görünmez olur ve klip uyarısı yapısal olarak yalan söylerdi.
    expect(SRC.includes('getFloatTimeDomainData')).toBe(true);
    expect(SRC.includes('getByteTimeDomainData')).toBe(false);
  });
});
