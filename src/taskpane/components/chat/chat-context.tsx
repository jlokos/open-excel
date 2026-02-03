import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type ThinkingLevel as AgentThinkingLevel,
} from "@mariozechner/pi-agent-core";
import {
  type AssistantMessage,
  getModel,
  getModels,
  getProviders,
  type Model,
  streamSimple,
  type Usage,
} from "@mariozechner/pi-ai";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getWorkbookMetadata } from "../../../lib/excel/api";
import { buildSkillPackageFromMarkdown, type SkillMetadata, type SkillPackage } from "../../../lib/skills";
import {
  type ChatSession,
  createSession,
  deleteSession,
  getOrCreateCurrentSession,
  getOrCreateWorkbookId,
  getSession,
  listSessions,
  listSkills,
  saveSkill,
  upsertSkillPackage,
  deleteSkill as deleteSkillRecord,
  getSkillFile,
  saveSession,
} from "../../../lib/storage";
import { EXCEL_TOOLS } from "../../../lib/tools";

export type ToolCallStatus = "pending" | "running" | "complete" | "error";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: ToolCallStatus;
      result?: string;
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  timestamp: number;
}

export type ThinkingLevel = "none" | "low" | "medium" | "high";

export interface ProviderConfig {
  provider: string;
  apiKey: string;
  model: string;
  useProxy: boolean;
  proxyUrl: string;
  thinking: ThinkingLevel;
}

export interface SessionStats {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalCost: number;
  contextWindow: number;
  lastUsage: Usage | null;
}

export interface SkillDraftInput {
  name?: string;
  summary?: string;
  whenToUse?: string;
  instructions?: string;
  tools?: string;
  inputs?: string;
  outputs?: string;
  examples?: string;
  constraints?: string;
  extraContext?: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata?: string;
}

const STORAGE_KEY = "openexcel-provider-config";
const LEGACY_SKILLS_KEY = "openexcel-agent-skills";

function loadSavedConfig(): ProviderConfig | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const config = JSON.parse(saved);
      if (config.proxyUrl === undefined) {
        config.proxyUrl = "";
      }
      return config;
    }
  } catch {}
  return null;
}

function loadLegacySkills(): Array<{ content?: string; enabled?: boolean; sourceType?: string; source?: string }> {
  try {
    const raw = localStorage.getItem(LEGACY_SKILLS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Array<{ content?: string; enabled?: boolean; sourceType?: string; source?: string }>;
  } catch {
    return [];
  }
}

function applyProxyToModel(model: Model<any>, config: ProviderConfig): Model<any> {
  if (!config.useProxy || !config.proxyUrl || !model.baseUrl) return model;
  return {
    ...model,
    baseUrl: `${config.proxyUrl}/?url=${encodeURIComponent(model.baseUrl)}`,
  };
}

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  providerConfig: ProviderConfig | null;
  sessionStats: SessionStats;
  currentSession: ChatSession | null;
  sessions: ChatSession[];
}

const INITIAL_STATS: SessionStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalCost: 0,
  contextWindow: 0,
  lastUsage: null,
};

interface ChatContextValue {
  state: ChatState;
  sendMessage: (content: string) => Promise<void>;
  setProviderConfig: (config: ProviderConfig) => void;
  clearMessages: () => void;
  abort: () => void;
  availableProviders: string[];
  getModelsForProvider: (provider: string) => Model<any>[];
  newSession: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  deleteCurrentSession: () => Promise<void>;
  skills: SkillMetadata[];
  upsertSkill: (skill: SkillPackage) => Promise<void>;
  setSkillEnabled: (id: string, enabled: boolean) => Promise<void>;
  removeSkill: (id: string) => Promise<void>;
  loadSkillContent: (id: string) => Promise<string | null>;
  buildSkillDraft: (input: SkillDraftInput) => Promise<string>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

const SYSTEM_PROMPT = `You are an AI assistant integrated into Microsoft Excel with full access to read and modify spreadsheet data.

Available tools:
READ:
- get_cell_ranges: Read cell values, formulas, and formatting
- get_range_as_csv: Get data as CSV (great for analysis)
- search_data: Find text across the spreadsheet
- get_all_objects: List charts, pivot tables, etc.

WRITE:
- set_cell_range: Write values, formulas, and formatting
- clear_cell_range: Clear contents or formatting
- copy_to: Copy ranges with formula translation
- modify_sheet_structure: Insert/delete/hide rows/columns, freeze panes
- modify_workbook_structure: Create/delete/rename sheets
- resize_range: Adjust column widths and row heights
- modify_object: Create/update/delete charts and pivot tables

Citations: Use markdown links with #cite: hash to reference sheets/cells. Clicking navigates there.
- Sheet only: [Sheet Name](#cite:sheetId)
- Cell/range: [A1:B10](#cite:sheetId!A1:B10)
Example: [Exchange Ratio](#cite:3) or [see cell B5](#cite:3!B5)

When the user asks about their data, read it first. Be concise. Use A1 notation for cell references.`;

const SKILL_BUILDER_PROMPT = `You are a Skill Creator. Generate a single SKILL.md file for a Codex-style Agent Skill.

Rules:
- Output only the SKILL.md content, no commentary or code fences.
- Include YAML frontmatter with required name and description fields.
- Use concise, actionable language.
- Use sections: Purpose, When to use, Instructions.
- Include Inputs, Outputs, Tools, Examples sections only if relevant.
- Prefer bullet lists for steps or rules.`;

function buildSystemPrompt(skills: SkillMetadata[], skillBodies: Record<string, string>): string {
  if (skills.length === 0) return SYSTEM_PROMPT;

  const metadataLines = skills
    .map((skill) => {
      const allowed = skill.allowedTools && skill.allowedTools.length > 0 ? ` (allowed-tools: ${skill.allowedTools.join(" ")})` : "";
      return `- ${skill.name}: ${skill.description}${allowed}`;
    })
    .join("\n");

  const activeSkillBlocks = skills
    .filter((skill) => skill.enabled && skillBodies[skill.id])
    .map((skill) => `<skill name="${skill.name}">\n${skillBodies[skill.id].trim()}\n</skill>`)
    .join("\n\n");

  const activeSection = activeSkillBlocks
    ? `Activated skills (full SKILL.md):\n${activeSkillBlocks}`
    : "Activated skills (full SKILL.md): none.";

  return `${SYSTEM_PROMPT}\n\nAgent Skills (metadata only):\n${metadataLines}\n\nTo load a skill's full SKILL.md or files on demand, use: list_skills, load_skill, read_skill_file.\n\n${activeSection}`;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function thinkingLevelToAgent(level: ThinkingLevel): AgentThinkingLevel {
  return level === "none" ? "off" : level;
}

function extractTextFromAssistantMessage(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  const assistantMsg = message as AssistantMessage;
  return assistantMsg.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:markdown|md)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();
  return text.trim();
}

function decodeSkillFileContent(content: string, encoding: "utf-8" | "base64"): string {
  if (encoding === "base64") {
    try {
      return atob(content);
    } catch {
      return "";
    }
  }
  return content;
}

function buildSkillDraftPrompt(input: SkillDraftInput): string {
  const lines: string[] = ["Skill brief:"];
  lines.push(`Name: ${input.name?.trim() || "Invent a concise name"}`);
  if (input.summary?.trim()) lines.push(`Summary: ${input.summary.trim()}`);
  if (input.whenToUse?.trim()) lines.push(`When to use: ${input.whenToUse.trim()}`);
  if (input.instructions?.trim()) lines.push(`Instructions/Rules: ${input.instructions.trim()}`);
  if (input.tools?.trim()) lines.push(`Tools: ${input.tools.trim()}`);
  if (input.inputs?.trim()) lines.push(`Inputs: ${input.inputs.trim()}`);
  if (input.outputs?.trim()) lines.push(`Outputs: ${input.outputs.trim()}`);
  if (input.examples?.trim()) lines.push(`Examples: ${input.examples.trim()}`);
  if (input.constraints?.trim()) lines.push(`Constraints: ${input.constraints.trim()}`);
  if (input.extraContext?.trim()) lines.push(`Extra context: ${input.extraContext.trim()}`);
  if (input.license?.trim()) lines.push(`License: ${input.license.trim()}`);
  if (input.compatibility?.trim()) lines.push(`Compatibility: ${input.compatibility.trim()}`);
  if (input.allowedTools?.trim()) lines.push(`Allowed tools: ${input.allowedTools.trim()}`);
  if (input.metadata?.trim()) lines.push(`Metadata: ${input.metadata.trim()}`);
  return `${lines.join("\n")}\n\nReturn only the SKILL.md content.`;
}

function extractPartsFromAssistantMessage(message: AgentMessage, existingParts: MessagePart[] = []): MessagePart[] {
  if (message.role !== "assistant") return existingParts;

  const assistantMsg = message as AssistantMessage;
  const existingToolCalls = new Map<string, MessagePart>();
  for (const part of existingParts) {
    if (part.type === "toolCall") {
      existingToolCalls.set(part.id, part);
    }
  }

  return assistantMsg.content.map((block): MessagePart => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "thinking") {
      return { type: "thinking", thinking: block.thinking };
    }
    const existing = existingToolCalls.get(block.id);
    return {
      type: "toolCall",
      id: block.id,
      name: block.name,
      args: block.arguments as Record<string, unknown>,
      status: existing?.type === "toolCall" ? existing.status : "pending",
      result: existing?.type === "toolCall" ? existing.result : undefined,
    };
  });
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ChatState>(() => {
    const saved = loadSavedConfig();
    const validConfig = saved?.provider && saved?.apiKey && saved?.model ? saved : null;
    return {
      messages: [],
      isStreaming: false,
      error: null,
      providerConfig: validConfig,
      sessionStats: INITIAL_STATS,
      currentSession: null,
      sessions: [],
    };
  });
  const [skills, setSkills] = useState<SkillMetadata[]>([]);
  const [skillBodies, setSkillBodies] = useState<Record<string, string>>({});

  const agentRef = useRef<Agent | null>(null);
  const streamingMessageIdRef = useRef<string | null>(null);
  const isStreamingRef = useRef(false);
  const pendingConfigRef = useRef<ProviderConfig | null>(null);
  const pendingSystemPromptRef = useRef<string | null>(null);
  const workbookIdRef = useRef<string | null>(null);
  const sessionLoadedRef = useRef(false);
  const currentSessionIdRef = useRef<string | null>(null);
  const providerConfigRef = useRef<ProviderConfig | null>(state.providerConfig);
  const systemPromptRef = useRef<string>(SYSTEM_PROMPT);

  const availableProviders = getProviders();

  const getModelsForProvider = useCallback((provider: string): Model<any>[] => {
    try {
      return getModels(provider as any);
    } catch {
      return [];
    }
  }, []);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    console.log("[Chat] Agent event:", event.type, event);
    switch (event.type) {
      case "message_start": {
        if (event.message.role === "assistant") {
          const id = generateId();
          streamingMessageIdRef.current = id;
          const parts = extractPartsFromAssistantMessage(event.message);
          setState((prev) => ({
            ...prev,
            messages: [
              ...prev.messages,
              {
                id,
                role: "assistant",
                parts,
                timestamp: Date.now(),
              },
            ],
          }));
        }
        break;
      }
      case "message_update": {
        if (event.message.role === "assistant" && streamingMessageIdRef.current) {
          const msgId = streamingMessageIdRef.current;
          setState((prev) => {
            const msgIndex = prev.messages.findIndex((m) => m.id === msgId);
            if (msgIndex === -1) return prev;
            const existing = prev.messages[msgIndex];
            const parts = extractPartsFromAssistantMessage(event.message, existing.parts);
            const updated = [...prev.messages];
            updated[msgIndex] = { ...existing, parts };
            return { ...prev, messages: updated };
          });
        }
        break;
      }
      case "message_end": {
        if (event.message.role === "assistant" && streamingMessageIdRef.current) {
          const msgId = streamingMessageIdRef.current;
          const assistantMsg = event.message as AssistantMessage;
          setState((prev) => {
            const msgIndex = prev.messages.findIndex((m) => m.id === msgId);
            if (msgIndex === -1) return prev;
            const existing = prev.messages[msgIndex];
            const parts = extractPartsFromAssistantMessage(event.message, existing.parts);
            const updated = [...prev.messages];
            updated[msgIndex] = { ...existing, parts };
            const stats = { ...prev.sessionStats };
            if (assistantMsg.usage) {
              stats.inputTokens += assistantMsg.usage.input ?? 0;
              stats.outputTokens += assistantMsg.usage.output ?? 0;
              stats.cacheRead += assistantMsg.usage.cacheRead ?? 0;
              stats.cacheWrite += assistantMsg.usage.cacheWrite ?? 0;
              stats.totalCost += assistantMsg.usage.cost?.total ?? 0;
              stats.lastUsage = assistantMsg.usage;
            }
            return { ...prev, messages: updated, sessionStats: stats };
          });
        }
        break;
      }
      case "tool_execution_start": {
        setState((prev) => {
          const messages = [...prev.messages];
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const partIdx = msg.parts.findIndex((p) => p.type === "toolCall" && p.id === event.toolCallId);
            if (partIdx !== -1) {
              const parts = [...msg.parts];
              const part = parts[partIdx];
              if (part.type === "toolCall") {
                parts[partIdx] = { ...part, status: "running" };
                messages[i] = { ...msg, parts };
              }
              break;
            }
          }
          return { ...prev, messages };
        });
        break;
      }
      case "tool_execution_end": {
        setState((prev) => {
          const messages = [...prev.messages];
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const partIdx = msg.parts.findIndex((p) => p.type === "toolCall" && p.id === event.toolCallId);
            if (partIdx !== -1) {
              const parts = [...msg.parts];
              const part = parts[partIdx];
              if (part.type === "toolCall") {
                const isError = event.result.type === "error";
                parts[partIdx] = {
                  ...part,
                  status: isError ? "error" : "complete",
                  result: event.result.result,
                };
                messages[i] = { ...msg, parts };
              }
              break;
            }
          }
          return { ...prev, messages };
        });
        break;
      }
      case "turn_end": {
        isStreamingRef.current = false;
        streamingMessageIdRef.current = null;
        setState((prev) => ({ ...prev, isStreaming: false }));
        if (currentSessionIdRef.current) {
          setState((prev) => {
            saveSession(currentSessionIdRef.current!, prev.messages).catch(console.error);
            return prev;
          });
        }
        break;
      }
    }
  }, []);

  const applyConfig = useCallback(
    (config: ProviderConfig, systemPrompt: string, apiKey: string) => {
      console.log("[Chat] applyConfig:", config.provider, config.model);

      let baseModel: Model<any>;
      try {
        baseModel = getModel(config.provider as any, config.model as any);
      } catch (err) {
        console.error("[Chat] Failed to get model:", err);
        setState((prev) => ({
          ...prev,
          error: `Invalid model: ${config.model}`,
          providerConfig: config,
        }));
        return;
      }

      const proxiedModel = applyProxyToModel(baseModel, config);

      const agent = new Agent({
        initialState: {
          model: proxiedModel,
          systemPrompt,
          thinkingLevel: thinkingLevelToAgent(config.thinking),
          tools: EXCEL_TOOLS,
          messages: [],
        },
        streamFn: (model, context, options) => {
          console.log("[Chat] streamFn called with model:", model.id, "context messages:", context.messages.length);
          return streamSimple(model, context, {
            ...options,
            apiKey,
          });
        },
      });
      agent.subscribe(handleAgentEvent);
      agentRef.current = agent;

      pendingConfigRef.current = null;
      pendingSystemPromptRef.current = null;
      providerConfigRef.current = config;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));

      setState((prev) => ({
        ...prev,
        providerConfig: config,
        error: null,
        sessionStats: {
          ...prev.sessionStats,
          contextWindow: proxiedModel.contextWindow ?? 0,
        },
      }));
    },
    [handleAgentEvent],
  );

  const setProviderConfig = useCallback(
    async (config: ProviderConfig) => {
      console.log("[Chat] setProviderConfig:", config);
      providerConfigRef.current = config;

      if (isStreamingRef.current) {
        pendingConfigRef.current = config;
        setState((prev) => ({ ...prev, providerConfig: config }));
        return;
      }

      await applyConfig(config, systemPromptRef.current, config.apiKey);
    },
    [applyConfig],
  );

  const abort = useCallback(() => {
    agentRef.current?.abort();
    isStreamingRef.current = false;
    setState((prev) => ({ ...prev, isStreaming: false }));
  }, []);

  const loadSkillContent = useCallback(async (skillId: string): Promise<string | null> => {
    const file = await getSkillFile(skillId, "SKILL.md");
    if (!file) return null;
    return decodeSkillFileContent(file.content, file.encoding);
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      const config = providerConfigRef.current;
      if (!config) {
        setState((prev) => ({ ...prev, error: "Please configure your API provider first" }));
        return;
      }

      const pendingConfig = pendingConfigRef.current;
      const pendingSystemPrompt = pendingSystemPromptRef.current;
      if (pendingConfig || pendingSystemPrompt) {
        const nextConfig = pendingConfig ?? config;
        const nextPrompt = pendingSystemPrompt ?? systemPromptRef.current;
        await applyConfig(nextConfig, nextPrompt, nextConfig.apiKey);
      }

      const agent = agentRef.current;
      if (!agent) {
        await applyConfig(config, systemPromptRef.current, config.apiKey);
      }

      const userMessage: ChatMessage = {
        id: generateId(),
        role: "user",
        parts: [{ type: "text", text: content }],
        timestamp: Date.now(),
      };

      isStreamingRef.current = true;
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
        isStreaming: true,
        error: null,
      }));

      try {
        let promptContent = content;
        try {
          console.log("[Chat] Fetching workbook metadata...");
          const metadata = await getWorkbookMetadata();
          console.log("[Chat] Workbook metadata:", metadata);
          promptContent = `<wb_context>\n${JSON.stringify(metadata, null, 2)}\n</wb_context>\n\n${content}`;
        } catch (err) {
          console.error("[Chat] Failed to get workbook metadata:", err);
        }
        await agentRef.current!.prompt(promptContent);
        console.log("[Chat] Full context:", agentRef.current!.state.messages);
      } catch (err) {
        console.error("[Chat] sendMessage error:", err);
        isStreamingRef.current = false;
        setState((prev) => ({
          ...prev,
          isStreaming: false,
          error: err instanceof Error ? err.message : "An error occurred",
        }));
      }
    },
    [applyConfig],
  );

  const clearMessages = useCallback(() => {
    abort();
    agentRef.current?.reset();
    if (currentSessionIdRef.current) {
      saveSession(currentSessionIdRef.current, []).catch(console.error);
    }
    setState((prev) => ({ ...prev, messages: [], error: null, sessionStats: INITIAL_STATS }));
  }, [abort]);

  const refreshSessions = useCallback(async () => {
    if (!workbookIdRef.current) return;
    const sessions = await listSessions(workbookIdRef.current);
    console.log(
      "[Chat] refreshSessions:",
      sessions.map((s) => ({ id: s.id, name: s.name, msgs: s.messages.length })),
    );
    setState((prev) => ({ ...prev, sessions }));
  }, []);

  const newSession = useCallback(async () => {
    console.log("[Chat] newSession called, workbookId:", workbookIdRef.current);
    if (!workbookIdRef.current) {
      console.error("[Chat] Cannot create session: workbookId not set");
      return;
    }
    if (isStreamingRef.current) {
      console.log("[Chat] newSession blocked: streaming in progress");
      return;
    }
    try {
      agentRef.current?.reset();
      const session = await createSession(workbookIdRef.current);
      console.log("[Chat] Created new session:", session.id);
      currentSessionIdRef.current = session.id;
      await refreshSessions();
      setState((prev) => ({
        ...prev,
        messages: [],
        currentSession: session,
        error: null,
        sessionStats: INITIAL_STATS,
      }));
    } catch (err) {
      console.error("[Chat] Failed to create session:", err);
    }
  }, [refreshSessions]);

  const switchSession = useCallback(async (sessionId: string) => {
    console.log("[Chat] switchSession called:", sessionId, "current:", currentSessionIdRef.current);
    if (currentSessionIdRef.current === sessionId) return;
    if (isStreamingRef.current) {
      console.log("[Chat] switchSession blocked: streaming in progress");
      return;
    }
    agentRef.current?.reset();
    try {
      const session = await getSession(sessionId);
      console.log("[Chat] Got session:", session?.id, "messages:", session?.messages.length);
      if (!session) {
        console.error("[Chat] Session not found:", sessionId);
        return;
      }
      currentSessionIdRef.current = session.id;
      setState((prev) => ({
        ...prev,
        messages: session.messages,
        currentSession: session,
        error: null,
        sessionStats: INITIAL_STATS,
      }));
    } catch (err) {
      console.error("[Chat] Failed to switch session:", err);
    }
  }, []);

  const deleteCurrentSession = useCallback(async () => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId || !workbookIdRef.current) return;
    if (isStreamingRef.current) return;
    agentRef.current?.reset();
    try {
      await deleteSession(sessionId);
      const remaining = await listSessions(workbookIdRef.current);
      if (remaining.length > 0) {
        const next = remaining[0];
        currentSessionIdRef.current = next.id;
        setState((prev) => ({
          ...prev,
          messages: next.messages,
          currentSession: next,
          sessions: remaining,
          error: null,
          sessionStats: INITIAL_STATS,
        }));
      } else {
        const newSess = await createSession(workbookIdRef.current);
        currentSessionIdRef.current = newSess.id;
        setState((prev) => ({
          ...prev,
          messages: [],
          currentSession: newSess,
          sessions: [newSess],
          error: null,
          sessionStats: INITIAL_STATS,
        }));
      }
    } catch (err) {
      console.error("[Chat] Failed to delete session:", err);
    }
  }, []);

  // Initialize workbook and session
  useEffect(() => {
    if (sessionLoadedRef.current) return;
    sessionLoadedRef.current = true;

    (async () => {
      try {
        const workbookId = await getOrCreateWorkbookId();
        workbookIdRef.current = workbookId;
        console.log("[Chat] Workbook ID:", workbookId);
        const session = await getOrCreateCurrentSession(workbookId);
        currentSessionIdRef.current = session.id;
        const sessions = await listSessions(workbookId);
        setState((prev) => ({
          ...prev,
          messages: session.messages,
          currentSession: session,
          sessions,
        }));
      } catch (err) {
        console.error("[Chat] Failed to load session:", err);
      }
    })();
  }, []);

  // Load skills from DB and migrate legacy skills
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const dbSkills = await listSkills();
      if (cancelled) return;
      if (dbSkills.length > 0) {
        setSkills(dbSkills);
        return;
      }
      const legacy = loadLegacySkills();
      if (legacy.length === 0) return;
      const migrated: SkillMetadata[] = [];
      for (const entry of legacy) {
        if (!entry.content) continue;
        const result = buildSkillPackageFromMarkdown({
          content: entry.content,
          sourceType: (entry.sourceType as "file" | "url" | "paste") || "paste",
          source: entry.source,
          enabled: entry.enabled ?? false,
        });
        if (result.errors.length > 0 || !result.skill) continue;
        const files = result.skill.files.map((file) => ({
          ...file,
          id: `${result.skill!.metadata.id}:${file.path}`,
          skillId: result.skill!.metadata.id,
        }));
        await upsertSkillPackage(result.skill.metadata, files);
        migrated.push(result.skill.metadata);
      }
      if (cancelled) return;
      if (migrated.length > 0) {
        localStorage.removeItem(LEGACY_SKILLS_KEY);
        setSkills(migrated);
      }
    })().catch((err) => console.error("[Chat] Failed to load skills:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  // Load skill bodies for enabled skills
  useEffect(() => {
    let cancelled = false;
    const enabledSkills = skills.filter((s) => s.enabled);
    if (enabledSkills.length === 0) {
      setSkillBodies({});
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      if (cancelled) return;
      const entries = await Promise.all(
        enabledSkills.map(async (skill) => {
          const content = await loadSkillContent(skill.id);
          return content ? [skill.id, content] : null;
        }),
      );
      if (cancelled) return;
      const nextBodies: Record<string, string> = {};
      for (const entry of entries) {
        if (entry) nextBodies[entry[0]] = entry[1];
      }
      setSkillBodies(nextBodies);
    })().catch((err) => console.error("[Chat] Failed to load skills:", err));
    return () => {
      cancelled = true;
    };
  }, [loadSkillContent, skills]);

  // Update system prompt when skills change
  useEffect(() => {
    const prompt = buildSystemPrompt(skills, skillBodies);
    systemPromptRef.current = prompt;
    const config = providerConfigRef.current;
    if (!config) return;
    if (isStreamingRef.current) {
      pendingSystemPromptRef.current = prompt;
      return;
    }
    applyConfig(config, prompt, config.apiKey);
  }, [skills, skillBodies, applyConfig]);

  const upsertSkill = useCallback(
    async (skill: SkillPackage) => {
      const files = skill.files.map((file) => ({
        ...file,
        id: `${skill.metadata.id}:${file.path}`,
        skillId: skill.metadata.id,
      }));
      await upsertSkillPackage(skill.metadata, files);
      setSkills((prev) => {
        const idx = prev.findIndex((s) => s.id === skill.metadata.id);
        if (idx === -1) return [...prev, skill.metadata];
        const next = [...prev];
        next[idx] = skill.metadata;
        return next;
      });
      if (skill.metadata.enabled) {
        const localSkillMd = skill.files.find((file) => file.path === "SKILL.md");
        const content = localSkillMd
          ? decodeSkillFileContent(localSkillMd.content, localSkillMd.encoding)
          : await loadSkillContent(skill.metadata.id);
        if (content) {
          setSkillBodies((prev) => ({ ...prev, [skill.metadata.id]: content }));
        }
      }
    },
    [loadSkillContent],
  );

  const setSkillEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      setSkills((prev) =>
        prev.map((skill) =>
          skill.id === id
            ? {
                ...skill,
                enabled,
                updatedAt: Date.now(),
              }
            : skill,
        ),
      );
      const existing = skills.find((skill) => skill.id === id);
      if (existing) {
        await saveSkill({ ...existing, enabled, updatedAt: Date.now() });
      }
      if (enabled) {
        const content = await loadSkillContent(id);
        if (content) {
          setSkillBodies((prev) => ({ ...prev, [id]: content }));
        }
      } else {
        setSkillBodies((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    },
    [loadSkillContent, skills],
  );

  const removeSkill = useCallback(async (id: string) => {
    await deleteSkillRecord(id);
    setSkills((prev) => prev.filter((skill) => skill.id !== id));
    setSkillBodies((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const buildSkillDraft = useCallback(async (input: SkillDraftInput) => {
    const config = providerConfigRef.current;
    if (!config) {
      throw new Error("Configure an API provider to generate a draft with AI.");
    }

    let baseModel: Model<any>;
    try {
      baseModel = getModel(config.provider as any, config.model as any);
    } catch {
      throw new Error("Invalid model configuration.");
    }

    const proxiedModel = applyProxyToModel(baseModel, config);
    const draftAgent = new Agent({
      initialState: {
        model: proxiedModel,
        systemPrompt: SKILL_BUILDER_PROMPT,
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      streamFn: (model, context, options) => {
        return streamSimple(model, context, {
          ...options,
          apiKey: config.apiKey,
        });
      },
    });

    let draft = "";
    draftAgent.subscribe((event: AgentEvent) => {
      if ((event.type === "message_update" || event.type === "message_end") && event.message.role === "assistant") {
        draft = extractTextFromAssistantMessage(event.message);
      }
    });

    await draftAgent.prompt(buildSkillDraftPrompt(input));
    return stripCodeFences(draft);
  }, []);

  return (
    <ChatContext.Provider
      value={{
        state,
        sendMessage,
        setProviderConfig,
        clearMessages,
        abort,
        availableProviders,
        getModelsForProvider,
        newSession,
        switchSession,
        deleteCurrentSession,
        skills,
        upsertSkill,
        setSkillEnabled,
        removeSkill,
        loadSkillContent,
        buildSkillDraft,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) throw new Error("useChat must be used within ChatProvider");
  return context;
}
