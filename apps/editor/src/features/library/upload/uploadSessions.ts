/**
 * uploadSessions — IndexedDB records of in-progress multipart uploads.
 *
 * The file CONTENT is never copied into IndexedDB (1–2 GB); only enough
 * metadata to (a) detect half-finished uploads on startup and (b) re-match the
 * file when the user re-picks it. Full browser-restart resume (File System
 * Access API handle + ListParts sync) lands in M6 — for M1 we persist the
 * session and surface a "pending uploads" badge in the library.
 *
 * Server-side, incomplete multipart uploads are swept after 7 days (bucket
 * lifecycle), which bounds how long these records stay meaningful.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface UploadSessionRecord {
  /** Server asset id — primary key. */
  assetId: string;
  projectId: string;
  fileName: string;
  fileSize: number;
  /** File.lastModified — used with name+size to re-match a re-picked file. */
  lastModified: number;
  partSize: number;
  createdAt: number;
  updatedAt: number;
}

interface UploadSessionsDbSchema extends DBSchema {
  uploadSessions: {
    key: string;
    value: UploadSessionRecord;
    indexes: { byProject: string };
  };
}

const DB_NAME = 'videoedit-uploads';
const DB_VERSION = 1;
const STORE = 'uploadSessions';

let dbPromise: Promise<IDBPDatabase<UploadSessionsDbSchema>> | null = null;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function getDb(): Promise<IDBPDatabase<UploadSessionsDbSchema>> {
  if (!dbPromise) {
    const opening = openDB<UploadSessionsDbSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE, { keyPath: 'assetId' });
        store.createIndex('byProject', 'projectId');
      },
    });
    // A failed open (private mode, quota, corrupted DB, version conflict) must
    // not poison every later call with the same cached rejection — drop the
    // cache so the next call retries the open.
    opening.catch(() => {
      if (dbPromise === opening) dbPromise = null;
    });
    dbPromise = opening;
  }
  return dbPromise;
}

export async function saveUploadSession(record: UploadSessionRecord): Promise<void> {
  if (!hasIndexedDb()) return;
  const db = await getDb();
  await db.put(STORE, record);
}

export async function deleteUploadSession(assetId: string): Promise<void> {
  if (!hasIndexedDb()) return;
  const db = await getDb();
  await db.delete(STORE, assetId);
}

/** List sessions, optionally scoped to one project. Newest first. */
export async function listUploadSessions(projectId?: string): Promise<UploadSessionRecord[]> {
  if (!hasIndexedDb()) return [];
  const db = await getDb();
  const records =
    projectId === undefined
      ? await db.getAll(STORE)
      : await db.getAllFromIndex(STORE, 'byProject', projectId);
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getUploadSession(assetId: string): Promise<UploadSessionRecord | undefined> {
  if (!hasIndexedDb()) return undefined;
  const db = await getDb();
  return db.get(STORE, assetId);
}
