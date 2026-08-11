/**
 * projects — testlerin KENDİ projesini kurması için ince API yardımcıları.
 *
 * Her spec kendi projesini seed eder (testler birbirinin dokümanını bozamaz).
 * fixtures/seed.ts iki KLİPLİ bir doküman kurar (timeline etkileşimleri için);
 * burada gereken ise TERSİ: gerçek medya akışlarının başlayacağı, klipsiz ama
 * bir video track'i olan proje.
 *
 * Neden boş bir track var: sunucunun oluşturduğu proje SIFIR track'lidir
 * (backend EmptyTimeline), appBridge canlılık kontrolü ise dokümanda en az bir
 * track görmek ister (support/appBridge.ts). Kullanıcının editörde gördüğü ilk
 * hal de zaten "+V ile açılmış bir track"tir.
 */
import type { APIRequestContext } from '@playwright/test';
import { createProject, saveTimeline } from '../fixtures/seed';

export interface ProjectFixture {
  projectId: string;
  projectName: string;
  /** Boş video track'inin id'si (klip eklendiğinde buraya düşer). */
  trackId: string;
}

/** Şema-geçerli, tek boş video track'li doküman. */
export function emptyVideoTrackDoc(projectId: string, trackId: string): unknown {
  return {
    schemaVersion: 1,
    projectId,
    settings: {
      width: 1920,
      height: 1080,
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      backgroundColor: '#000000',
    },
    tracks: [
      {
        id: trackId,
        type: 'video',
        name: 'V1',
        muted: false,
        hidden: false,
        locked: false,
        clips: [],
      },
    ],
    markers: [],
  };
}

export async function createEmptyProject(
  request: APIRequestContext,
  accessToken: string,
  label: string,
): Promise<ProjectFixture> {
  const projectName = `${label} ${Date.now().toString(36)}`;
  const project = await createProject(request, accessToken, projectName);
  const trackId = crypto.randomUUID();
  await saveTimeline(
    request,
    accessToken,
    project.id,
    emptyVideoTrackDoc(project.id, trackId),
    project.revisionNumber,
  );
  return { projectId: project.id, projectName, trackId };
}
