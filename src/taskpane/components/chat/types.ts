export type ChatTab = "chat" | "settings" | "skills";

export type AuthMethod = "apiKey" | "oauth";
export type BrowserOAuthProviderId = "anthropic" | "github-copilot" | "openai-codex";

export interface CustomEndpointConfig {
  baseUrl: string;
  modelId: string;
  modelName?: string;
  contextWindow: number;
  maxTokens?: number;
  supportsImages?: boolean;
}

export interface ExtendedProviderConfig {
  provider: string;
  model: string;
  authMethod: AuthMethod;
  apiKey?: string;
  oauthProvider?: BrowserOAuthProviderId;
  customEndpoint?: CustomEndpointConfig;
  useProxy: boolean;
  proxyUrl: string;
  thinking: "none" | "low" | "medium" | "high";
}
