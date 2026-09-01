/**
 * shuttle — J tuşunun SESSİZ kademeli geri taraması + transport durumu.
 *
 * Mimari (özellik turu, plan kararı): motora SIFIR dokunuş. Motor `paused`
 * kalır; bu modüldeki metronom (setInterval) playhead'i STORE üzerinden geri
 * taşır ve mevcut scrub yolu (PlayerPanel userSeekSeq aboneliği →
 * engine.seek(precise:false) → applyScrub throttle'ı) kareyi getirir.
 * Sessizlik YAPISALDIR: hiçbir <video>/<audio> elementi play() almaz, ses
 * zarfı hiç kurulmaz — ses koduna dokunulmaz. Reddedilen alternatif (motor
 * API'sine yön/negatif rate) DECISIONS'ta gerekçeli.
 *
 * Hız dürüstlüğü: döngü İÇ FLOAT akümülatör (`virtualUs`) tutar ve store'a
 * yalnız kare-ızgara-yapışık değeri yazar. Store'un yapışık değerinden geri
 * hesaplamak, tik başına ilerlemenin bir kareden küçük kaldığı anlarda
 * yuvarlanma-stall'ı üretirdi (yazılan değer geri okununca ilerleme sıfırlanır);
 * akümülatör bu geri beslemeyi keser.
 *
 * Sahiplik/iptal: döngü her yazımdan sonra KENDİ userSeekSeq'ini kaydeder
 * (zustand senkron — yazım+okuma atomik). Bir sonraki tikte seq farklıysa
 * DIŞARIDAN bir user seek olmuştur (timeline scrub, ok tuşları, Home…) ve
 * shuttle kendini iptal eder — ayrı bir kanca gerekmez. `isPlaying` true
 * olduğunda da aynı şekilde durur (oynatma playhead sahipliğini motora verir).
 */
import { create } from 'zustand';
import { snapUsToFrameGrid } from '@videoedit/timeline-schema';
import { useDocStore } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';

/**
 * Transport durumu — UI'nin (PlayerPanel rozeti) ve dispatcher testlerinin
 * gördüğü tek gerçek. `forwardRate` L kademesidir (eski modül-let buraya
 * taşındı); `shuttleRate` null ise geri tarama kapalıdır.
 */
export interface TransportStore {
  /** L kademesi (1x/2x/4x/8x) — oynatma yönünün hız çarpanı. */
  forwardRate: number;
  /** Aktif geri tarama hızı; null = shuttle kapalı. */
  shuttleRate: number | null;
  setForwardRate(rate: number): void;
}

export const useTransportStore = create<TransportStore>()((set) => ({
  forwardRate: 1,
  shuttleRate: null,
  setForwardRate: (rate) => set({ forwardRate: rate }),
}));

/** Metronom aralığı — 30 fps karesinin (~33,3 ms) altında kalan en yakın tam sayı. */
export const SHUTTLE_TICK_MS = 33;

/** Kademe tavanı: J tekrar basışları 1→2→4→8 katlar ve burada doyar. */
export const SHUTTLE_MAX_RATE = 8;

let timer: ReturnType<typeof setInterval> | null = null;
/** İç float akümülatör (µs) — store'a yazılan yapışık değerden BAĞIMSIZ. */
let virtualUs = 0;
/** Bir önceki tikin Date.now değeri (delta hesabı; fake timer'lar Date'i de sarar). */
let lastTickMs = 0;
/** Son KENDİ yazımımızın userSeekSeq'i — farklı seq = dış seek = iptal. */
let lastOwnSeq = 0;

/**
 * J basışı: shuttle kapalıysa mevcut playhead'den 1x geri taramayı başlatır;
 * açıksa kademeyi ikiye katlar (1→2→4→8; tavanda kalır). Akümülatör ve
 * metronom aynen sürer — hız değişimi bir SONRAKİ tikin deltasından itibaren
 * işler (geçmiş dilim yeniden fiyatlanmaz).
 */
export function startOrBumpShuttle(): void {
  if (timer !== null) {
    const current = useTransportStore.getState().shuttleRate ?? 1;
    useTransportStore.setState({ shuttleRate: Math.min(current * 2, SHUTTLE_MAX_RATE) });
    return;
  }
  const editor = useEditorStore.getState();
  virtualUs = editor.playheadUs;
  lastOwnSeq = editor.userSeekSeq;
  lastTickMs = Date.now();
  useTransportStore.setState({ shuttleRate: 1 });
  timer = setInterval(tick, SHUTTLE_TICK_MS);
}

/**
 * Shuttle'ı durdurur; aktif MİYDİ bilgisini döndürür (Space'in "shuttle'dayken
 * dur, oynatmaya geçme" kuralı bunu okur).
 */
export function stopShuttle(): boolean {
  const wasActive = timer !== null;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (useTransportStore.getState().shuttleRate !== null) {
    useTransportStore.setState({ shuttleRate: null });
  }
  return wasActive;
}

function tick(): void {
  const editor = useEditorStore.getState();
  // (1) Oynatma başladıysa playhead sahibi artık motordur.
  if (editor.isPlaying) {
    stopShuttle();
    return;
  }
  // (2) DIŞ user seek (timeline scrub / ok tuşları / Home…) — kullanıcının
  // yeni niyeti kazanır, shuttle kendini iptal eder.
  if (editor.userSeekSeq !== lastOwnSeq) {
    stopShuttle();
    return;
  }
  const now = Date.now();
  const dtMs = now - lastTickMs;
  lastTickMs = now;
  const rate = useTransportStore.getState().shuttleRate ?? 1;
  // (3) Gerçek geçen süreyle geri say (metronomun gecikmesi hızı bozmaz).
  virtualUs -= dtMs * 1000 * rate;
  // (4) BOF kelepçesi: başlangıca varınca TAM 0'a yaz ve dur.
  if (virtualUs <= 0) {
    editor.setPlayheadUs(0);
    stopShuttle();
    return;
  }
  // (5) Store'a KARE-IZGARA-yapışık yaz; kendi seq'imizi hemen kaydet.
  const fps = useDocStore.getState().doc.settings.fps;
  editor.setPlayheadUs(snapUsToFrameGrid(Math.round(virtualUs), fps));
  lastOwnSeq = useEditorStore.getState().userSeekSeq;
}
