import Dexie, { type Table } from "dexie";
import type { ChatMessage } from "../../taskpane/components/chat/chat-context";
import type { SkillFileEntry, SkillMetadata } from "../skills";

export interface ChatSession {
  id: string;
  workbookId: string;
  name: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface SkillRecord extends SkillMetadata {}

export interface SkillFileRecord extends SkillFileEntry {
  id: string;
  skillId: string;
}

class OpenExcelDB extends Dexie {
  sessions!: Table<ChatSession, string>;
  skills!: Table<SkillRecord, string>;
  skillFiles!: Table<SkillFileRecord, string>;

  constructor() {
    super("OpenExcelDB_v3");
    this.version(1).stores({
      sessions: "id, workbookId, updatedAt",
    });
    this.version(2).stores({
      sessions: "id, workbookId, updatedAt",
      skills: "id, name, updatedAt, enabled",
      skillFiles: "id, skillId, path",
    });
  }
}

const db = new OpenExcelDB();

export { db };

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
        reject(new Error(result.error?.message ?? "Failed to save workbook ID"));
      }
    });
  });
}

export async function listSessions(workbookId: string): Promise<ChatSession[]> {
  return db.sessions.where("workbookId").equals(workbookId).reverse().sortBy("updatedAt");
}

export async function createSession(workbookId: string, name?: string): Promise<ChatSession> {
  const now = Date.now();
  const session: ChatSession = {
    id: crypto.randomUUID(),
    workbookId,
    name: name ?? "New Chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  await db.sessions.add(session);
  return session;
}

export async function getSession(sessionId: string): Promise<ChatSession | undefined> {
  return db.sessions.get(sessionId);
}

function deriveSessionName(messages: ChatMessage[]): string | null {
  const firstUserMsg = messages.find((m) => m.role === "user");
  if (!firstUserMsg) return null;
  const textPart = firstUserMsg.parts.find((p) => p.type === "text");
  if (!textPart || textPart.type !== "text") return null;
  const text = textPart.text.trim();
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

export async function saveSession(sessionId: string, messages: ChatMessage[]): Promise<void> {
  console.log("[DB] saveSession:", sessionId, "messages:", messages.length);
  const session = await db.sessions.get(sessionId);
  if (!session) {
    console.error("[DB] Session not found for save:", sessionId);
    return;
  }
  let name = session.name;
  if (name === "New Chat") {
    const derivedName = deriveSessionName(messages);
    if (derivedName) name = derivedName;
  }
  await db.sessions.put({
    ...session,
    messages,
    name,
    updatedAt: Date.now(),
  });
  console.log("[DB] saveSession complete");
}

export async function renameSession(sessionId: string, name: string): Promise<void> {
  const session = await db.sessions.get(sessionId);
  if (session) {
    await db.sessions.put({ ...session, name });
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.sessions.delete(sessionId);
}

export async function getOrCreateCurrentSession(workbookId: string): Promise<ChatSession> {
  const sessions = await listSessions(workbookId);
  if (sessions.length > 0) {
    return sessions[0];
  }
  return createSession(workbookId);
}

export async function listSkills(): Promise<SkillRecord[]> {
  return db.skills.orderBy("updatedAt").reverse().toArray();
}

export async function getSkill(skillId: string): Promise<SkillRecord | undefined> {
  return db.skills.get(skillId);
}

export async function getSkillByName(name: string): Promise<SkillRecord | undefined> {
  return db.skills.where("name").equals(name).first();
}

export async function saveSkill(skill: SkillRecord): Promise<void> {
  await db.skills.put({ ...skill, updatedAt: Date.now() });
}

export async function deleteSkill(skillId: string): Promise<void> {
  await db.transaction("rw", db.skills, db.skillFiles, () => {
    return db.skills
      .delete(skillId)
      .then(() => db.skillFiles.where("skillId").equals(skillId).delete())
      .then(() => undefined);
  });
}

export async function listSkillFiles(skillId: string): Promise<SkillFileRecord[]> {
  return db.skillFiles.where("skillId").equals(skillId).toArray();
}

export async function getSkillFile(skillId: string, path: string): Promise<SkillFileRecord | undefined> {
  return db.skillFiles
    .where("skillId")
    .equals(skillId)
    .and((file) => file.path === path)
    .first();
}

export async function upsertSkillPackage(skill: SkillRecord, files: SkillFileRecord[]): Promise<void> {
  await db.transaction("rw", db.skills, db.skillFiles, () => {
    return db.skills
      .put({ ...skill, updatedAt: Date.now() })
      .then(() => db.skillFiles.where("skillId").equals(skill.id).delete())
      .then(() => (files.length > 0 ? db.skillFiles.bulkPut(files) : undefined))
      .then(() => undefined);
  });
}
