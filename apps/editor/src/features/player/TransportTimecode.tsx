/**
 * TransportTimecode — transport çubuğundaki DÜZENLENEBİLİR playhead zaman kodu.
 *
 * Yerleşim sözleşmesi (bilinçli): bu bileşen bir Fragment döndürür, sarmalayıcı
 * div AÇMAZ ve YENİ SATIR EKLEMEZ. Oynatıcı sahnesi `flex-1` ile kalan yüksekliği
 * yutar; transport çubuğuna bir satır eklemek tuvalin letterbox kutusunu ve
 * dolayısıyla gizmo koordinat kökenini kaydırırdı. Mesaj bu yüzden AYNI satırda,
 * kısaltılarak (title'da tam metniyle) gösterilir.
 *
 * Düzenleme modeli — "ayna donar":
 * Alan, odakta DEĞİLKEN motor saatinin aynasıdır (playheadUs -> metin). Odak
 * geldiği anda metin DONDURULUR (`draft`): motor saati 60 Hz'te yazmaya devam
 * ederken alanın değerini değiştirmek caret'i her karede zıplatır ve yazmayı
 * imkânsız kılar. Dokunulmamış bir blur COMMIT ETMEZ — `setPlayheadUs('user')`
 * bir userSeekSeq artışıdır ve o artış J geri taramasını (shuttle) iptal eder;
 * yani "alana tıklayıp vazgeçmek" transport durumunu sessizce bozardı.
 *
 * Ret/kelepçe dürüstlüğü: Enter'da reddedilen metin SİLİNMEZ (kullanıcı ne
 * yazdığını görsün, düzeltebilsin) ve playhead OYNAMAZ; blur'da reddedilen metin
 * geri alınır. Kelepçe sessiz değildir — proje sonuna oturan hedef amber bir
 * bildirimle söylenir (metinler `playerFeedback.ts`, ayrıştırma `timecodeInput.ts`).
 */
import { useCallback, useRef, useState } from 'react';
import { type MicroSec, type Rational } from '@videoedit/timeline-schema';
import { timecodeFailureMessage, timecodeNoticeMessage } from './playerFeedback';
import { commitTimecodeText, displayTimecode } from './timecodeInput';

interface FieldMessage {
  kind: 'error' | 'notice';
  text: string;
}

export interface TransportTimecodeProps {
  /** Canlı playhead (motor saati) — odak yokken alanın aynası. */
  playheadUs: MicroSec;
  /** Proje sonu: hem "/" göstergesi hem de kelepçenin ÜST SINIRI. */
  durationUs: MicroSec;
  fps: Rational;
  /** Kabul edilen hedefi yazar (tek yazım yolu: store, `'user'` kaynağıyla). */
  onSeek(timeUs: MicroSec): void;
}

export function TransportTimecode({
  playheadUs,
  durationUs,
  fps,
  onSeek,
}: TransportTimecodeProps) {
  const mirror = displayTimecode(playheadUs, fps);
  /** null = ayna modu (odak yok, dokunulmamış); string = DONMUŞ/yazılan metin. */
  const [draft, setDraft] = useState<string | null>(null);
  /** Kullanıcı gerçekten yazdı mı (blur'da commit edilip edilmeyeceğini belirler). */
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<FieldMessage | null>(null);
  /** Ayna metninin CANLI değeri — Escape/odak anında dondurulacak kaynak. */
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;

  const commit = useCallback(
    (text: string, from: 'enter' | 'blur') => {
      const result = commitTimecodeText(text, { fps, durationUs });
      if (result.kind === 'reject') {
        if (from === 'enter') {
          setMessage({
            kind: 'error',
            text: timecodeFailureMessage(result.reason, { maxFrame: result.maxFrame }),
          });
          return;
        }
        // Odaktan çıkarken geçersiz metni ekranda bırakmak, alanı playhead'in
        // yalancı bir aynası hâline getirirdi.
        setDraft(null);
        setDirty(false);
        setMessage(null);
        return;
      }
      onSeek(result.timeUs);
      const notice = timecodeNoticeMessage(result.notice);
      setMessage(notice === null ? null : { kind: 'notice', text: notice });
      setDirty(false);
      // Enter'da odak alanda KALIR: aynayı kabul edilen (gerekirse kelepçelenmiş)
      // değere tazele — böylece kelepçe alanın kendisinde de görünür.
      setDraft(from === 'enter' ? displayTimecode(result.timeUs, fps) : null);
    },
    [durationUs, fps, onSeek],
  );

  return (
    <>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        maxLength={16}
        className="w-[11ch] rounded border border-transparent bg-transparent px-1 text-center font-mono text-fg hover:border-edge focus:border-edge focus:bg-surface-1 focus:outline-none"
        title="Playhead (proje fps zaman kodu)"
        aria-label="Playhead zaman kodu"
        data-testid="transport-timecode-input"
        value={draft ?? mirror}
        onFocus={(e) => {
          setDraft(mirrorRef.current);
          setDirty(false);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
          setMessage(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(draft ?? mirrorRef.current, 'enter');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            // Kısayol dağıtıcısının Escape'i (kısayol overlay'i) buraya
            // karışmasın: alandaki Escape'in tek anlamı "yazdığımı geri al".
            e.stopPropagation();
            setDraft(mirrorRef.current);
            setDirty(false);
            setMessage(null);
          }
        }}
        onBlur={() => {
          if (dirty) {
            commit(draft ?? mirrorRef.current, 'blur');
            return;
          }
          setDraft(null);
          setMessage(null);
        }}
      />
      <span className="text-fg-muted">/</span>
      <span className="font-mono" title="Proje süresi">
        {displayTimecode(durationUs, fps)}
      </span>
      {message !== null && (
        <span
          role="status"
          data-testid="transport-timecode-message"
          data-kind={message.kind}
          title={message.text}
          className={`min-w-0 flex-1 truncate text-[11px] ${
            message.kind === 'error' ? 'text-red-400' : 'text-amber-400'
          }`}
        >
          {message.text}
        </span>
      )}
    </>
  );
}
