/**
 * ExportJobsCard — active/finished export jobs for the open project (M3).
 * Rendered as the "Dışa Aktarmalar" section of the Inspector panel.
 *
 * List comes from GET /api/projects/{id}/exports (newest first); while any job
 * is queued/running the query polls every 2 s (also in background tabs — same
 * interim pattern as useProjectAssets). Rows: status badge, progress bar
 * (percent + stage), Cancel for queued/running, download link when succeeded,
 * the backend `error` field when failed.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  cancelJob,
  isJobActive,
  projectExportsQueryKey,
  useProjectExports,
  type ExportJobDto,
} from '../../entities/exports';
import { clampPercent, stageLabel, statusBadgeClass, statusLabel } from './exportLogic';

export function ExportJobsCard({ projectId }: { projectId: string }) {
  const { data, isPending, isError } = useProjectExports(projectId);
  const jobs = data?.items ?? [];

  if (isPending) {
    return <p className="px-3 py-2 text-xs text-fg-muted">Yükleniyor…</p>;
  }
  if (isError) {
    return <p className="px-3 py-2 text-xs text-danger">Dışa aktarma listesi alınamadı.</p>;
  }
  if (jobs.length === 0) {
    return <p className="px-3 py-2 text-xs text-fg-muted">Henüz dışa aktarma yok.</p>;
  }

  return (
    <ul className="flex flex-col gap-1.5 px-3 py-2">
      {jobs.map((job) => (
        <ExportJobRow key={job.id} job={job} projectId={projectId} />
      ))}
    </ul>
  );
}

function ExportJobRow({ job, projectId }: { job: ExportJobDto; projectId: string }) {
  const queryClient = useQueryClient();
  const [canceling, setCanceling] = useState(false);
  const active = isJobActive(job.status);
  const percent = clampPercent(job.progressPercent);

  const onCancel = async (): Promise<void> => {
    if (canceling) return;
    setCanceling(true);
    try {
      await cancelJob(job.id);
    } catch {
      // A late cancel (job already terminal) is not worth an error state — the
      // refetch below shows the authoritative status either way.
    } finally {
      await queryClient.invalidateQueries({ queryKey: projectExportsQueryKey(projectId) });
      setCanceling(false);
    }
  };

  return (
    <li className="rounded border border-edge bg-surface-2 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${statusBadgeClass(job.status)}`}
        >
          {statusLabel(job.status)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-fg-muted" title={job.id}>
          {job.id}
        </span>
        {active && (
          <button
            type="button"
            disabled={canceling}
            className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-fg-muted hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-50"
            onClick={() => void onCancel()}
          >
            {canceling ? 'İptal ediliyor…' : 'İptal'}
          </button>
        )}
        {job.status === 'succeeded' && job.downloadUrl && (
          <a
            href={job.downloadUrl}
            download
            className="rounded bg-accent px-2 py-0.5 text-[10px] font-semibold text-surface-0 hover:opacity-90"
            title="24 saat geçerli indirme bağlantısı"
          >
            İndir
          </a>
        )}
      </div>

      {active && (
        <div className="mt-1.5">
          <div className="flex items-center justify-between text-[10px] text-fg-muted">
            <span>{stageLabel(job.progressStage)}</span>
            <span className="font-mono">%{percent}</span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3"
          >
            <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}

      {job.status === 'failed' && job.error && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-danger">{job.error}</p>
      )}
    </li>
  );
}
