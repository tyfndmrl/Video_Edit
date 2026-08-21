/**
 * cubeLut — .cube (3D LUT) metin ayrıştırıcısı + CPU trilinear referansı.
 *
 * SÖZLEŞME (üç tarafla senkron):
 *  - Worker'ın yükleme kapısı (backend CubeLutValidator) ile AYNI dilbilgisi:
 *    '#' yorumlar ve boş satırlar her yerde; TITLE/DOMAIN_MIN/DOMAIN_MAX satırları
 *    veri ARASINDA bile tolere edilir (ffmpeg parse_cube aynısını yapar); domain
 *    [0,1] olmak zorundadır (worker zaten reddetti — buradaki kontrol savunmadır);
 *    veri satırı sayısı tam N³.
 *  - Veri sırası .cube standardı: KIRMIZI en hızlı değişir. texImage3D bellek
 *    düzeni x-en-hızlıdır; shader `texture(uLut3D, c.rgb * uLutScale + uLutOffset)`
 *    ile (r,g,b) koordinatı örnekler → dosya sırası dokuya DOĞRUDAN kopyalanır,
 *    hiçbir yeniden sıralama yoktur.
 *  - `sampleCubeLut` §4.2'nin GPU örneklemesinin CPU eşidir (trilinear +
 *    yarım-texel ofset + intensity karışımı) — testler ve e2e piksel iddiaları
 *    shader'ı bu referansla karşılaştırır.
 *
 * Worker Ready demeden bu ayrıştırıcıya dosya gelmez (previewSource 'lut' kuralı
 * yalnız ready varlıkta URL verir); yine de hata dalları korunur — sunucudan
 * bozuk içerik gelmesi (yarım indirme, CDN hatası) sessiz siyah kare olmamalı.
 */

export interface CubeLut {
  /** Kenar boyu N (LUT_3D_SIZE). */
  size: number;
  /**
   * RGBA float veri, uzunluk N³×4 (alfa=1) — texImage3D(RGBA16F, FLOAT) girdisi.
   * Düzen: r indeksi en hızlı (x ekseni), sonra g (y), sonra b (z).
   */
  data: Float32Array;
}

export type CubeLutParseResult =
  | { ok: true; lut: CubeLut }
  | { ok: false; error: string };

/** Worker kapısıyla aynı sınırlar (CubeLutValidator.MinSize/MaxSize). */
export const CUBE_MIN_SIZE = 2;
export const CUBE_MAX_SIZE = 129;

/** "DOMAIN_MIN 0 0 0" satırının üç bileşeni de expected mı? */
function isUnitDomain(rest: string, expected: number): boolean {
  const parts = rest.trim().split(/\s+/);
  if (parts.length !== 3) return false;
  return parts.every((p) => {
    const v = Number.parseFloat(p);
    return Number.isFinite(v) && v === expected;
  });
}

export function parseCubeLut(text: string): CubeLutParseResult {
  const lines = text.split(/\r\n|\n|\r/);
  let size = 0;
  let data: Float32Array | null = null;
  let rows = 0;
  let expectedRows = 0;

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo].trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.startsWith('TITLE')) continue;

    if (line.startsWith('LUT_1D_SIZE')) {
      return { ok: false, error: '1D LUT (LUT_1D_SIZE) desteklenmez — 3D .cube gerekir' };
    }

    if (line.startsWith('DOMAIN_MIN')) {
      if (!isUnitDomain(line.slice('DOMAIN_MIN'.length), 0)) {
        return { ok: false, error: `satır ${lineNo + 1}: DOMAIN_MIN '0 0 0' olmalı` };
      }
      continue;
    }

    if (line.startsWith('DOMAIN_MAX')) {
      if (!isUnitDomain(line.slice('DOMAIN_MAX'.length), 1)) {
        return { ok: false, error: `satır ${lineNo + 1}: DOMAIN_MAX '1 1 1' olmalı` };
      }
      continue;
    }

    if (line.startsWith('LUT_3D_SIZE')) {
      if (size !== 0) {
        return { ok: false, error: `satır ${lineNo + 1}: LUT_3D_SIZE iki kez` };
      }
      const parsed = Number.parseInt(line.slice('LUT_3D_SIZE'.length).trim(), 10);
      if (!Number.isInteger(parsed) || parsed < CUBE_MIN_SIZE || parsed > CUBE_MAX_SIZE) {
        return {
          ok: false,
          error: `satır ${lineNo + 1}: LUT_3D_SIZE [${CUBE_MIN_SIZE}, ${CUBE_MAX_SIZE}] aralığında olmalı`,
        };
      }
      size = parsed;
      expectedRows = size * size * size;
      data = new Float32Array(expectedRows * 4);
      continue;
    }

    // Kalan her satır bir VERİ satırıdır: 3 sonlu float.
    const parts = line.split(/\s+/);
    if (parts.length !== 3) {
      return { ok: false, error: `satır ${lineNo + 1}: 3 sayı bekleniyordu` };
    }
    const r = Number.parseFloat(parts[0]);
    const g = Number.parseFloat(parts[1]);
    const b = Number.parseFloat(parts[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      return { ok: false, error: `satır ${lineNo + 1}: sonlu olmayan değer` };
    }
    if (data === null) {
      return { ok: false, error: `satır ${lineNo + 1}: LUT_3D_SIZE'dan önce veri satırı` };
    }
    if (rows >= expectedRows) {
      return { ok: false, error: `satır ${lineNo + 1}: ${expectedRows} satırdan fazla veri` };
    }
    const at = rows * 4;
    data[at] = r;
    data[at + 1] = g;
    data[at + 2] = b;
    data[at + 3] = 1;
    rows++;
  }

  if (size === 0 || data === null) {
    return { ok: false, error: 'LUT_3D_SIZE satırı yok — 3D .cube değil' };
  }
  if (rows !== expectedRows) {
    return { ok: false, error: `${expectedRows} veri satırı bekleniyordu, ${rows} bulundu` };
  }
  return { ok: true, lut: { size, data } };
}

// ---------------------------------------------------------------------------
// CPU referansı — §4.2 GPU örneklemesinin birebir eşi
// ---------------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** LUT düğümü (tamsayı indeks, [0, N-1]'e kelepçeli). */
function nodeAt(lut: CubeLut, ri: number, gi: number, bi: number): [number, number, number] {
  const n = lut.size;
  const clampIndex = (v: number): number => Math.min(n - 1, Math.max(0, v));
  const at = ((clampIndex(bi) * n + clampIndex(gi)) * n + clampIndex(ri)) * 4;
  return [lut.data[at], lut.data[at + 1], lut.data[at + 2]];
}

/**
 * §4.2'nin tamamı CPU'da: `mix(c, texture(uLut3D, c*uLutScale + uLutOffset).rgb, intensity)`.
 *
 * GPU LINEAR örneklemesinin matematiği: doku koordinatı `u ∈ [0,1]`, texel merkezi
 * `(i + 0.5)/N`. `u * (N-1)/N + 1/(2N)` dönüşümü [0,1]'i tam olarak
 * [ilk texel merkezi, son texel merkezi] aralığına oturtur; içeride
 * `t = u*(N-1)` kesirli indeksiyle üç eksende lineer (= trilinear) ağırlıklama
 * yapılır. Girdi önce [0,1]'e kelepçelenir (shader'a gelen renk zaten
 * clamp'lidir — §4.1 aşamaları); çıktı kelepçelenMEZ (8-bit framebuffer yazımı
 * doğal clamp'tir; referansın 8-bit karşılaştırması da aynı clamp'i uygular).
 */
export function sampleCubeLut(lut: CubeLut, rgb: Rgb, intensity: number): Rgb {
  const n = lut.size;
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  const tr = clamp01(rgb.r) * (n - 1);
  const tg = clamp01(rgb.g) * (n - 1);
  const tb = clamp01(rgb.b) * (n - 1);
  const r0 = Math.floor(tr);
  const g0 = Math.floor(tg);
  const b0 = Math.floor(tb);
  const fr = tr - r0;
  const fg = tg - g0;
  const fb = tb - b0;

  let outR = 0;
  let outG = 0;
  let outB = 0;
  for (let db = 0; db <= 1; db++) {
    for (let dg = 0; dg <= 1; dg++) {
      for (let dr = 0; dr <= 1; dr++) {
        const w =
          (dr === 0 ? 1 - fr : fr) * (dg === 0 ? 1 - fg : fg) * (db === 0 ? 1 - fb : fb);
        if (w === 0) continue;
        const [nr, ng, nb] = nodeAt(lut, r0 + dr, g0 + dg, b0 + db);
        outR += w * nr;
        outG += w * ng;
        outB += w * nb;
      }
    }
  }

  const k = Math.min(1, Math.max(0, intensity));
  return {
    r: rgb.r + (outR - rgb.r) * k,
    g: rgb.g + (outG - rgb.g) * k,
    b: rgb.b + (outB - rgb.b) * k,
  };
}
