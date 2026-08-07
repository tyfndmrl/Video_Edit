/**
 * projectPickerLogic — ProjectPicker'ın DOM'suz test edilebilir çekirdeği:
 * liste -> seçim akışı (store + URL senkronu) ve yeni-proje ad doğrulaması.
 *
 * ?project=<id> paylaşılabilir RESMİ derin bağlantıdır (editorStore
 * initialProjectId bunu okur); seçim/kapama history.replaceState ile parametreyi
 * günceller ki adres çubuğu her an kopyalanabilir kalsın.
 */
import type { Uuid } from '@videoedit/timeline-schema';
import { useEditorStore } from '../../state/editorStore';

/** Mevcut query string'e ?project= parametresini yazar/siler (saf — test edilir). */
export function projectSearchString(search: string, projectId: string | null): string {
  const params = new URLSearchParams(search);
  if (projectId === null) params.delete('project');
  else params.set('project', projectId);
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** ?project= parametresini adres çubuğuna yazar (yeni history girdisi yaratmadan). */
function syncProjectUrl(projectId: string | null): void {
  if (typeof window === 'undefined' || typeof history === 'undefined') return;
  const search = projectSearchString(window.location.search, projectId);
  history.replaceState(null, '', `${window.location.pathname}${search}${window.location.hash}`);
}

/**
 * Seçiciden proje açma: activeProjectId set edilir (EditorBoot openProject'i
 * tetikler) ve URL derin bağlantısı güncellenir.
 */
export function openProjectInEditor(projectId: Uuid): void {
  useEditorStore.getState().setActiveProjectId(projectId);
  syncProjectUrl(projectId);
}

/**
 * Seçiciye dönüş (TopBar "Projeler"): activeProjectId null'a çekilir —
 * EditorBoot closeProject() çağırır (autosave dispose-flush orada) — ve
 * URL'den ?project= temizlenir.
 */
export function returnToProjectPicker(): void {
  useEditorStore.getState().setActiveProjectId(null);
  syncProjectUrl(null);
}

export type ProjectNameValidation = { ok: true; name: string } | { ok: false; error: string };

/** Backend kuralıyla aynı sınır: 1..200 karakter (trim sonrası). */
export const PROJECT_NAME_MAX_LENGTH = 200;

export function validateProjectName(raw: string): ProjectNameValidation {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, error: 'Proje adı boş olamaz.' };
  if (name.length > PROJECT_NAME_MAX_LENGTH) {
    return { ok: false, error: `Proje adı en fazla ${PROJECT_NAME_MAX_LENGTH} karakter olabilir.` };
  }
  return { ok: true, name };
}

/** Liste satırındaki "son değişiklik" metni; bozuk tarih '—' olur. */
export function formatUpdatedAt(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
