/**
 * AssetDeleteDialog — medya silme onayı.
 *
 * Akış (M6): silmeden ÖNCE GET /api/assets/{id}/usage sorulur; kullanımdaysa
 * kaç projede kaç klipte olduğu YAZILIR ve onay düğmesi "yine de sil" olur.
 * Kullanım sorgusu bitmeden silme düğmesi ETKİN DEĞİLDİR — "bozulacak mı?"
 * sorusunun yanıtını görmeden basılan bir onay, onay değildir.
 *
 * Silme başarısızsa dialog AÇIK kalır ve hatayı gösterir: sessizce kapanıp
 * listede duran medyayı "silinmiş" sanmak en kötü sonuç olurdu.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryClient } from '../../app/queryClient';
import { ApiError } from '../../entities/apiClient';
import { problemDetailsMessage } from '../../entities/problemDetails';
import {
  deleteAsset,
  getAssetUsage,
  projectAssetsQueryKey,
  quotaQueryKey,
  type AssetDto,
} from '../../entities/assets';
import { summarizeAssetUsage } from './assetUsage';
import { forgetAsset } from './missingMedia';
import { formatBytes } from './format';

export interface AssetDeleteDialogProps {
  asset: AssetDto;
  projectId: string;
  onClose(): void;
}

export function AssetDeleteDialog({ asset, projectId, onClose }: AssetDeleteDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const usageQuery = useQuery({
    queryKey: ['assets', asset.id, 'usage'] as const,
    queryFn: () => getAssetUsage(asset.id),
    // Kullanım anlık bir sorudur: dialog her açıldığında taze sorulur.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Escape kapatır (silme sürerken değil — istek uçuşta iken kapatmak
  // kullanıcıya sonucu göstermeden bırakırdı). Capture: global kısayol
  // dispatcher'ına sızmasın.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || deleting) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, deleting]);

  const summary = usageQuery.data ? summarizeAssetUsage(usageQuery.data, asset.kind) : null;

  const confirm = async (): Promise<void> => {
    setDeleting(true);
    setError(null);
    try {
      await deleteAsset(asset.id);
      // Önce yerel gerçeği güncelle (asset haritadan ve "bilinen" damgasından
      // düşer -> timeline'daki klipler ANINDA "medya eksik" olur), sonra
      // sunucu listesini ve kota göstergesini tazele.
      forgetAsset(asset.id);
      void queryClient.invalidateQueries({ queryKey: projectAssetsQueryKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: quotaQueryKey });
      onClose();
    } catch (err) {
      const detail = err instanceof ApiError ? problemDetailsMessage(err.body) : null;
      setError(detail ?? (err instanceof Error ? err.message : String(err)));
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      data-testid="asset-delete-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !deleting) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Medyayı sil"
        data-testid="asset-delete-dialog"
        className="w-full max-w-sm rounded-md border border-edge bg-surface-2 p-4 shadow-xl"
      >
        <h2 className="text-sm font-semibold text-fg">Medyayı sil</h2>
        <p className="mt-1 truncate text-xs text-fg-muted" title={asset.fileName}>
          {asset.fileName} · {formatBytes(asset.sizeBytes)}
        </p>

        <div className="mt-3 min-h-[2.5rem] text-xs">
          {usageQuery.isPending && (
            <p className="text-fg-muted" data-testid="asset-delete-usage-loading">
              Kullanım kontrol ediliyor…
            </p>
          )}
          {usageQuery.isError && (
            <div className="rounded border border-danger/40 bg-danger/10 px-2 py-1.5">
              <p className="text-danger">Kullanım bilgisi alınamadı.</p>
              <button
                type="button"
                className="mt-1 rounded border border-edge px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface-3 hover:text-fg"
                onClick={() => void usageQuery.refetch()}
              >
                Tekrar dene
              </button>
            </div>
          )}
          {summary !== null &&
            (summary.used ? (
              <div
                className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5"
                data-testid="asset-delete-usage-warning"
                role="alert"
              >
                <p className="font-semibold text-amber-400">{summary.warning}</p>
                <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-fg-muted">
                  {summary.projectLines.map((line) => (
                    <li key={line} className="truncate">
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-fg-muted" data-testid="asset-delete-usage-unused">
                Bu medya hiçbir projede kullanılmıyor. Silinsin mi?
              </p>
            ))}
        </div>

        {error !== null && (
          <p
            role="alert"
            data-testid="asset-delete-error"
            className="mt-2 text-[11px] leading-snug break-words text-danger"
          >
            Silinemedi: {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            data-testid="asset-delete-cancel"
            disabled={deleting}
            className="rounded border border-edge px-3 py-1 text-xs text-fg-muted hover:bg-surface-3 hover:text-fg disabled:opacity-50"
            onClick={onClose}
          >
            Vazgeç
          </button>
          <button
            type="button"
            data-testid="asset-delete-confirm"
            // Kullanım yanıtı gelmeden onay YOK: uyarıyı görmeden verilen onay
            // bilinçli bir karar değildir.
            disabled={deleting || summary === null}
            className="rounded bg-danger px-3 py-1 text-xs font-semibold text-surface-0 hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
            onClick={() => void confirm()}
          >
            {deleting ? 'Siliniyor…' : summary?.used ? 'Yine de sil' : 'Sil'}
          </button>
        </div>
      </div>
    </div>
  );
}
