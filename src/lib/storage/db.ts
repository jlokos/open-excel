import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { UserMessage } from "@mariozechner/pi-ai";
import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import { stripEnrichment } from "../message-utils";

export interface ChatSession {
  id: string;
  workbookId: string;
  name: string;
  agentMessages: AgentMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface VfsFile {
  id: string; // "{sessionId}:{path}" composite key
  sessionId: string;
  path: string;
  data: Uint8Array;
}

export interface SkillFile {
  id: string; // "{skillName}:{path}" composite key
  skillName: string;
  path: string; // relative path within skill folder, e.g. "SKILL.md"
  data: Uint8Array;
}

export interface StoredIndexBlock {
  blockId: string;
  sheetId: number;
  sheetName: string;
  range: string;
  descriptor: string;
  stats: Record<string, unknown>;
  vector: ArrayBuffer;
}

export interface WorkbookIndexRecord {
  workbookId: string;
  modelId: string;
  indexVersion: number;
  createdAt: number;
  updatedAt: number;
  blockCount: number;
  blocks: StoredIndexBlock[];
}

interface OpenExcelSchema extends DBSchema {
  sessions: {
    key: string;
    value: ChatSession;
    indexes: { workbookId: string; updatedAt: number };
  };
  vfsFiles: {
    key: string;
    value: VfsFile;
    indexes: { sessionId: string };
  };
  skillFiles: {
    key: string;
    value: SkillFile;
    indexes: { skillName: string };
  };
  workbookIndexes: {
    key: string;
    value: WorkbookIndexRecord;
    indexes: { updatedAt: number };
  };
}

let dbPromise: Promise<IDBPDatabase<OpenExcelSchema>> | null = null;
const DB_NAME = "OpenExcelDB_v3";
const MIN_DB_VERSION = 31;

function isVersionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "VersionError"
  );
}

function hasRequiredSchema(db: IDBPDatabase<OpenExcelSchema>): boolean {
  if (!db.objectStoreNames.contains("sessions")) return false;
  if (!db.objectStoreNames.contains("vfsFiles")) return false;
  if (!db.objectStoreNames.contains("skillFiles")) return false;
  if (!db.objectStoreNames.contains("workbookIndexes")) return false;

  const sessions = db.transaction("sessions", "readonly").store;
  if (!sessions.indexNames.contains("workbookId")) return false;
  if (!sessions.indexNames.contains("updatedAt")) return false;

  const vfsFiles = db.transaction("vfsFiles", "readonly").store;
  if (!vfsFiles.indexNames.contains("sessionId")) return false;

  const skillFiles = db.transaction("skillFiles", "readonly").store;
  if (!skillFiles.indexNames.contains("skillName")) return false;

  const workbookIndexes = db.transaction("workbookIndexes", "readonly").store;
  return workbookIndexes.indexNames.contains("updatedAt");
}

function openDbAtVersion(
  version: number,
): Promise<IDBPDatabase<OpenExcelSchema>> {
  return openDB<OpenExcelSchema>(DB_NAME, version, {
    upgrade(db, _oldVersion, _newVersion, transaction) {
      const sessions = db.objectStoreNames.contains("sessions")
        ? transaction.objectStore("sessions")
        : db.createObjectStore("sessions", { keyPath: "id" });
      if (!sessions.indexNames.contains("workbookId")) {
        sessions.createIndex("workbookId", "workbookId");
      }
      if (!sessions.indexNames.contains("updatedAt")) {
        sessions.createIndex("updatedAt", "updatedAt");
      }

      const vfsFiles = db.objectStoreNames.contains("vfsFiles")
        ? transaction.objectStore("vfsFiles")
        : db.createObjectStore("vfsFiles", { keyPath: "id" });
      if (!vfsFiles.indexNames.contains("sessionId")) {
        vfsFiles.createIndex("sessionId", "sessionId");
      }

      const skillFiles = db.objectStoreNames.contains("skillFiles")
        ? transaction.objectStore("skillFiles")
        : db.createObjectStore("skillFiles", { keyPath: "id" });
      if (!skillFiles.indexNames.contains("skillName")) {
        skillFiles.createIndex("skillName", "skillName");
      }

      const workbookIndexes = db.objectStoreNames.contains("workbookIndexes")
        ? transaction.objectStore("workbookIndexes")
        : db.createObjectStore("workbookIndexes", { keyPath: "workbookId" });
      if (!workbookIndexes.indexNames.contains("updatedAt")) {
        workbookIndexes.createIndex("updatedAt", "updatedAt");
      }
    },
  });
}

async function openDbWithFallback(): Promise<IDBPDatabase<OpenExcelSchema>> {
  try {
    // Dexie used version(3) which maps to IndexedDB version 30.
    // Open at >=31 to include workbookIndexes while preserving compatibility.
    return await openDbAtVersion(MIN_DB_VERSION);
  } catch (error) {
    if (!isVersionError(error)) {
      throw error;
    }

    console.warn(
      `[DB] ${DB_NAME} is at a higher version than ${MIN_DB_VERSION}. Retrying with existing version.`,
    );

    const existingDb = await openDB<OpenExcelSchema>(DB_NAME);
    if (hasRequiredSchema(existingDb)) {
      return existingDb;
    }

    const targetVersion = Math.max(MIN_DB_VERSION, existingDb.version + 1);
    existingDb.close();
    return openDbAtVersion(targetVersion);
  }
}

function getDb(): Promise<IDBPDatabase<OpenExcelSchema>> {
  if (!dbPromise) {
    dbPromise = openDbWithFallback().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

function extractUserText(msg: AgentMessage): string | null {
  if (msg.role !== "user") return null;
  const text = stripEnrichment((msg as UserMessage).content).trim();
  return text || null;
}

function deriveSessionName(agentMessages: AgentMessage[]): string | null {
  const firstUser = agentMessages.find((m) => m.role === "user");
  if (!firstUser) return null;
  const text = extractUserText(firstUser);
  if (!text) return null;
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

export function getSessionMessageCount(session: ChatSession): number {
  return (session.agentMessages ?? []).filter(
    (m) => m.role === "user" || m.role === "assistant",
  ).length;
}

export async function getOrCreateWorkbookId(): Promise<string> {
  return new Promise((resolve, reject) => {
    const settings = Office.context.document.settings;
    let workbookId = settings.get("openexcel-workbook-id") as string | null;

    if (workbookId) {
      resolve(workbookId);
      return;
    }

    workbookId = crypto.randomUUID();
    settings.set("openexcel-workbook-id", workbookId);
    settings.saveAsync((result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) {
        resolve(workbookId);
      } else {
        reject(
          new Error(result.error?.message ?? "Failed to save workbook ID"),
        );
      }
    });
  });
}

export async function listSessions(workbookId: string): Promise<ChatSession[]> {
  const db = await getDb();
  const sessions = await db.getAllFromIndex(
    "sessions",
    "workbookId",
    workbookId,
  );
  for (const s of sessions) {
    if (!s.agentMessages) s.agentMessages = [];
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

export async function createSession(
  workbookId: string,
  name?: string,
): Promise<ChatSession> {
  const db = await getDb();
  const now = Date.now();
  const session: ChatSession = {
    id: crypto.randomUUID(),
    workbookId,
    name: name ?? "New Chat",
    agentMessages: [],
    createdAt: now,
    updatedAt: now,
  };
  await db.add("sessions", session);
  return session;
}

export async function getSession(
  sessionId: string,
): Promise<ChatSession | undefined> {
  const db = await getDb();
  const session = await db.get("sessions", sessionId);
  if (session && !session.agentMessages) {
    session.agentMessages = [];
  }
  return session;
}

export async function saveSession(
  sessionId: string,
  agentMessages: AgentMessage[],
): Promise<void> {
  console.log(
    "[DB] saveSession:",
    sessionId,
    "agentMessages:",
    agentMessages.length,
  );
  const db = await getDb();
  const session = await db.get("sessions", sessionId);
  if (!session) {
    console.error("[DB] Session not found for save:", sessionId);
    return;
  }
  let name = session.name;
  if (name === "New Chat") {
    const derivedName = deriveSessionName(agentMessages);
    if (derivedName) name = derivedName;
  }
  await db.put("sessions", {
    ...session,
    agentMessages,
    name,
    updatedAt: Date.now(),
  });
  console.log("[DB] saveSession complete");
}

export async function renameSession(
  sessionId: string,
  name: string,
): Promise<void> {
  const db = await getDb();
  const session = await db.get("sessions", sessionId);
  if (session) {
    await db.put("sessions", { ...session, name });
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.delete("sessions", sessionId);
}

export async function getOrCreateCurrentSession(
  workbookId: string,
): Promise<ChatSession> {
  const sessions = await listSessions(workbookId);
  if (sessions.length > 0) {
    const session = sessions[0];
    if (!session.agentMessages) session.agentMessages = [];
    return session;
  }
  return createSession(workbookId);
}

export async function saveVfsFiles(
  sessionId: string,
  files: { path: string; data: Uint8Array }[],
): Promise<void> {
  console.log("[DB] saveVfsFiles:", sessionId, "files:", files.length);
  const db = await getDb();
  const tx = db.transaction("vfsFiles", "readwrite");
  const store = tx.store;
  const existing = await store.index("sessionId").getAllKeys(sessionId);
  for (const key of existing) {
    await store.delete(key);
  }
  for (const f of files) {
    await store.add({
      id: `${sessionId}:${f.path}`,
      sessionId,
      path: f.path,
      data: f.data,
    });
  }
  await tx.done;
}

export async function loadVfsFiles(
  sessionId: string,
): Promise<{ path: string; data: Uint8Array }[]> {
  const db = await getDb();
  const rows = await db.getAllFromIndex("vfsFiles", "sessionId", sessionId);
  console.log("[DB] loadVfsFiles:", sessionId, "files:", rows.length);
  return rows.map((r) => ({ path: r.path, data: r.data }));
}

export async function deleteVfsFiles(sessionId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("vfsFiles", "readwrite");
  const keys = await tx.store.index("sessionId").getAllKeys(sessionId);
  for (const key of keys) {
    await tx.store.delete(key);
  }
  await tx.done;
}

export async function saveSkillFiles(
  skillName: string,
  files: { path: string; data: Uint8Array }[],
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("skillFiles", "readwrite");
  const store = tx.store;
  const existing = await store.index("skillName").getAllKeys(skillName);
  for (const key of existing) {
    await store.delete(key);
  }
  for (const f of files) {
    await store.add({
      id: `${skillName}:${f.path}`,
      skillName,
      path: f.path,
      data: f.data,
    });
  }
  await tx.done;
}

export async function loadSkillFiles(
  skillName: string,
): Promise<{ path: string; data: Uint8Array }[]> {
  const db = await getDb();
  const rows = await db.getAllFromIndex("skillFiles", "skillName", skillName);
  return rows.map((r) => ({ path: r.path, data: r.data }));
}

export async function loadAllSkillFiles(): Promise<
  { skillName: string; path: string; data: Uint8Array }[]
> {
  const db = await getDb();
  const rows = await db.getAll("skillFiles");
  return rows.map((r) => ({
    skillName: r.skillName,
    path: r.path,
    data: r.data,
  }));
}

export async function deleteSkillFiles(skillName: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("skillFiles", "readwrite");
  const keys = await tx.store.index("skillName").getAllKeys(skillName);
  for (const key of keys) {
    await tx.store.delete(key);
  }
  await tx.done;
}

export async function listSkillNames(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAll("skillFiles");
  const names = new Set(rows.map((r) => r.skillName));
  return [...names].sort();
}

export async function saveWorkbookIndex(
  record: WorkbookIndexRecord,
): Promise<void> {
  const db = await getDb();
  await db.put("workbookIndexes", record);
}

export async function loadWorkbookIndex(
  workbookId: string,
): Promise<WorkbookIndexRecord | undefined> {
  const db = await getDb();
  return db.get("workbookIndexes", workbookId);
}

export async function deleteWorkbookIndex(workbookId: string): Promise<void> {
  const db = await getDb();
  await db.delete("workbookIndexes", workbookId);
}
