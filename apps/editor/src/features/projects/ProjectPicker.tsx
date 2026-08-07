/**
 * ProjectPicker — activeProjectId null iken editör grid'i YERİNE render edilen
 * tam ekran proje seçici (modal değil, ana içerik):
 * - proje listesi (ad + son değişiklik; tıkla -> aç),
 * - "Yeni proje": ad gir + oluştur -> doğrudan aç.
 *
 * Açma = openProjectInEditor (editorStore.setActiveProjectId + ?project= URL
 * senkronu); dokümanı EditorBoot/projectSession yükler.
 */
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../entities/apiClient';
import { problemDetailsMessage } from '../../entities/problemDetails';
import { logout } from '../../entities/auth';
import {
  createProject,
  projectsListQueryKey,
  useProjectsList,
  type ProjectSummaryDto,
} from '../../entities/projects';
import {
  formatUpdatedAt,
  openProjectInEditor,
  validateProjectName,
} from './projectPickerLogic';

export function ProjectPicker() {
  const projectsQuery = useProjectsList();

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-surface-0 text-fg">
      <header className="flex items-center gap-2 border-b border-edge bg-surface-2 px-4 py-2">
        <span className="text-sm font-semibold">VideoEdit</span>
        <span className="text-xs text-fg-muted">Projeler</span>
        <button
          type="button"
          className="ml-auto rounded border border-edge px-2.5 py-1 text-xs text-fg-muted hover:bg-surface-3 hover:text-fg"
          onClick={() => {
            void logout().then(() => window.location.reload());
          }}
        >
          Çıkış yap
        </button>
      </header>

      <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">
        <h1 className="text-lg font-semibold">Projeler</h1>
        <p className="mt-1 text-xs text-fg-muted">
          Bir proje seçin veya yeni bir proje oluşturun. Adres çubuğundaki{' '}
          <code className="rounded bg-surface-2 px-1">?project=</code> bağlantısı paylaşılabilir.
        </p>

        <CreateProjectForm />
        <ProjectList query={projectsQuery} />
      </div>
    </div>
  );
}

function CreateProjectForm() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    const validation = validateProjectName(name);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createProject(validation.name);
      // Liste bir dahaki seçici açılışında taze olsun (açılış beklemez).
      void queryClient.invalidateQueries({ queryKey: projectsListQueryKey });
      openProjectInEditor(created.id);
    } catch (err) {
      const detail = err instanceof ApiError ? problemDetailsMessage(err.body) : null;
      setError(detail ?? 'Proje oluşturulamadı — sunucuya ulaşılamıyor.');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-6 rounded-lg border border-edge bg-surface-1 p-4">
      <h2 className="text-sm font-semibold">Yeni proje</h2>
      <div className="mt-2 flex gap-2">
        <input
          className="min-w-0 flex-1 rounded border border-edge bg-surface-2 px-3 py-2 text-sm"
          placeholder="Proje adı"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="project-name-input"
        />
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded bg-accent px-4 py-2 text-sm font-semibold text-surface-0 hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
          data-testid="project-create-button"
        >
          {busy ? 'Oluşturuluyor…' : 'Oluştur'}
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-fg-muted">1080p · 30 fps · 48 kHz (varsayılan ayarlar)</p>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </form>
  );
}

function ProjectList({ query }: { query: ReturnType<typeof useProjectsList> }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        Mevcut projeler
        {query.data && (
          <span className="rounded-full bg-surface-3 px-1.5 py-px text-[10px] font-semibold text-fg-muted">
            {query.data.totalCount}
          </span>
        )}
      </h2>

      {query.isLoading && <p className="py-2 text-xs text-fg-muted">Projeler yükleniyor…</p>}
      {query.isError && (
        <div className="flex items-center gap-2 py-2 text-xs text-danger">
          <span>Projeler yüklenemedi.</span>
          <button
            type="button"
            className="rounded border border-edge px-2 py-0.5 text-fg-muted hover:bg-surface-3 hover:text-fg"
            onClick={() => void query.refetch()}
          >
            Tekrar dene
          </button>
        </div>
      )}
      {query.isSuccess && query.data.items.length === 0 && (
        <p className="py-2 text-xs text-fg-muted">Henüz proje yok — yukarıdan ilk projenizi oluşturun.</p>
      )}

      <ul className="flex flex-col gap-1.5">
        {(query.data?.items ?? []).map((p) => (
          <li key={p.id}>
            <ProjectRow project={p} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProjectRow({ project }: { project: ProjectSummaryDto }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded border border-edge bg-surface-1 px-3 py-2.5 text-left hover:bg-surface-3"
      onClick={() => openProjectInEditor(project.id)}
      data-testid={`project-row-${project.id}`}
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={project.name}>
        {project.name}
      </span>
      <span className="shrink-0 text-[11px] text-fg-muted">
        Son değişiklik: {formatUpdatedAt(project.updatedAt)}
      </span>
    </button>
  );
}
