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
 * SCOPE, stated exactly: these assertions cover THIS FILE. The first test below
 * is the load-bearing one -- in executable code (comments stripped), the word
 * `destination` may appear on exactly ONE line, and that line must be master's
 * own connect. A serial tap therefore goes red wherever in this file it is
 * written, including through a local alias. The body scans that follow are
 * narrower and only pin the shape of buildMeterTap itself. Nothing outside this
 * file can reach the tap: `meterTap` is private and never returned.
 *
 * The body-only version of this guard was MEASURED blind during review: adding
 * `this.meterTap?.connect(this.ctx.destination)` in ensureContext -- a real
 * §8.3 violation -- left all four assertions green.
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
