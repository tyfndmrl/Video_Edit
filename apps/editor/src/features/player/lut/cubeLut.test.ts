/**
 * cubeLut — .cube ayrıştırıcısı + CPU trilinear referansı (§4.2).
 *
 * Dilbilgisi iddiaları worker'ın yükleme kapısıyla (backend CubeLutValidator)
 * AYNI vakaları kullanır: iki taraf aynı dosyayı kabul/ret etmeli, yoksa
 * "worker Ready dedi, önizleme okuyamadı" sınıfı bir sessiz kırık doğar.
 * R↔B takas fixture'ı backend'in GERÇEK ffmpeg'le ölçtüğü tablonun birebir
 * aynısıdır (ExportJobPipelineTests.SwapRedBlueCube) — ayrıştırıcının eksen
 * sırası yanlış olsaydı buradaki örnekleme iddiası ffmpeg'in ölçülmüş
 * çıktısıyla çelişirdi.
 */
import { describe, expect, it } from 'vitest';
import { parseCubeLut, sampleCubeLut, type CubeLut } from './cubeLut';

/** Backend fixture'ının birebir metni: R ve B kanallarını takas eden 2³ küp. */
function swapRedBlueCubeText(): string {
  const lines = ['TITLE "swap-rb"', 'LUT_3D_SIZE 2', 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  for (let b = 0; b < 2; b++) {
    for (let g = 0; g < 2; g++) {
      for (let r = 0; r < 2; r++) {
        lines.push(`${b}.0 ${g}.0 ${r}.0`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function parsed(text: string): CubeLut {
  const result = parseCubeLut(text);
  if (!result.ok) throw new Error(result.error);
  return result.lut;
}

describe('parseCubeLut', () => {
  it('parses the swap-rb fixture: size 2, red-fastest RGBA layout', () => {
    const lut = parsed(swapRedBlueCubeText());
    expect(lut.size).toBe(2);
    expect(lut.data).toHaveLength(2 * 2 * 2 * 4);
    // Dosyanın İLK satırı (r=0,g=0,b=0 düğümü) -> data[0..3]; değeri (0,0,0,1).
    expect([...lut.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
    // İKİNCİ satır r=1 düğümüdür (kırmızı en hızlı): değer (0,0,1).
    expect([...lut.data.slice(4, 8)]).toEqual([0, 0, 1, 1]);
    // Son satır (r=1,g=1,b=1): değer (1,1,1).
    expect([...lut.data.slice(7 * 4, 7 * 4 + 4)]).toEqual([1, 1, 1, 1]);
  });

  it('tolerates comments, blank lines, CRLF and header lines between data (ffmpeg tolerance)', () => {
    const text = '# yorum\r\n\r\nLUT_3D_SIZE 2\r\nTITLE "gec"\r\n' + '0 0 0\r\n'.repeat(8);
    expect(parseCubeLut(text).ok).toBe(true);
  });

  it('accepts scientific notation and negative values (ffmpeg %f does)', () => {
    const text = 'LUT_3D_SIZE 2\n' + '1e-3 -0.25 0.999999\n'.repeat(8);
    expect(parseCubeLut(text).ok).toBe(true);
  });

  const REJECTED: [string, string, string][] = [
    ['missing size', '0 0 0\n', 'LUT_3D_SIZE'],
    ['1D lut', 'LUT_1D_SIZE 4\n0 0 0\n', '1D'],
    ['size below 2', 'LUT_3D_SIZE 1\n0 0 0\n', 'LUT_3D_SIZE'],
    ['size above 129', 'LUT_3D_SIZE 130\n0 0 0\n', 'LUT_3D_SIZE'],
    ['too few rows', 'LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(7), '8'],
    ['extra rows', 'LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(9), 'fazla'],
    ['2 components', 'LUT_3D_SIZE 2\n0 0\n', '3 sayı'],
    ['4 components', 'LUT_3D_SIZE 2\n0 0 0 0\n', '3 sayı'],
    ['non-numeric', 'LUT_3D_SIZE 2\na b c\n', 'sonlu'], // parseFloat('a') = NaN -> sonlu-değil dalı
    ['non-finite', 'LUT_3D_SIZE 2\nNaN 0 0\n', 'sonlu'],
    ['data before size', '0.5 0.5 0.5\nLUT_3D_SIZE 2\n', 'önce'],
    ['duplicate size', 'LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(8), 'iki kez'],
    ['non-unit domain min', 'LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0.1\n' + '0 0 0\n'.repeat(8), 'DOMAIN_MIN'],
    ['non-unit domain max', 'LUT_3D_SIZE 2\nDOMAIN_MAX 0.9 1 1\n' + '0 0 0\n'.repeat(8), 'DOMAIN_MAX'],
  ];

  it.each(REJECTED)('rejects %s (worker gate mirror)', (_name, text, fragment) => {
    const result = parseCubeLut(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(fragment);
  });
});

describe('sampleCubeLut (§4.2 CPU reference)', () => {
  const swap = parsed(swapRedBlueCubeText());

  it('reproduces the ffmpeg-measured swap: (0.5, 0.25, 0.125) -> (0.125, 0.25, 0.5) at intensity 1', () => {
    // Backend testinin GERÇEK ffmpeg ölçümü: kaynak 0x804020 -> çıktı ≈ 0x204080.
    const out = sampleCubeLut(swap, { r: 0x80 / 255, g: 0x40 / 255, b: 0x20 / 255 }, 1);
    expect(out.r).toBeCloseTo(0x20 / 255, 5);
    expect(out.g).toBeCloseTo(0x40 / 255, 5);
    expect(out.b).toBeCloseTo(0x80 / 255, 5);
  });

  it('intensity mixes linearly: 0 = original, 0.5 = midpoint (export blend formula)', () => {
    const src = { r: 0.8, g: 0.4, b: 0.2 };
    const at0 = sampleCubeLut(swap, src, 0);
    expect(at0).toEqual(src);
    const at1 = sampleCubeLut(swap, src, 1);
    const half = sampleCubeLut(swap, src, 0.5);
    expect(half.r).toBeCloseTo((src.r + at1.r) / 2, 6);
    expect(half.g).toBeCloseTo((src.g + at1.g) / 2, 6);
    expect(half.b).toBeCloseTo((src.b + at1.b) / 2, 6);
  });

  it('identity lut leaves every probe untouched (trilinear weights sum to 1)', () => {
    // 3³ kimlik küpü: düğüm değeri = düğüm koordinatı.
    const n = 3;
    const data = new Float32Array(n * n * n * 4);
    let i = 0;
    for (let b = 0; b < n; b++) {
      for (let g = 0; g < n; g++) {
        for (let r = 0; r < n; r++) {
          data[i++] = r / (n - 1);
          data[i++] = g / (n - 1);
          data[i++] = b / (n - 1);
          data[i++] = 1;
        }
      }
    }
    const identity: CubeLut = { size: n, data };
    for (const probe of [
      { r: 0, g: 0, b: 0 },
      { r: 1, g: 1, b: 1 },
      { r: 0.5, g: 0.25, b: 0.75 },
      { r: 0.123, g: 0.456, b: 0.789 },
    ]) {
      const out = sampleCubeLut(identity, probe, 1);
      expect(out.r).toBeCloseTo(probe.r, 6);
      expect(out.g).toBeCloseTo(probe.g, 6);
      expect(out.b).toBeCloseTo(probe.b, 6);
    }
  });

  it('clamps out-of-range input into the table domain before sampling', () => {
    // intensity 1'de sonuç saf LUT değeridir (orijinal terim mix'te düşer):
    // [0,1] dışı girdi, kelepçelenmiş girdiyle AYNI düğümleri örneklemeli.
    const out = sampleCubeLut(swap, { r: 1.5, g: -0.2, b: 0.5 }, 1);
    const clamped = sampleCubeLut(swap, { r: 1, g: 0, b: 0.5 }, 1);
    expect(out.r).toBeCloseTo(clamped.r, 6);
    expect(out.g).toBeCloseTo(clamped.g, 6);
    expect(out.b).toBeCloseTo(clamped.b, 6);
  });
});
