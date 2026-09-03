/**
 * timecodeInput — transport çubuğundaki ELLE zaman kodu girişinin saf çekirdeği.
 *
 * Neden burada, `@videoedit/timeline-schema/time.ts`'te DEĞİL: paylaşılan şema
 * paketi TS ve C# tarafının BİREBİR aynı davranışı uygulamak zorunda olduğu
 * sözleşmedir; C# tarafı zaman kodu AYRIŞTIRMAZ (yalnız üretir —
 * `Timecode.ToTimecodeString`). Ayrıştırıcıyı oraya koymak ya ölü bir ikiz
 * doğururdu ya da "her iki dil de uygular" kuralını sessizce delerdi. Bu modül
 * app-yerel bir GİRDİ katmanıdır: ileri yön (`formatTimecode`) şemadan gelir,
 * ters yön burada yaşar ve testi ileri yöne ÇİVİLENİR.
 *
 * Toplamsallık sözleşmesi: buradaki hiçbir fonksiyon HİÇBİR girdide fırlatmaz.
 * Bir metin kutusundan gelen ham dize her şey olabilir; `formatTimecode` /
 * `usToFrame` ise tamsayı disiplinini `RangeError` ile korur. O yüzeyin UI'ya
 * sızmaması için sınır kontrolü burada yapılır ve sonuç TİPLİ bir ret olarak
 * döner (sessiz düzeltme değil — görünür, çevrilebilir bir kod).
 *
 * Dilbilgisi (kullanıcı kararı — "saat okuması", plan §Dilim 1):
 *   `SS` · `MM:SS` · `HH:MM:SS` · `HH:MM:SS:FF`
 * Yani `90` = 90 saniye, `1:30` = 1 dk 30 sn, `1:30:00` = 1 SAAT 30 dk, kare
 * alanı YALNIZ dört alanlı yazımda vardır. Baştaki alan takvim sınırına
 * uymak zorunda değildir (`90`, `100:00:00`); iç alanlar katıdır.
 */
import { formatTimecode, type MicroSec, type Rational } from '@videoedit/timeline-schema';

// ---------------------------------------------------------------------------
// Ret / bildirim kodları
//
// Bu dosyadaki SCREAMING_CASE + küçük-harf-İngilizce sabitler `feedbackCoverage`
// taramasının kod envanteridir: her biri `playerFeedback.ts` tablosunda Türkçe
// karşılık bulmak ZORUNDA (eşlenmemiş kod = kullanıcıya jenerik mesaj). Bu form
// yalnız GERÇEK kodlara ayrılmıştır — başka hiçbir sabit bu şekli almamalı.
// ---------------------------------------------------------------------------

/** Dilbilgisine hiç uymayan metin (harf, işaret, alan sayısı/basamak taşması). */
export const TIMECODE_NOT_UNDERSTOOD = 'timecode not understood';
/** Noktalı virgüllü (drop-frame) yazım — MVP kararı: desteklenmiyor. */
export const TIMECODE_DROP_FRAME = 'drop-frame timecode not supported';
/** İç alan takvim/kare sınırının dışında (MM/SS > 59, FF >= nominal fps). */
export const TIMECODE_FIELD_OUT_OF_RANGE = 'timecode field out of range';
/** Sonuç akıl sınırının (24 saat) ötesinde. */
export const TIMECODE_TOO_LARGE = 'timecode too large';
/** Hedef proje sonunun ötesindeydi; playhead proje sonuna oturtuldu. */
export const TIMECODE_CLAMPED_TO_END = 'timecode clamped to project end';
/** Proje boş (süre 0); playhead başta kaldı. */
export const TIMECODE_CLAMPED_EMPTY = 'timecode clamped on empty project';

/** Kabul edilen en büyük sonuç: 24 saat. */
const MAX_TIMECODE_US = 24 * 60 * 60 * 1_000_000;
/** Baştaki alanın en çok basamağı (takvim sınırı yok ama sonsuz da değil). */
const MAX_LEAD_DIGITS = 6;
/** İç alanların (MM/SS/FF) en çok basamağı. */
const MAX_INNER_DIGITS = 2;
/** Dilbilgisinin kabul ettiği en çok alan (`HH:MM:SS:FF`). */
const MAX_FIELDS = 4;
/** ASCII rakam + iki nokta dışında hiçbir şeyi kabul etmeyen kabuk. */
const TIMECODE_SHAPE = /^[0-9]+(:[0-9]+)*$/;

const US_PER_SECOND = 1_000_000;

/** Ayrıştırma sonucu: ya tamsayı µs, ya TİPLİ bir ret. */
export type ParsedTimecode =
  | { ok: true; timeUs: MicroSec }
  | { ok: false; reason: string; maxFrame?: number };

/** Commit sonucu: ya bir seek (opsiyonel bildirimle), ya tipli bir ret. */
export type TimecodeCommit =
  | { kind: 'seek'; timeUs: MicroSec; notice: string | null }
  | { kind: 'reject'; reason: string; maxFrame?: number };

/**
 * Zaman kodunun kare alanının tabanı: nominal (tam sayıya yuvarlanmış) fps.
 * `formatTimecode` ile AYNI kural (29.97 -> 30) — iki taraf ayrışırsa yazılan
 * metin ile gösterilen metin birbirini tutmaz.
 *
 * Kullanılamaz bir rational'da 0 döner; çağıran bunu ret'e çevirir (fırlatmaz).
 * Kabul koşulu `time.ts`'in `assertRational`'ı ile AYNI (pozitif tamsayı çift),
 * böylece bu kapıdan geçen her fps `formatTimecode`'u da fırlatmadan geçer.
 */
function nominalFps(fps: Rational | null | undefined): number {
  const num = fps?.num ?? 0;
  const den = fps?.den ?? 0;
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) return 0;
  return Math.max(1, Math.floor(num / den + 0.5));
}

/** Tamsayı tavan bölmesi (x, y > 0) — float `Math.ceil` yuvarlama hatası yok. */
function ceilDiv(x: number, y: number): number {
  return Math.floor((x + y - 1) / y);
}

/**
 * Kare indeksini, `formatTimecode`'u O KAREYE eşitleyen EN KÜÇÜK tamsayı µs'ye
 * çevirir: `ceil(frames * den * 1e6 / num)`.
 *
 * Neden `frameToUs` DEĞİL (bu dilimin tek yeni matematiği): `frameToUs` half-up
 * yuvarlar, `formatTimecode` ise floor ile kare sayar. 30 fps'te 1. kare
 * `frameToUs` ile 33 333 µs olur ve `formatTimecode(33333)` "00:00:00:00" der
 * (çapraz-dil vektörü `time-vectors.json` bunu çiviliyor) — yani kullanıcının
 * yazdığı ":01" alan güncellenince ":00"a düşerdi. Tavan, ters fonksiyonu ileri
 * fonksiyonun tam tersi yapar.
 *
 * Taşma güvenliği: çarpım tek parçada `frames * den * 1e6` olarak hesaplansaydı
 * uzun zaman kodlarında 2^53'ü aşabilirdi; bölüm ve kalan ayrı taşınır.
 */
function frameToCeilUs(frames: number, fps: Rational): MicroSec {
  const a = frames * fps.den;
  const q = Math.floor(a / fps.num);
  const r = a - q * fps.num;
  return q * US_PER_SECOND + (r === 0 ? 0 : ceilDiv(r * US_PER_SECOND, fps.num));
}

function reject(reason: string, maxFrame?: number): ParsedTimecode {
  return maxFrame === undefined ? { ok: false, reason } : { ok: false, reason, maxFrame };
}

/**
 * Kullanıcının yazdığı zaman kodunu tamsayı µs'ye çevirir. FIRLATMAZ.
 *
 * @param raw ham metin (baştaki/sondaki boşluklar kırpılır)
 * @param fps proje kare hızı (nominal tabanı buradan gelir)
 */
export function parseTimecode(raw: unknown, fps: Rational): ParsedTimecode {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return reject(TIMECODE_NOT_UNDERSTOOD);
  // Drop-frame ayrı bir KOD ile reddedilir: ';' yazan kullanıcı yazım hatası
  // yapmıyor, desteklenmeyen bir standart istiyor — ona öyle denmeli.
  if (text.includes(';')) return reject(TIMECODE_DROP_FRAME);
  if (!TIMECODE_SHAPE.test(text)) return reject(TIMECODE_NOT_UNDERSTOOD);

  const fields = text.split(':');
  if (fields.length > MAX_FIELDS) return reject(TIMECODE_NOT_UNDERSTOOD);
  if (fields[0].length > MAX_LEAD_DIGITS) return reject(TIMECODE_NOT_UNDERSTOOD);
  for (let i = 1; i < fields.length; i++) {
    if (fields[i].length > MAX_INNER_DIGITS) return reject(TIMECODE_NOT_UNDERSTOOD);
  }

  const fpsTC = nominalFps(fps);
  // Proje fps'i okunamıyorsa zaman kodu ızgarası TANIMSIZDIR; sessizce bir
  // varsayılana düşmek yanlış kareye atlamak demek olurdu.
  if (fpsTC === 0) return reject(TIMECODE_NOT_UNDERSTOOD);

  const n = fields.map((f) => Number(f));
  let hh = 0;
  let mm = 0;
  let ss = 0;
  let ff = 0;
  switch (fields.length) {
    case 1:
      ss = n[0];
      break;
    case 2:
      mm = n[0];
      ss = n[1];
      break;
    case 3:
      hh = n[0];
      mm = n[1];
      ss = n[2];
      break;
    default:
      hh = n[0];
      mm = n[1];
      ss = n[2];
      ff = n[3];
      break;
  }

  // İç alanlar takvim-KATI: `1:75` yazan kullanıcı 2 dk 15 sn demek istemiş
  // olabilir ama zaman kodu okuması değildir; sessizce taşırmak yerine söyle.
  // (Baştaki alan bilinçle serbesttir: `90` = 90 sn, `100:00:00` = 100 saat.)
  if (fields.length >= 2 && ss > 59) return reject(TIMECODE_FIELD_OUT_OF_RANGE);
  if (fields.length >= 3 && mm > 59) return reject(TIMECODE_FIELD_OUT_OF_RANGE);
  if (fields.length === 4 && ff >= fpsTC) {
    return reject(TIMECODE_FIELD_OUT_OF_RANGE, fpsTC - 1);
  }

  const totalSeconds = (hh * 60 + mm) * 60 + ss;
  // Ucuz ön kapı: µs matematiğine girmeden önce büyüklüğü sınırla (tamsayı
  // kesinliği korunur), sonra tam sonucu da sınırda tut (24:00:00:01 gibi).
  if (totalSeconds > MAX_TIMECODE_US / US_PER_SECOND) return reject(TIMECODE_TOO_LARGE);
  const timeUs = frameToCeilUs(totalSeconds * fpsTC + ff, fps);
  if (timeUs > MAX_TIMECODE_US) return reject(TIMECODE_TOO_LARGE);
  return { ok: true, timeUs };
}

/**
 * Alanın commit'i: ayrıştır, sonra PROJE SONUNA kelepçele.
 *
 * Kelepçe kullanıcı kararıdır ("hepsi kelepçelensin"), ama SESSİZ değildir:
 * hedef değiştiyse bir bildirim kodu döner ve alan onu yazar. Boş projede
 * (süre 0) üst sınır 0'dır — playhead başta kalır; bu ayrı bir koddur, çünkü
 * "proje sonuna oturtuldu" boş bir projede anlamsız olurdu.
 */
export function commitTimecodeText(
  raw: unknown,
  opts: { fps: Rational; durationUs: MicroSec },
): TimecodeCommit {
  const parsed = parseTimecode(raw, opts.fps);
  if (!parsed.ok) {
    return parsed.maxFrame === undefined
      ? { kind: 'reject', reason: parsed.reason }
      : { kind: 'reject', reason: parsed.reason, maxFrame: parsed.maxFrame };
  }
  const duration = Number.isFinite(opts.durationUs) ? Math.floor(opts.durationUs) : 0;
  if (duration <= 0) {
    return parsed.timeUs > 0
      ? { kind: 'seek', timeUs: 0, notice: TIMECODE_CLAMPED_EMPTY }
      : { kind: 'seek', timeUs: 0, notice: null };
  }
  if (parsed.timeUs > duration) {
    return { kind: 'seek', timeUs: duration, notice: TIMECODE_CLAMPED_TO_END };
  }
  return { kind: 'seek', timeUs: parsed.timeUs, notice: null };
}

/**
 * Playhead'in ekrandaki zaman kodu metni. FIRLATMAZ.
 *
 * `formatTimecode` tamsayı ve negatif-olmayan µs ister (aksi halde
 * `RangeError`); motor saati ise ham float taşıyabilir. Bu koruma eskiden
 * `PlayerPanel` içindeydi — girdi alanı aynı metni AYNA olarak kullandığı için
 * tek yere taşındı, iki kopya kural doğmasın.
 */
export function displayTimecode(playheadUs: number, fps: Rational): string {
  const safeUs = Number.isFinite(playheadUs) ? Math.max(0, Math.round(playheadUs)) : 0;
  if (nominalFps(fps) === 0) return '';
  return formatTimecode(safeUs, fps);
}
