/**
 * previewSource — which presigned URL the PREVIEW decodes for an asset.
 *
 * This is not a detail: picking the wrong field is invisible in every store and
 * shows up only as a black canvas.
 *
 * The rule is kind-dependent because the DERIVATIVES are kind-dependent
 * (backend VideoEdit.Worker/Jobs/ProcessAssetJob.cs):
 *
 *  - video / audio -> `proxy`. ProcessVideoAsync / ProcessAudioAsync transcode a
 *    seek-friendly proxy exactly so the <video> pool can scrub it.
 *  - image         -> `poster`. ProcessImageAsync writes ONLY a poster
 *    ("Image için proxy ÜRETİLMEZ") — asking for `proxy` here yields null, the
 *    image texture path bails out on the missing URL (engineV1.imageDrawItem)
 *    and the user who just added a photo sees nothing at all. The export was
 *    always correct, which is what made this a silent preview-only failure.
 *
 * Why the POSTER and not the original file (the cheap, correct option):
 *  - it already exists for every ready image — no worker change, no second
 *    derivative, no extra storage;
 *  - PosterRecipe.BuildImageArgs keeps the source aspect, caps the width at
 *    1280 px and re-encodes as JPEG q=4, so it is a preview-sized texture
 *    instead of a 40 MP upload pushed through GPU upload every load;
 *  - it runs the SAME ColorChain tonemap the proxy/export path uses for HDR
 *    sources, so an HDR photo previews in the SDR the export will produce.
 * The width cap costs a little sharpness at 1080p; the aspect ratio — the only
 * thing rendering-semantics §2.2 fit=contain actually consumes — is preserved.
 *
 * Stickers need no case of their own: a sticker clip references an IMAGE asset
 * (engineV1 routes both through imageDrawItem), and this function dispatches on
 * the asset kind, not the clip kind.
 */
import type { AssetSummary } from '../../state/assetStore';

/** The fields the decision actually reads (keeps tests from building whole assets). */
export type PreviewSourceAsset = Pick<
  AssetSummary,
  'kind' | 'status' | 'proxyUrl' | 'posterUrl' | 'originalUrl'
>;

/**
 * Which media-urls FIELD an asset's preview reads — the kind rule above, as
 * data. The names are the media-urls response field names (`AssetMediaUrls
 * .proxy` / `.poster` / `.original`), which is what lets mediaUrls' "is a
 * ready asset still missing its url" check share THIS rule instead of copying
 * it: a proxy-only check there counted every ready image as permanently
 * url-less (the worker never writes a proxy for a still) and re-fetched
 * /media-urls every 5 s for as long as the tab lived.
 *
 * 'lut' -> 'original': a .cube has NO derivative at all (the worker validates
 * the text and stops), and what the preview needs is the raw table itself —
 * the WebGL loader fetches this URL, parses it and uploads the 3D texture.
 */
export function previewDerivative(
  kind: PreviewSourceAsset['kind'],
): 'poster' | 'proxy' | 'original' {
  if (kind === 'lut') return 'original';
  return kind === 'image' ? 'poster' : 'proxy';
}

/**
 * Presigned URL the preview engine should decode for `asset`, or null when
 * there is nothing (yet) to decode. Never returns a URL for an asset that is
 * not `ready`: the derivatives do not exist before then (and a LUT's table
 * has not passed validation before then either).
 */
export function previewSourceUrl(asset: PreviewSourceAsset): string | null {
  if (asset.status !== 'ready') return null;
  const field = previewDerivative(asset.kind);
  const url =
    field === 'poster' ? asset.posterUrl : field === 'original' ? asset.originalUrl : asset.proxyUrl;
  return url ?? null;
}
