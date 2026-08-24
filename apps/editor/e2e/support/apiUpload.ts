/**
 * apiUpload — bir medya dosyasını REST sözleşmesi üzerinden yükler ve worker
 * "ready" diyene kadar bekler (scripts/seed-demo.ps1 ile aynı uçlar):
 *
 *   POST /api/projects/{projectId}/assets   (init)
 *   POST /api/assets/{id}/parts/presign     (imzalı PUT adresi)
 *   PUT  <presigned url>                    (bayt -> MinIO/R2, API'den geçmez)
 *   POST /api/assets/{id}/complete          (işleme kuyruğa girer)
 *   GET  /api/assets/{id}                   (status: ready olana kadar)
 *
 * NE ZAMAN KULLANILIR: iddiası UI ETKİLEŞİMİ OLMAYAN ama gerçek türevlere
 * (worker'ın ürettiği proxy/poster) ihtiyaç duyan ölçüm testleri
 * (audio-parity.spec.ts). "Dosya seç" düğmesinin/kitaplık panelinin çalıştığı
 * iddiası bu yardımcıyla KURULAMAZ — o iddia gerçek dosya seçici isteyen
 * LibraryPanelHarness.pickFiles'ındır (review-gate kural 3).
 *
 * Tek part'lık (< 64 MiB) dosyalar içindir; büyük dosya gelirse sessizce
 * yanlış yüklemek yerine açıkça reddeder (üretim yükleyicisi uploadEngine.ts'tir).
 */
import { readFileSync } from 'node:fs';
import type { APIRequestContext } from '@playwright/test';

interface InitResponse {
  assetId: string;
  partSize: number;
  partCount: number;
}

interface AssetStatusResponse {
  status: string;
  errorCode?: string | null;
}

export interface UploadedAsset {
  assetId: string;
  fileName: string;
}

export async function uploadAssetViaApi(
  request: APIRequestContext,
  accessToken: string,
  projectId: string,
  filePath: string,
  fileName: string,
  contentType: string,
): Promise<UploadedAsset> {
  const bytes = readFileSync(filePath);
  const auth = { Authorization: `Bearer ${accessToken}` };

  const initRes = await request.post(`/api/projects/${projectId}/assets`, {
    headers: auth,
    data: { fileName, contentType, sizeBytes: bytes.byteLength },
  });
  if (!initRes.ok()) {
    throw new Error(`init başarısız (HTTP ${initRes.status()}): ${await initRes.text()}`);
  }
  const init = (await initRes.json()) as InitResponse;
  if (init.partCount !== 1) {
    throw new Error(
      `${fileName} ${init.partCount} part gerektiriyor — bu yardımcı yalnız tek part'lık ` +
        'test dosyaları içindir (üretim yolu: uploadEngine.ts).',
    );
  }

  const presignRes = await request.post(`/api/assets/${init.assetId}/parts/presign`, {
    headers: auth,
    data: { partNumbers: [1] },
  });
  if (!presignRes.ok()) {
    throw new Error(`presign başarısız (HTTP ${presignRes.status()}): ${await presignRes.text()}`);
  }
  const presigned = (await presignRes.json()) as { url: string }[];
  const putUrl = presigned[0]?.url;
  if (!putUrl) throw new Error('presign yanıtında url yok.');

  // İmzalı PUT: Authorization başlığı BİLEREK yok (imza sorgu dizisindedir).
  const putRes = await request.put(putUrl, {
    data: bytes,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!putRes.ok()) {
    throw new Error(`depolamaya PUT başarısız (HTTP ${putRes.status()}).`);
  }
  const etag = (putRes.headers()['etag'] ?? '').replaceAll('"', '');
  if (!etag) throw new Error('Depolama ETag döndürmedi — multipart tamamlanamaz.');

  const completeRes = await request.post(`/api/assets/${init.assetId}/complete`, {
    headers: auth,
    data: { parts: [{ partNumber: 1, etag }] },
  });
  if (!completeRes.ok()) {
    throw new Error(`complete başarısız (HTTP ${completeRes.status()}): ${await completeRes.text()}`);
  }

  return { assetId: init.assetId, fileName };
}

/** Asset "ready" olana kadar bekler; "failed" anında tipli hatayla düşer. */
export async function waitAssetReady(
  request: APIRequestContext,
  accessToken: string,
  assetId: string,
  fileName: string,
  timeoutMs = 180_000,
): Promise<void> {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const res = await request.get(`/api/assets/${assetId}`, { headers: auth });
    if (res.ok()) {
      const body = (await res.json()) as AssetStatusResponse;
      last = body.status;
      if (last === 'ready') return;
      if (last === 'failed') {
        throw new Error(`${fileName} sunucuda BAŞARISIZ oldu (errorCode: ${String(body.errorCode)}).`);
      }
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `${fileName} ${timeoutMs / 1000} sn içinde hazır olmadı (son durum: ${last}). Worker ayakta mı?`,
  );
}

/** Bir projenin media-urls yanıtından asset başına PROXY presigned URL'leri. */
export async function fetchProxyUrls(
  request: APIRequestContext,
  accessToken: string,
  projectId: string,
): Promise<Record<string, string>> {
  const res = await request.get(`/api/projects/${projectId}/media-urls`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok()) {
    throw new Error(`media-urls başarısız (HTTP ${res.status()}): ${await res.text()}`);
  }
  const body = (await res.json()) as { assets: Record<string, { proxy?: string | null }> };
  const out: Record<string, string> = {};
  for (const [id, urls] of Object.entries(body.assets)) {
    if (urls.proxy) out[id] = urls.proxy;
  }
  return out;
}
