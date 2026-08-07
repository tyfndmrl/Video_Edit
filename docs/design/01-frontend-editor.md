# Frontend Editör Çekirdeği — Tasarım Dokümanı

## 1. Zaman Temsili ve Timeline Veri Modeli

### 1.1 Zaman temsili kararı: tamsayı mikrosaniye (µs)

**Karar:** Tüm zaman değerleri `int` mikrosaniye (`timeUs: number`, JS number 2^53'e kadar tam — µs cinsinden ~285 yıl, güvenli). Frame sayısı DEĞİL.

**Gerekçe:**
- **Frame tabanlı temsilin sorunu:** "Frame" hangi fps'e göre? 23.976 (24000/1001) kaynak + 30 fps kaynak + 25 fps proje aynı timeline'da olabilir. Frame index'i asset'e bağımlıdır, timeline pozisyonu için doğal birim değildir. Ayrıca 23.976 gibi rational fps'lerde frame→saniye dönüşümü zaten rational aritmetik gerektirir.
- **Float saniyenin sorunu (yasak zaten):** `0.1 + 0.2 !== 0.3`; uzun timeline'da kümülatif drift, export ile önizleme arasında 1-frame kaymalar.
- **µs neden yeterli:** En yüksek pratik fps (240) için frame süresi ~4167 µs; µs çözünürlüğü her frame sınırını tam temsil eder. 24000/1001 fps'te frame süresi 41708.33... µs tam bölünmez, ama frame sınırları `round(n * 1001 * 1e6 / 24000)` ile deterministik hesaplanır ve **yuvarlama kuralı sözleşmeye yazılır** (aşağıda).
- Ses örnekleri için de µs yeterli hassasiyettedir (48 kHz → örnek başına ~20.83 µs; export tarafı sample-accurate hizalamayı kendi yapar).

**Değişken fps (VFR) kaynaklar:** Telefon kayıtları sık sık VFR'dir. Kural: **VFR frontend'e hiç sızmaz.** Backend proxy üretirken CFR'a normalize eder (`ffmpeg -vsync cfr -r <targetFps>`); ffprobe metadata'sında hem orijinal `avg_frame_rate` hem proxy'nin CFR değeri bulunur. Frontend frame-step ve snapping için daima proxy'nin CFR rational fps'ini kullanır. Export üreticisi de orijinal dosyaya aynı CFR normalizasyonunu uygular (sözleşme notu: bu, backend/export tasarımına eklenmesi gereken bir gereksinimdir).

**Yuvarlama sözleşmesi (frontend + export ortak):**
- µs'ye dönüşümlerde `Math.round` (half-up).
- `timelineDurationUs = round((sourceOutUs - sourceInUs) / speed)` — export üreticisi aynı formülü kullanmalı.
- Frame index → µs: `round(frameIndex * fps.den * 1_000_000 / fps.num)`.
- µs → frame index (snapping): `round(timeUs * fps.num / (fps.den * 1_000_000))`.

### 1.2 TypeScript şeması (paylaşılan sözleşme — `@app/timeline-schema` paketi)

Bu tipler **zod v4** ile tanımlanır; zod'dan JSON Schema üretilir (`z.toJSONSchema`), backend C# tarafı NJsonSchema ile aynı şemadan DTO üretir. Tek kaynak: bu paket.

```ts
// ---------- Temel ----------
/** Tamsayı mikrosaniye. Float YASAK. Tüm aritmetik integer. */
export type MicroSec = number;

export interface Rational { num: number; den: number } // örn. {num:24000, den:1001}

export type Uuid = string; // uuid v7 önerilir (sıralanabilir)

// ---------- Doküman kökü ----------
export interface TimelineDoc {
  schemaVersion: 1;               // migration için zorunlu
  projectId: Uuid;
  settings: ProjectSettings;
  tracks: Track[];                // index 0 = en üst katman (render sırası: sondan başa)
  markers: Marker[];
}

export interface ProjectSettings {
  width: number;                  // örn. 1920
  height: number;                 // örn. 1080
  fps: Rational;                  // proje/çıkış fps'i; frame-step ve timecode bunu kullanır
  audioSampleRate: 44100 | 48000; // export miks hedefi
  backgroundColor: string;        // "#000000"
}

export interface Marker { id: Uuid; timeUs: MicroSec; label?: string; color?: string }

// ---------- Track ----------
export type TrackType = 'video' | 'audio' | 'overlay'; // overlay: text/sticker/shape
export interface Track {
  id: Uuid;
  type: TrackType;
  name?: string;
  muted: boolean;     // audio + video'nun sesi için
  hidden: boolean;    // görsel katman gizleme
  locked: boolean;
  clips: Clip[];      // İNVARYANT: timelineStartUs'a göre sıralı, çakışma yok
}

// ---------- Clip ----------
export type ClipKind = 'video' | 'audio' | 'image' | 'text' | 'shape' | 'sticker';

export interface ClipBase {
  id: Uuid;
  kind: ClipKind;
  timelineStartUs: MicroSec;
  /** Timeline'da kapladığı süre (speed uygulanmış). Bitiş = start + duration. */
  timelineDurationUs: MicroSec;
  transform: Transform;
  keyframes: KeyframeTracks;     // boş obje = keyframe yok
  effects: Effect[];
  opacity: number;               // 0..1 taban değeri (keyframe ile override edilebilir)
}

export interface MediaClip extends ClipBase {
  kind: 'video' | 'audio' | 'image';
  assetId: Uuid;
  /** Kaynak (orijinal medya) zaman aralığı, media'nın kendi zamanında. Image için 0/duration. */
  sourceInUs: MicroSec;
  sourceOutUs: MicroSec;         // İNVARYANT: sourceOutUs > sourceInUs
  /** MVP: sabit hız. İNVARYANT: timelineDurationUs === round((out-in)/rate) */
  speed: { rate: number };       // 0.1 .. 10; ileride SpeedRamp union'a eklenir
  audio: ClipAudio | null;       // video'nun gömülü sesi; detach edilmişse null
  transitionIn?: Transition;     // bu clip'e GİRİŞ geçişi (önceki clip ile overlap mantığı export'ta xfade)
  transitionOut?: Transition;
}

export interface ClipAudio {
  volume: number;                // lineer gain 0..2 (0 dB = 1)
  fadeInUs: MicroSec;
  fadeOutUs: MicroSec;
  muted: boolean;
}

export interface TextClip extends ClipBase {
  kind: 'text';
  text: {
    content: string;
    fontFamily: string; fontSizePx: number; fontWeight: number; italic: boolean;
    fill: string; stroke?: { color: string; widthPx: number };
    background?: { color: string; paddingPx: number; radiusPx: number };
    align: 'left' | 'center' | 'right';
    lineHeight: number;          // 1.2 gibi çarpan
  };
}

export interface ShapeClip extends ClipBase {
  kind: 'shape';
  shape: { type: 'rect' | 'ellipse' | 'line' | 'arrow'; fill: string; stroke?: { color: string; widthPx: number }; radiusPx?: number };
}

export interface StickerClip extends ClipBase {
  kind: 'sticker';
  assetId: Uuid;                 // PNG/WebP/animasyonlu WebP asset
}

export type Clip = MediaClip | TextClip | ShapeClip | StickerClip;

// ---------- Transform ----------
/** Koordinat sistemi: proje çözünürlüğüne göre NORMALİZE.
 *  x,y: kompozisyon merkezine göre, [-0.5..0.5] aralığı tipik (1.0 = tam genişlik/yükseklik).
 *  Böylece export çözünürlüğü değişse de yerleşim bozulmaz. */
export interface Transform {
  x: number; y: number;
  scale: number;                 // 1 = orijinal fit boyutu
  rotationDeg: number;
  anchorX: number; anchorY: number; // 0..1, default 0.5/0.5
}

// ---------- Keyframe ----------
export type Easing =
  | { type: 'linear' }
  | { type: 'easeIn' } | { type: 'easeOut' } | { type: 'easeInOut' }
  | { type: 'cubicBezier'; x1: number; y1: number; x2: number; y2: number };

export interface Keyframe {
  /** Clip'in timeline başlangıcına GÖRELİ, timeline-zamanında (speed'den bağımsız). */
  timeUs: MicroSec;
  value: number;
  easing: Easing;                // BU keyframe'den SONRAKİ segmentin easing'i
}

/** Anahtarlar animasyonlanabilir skaler property'ler. Yoksa taban değer geçerli. */
export interface KeyframeTracks {
  x?: Keyframe[]; y?: Keyframe[];
  scale?: Keyframe[]; rotationDeg?: Keyframe[];
  opacity?: Keyframe[];
  volume?: Keyframe[];           // audio için
  // effect parametreleri: "fx.<effectId>.<param>" anahtarıyla — bkz Effect
  [key: `fx.${string}`]: Keyframe[] | undefined;
}

// ---------- Effect ----------
export type EffectType = 'colorAdjust' | 'lut' | 'blur' | 'chromaKey';
export interface Effect {
  id: Uuid;
  type: EffectType;
  enabled: boolean;
  /** Parametreler düz skaler; animasyon KeyframeTracks'te "fx.<id>.<param>" ile. */
  params: Record<string, number | string>;
  // colorAdjust: { brightness:-1..1, contrast:-1..1, saturation:-1..1, temperature:-1..1, tint:-1..1, exposure:-1..1 }
  // lut: { assetId: Uuid, intensity: 0..1 }
}

// ---------- Transition ----------
export type TransitionType = 'crossfade' | 'fadeToBlack' | 'wipeLeft' | 'wipeRight' | 'slideUp' | 'dissolve';
export interface Transition { type: TransitionType; durationUs: MicroSec }
```

**Makine-dostu invaryantlar (zod `superRefine` + CI testi + export üreticisi de doğrular):**
1. Track içindeki clip'ler `timelineStartUs`'a göre artan sıralı ve `clip[i].end <= clip[i+1].start`.
2. `sourceOutUs > sourceInUs`; her ikisi `[0, asset.durationUs]` içinde.
3. `timelineDurationUs === round((sourceOutUs - sourceInUs) / speed.rate)`.
4. Keyframe dizileri `timeUs`'a göre sıralı, `[0, timelineDurationUs]` içinde, aynı timeUs'ta tek keyframe.
5. Transition süresi komşu iki clip'in kısasının yarısını aşamaz.
6. Tüm `*Us` alanları negatif olmayan tamsayı (`Number.isInteger`).

---

## 2. State Yönetimi + Undo/Redo

### 2.1 Mimari: Zustand + immer patch tabanlı history (command pattern hibrit)

**Karar:** `zustand@5` + `immer@10` `produceWithPatches`. Saf command pattern (her eylem için do/undo sınıfı) yerine **patch-based history**: her mutasyon immer ile yapılır, `patches` + `inversePatches` çifti eylem etiketiyle history'ye itilir. Command pattern'in "her yeni özellik için undo kodu yaz" maliyeti yok; patch'ler otomatik, doğruluk garanti.

```ts
interface HistoryEntry {
  label: string;                    // "Clip kırpıldı", "3 clip taşındı" — UI'da gösterilir
  actionType: string;               // 'trim' | 'move' | 'split' ... coalescing için
  patches: Patch[];
  inversePatches: Patch[];
  timestamp: number;
}
// Store ayrımı — KRİTİK:
// docStore   : TimelineDoc — undo'ya TABİ, autosave'e TABİ
// editorStore: selection, playheadUs, zoom (pxPerUs), scrollUs, tool, snapping — undo DIŞI
// assetStore : asset metadata cache, upload durumları — undo DIŞI
```

Undo yalnızca dokümanı geri alır; playhead/selection geri sarılmaz (Premiere/CapCut uzlaşımı). İstisna: undo sonrası etkilenen clip'ler seçilir (UX inceliği).

### 2.2 Transaction API ve coalescing

```ts
const tx = docStore.begin('trim', 'Clip kırpıldı');
tx.update(draft => { /* her pointermove'da */ });
tx.commit();   // pointerup: TEK history entry (begin öncesi → commit anı farkı)
tx.abort();    // Esc: begin anındaki state'e dön, history'ye girmez
```

**Tek undo adımı sayılanlar:** drag-move'un tamamı, trim sürüklemesinin tamamı, slider/knob sürüklemesi (volume, renk), text yazımının burst'ü (500 ms debounce ile birleştir), çoklu seçim taşıma (tek entry, "5 clip taşındı"). **Ayrı adımlar:** split, delete, paste, keyframe ekleme, effect ekleme/çıkarma.

### 2.3 İşlem geçmişi UI'ı

Panel: `HistoryEntry.label` listesi, tıklayınca o noktaya jump (aradaki inverse/forward patch'ler toplu uygulanır). Limit: 200 entry (bellek). Redo yığını yeni eylemde temizlenir (lineer history; branch'li history MVP dışı).

### 2.4 Autosave ilişkisi

- Autosave **doc snapshot'ı** serialize eder (JSON), history'yi DEĞİL. Undo geçmişi client-only; sekme yenilenince kaybolur (MVP kabulü; ileride IndexedDB'ye patch log).
- Debounce: son mutasyondan 2 s sonra, en geç 15 s'de bir (leading değil trailing + maxWait). `revision: number` alanıyla optimistic concurrency → `PUT /api/projects/{id}/timeline` `If-Match: revision`; 409'da "başka sekmede değişti" diyaloğu.
- Sunucu her save'i versiyon geçmişine yazmaz; **checkpoint kuralı**: son versiyondan ≥ 60 s geçtiyse veya entry sayısı ≥ 20 arttıysa yeni versiyon satırı (backend tasarımıyla ortak sözleşme).
- Undo yapıldığında da autosave tetiklenir (undo edilmiş hali kaydetmek doğru davranış).

---

## 3. Timeline UI

### 3.1 Render yaklaşımı: **hibrit — canvas gövde + DOM overlay**

**Karar ve gerekçe:**
- **Canvas (ana gövde):** clip blokları, filmstrip thumbnail'lar, waveform'lar, keyframe elmasları, snapping kılavuz çizgileri, playhead. Neden: 10+ track × onlarca clip × filmstrip karesi + 60 fps pan/zoom'da DOM layout/paint maliyeti kabul edilemez; canvas'ta tek `requestAnimationFrame` geçişiyle sadece görünür aralık çizilir (zaman-viewport virtualization: `visibleStartUs..visibleEndUs` dışındaki hiçbir şey çizilmez).
- **DOM overlay (canvas üstünde absolute):** context menu, clip üstü inline text editing, tooltip'ler, trim cursor'ları, drag ghost. Neden: erişilebilirlik, IME, native text input.
- **Ruler** ayrı canvas (yalnız zoom/pan'da redraw). **Playhead** ayrı ince katman (her frame'de tüm timeline'ı redraw etmemek için).
- devicePixelRatio ölçekli çizim; `OffscreenCanvas` + worker MVP'de gerekmez, çizim bütçesi yeterli.

Hit-testing: DOM olmadığı için kendi hit-test'imiz — çizim sırasında üretilen `{clipId, rect, region: 'body'|'trimL'|'trimR'|'fadeHandle'|'keyframe'}` listesi üzerinde pointer sorgusu.

### 3.2 Zoom / pan / koordinat

- Tek dönüşüm: `xPx = (timeUs - scrollUs) * pxPerUs`. `pxPerUs` aralığı ~`[genişlik/tümSüre, 0.005]` (0.005 ≈ 5 px/ms, frame-level zoom).
- `Ctrl+wheel` → imleç altındaki zaman sabit kalacak şekilde zoom (cursor-anchored). `wheel` dikey scroll (track'ler), `Shift+wheel` yatay pan. Pinch desteklenir (`wheel` + `ctrlKey` zaten pinch'i verir).
- Filmstrip: sunucu sprite'ı (örn. her 1 s'de 1 kare, 160px yükseklik, tek JPEG/WebP sprite + index JSON). Zoom seviyesine göre kare atlama; `drawImage` sprite'tan slice.
- Waveform: sunucudan multi-resolution peaks JSON (örn. 100 peak/s ve 1000 peak/s iki seviye); min/max çifti dikey çizgilerle çizilir.

### 3.3 Etkileşimler

- **Snapping** (S ile aç/kapa): hedefler = diğer clip kenarları, playhead, marker'lar, saniye/frame grid'i. Eşik 8 px → `8 / pxPerUs` µs. En yakın aday kazanır; snap olduğunda dikey turuncu kılavuz çizgisi.
- **Trim:** normal trim (boşluk bırakır), `Ctrl` basılıyken **ripple trim** (sonraki clip'ler kayar), iki clip sınırında **roll trim** (ortak kenar; toplam süre sabit). Trim sınırları: `sourceIn >= 0`, `sourceOut <= asset.duration` (medya sınırı görsel olarak kırmızı direnç).
- **Split (C):** playhead altındaki (veya seçili) clip iki MediaClip'e bölünür; keyframe'ler zamana göre pay edilir, sınırdaki değer interpolasyonla her iki parçaya yazılır.
- **Çoklu seçim:** tıklama, `Shift+tık` ekle, boş alanda marquee (kayan seçim kutusu). Taşıma çoklu clip'i göreli konum koruyarak taşır; hedefte çakışma varsa bırakma reddedilir (kırmızı highlight) — MVP'de auto-ripple yok, basit tut.
- **Drag-drop:** kütüphane panelinden timeline'a native HTML5 DnD yerine **pointer-event tabanlı özel DnD** (dnd-kit canvas'la uyumsuz); medya havuzundan sürüklenen asset için ghost + insert göstergesi; boş alt bölgeye bırakınca yeni track oluşur.

### 3.4 Klavye kısayol haritası (CapCut/Premiere uzlaşımı)

| Kısayol | Eylem |
|---|---|
| Space | Oynat/Duraklat |
| J / K / L | Geri oynat* / dur / ileri oynat (L tekrar = 2x) |
| ← / → | 1 frame geri/ileri (proje fps'ine göre) |
| Shift+← / → | 1 s geri/ileri |
| Home / End | Timeline başı / sonu |
| ↑ / ↓ | Önceki/sonraki kesim noktasına atla |
| C | Playhead'de split (blade) |
| Q / W | Clip başını / sonunu playhead'e trim'le |
| Delete | Sil (boşluk kalır); Shift+Delete: ripple delete |
| Ctrl+Z / Ctrl+Shift+Z (ve Ctrl+Y) | Undo / Redo |
| Ctrl+C / X / V | Kopyala / kes / playhead'e yapıştır |
| Ctrl+D | Duplicate |
| S | Snapping aç/kapa |
| M | Marker ekle |
| + / − (veya Ctrl+wheel) | Zoom in/out |
| Shift+Z | Timeline'ı sığdır (fit) |
| Ctrl+A | Tümünü seç |

*J (reverse play) v1 player'da desteklenmez — v1'de "hızlı geri scrub" olarak davranır; v2'de gerçek reverse. Kısayol motoru: input/textarea odaklıyken devre dışı; `useHotkeys` yerine tek merkezi `keydown` dispatcher (çakışma yönetimi ve context — timeline odaklı mı, player mı — için).

### 3.5 Timecode

Format `HH:MM:SS:FF` (FF = proje fps'ine göre frame). 23.976 gibi NTSC fps'lerde **drop-frame timecode kullanılmıyor** (MVP kararı — sosyal medya içeriği için gereksiz karmaşıklık); frame sayısı `floor(timeUs * fps.num / (fps.den * 1e6))`'dan türetilir, non-drop gösterilir. Ruler etiketleri zoom'a göre adaptif: saat → dakika → saniye → frame.

---

## 4. Player / Önizleme Motoru

### 4.1 Ortak soyutlama (iki aşamanın da uyduğu arayüz)

```ts
interface PlaybackEngine {
  load(doc: TimelineDoc, assets: AssetResolver): void;
  play(): void; pause(): void;
  seek(timeUs: MicroSec, opts?: { precise: boolean }): Promise<void>; // precise: frame-accurate (durunca), değilse hızlı scrub
  readonly clock$: Observable<MicroSec>;  // UI playhead bunu takip eder
  setPlaybackRate(r: number): void;
  dispose(): void;
}
```

**Kritik mimari karar: kompozitör (WebGL2) ilk günden ortak.** v1 ile v2 arasındaki fark yalnızca *frame kaynağı*dır: v1'de `HTMLVideoElement` → `texImage2D`, v2'de `VideoFrame` → `texImage2D`. Efekt shader'ları, transform, text/sticker, keyframe interpolasyonu — hepsi tek WebGL pipeline'da yaşar ve v2'ye aynen taşınır. Bu, "v1'i çöpe atma" riskini ortadan kaldırır.

### 4.2 Aşama v1: `<video>` havuzu + WebGL kompozisyon (MVP'nin oynatma motoru)

- **Video kaynağı:** track başına (aynı anda aktif video clip başına) bir gizli `<video>` elementi havuzu (pool, max ~4). Clip değişiminden ~1 s önce sonraki clip'in elementi `preload` + `currentTime` ile hazırlanır (double-buffering) → kesim noktasında takılma yok.
- **Kompozisyon:** `requestAnimationFrame` döngüsünde her aktif video elementinden `texImage2D` ile texture güncelle → track sırasına göre (alt track önce) quad'lar çiz: transform (normalize koordinat → NDC), opacity blend, efekt shader zinciri (colorAdjust tek uber-shader: brightness/contrast/saturation/temperature; LUT 3D texture).
- **Frame-accurate seek:** durmuşken `seek(t, {precise:true})` → `video.currentTime = sourceTime` set edilir, `requestVideoFrameCallback` ile gelen frame'in `mediaTime`'ı hedefle karşılaştırılır; kısa GOP proxy (öneri: **GOP 30 / 1 s, H.264 High, CRF 23, 960x540 veya 1280x720**) sayesinde seek gecikmesi ~1 GOP decode. `<video>` seek'i çoğu Chromium sürümünde frame-exact'e çok yakındır; ±1 frame sapma v1'de kabul edilir ve UI "önizleme hassasiyeti" olarak belgelenir.
- **Scrub:** sürükleme sırasında `precise:false` → `video.fastSeek` benzeri davranış (currentTime spam'i throttle edilir, son istenen zaman kazanır).
- **Ses:** her video elementi `MediaElementAudioSourceNode` ile Web Audio grafiğine bağlanır → clip başına `GainNode` (volume + fade'ler `AudioParam.setValueCurveAtTime` ile) → master `GainNode` → destination. Detached/ayrı audio clip'leri için ayrı `<audio>` elementleri aynı grafiğe.
- **A/V senkron ve clock:** master clock = `AudioContext.currentTime` türevi monotonic saat. Her rAF'ta beklenen `sourceTime` ile `video.currentTime` farkı > 50 ms ise video yeniden hizalanır (küçük farklar playbackRate ±%2 nudge ile eritilir). Kesimler arası ses tıkırtısı: kesim noktasında 5 ms micro-fade.
- **Text/sticker/shape:** metin Canvas2D offscreen'e rasterize edilir → texture (font yüklenince invalidate; `document.fonts.ready`). Editing modunda WYSIWYG DOM overlay (contenteditable) player üstünde konumlanır; blur olunca rasterize edilip texture'a döner. Sticker PNG/WebP doğrudan texture.
- **Geçiş önizlemesi:** iki video elementi aynı anda decode ederken shader'da mix (crossfade/wipe) — pool bu yüzden min 2+2.
- **v1'in bilinen sınırları:** reverse playback yok; 3+ eşzamanlı video katmanında düşük donanımda frame drop; speed != 1 clip'lerde `playbackRate` 0.0625–16 aralığıyla sınırlı ve pitch düzeltmesi tarayıcıya bağlı.

### 4.3 Aşama v2: WebCodecs pipeline (M4+)

- **Demux:** `mp4box.js` (worker içinde) → fMP4 sample'ları `EncodedVideoChunk`/`EncodedAudioChunk`.
- **Video decode:** aktif clip başına bir `VideoDecoder` (worker'da). Frame-accurate seek: hedeften önceki keyframe'e git, oraya kadar decode edip `VideoFrame.close()` ile at, hedef frame'i teslim et — 1 s GOP proxy'de en kötü 30 frame decode (~<100 ms). **Her `VideoFrame` mutlaka `close()`** — aksi halde decoder stall (en sık yapılan hata).
- **Kompozisyon:** aynı WebGL2 kompozitör, kaynak `VideoFrame`. İleride WebGPU'ya geçiş kompozitör arkasında saklanır.
- **Ses:** `AudioDecoder` → PCM → AudioWorklet içinde miks (SharedArrayBuffer ring buffer; COOP/COEP header'ları gerekir — Vite konfiginde hazır). Master clock = worklet'in tükettiği sample sayısı → gerçek sample-accurate senkron.
- **Kazanımlar:** gerçek frame-accurate her koşulda, reverse playback, garantili çok katman performansı, decode'un main thread'den tamamen çıkması.
- **Geçiş stratejisi:** `PlaybackEngine` implementasyonu feature flag ile seçilir; v2 önce yalnız "precise seek + tek katman" için devreye alınır (hibrit: oynatma v1, duraklı frame gösterimi v2), sonra tam oynatma.

**Net öneri:** M1–M3 boyunca v1 ile ürünleş; v2'yi M4'te hibrit başlat. Kompozitör ortak olduğu için efekt/keyframe/text işleri hiçbir aşamada bloklanmaz.

---

## 5. Proje Yapısı, Kütüphaneler, Vite

### 5.1 Monorepo düzeni (pnpm workspaces)

```
/packages
  /timeline-schema        # zod şemaları + tipler + invariant validator + JSON Schema çıktısı
                          # (CI'da json-schema üret → backend NJsonSchema ile C# DTO)
/apps
  /editor                 # Vite + React SPA
    /src
      /app                # routing, providers, auth guard
      /entities           # asset, project API tipleri + react-query hooks
      /features
        /timeline         # canvas timeline
          /render         # drawClip, drawWaveform, drawFilmstrip, drawRuler
          /interactions   # dragMove, trim, marquee, snapping, dnd
          /hitTest.ts
        /player           # PlaybackEngine arayüzü
          /engine-video   # v1: <video> pool + sync
          /engine-webcodecs # v2 (M4)
          /compositor     # WebGL2: shaders/, textRaster.ts, lut.ts (ORTAK)
          /audio          # WebAudio graph, fades
        /inspector        # seçili clip özellik paneli, keyframe editörü
        /library          # medya havuzu, upload (multipart→R2 presigned)
        /history          # undo panel UI
      /state              # docStore, editorStore, assetStore, transactions.ts, autosave.ts
      /lib                # time.ts (µs<->frame<->timecode, rational), geometry, easing
      /workers            # demux.worker.ts, decode.worker.ts (v2)
```

### 5.2 Kütüphaneler (2026 başı itibarıyla güncel majörler; kurulumda `npm view <pkg> version` ile teyit edin)

| Amaç | Paket | Not |
|---|---|---|
| UI | `react@19`, `react-dom@19` | |
| Build | `vite@7`, `typescript@5.x` | |
| State | `zustand@5` + `immer@10` | patch history için `produceWithPatches` |
| Şema | `zod@4` | JSON Schema üretimi built-in |
| Server cache | `@tanstack/react-query@5` | asset/proje API |
| WebGL yardımcı | `twgl.js` | ince sarmalayıcı; pixi/three GEREKMEZ (kendi kompozitörümüz küçük) |
| Demux (v2) | `mp4box` (mp4box.js) | worker'da |
| Worker RPC | `comlink` | |
| UI kit | `radix-ui` primitives + Tailwind v4 (veya shadcn/ui) | panel/menu/dialog |
| Sanallaştırma | gerekmez (canvas kendi virtualization'ı) | |
| Test | `vitest@3`, `@playwright/test` | time.ts ve invariant'lar %100 birim test |

Bilinçli olarak **kullanılmayanlar:** `wavesurfer.js` (kendi peaks çizimimiz), `dnd-kit` (canvas uyumsuz), `redux` (gereksiz tören), `remotion` (farklı problem).

### 5.3 Vite konfig özeti

```ts
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  server: {
    headers: { // v2 SharedArrayBuffer + AudioWorklet için şimdiden
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      // DİKKAT: COEP açıkken R2'den gelen medya CORS'lu servis edilmeli
      // (R2 bucket CORS + <video crossorigin="anonymous">), yoksa yüklenmez.
    },
    proxy: { '/api': 'http://localhost:5000' },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
});
```

---

## 6. Fazlar / Milestone'lar

- **M0 (hafta 1-2):** `timeline-schema` paketi + invariant validator + `time.ts` (rational/timecode, tam test kapsamı); docStore + transaction/undo altyapısı; JSON Schema → C# codegen hattı backend ile el sıkışması.
- **M1 (hafta 3-5):** Timeline canvas: ruler, clip blokları, zoom/pan, playhead; move/trim/split/delete + snapping + undo; asset library + drag-drop; autosave.
- **M2 (hafta 6-8):** Player v1: WebGL kompozitör + `<video>` pool, play/pause/seek/frame-step, Web Audio miks + fade, filmstrip + waveform çizimi, klavye haritası tamamı.
- **M3 (hafta 9-11):** Transform gizmo'ları (player üstünde), keyframe editörü + easing, colorAdjust/LUT efektleri, text/sticker/shape + WYSIWYG, geçişler, speed, ripple/roll trim, history paneli.
- **M4 (hafta 12+):** WebCodecs engine hibrit (precise seek), sonra tam oynatma; performans sertleştirme; export önizleme/orijinal karşılaştırma testleri (aynı doc → export edilen kare ile önizleme karesinin piksel karşılaştırması, CI'da golden test).

## 7. Bilinen Tuzaklar

1. **Önizleme ≠ export kayması:** yuvarlama kuralları (§1.1) iki tarafta birebir aynı uygulanmazsa 1-frame kaymalar. Golden-frame CI testi şart.
2. **VFR kaynaklar:** proxy CFR normalizasyonu yapılmazsa frame-step ve waveform hizası kayar — backend sözleşmesine eklendi.
3. **`VideoFrame.close()` unutulması (v2):** decoder sessizce stall olur; frame havuzu + lint-benzeri runtime sayaç koy.
4. **COEP + R2 CORS:** `require-corp` açıkken bucket CORS'u ve `crossorigin` attribute'ları eksikse tüm medya kırılır; M0'da smoke test.
5. **`<video>` seek toleransı:** bazı sürümlerde `currentTime` en yakın frame'e yuvarlanır; `requestVideoFrameCallback.mediaTime` ile doğrula, körlemesine güvenme.
6. **Autosave vs undo yarışları:** save uçuştayken yeni mutasyon → revision çakışması; tek kuyruklu save (in-flight varken bekle, en son snapshot kazanır).
7. **Keyframe + split etkileşimi:** bölme anında interpolasyonlu değer yazılmazsa görsel sıçrama.
8. **Text rasterizasyonunda font yüklenme yarışı:** fallback fontla rasterize edilip cache'lenirse yanlış görüntü kalır — `document.fonts` event'inde texture invalidation.
9. **Bellek:** filmstrip sprite'ları + waveform'lar sınırsız cache'lenirse 2 GB'lık projede sekme çöker; LRU (örn. 300 MB) zorunlu.
10. **Kısayol/IME çakışması:** text editing sırasında C/S/M gibi tek tuş kısayolları mutlaka bastırılmalı (merkezi dispatcher context'i).
11. **Zustand'da devasa doc'un naive selector'ları:** her mutasyonda tüm timeline re-render — selector'lar track/clip id bazlı granüler olmalı; canvas zaten React dışı çizdiği için ana gövde etkilenmez, panel'ler için geçerli.
12. **Concurrent `<video>` decode limiti:** düşük donanımda 4+ eşzamanlı H.264 decode donar; pool boyutunu `navigator.hardwareConcurrency`'ye göre kıs, gerekirse gizli katmanların elementlerini duraklat.