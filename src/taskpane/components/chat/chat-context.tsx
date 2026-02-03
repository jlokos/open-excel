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
import { buildSkillPackageFromMarkdown, extractSkillName, type SkillMetadata, type SkillPackage } from "../../../lib/skills";
import {
  type ChatSession,
  createSession,
  deleteSession,
  getOrCreateCurrentSession,
  getOrCreateWorkbookId,
  getSession,
  listSessions,
  listSkills,
  listSkillFiles,
  saveSkill,
  upsertSkillPackage,
  deleteSkill as deleteSkillRecord,
  getSkillFile,
  saveSession,
  getAllOAuthCredentials,
  saveOAuthCredentials,
  deleteOAuthCredentials,
  type OAuthCredentialRecord,
} from "../../../lib/storage";
import { EXCEL_TOOLS } from "../../../lib/tools";
import type { BrowserOAuthProviderId, CustomEndpointConfig, ExtendedProviderConfig } from "./types";
import type { OAuthCredentials } from "./oauth-login-dialog";

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

export interface ProviderConfig extends ExtendedProviderConfig {}

export interface SessionStats {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalCost: number;
  contextWindow: number;
  lastUsage: Usage | null;
}

interface DebugInfo {
  requestId: string | null;
  provider?: string;
  model?: string;
  baseUrl?: string;
  payloadPreview?: string;
  payloadSize?: number;
  error?: string | null;
  timestamp?: number;
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

export type OAuthStatus = Record<BrowserOAuthProviderId, boolean>;

const STORAGE_KEY = "openexcel-provider-config";
const LEGACY_SKILLS_KEY = "openexcel-agent-skills";
const CUSTOM_PROVIDER_ID = "custom";

const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_JWT_CLAIM_PATH = "https://api.openai.com/auth";

const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
} as const;

function loadSavedConfig(): ProviderConfig | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const config = JSON.parse(saved);
      if (config.proxyUrl === undefined) {
        config.proxyUrl = "";
      }
      if (config.authMethod === undefined) {
        config.authMethod = "apiKey";
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

function applyOAuthModelOverrides(
  model: Model<any>,
  config: ProviderConfig,
  oauthCredentials?: OAuthCredentialRecord | null,
): Model<any> {
  if (config.authMethod !== "oauth" || !config.oauthProvider || !oauthCredentials) return model;

  if (config.oauthProvider === "github-copilot") {
    const enterpriseDomain =
      typeof oauthCredentials.enterpriseUrl === "string"
        ? normalizeDomain(oauthCredentials.enterpriseUrl) ?? oauthCredentials.enterpriseUrl
        : undefined;
    const token = typeof oauthCredentials.access === "string" ? oauthCredentials.access : undefined;
    const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
    if (baseUrl && baseUrl !== model.baseUrl) {
      return { ...model, baseUrl };
    }
  }

  return model;
}

function buildCustomModel(endpoint: CustomEndpointConfig): Model<"openai-completions"> {
  return {
    id: endpoint.modelId,
    name: endpoint.modelName || endpoint.modelId,
    api: "openai-completions",
    provider: "custom" as any,
    baseUrl: endpoint.baseUrl,
    reasoning: false,
    input: endpoint.supportsImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: endpoint.contextWindow,
    maxTokens: endpoint.maxTokens ?? Math.floor(endpoint.contextWindow / 4),
  };
}

function buildProxiedUrl(url: string, proxyUrl?: string): string {
  if (!proxyUrl) return url;
  return `${proxyUrl}/?url=${encodeURIComponent(url)}`;
}

function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function getBaseUrlFromToken(token: string): string | null {
  const match = token.match(/proxy-ep=([^;]+)/);
  if (!match) return null;
  const proxyHost = match[1];
  const apiHost = proxyHost.replace(/^proxy\./, "api.");
  return `https://${apiHost}`;
}

function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
  if (token) {
    const urlFromToken = getBaseUrlFromToken(token);
    if (urlFromToken) return urlFromToken;
  }
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
  return "https://api.individual.githubcopilot.com";
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1] ?? "";
    return JSON.parse(atob(payload)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getOpenAICodexAccountId(token: string): string | null {
  const payload = decodeJwt(token);
  const auth = payload?.[OPENAI_JWT_CLAIM_PATH as keyof typeof payload] as { chatgpt_account_id?: string } | undefined;
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function buildPayloadPreview(payload: unknown, maxLen = 4000): { preview: string; size: number } {
  let text = "";
  try {
    text = JSON.stringify(payload, null, 2);
  } catch {
    text = String(payload);
  }
  const size = text.length;
  if (text.length > maxLen) {
    text = `${text.slice(0, maxLen)}\n... truncated (${size - maxLen} chars)`;
  }
  return { preview: text, size };
}

function formatProviderError(message: string, config: ProviderConfig | null): string {
  if (!config) return message;
  const normalized = message.toLowerCase();
  if (config.provider === "openai-codex" && (normalized.includes("load failed") || normalized.includes("failed to fetch"))) {
    return "OpenAI Codex request failed (network/CORS). Set a CORS proxy in Settings and try again.";
  }
  return message;
}

async function refreshAnthropicToken(
  refreshToken: string,
  proxyUrl?: string,
): Promise<{ access: string; refresh: string; expires: number } | null> {
  try {
    const tokenUrl = buildProxiedUrl(ANTHROPIC_TOKEN_URL, proxyUrl);
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: ANTHROPIC_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      console.error("[OAuth] Failed to refresh Anthropic token:", await response.text());
      return null;
    }

    const data = await response.json();
    return {
      access: data.access_token,
      refresh: data.refresh_token || refreshToken,
      expires: Date.now() + (data.expires_in || 3600) * 1000 - 5 * 60 * 1000,
    };
  } catch (err) {
    console.error("[OAuth] Error refreshing Anthropic token:", err);
    return null;
  }
}

async function refreshGitHubCopilotToken(
  refreshToken: string,
  enterpriseDomain?: string,
  proxyUrl?: string,
): Promise<{ access: string; refresh: string; expires: number; enterpriseUrl?: string } | null> {
  try {
    const domain = enterpriseDomain || "github.com";
    const tokenUrl = buildProxiedUrl(`https://api.${domain}/copilot_internal/v2/token`, proxyUrl);
    const response = await fetch(tokenUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${refreshToken}`,
        ...COPILOT_HEADERS,
      },
    });

    if (!response.ok) {
      console.error("[OAuth] Failed to refresh GitHub Copilot token:", await response.text());
      return null;
    }

    const data = await response.json();
    if (!data?.token || typeof data.expires_at !== "number") {
      console.error("[OAuth] Invalid GitHub Copilot token response:", data);
      return null;
    }

    return {
      access: data.token,
      refresh: refreshToken,
      expires: data.expires_at * 1000 - 5 * 60 * 1000,
      enterpriseUrl: enterpriseDomain,
    };
  } catch (err) {
    console.error("[OAuth] Error refreshing GitHub Copilot token:", err);
    return null;
  }
}

async function refreshOpenAICodexToken(
  refreshToken: string,
  proxyUrl?: string,
): Promise<{ access: string; refresh: string; expires: number; accountId?: string } | null> {
  try {
    const tokenUrl = buildProxiedUrl(OPENAI_TOKEN_URL, proxyUrl);
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OPENAI_CLIENT_ID,
      }).toString(),
    });

    if (!response.ok) {
      console.error("[OAuth] Failed to refresh OpenAI Codex token:", await response.text());
      return null;
    }

    const data = await response.json();
    if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
      console.error("[OAuth] Invalid OpenAI Codex token response:", data);
      return null;
    }

    const accountId = getOpenAICodexAccountId(data.access_token);

    return {
      access: data.access_token,
      refresh: data.refresh_token,
      expires: Date.now() + data.expires_in * 1000,
      accountId: accountId ?? undefined,
    };
  } catch (err) {
    console.error("[OAuth] Error refreshing OpenAI Codex token:", err);
    return null;
  }
}

async function getApiKeyForConfig(
  config: ProviderConfig,
  oauthCredentials: OAuthCredentialRecord[],
  proxyUrl?: string,
): Promise<{ apiKey: string; updatedCredentials?: OAuthCredentialRecord; credentials?: OAuthCredentialRecord } | null> {
  if (config.authMethod === "apiKey") {
    return { apiKey: config.apiKey || "" };
  }

  if (!config.oauthProvider) {
    return null;
  }

  const creds = oauthCredentials.find((c) => c.id === config.oauthProvider);
  if (!creds) {
    return null;
  }

  const now = Date.now();
  const bufferMs = 5 * 60 * 1000;

  const expires = typeof creds.expires === "number" ? creds.expires : 0;
  if (expires > now + bufferMs) {
    return { apiKey: creds.access, credentials: creds };
  }

  let refreshed: { access: string; refresh: string; expires: number; [key: string]: unknown } | null = null;

  if (config.oauthProvider === "anthropic" && creds.refresh) {
    refreshed = await refreshAnthropicToken(creds.refresh, proxyUrl);
  }

  if (config.oauthProvider === "github-copilot" && creds.refresh) {
    const enterpriseDomain =
      typeof creds.enterpriseUrl === "string" ? normalizeDomain(creds.enterpriseUrl) ?? creds.enterpriseUrl : undefined;
    refreshed = await refreshGitHubCopilotToken(creds.refresh, enterpriseDomain, proxyUrl);
  }

  if (config.oauthProvider === "openai-codex" && creds.refresh) {
    refreshed = await refreshOpenAICodexToken(creds.refresh, proxyUrl);
  }

  if (refreshed) {
    const updatedCredentials: OAuthCredentialRecord = {
      id: config.oauthProvider,
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      updatedAt: Date.now(),
      ...refreshed,
    };
    return { apiKey: refreshed.access, updatedCredentials, credentials: updatedCredentials };
  }

  return null;
}

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  providerConfig: ProviderConfig | null;
  sessionStats: SessionStats;
  currentSession: ChatSession | null;
  sessions: ChatSession[];
  debug: DebugInfo;
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

const INITIAL_DEBUG: DebugInfo = {
  requestId: null,
  error: null,
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
  oauthStatus: OAuthStatus;
  loginWithOAuth: (providerId: BrowserOAuthProviderId, credentials: OAuthCredentials) => Promise<void>;
  logoutOAuth: (providerId: BrowserOAuthProviderId) => Promise<void>;
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
    const isCustom = saved?.provider === CUSTOM_PROVIDER_ID;
    const hasAuth = saved?.authMethod === "oauth" ? saved?.oauthProvider : saved?.apiKey;
    const hasModel = isCustom ? saved?.customEndpoint?.modelId : saved?.model;
    const validConfig = saved?.provider && hasAuth && hasModel ? saved : null;
    return {
      messages: [],
      isStreaming: false,
      error: null,
      providerConfig: validConfig,
      sessionStats: INITIAL_STATS,
      currentSession: null,
      sessions: [],
      debug: INITIAL_DEBUG,
    };
  });
  const [skills, setSkills] = useState<SkillMetadata[]>([]);
  const [skillBodies, setSkillBodies] = useState<Record<string, string>>({});
  const OAUTH_PROVIDER_IDS: BrowserOAuthProviderId[] = ["anthropic", "github-copilot", "openai-codex"];

  const [oauthStatus, setOauthStatus] = useState<OAuthStatus>(() =>
    Object.fromEntries(OAUTH_PROVIDER_IDS.map((id) => [id, false])) as OAuthStatus,
  );
  const [oauthCredentials, setOauthCredentials] = useState<OAuthCredentialRecord[]>([]);

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
  const oauthCredentialsRef = useRef<OAuthCredentialRecord[]>([]);

  useEffect(() => {
    oauthCredentialsRef.current = oauthCredentials;
  }, [oauthCredentials]);

  const availableProviders = getProviders();

  const getModelsForProvider = useCallback((provider: string): Model<any>[] => {
    if (provider === CUSTOM_PROVIDER_ID) return [];
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
          const chatMessage: ChatMessage = {
            id,
            role: "assistant",
            parts,
            timestamp: event.message.timestamp,
          };
          setState((prev) => ({
            ...prev,
            messages: [...prev.messages, chatMessage],
          }));
        }
        break;
      }
      case "message_update": {
        if (event.message.role === "assistant" && streamingMessageIdRef.current) {
          setState((prev) => {
            const messages = [...prev.messages];
            const idx = messages.findIndex((m) => m.id === streamingMessageIdRef.current);
            if (idx !== -1) {
              const parts = extractPartsFromAssistantMessage(event.message, messages[idx].parts);
              messages[idx] = { ...messages[idx], parts };
            }
            return { ...prev, messages };
          });
        }
        break;
      }
      case "message_end": {
        if (event.message.role === "assistant") {
          const assistantMsg = event.message as AssistantMessage;
          const isError = assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted";
          const rawError = assistantMsg.errorMessage || "Request failed";
          const formattedError = isError ? formatProviderError(rawError, providerConfigRef.current) : null;
          console.log("[Chat] Assistant message result:", event.message);
          console.log("[Chat] Usage:", assistantMsg.usage);
          console.log("[Chat] stopReason:", assistantMsg.stopReason, "errorMessage:", assistantMsg.errorMessage);

          setState((prev) => {
            const messages = [...prev.messages];
            const idx = messages.findIndex((m) => m.id === streamingMessageIdRef.current);

            if (isError) {
              if (idx !== -1) {
                messages.splice(idx, 1);
              }
            } else if (idx !== -1) {
              const parts = extractPartsFromAssistantMessage(event.message, messages[idx].parts);
              messages[idx] = { ...messages[idx], parts };
            }

            return {
              ...prev,
              messages,
              error: isError ? formattedError || rawError : prev.error,
              debug: isError
                ? {
                    ...prev.debug,
                    error: rawError,
                    timestamp: Date.now(),
                  }
                : prev.debug,
              sessionStats: isError
                ? prev.sessionStats
                : {
                    inputTokens: prev.sessionStats.inputTokens + assistantMsg.usage.input,
                    outputTokens: prev.sessionStats.outputTokens + assistantMsg.usage.output,
                    cacheRead: prev.sessionStats.cacheRead + assistantMsg.usage.cacheRead,
                    cacheWrite: prev.sessionStats.cacheWrite + assistantMsg.usage.cacheWrite,
                    totalCost: prev.sessionStats.totalCost + assistantMsg.usage.cost.total,
                    contextWindow: prev.sessionStats.contextWindow,
                    lastUsage: assistantMsg.usage,
                  },
            };
          });
          streamingMessageIdRef.current = null;
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
      case "tool_execution_update": {
        setState((prev) => {
          const messages = [...prev.messages];
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const partIdx = msg.parts.findIndex((p) => p.type === "toolCall" && p.id === event.toolCallId);
            if (partIdx !== -1) {
              const parts = [...msg.parts];
              const part = parts[partIdx];
              if (part.type === "toolCall") {
                let partialText: string;
                if (typeof event.partialResult === "string") {
                  partialText = event.partialResult;
                } else if (event.partialResult?.content && Array.isArray(event.partialResult.content)) {
                  partialText = event.partialResult.content
                    .filter((c: { type: string }) => c.type === "text")
                    .map((c: { text: string }) => c.text)
                    .join("\n");
                } else {
                  partialText = JSON.stringify(event.partialResult, null, 2);
                }
                parts[partIdx] = { ...part, result: partialText };
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
                let resultText: string;
                if (typeof event.result === "string") {
                  resultText = event.result;
                } else if (event.result?.content && Array.isArray(event.result.content)) {
                  resultText = event.result.content
                    .filter((c: { type: string }) => c.type === "text")
                    .map((c: { text: string }) => c.text)
                    .join("\n");
                } else {
                  resultText = JSON.stringify(event.result, null, 2);
                }
                parts[partIdx] = { ...part, status: event.isError ? "error" : "complete", result: resultText };
                messages[i] = { ...msg, parts };
              }
              break;
            }
          }
          return { ...prev, messages };
        });
        break;
      }
      case "agent_end": {
        isStreamingRef.current = false;
        setState((prev) => ({ ...prev, isStreaming: false }));
        streamingMessageIdRef.current = null;
        break;
      }
    }
  }, []);

  const applyConfig = useCallback(
    async (config: ProviderConfig, systemPrompt: string, apiKey: string) => {
      let contextWindow = 0;
      let baseModel: Model<any>;

      const isCustom = config.provider === CUSTOM_PROVIDER_ID;

      if (isCustom && config.customEndpoint) {
        baseModel = buildCustomModel(config.customEndpoint);
        contextWindow = config.customEndpoint.contextWindow;
      } else {
        try {
          baseModel = getModel(config.provider as any, config.model as any);
          contextWindow = baseModel.contextWindow;
        } catch {
          return;
        }
      }

      const oauthCreds =
        config.authMethod === "oauth" && config.oauthProvider
          ? oauthCredentialsRef.current.find((c) => c.id === config.oauthProvider)
          : null;
      const oauthModel = isCustom ? baseModel : applyOAuthModelOverrides(baseModel, config, oauthCreds);
      const proxiedModel = isCustom ? oauthModel : applyProxyToModel(oauthModel, config);
      const existingMessages = agentRef.current?.state.messages ?? [];

      if (agentRef.current) {
        agentRef.current.abort();
      }

      const agent = new Agent({
        initialState: {
          model: proxiedModel,
          systemPrompt,
          thinkingLevel: thinkingLevelToAgent(config.thinking),
          tools: EXCEL_TOOLS,
          messages: existingMessages,
        },
        streamFn: (model, context, options) => {
          const requestId = generateId();
          return streamSimple(model, context, {
            ...options,
            apiKey,
            onPayload: (payload) => {
              options?.onPayload?.(payload);
              const { preview, size } = buildPayloadPreview(payload);
              console.log("[Chat] Request payload:", {
                requestId,
                provider: model.provider,
                model: model.id,
                baseUrl: model.baseUrl,
                payload,
              });
              setState((prev) => ({
                ...prev,
                debug: {
                  requestId,
                  provider: model.provider,
                  model: model.id,
                  baseUrl: model.baseUrl,
                  payloadPreview: preview,
                  payloadSize: size,
                  error: null,
                  timestamp: Date.now(),
                },
              }));
            },
          });
        },
      });
      agentRef.current = agent;
      agent.subscribe(handleAgentEvent);
      pendingConfigRef.current = null;
      pendingSystemPromptRef.current = null;
      providerConfigRef.current = config;

      console.log("[Chat] Model info:", {
        id: baseModel.id,
        contextWindow: baseModel.contextWindow,
        maxTokens: baseModel.maxTokens,
        cost: baseModel.cost,
        reasoning: baseModel.reasoning,
      });

      setState((prev) => ({
        ...prev,
        providerConfig: config,
        error: null,
        sessionStats: { ...prev.sessionStats, contextWindow },
      }));
    },
    [handleAgentEvent],
  );

  const setProviderConfig = useCallback(
    async (config: ProviderConfig) => {
      providerConfigRef.current = config;

      const result = await getApiKeyForConfig(config, oauthCredentialsRef.current, config.proxyUrl);
      if (!result) {
        setState((prev) => ({
          ...prev,
          providerConfig: config,
          error: config.authMethod === "oauth" ? `Not logged in with ${config.oauthProvider}` : null,
        }));
        return;
      }

      if (result.updatedCredentials) {
        await saveOAuthCredentials(result.updatedCredentials.id, {
          refresh: result.updatedCredentials.refresh,
          access: result.updatedCredentials.access,
          expires: result.updatedCredentials.expires,
          ...result.updatedCredentials,
        });
        const next = (() => {
          const existing = oauthCredentialsRef.current;
          const idx = existing.findIndex((c) => c.id === result.updatedCredentials!.id);
          if (idx === -1) return [...existing, result.updatedCredentials!];
          const updated = [...existing];
          updated[idx] = result.updatedCredentials!;
          return updated;
        })();
        oauthCredentialsRef.current = next;
        setOauthCredentials(next);
      }

      if (isStreamingRef.current) {
        pendingConfigRef.current = config;
        setState((prev) => ({ ...prev, providerConfig: config }));
        return;
      }

      await applyConfig(config, systemPromptRef.current, result.apiKey);
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

      if (config.provider === "openai-codex" && (!config.useProxy || !config.proxyUrl)) {
        const message = "OpenAI Codex requires a CORS proxy in this browser. Enable the proxy and add a proxy URL.";
        setState((prev) => ({
          ...prev,
          error: message,
          debug: { ...prev.debug, error: message, timestamp: Date.now() },
        }));
        return;
      }

      const result = await getApiKeyForConfig(config, oauthCredentialsRef.current, config.proxyUrl);
      if (!result) {
        setState((prev) => ({
          ...prev,
          error: config.authMethod === "oauth" ? `Not logged in with ${config.oauthProvider}` : "No API key configured",
        }));
        return;
      }

      if (result.updatedCredentials) {
        await saveOAuthCredentials(result.updatedCredentials.id, {
          refresh: result.updatedCredentials.refresh,
          access: result.updatedCredentials.access,
          expires: result.updatedCredentials.expires,
          ...result.updatedCredentials,
        });
        const next = (() => {
          const existing = oauthCredentialsRef.current;
          const idx = existing.findIndex((c) => c.id === result.updatedCredentials!.id);
          if (idx === -1) return [...existing, result.updatedCredentials!];
          const updated = [...existing];
          updated[idx] = result.updatedCredentials!;
          return updated;
        })();
        oauthCredentialsRef.current = next;
        setOauthCredentials(next);
      }

      const pendingConfig = pendingConfigRef.current;
      const pendingSystemPrompt = pendingSystemPromptRef.current;
      if (pendingConfig || pendingSystemPrompt) {
        const nextConfig = pendingConfig ?? config;
        const nextPrompt = pendingSystemPrompt ?? systemPromptRef.current;
        await applyConfig(nextConfig, nextPrompt, result.apiKey);
      }

      const agent = agentRef.current;
      if (!agent) {
        await applyConfig(config, systemPromptRef.current, result.apiKey);
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
          debug: {
            ...prev.debug,
            error: err instanceof Error ? err.message : "An error occurred",
            timestamp: Date.now(),
          },
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
    setState((prev) => ({ ...prev, messages: [], error: null, sessionStats: INITIAL_STATS, debug: INITIAL_DEBUG }));
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
    if (!currentSessionIdRef.current || !workbookIdRef.current) return;
    if (isStreamingRef.current) {
      console.log("[Chat] deleteCurrentSession blocked: streaming in progress");
      return;
    }
    agentRef.current?.reset();
    await deleteSession(currentSessionIdRef.current);
    const session = await getOrCreateCurrentSession(workbookIdRef.current);
    currentSessionIdRef.current = session.id;
    await refreshSessions();
    setState((prev) => ({
      ...prev,
      messages: session.messages,
      currentSession: session,
      error: null,
      sessionStats: INITIAL_STATS,
    }));
  }, [refreshSessions]);

  const loginWithOAuth = useCallback(async (providerId: BrowserOAuthProviderId, credentials: OAuthCredentials) => {
    await saveOAuthCredentials(providerId, credentials);
    const newCred: OAuthCredentialRecord = {
      id: providerId,
      ...credentials,
      updatedAt: Date.now(),
    };
    const next = (() => {
      const existing = oauthCredentialsRef.current;
      const idx = existing.findIndex((c) => c.id === providerId);
      if (idx === -1) return [...existing, newCred];
      const updated = [...existing];
      updated[idx] = newCred;
      return updated;
    })();
    oauthCredentialsRef.current = next;
    setOauthCredentials(next);
    setOauthStatus((prev) => ({ ...prev, [providerId]: true }));
  }, []);

  const logoutOAuth = useCallback(async (providerId: BrowserOAuthProviderId) => {
    await deleteOAuthCredentials(providerId);
    const next = oauthCredentialsRef.current.filter((c) => c.id !== providerId);
    oauthCredentialsRef.current = next;
    setOauthCredentials(next);
    setOauthStatus((prev) => ({ ...prev, [providerId]: false }));
  }, []);

  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (prevStreamingRef.current && !state.isStreaming && currentSessionIdRef.current) {
      const sessionId = currentSessionIdRef.current;
      saveSession(sessionId, state.messages)
        .then(async () => {
          await refreshSessions();
          const updated = await getSession(sessionId);
          if (updated) {
            setState((prev) => ({ ...prev, currentSession: updated }));
          }
        })
        .catch(console.error);
    }
    prevStreamingRef.current = state.isStreaming;
  }, [state.isStreaming, state.messages, refreshSessions]);

  useEffect(() => {
    return () => {
      agentRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (sessionLoadedRef.current) return;
    sessionLoadedRef.current = true;

    getOrCreateWorkbookId()
      .then(async (id) => {
        workbookIdRef.current = id;
        console.log("[Chat] Workbook ID:", id);
        const session = await getOrCreateCurrentSession(id);
        currentSessionIdRef.current = session.id;
        const sessions = await listSessions(id);
        console.log("[Chat] Loaded session:", session.id, "with", session.messages.length, "messages");
        setState((prev) => ({
          ...prev,
          messages: session.messages,
          currentSession: session,
          sessions,
        }));
      })
      .catch((err) => {
        console.error("[Chat] Failed to load session:", err);
      });
  }, []);

  useEffect(() => {
    getAllOAuthCredentials()
      .then((creds) => {
        setOauthCredentials(creds);
        const status = Object.fromEntries(OAUTH_PROVIDER_IDS.map((id) => [id, false])) as OAuthStatus;
        for (const cred of creds) {
          if (OAUTH_PROVIDER_IDS.includes(cred.id as BrowserOAuthProviderId)) {
            status[cred.id as BrowserOAuthProviderId] = true;
          }
        }
        setOauthStatus(status);
      })
      .catch((err) => console.error("[Chat] Failed to load OAuth credentials:", err));
  }, []);

  useEffect(() => {
    const saved = loadSavedConfig();
    if (saved?.provider) {
      const isCustom = saved.provider === CUSTOM_PROVIDER_ID;
      const hasAuth = saved.authMethod === "oauth" ? saved.oauthProvider : saved.apiKey;
      const hasModel = isCustom ? saved.customEndpoint?.modelId : saved.model;
      if (hasAuth && hasModel) {
        setProviderConfig(saved);
      }
    }
  }, [setProviderConfig]);

  useEffect(() => {
    let cancelled = false;
    listSkills()
      .then(async (loaded) => {
        if (cancelled) return;
        let resolved = loaded;
        const legacy = loadLegacySkills();
        let hadLegacyErrors = false;
        const legacyByName = new Map<string, { content: string; enabled?: boolean; sourceType?: string; source?: string }>();

        if (legacy.length > 0) {
          for (const legacySkill of legacy) {
            const content = legacySkill.content;
            if (!content) continue;
            const name = extractSkillName(content);
            if (name) {
              legacyByName.set(name, { ...legacySkill, content });
            }
          }
        }

        if (resolved.length === 0 && legacy.length > 0) {
          for (const legacySkill of legacy) {
            if (!legacySkill.content) continue;
            const result = buildSkillPackageFromMarkdown({
              content: legacySkill.content,
              sourceType: "paste",
              source: legacySkill.source,
              enabled: legacySkill.enabled ?? false,
            });
            if (!result.skill) {
              console.warn("[Chat] Skipping legacy skill:", result.errors.join(" "));
              hadLegacyErrors = true;
              continue;
            }
            const files = result.skill.files.map((file) => ({
              ...file,
              id: `${result.skill?.metadata.id}:${file.path}`,
              skillId: result.skill?.metadata.id,
            }));
            await upsertSkillPackage(result.skill.metadata, files);
          }
          if (!hadLegacyErrors) {
            localStorage.removeItem(LEGACY_SKILLS_KEY);
          }
          resolved = await listSkills();
        }

        if (resolved.length > 0 && legacyByName.size > 0) {
          let repairedMissing = false;
          for (const skill of resolved) {
            const existingSkillMd = await getSkillFile(skill.id, "SKILL.md");
            if (existingSkillMd && existingSkillMd.content && existingSkillMd.content.length > 0) continue;
            const legacySkill = legacyByName.get(skill.name) ?? legacyByName.get(skill.id);
            if (!legacySkill?.content) continue;
            const existingFiles = await listSkillFiles(skill.id);
            const skillMdFile = {
              id: `${skill.id}:SKILL.md`,
              skillId: skill.id,
              path: "SKILL.md",
              content: legacySkill.content,
              encoding: "utf-8" as const,
              mimeType: "text/markdown",
              size: legacySkill.content.length,
            };
            const nextFiles = [...existingFiles, skillMdFile];
            await upsertSkillPackage(skill, nextFiles);
            repairedMissing = true;
          }
          if (repairedMissing) {
            resolved = await listSkills();
          }
        }

        setSkills(resolved);
        const enabledSkills = resolved.filter((skill) => skill.enabled);
        if (enabledSkills.length === 0) {
          setSkillBodies({});
          return;
        }
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
      })
      .catch((err) => console.error("[Chat] Failed to load skills:", err));
    return () => {
      cancelled = true;
    };
  }, [loadSkillContent]);

  useEffect(() => {
    const prompt = buildSystemPrompt(skills, skillBodies);
    systemPromptRef.current = prompt;
    const config = providerConfigRef.current;
    if (!config) return;
    if (isStreamingRef.current) {
      pendingSystemPromptRef.current = prompt;
      return;
    }

    getApiKeyForConfig(config, oauthCredentialsRef.current, config.proxyUrl).then((result) => {
      if (!result) return;
      if (result.updatedCredentials) {
        saveOAuthCredentials(result.updatedCredentials.id, {
          refresh: result.updatedCredentials.refresh,
          access: result.updatedCredentials.access,
          expires: result.updatedCredentials.expires,
          ...result.updatedCredentials,
        }).catch(console.error);
        const next = (() => {
          const existing = oauthCredentialsRef.current;
          const idx = existing.findIndex((c) => c.id === result.updatedCredentials!.id);
          if (idx === -1) return [...existing, result.updatedCredentials!];
          const updated = [...existing];
          updated[idx] = result.updatedCredentials!;
          return updated;
        })();
        oauthCredentialsRef.current = next;
        setOauthCredentials(next);
      }
      applyConfig(config, prompt, result.apiKey);
    });
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

    const result = await getApiKeyForConfig(config, oauthCredentialsRef.current, config.proxyUrl);
    if (!result) {
      throw new Error(config.authMethod === "oauth" ? `Not logged in with ${config.oauthProvider}` : "No API key configured");
    }

    if (result.updatedCredentials) {
      await saveOAuthCredentials(result.updatedCredentials.id, {
        refresh: result.updatedCredentials.refresh,
        access: result.updatedCredentials.access,
        expires: result.updatedCredentials.expires,
        ...result.updatedCredentials,
      });
      const next = (() => {
        const existing = oauthCredentialsRef.current;
        const idx = existing.findIndex((c) => c.id === result.updatedCredentials!.id);
        if (idx === -1) return [...existing, result.updatedCredentials!];
        const updated = [...existing];
        updated[idx] = result.updatedCredentials!;
        return updated;
      })();
      oauthCredentialsRef.current = next;
      setOauthCredentials(next);
    }

    let baseModel: Model<any>;
    const isCustom = config.provider === CUSTOM_PROVIDER_ID;

    if (isCustom && config.customEndpoint) {
      baseModel = buildCustomModel(config.customEndpoint);
    } else {
      try {
        baseModel = getModel(config.provider as any, config.model as any);
      } catch {
        throw new Error("Invalid model configuration.");
      }
    }

    const oauthCreds =
      config.authMethod === "oauth" && config.oauthProvider
        ? result.credentials ?? oauthCredentialsRef.current.find((c) => c.id === config.oauthProvider)
        : null;
    const oauthModel = isCustom ? baseModel : applyOAuthModelOverrides(baseModel, config, oauthCreds);
    const proxiedModel = isCustom ? oauthModel : applyProxyToModel(oauthModel, config);
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
          apiKey: result.apiKey,
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
        oauthStatus,
        loginWithOAuth,
        logoutOAuth,
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
