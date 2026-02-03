import { AlertCircle, CheckCircle2, Copy, ExternalLink, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getModels } from "@mariozechner/pi-ai";
import type { BrowserOAuthProviderId } from "./types";

export interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

interface OAuthLoginDialogProps {
  provider: BrowserOAuthProviderId;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (credentials: OAuthCredentials) => void;
  proxyUrl?: string;
}

type FlowState =
  | { step: "idle" }
  | { step: "loading"; message: string }
  | { step: "prompt_domain" }
  | { step: "waiting_code"; provider: "anthropic" | "openai-codex"; authUrl: string; codeVerifier: string; state: string }
  | { step: "waiting_device"; deviceCode: string; userCode: string; verificationUrl: string; expiresAt: number; domain: string }
  | { step: "exchanging" }
  | { step: "success" }
  | { step: "error"; message: string };

const ANTHROPIC_AUTH_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const ANTHROPIC_SCOPE = "org:create_api_key user:profile user:inference";

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
} as const;

const OPENAI_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_SCOPE = "openid profile email offline_access";
const OPENAI_ORIGINATOR = "pi";
const OPENAI_JWT_CLAIM_PATH = "https://api.openai.com/auth";

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);

  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64urlEncode(new Uint8Array(hash));

  return { verifier, challenge };
}

function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildProxiedUrl(url: string, proxyUrl?: string): string {
  if (!proxyUrl) return url;
  return `${proxyUrl}/?url=${encodeURIComponent(url)}`;
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Not a URL
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
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

function getGitHubUrls(domain: string): { deviceCodeUrl: string; accessTokenUrl: string; copilotTokenUrl: string } {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
  };
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

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

async function enableGitHubCopilotModel(token: string, modelId: string, enterpriseDomain?: string, proxyUrl?: string) {
  const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
  const url = buildProxiedUrl(`${baseUrl}/models/${modelId}/policy`, proxyUrl);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "openai-intent": "chat-policy",
        "x-interaction-type": "chat-policy",
        ...COPILOT_HEADERS,
      },
      body: JSON.stringify({ state: "enabled" }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function enableAllGitHubCopilotModels(
  token: string,
  enterpriseDomain?: string,
  proxyUrl?: string,
): Promise<void> {
  const models = getModels("github-copilot");
  await Promise.all(models.map((model) => enableGitHubCopilotModel(token, model.id, enterpriseDomain, proxyUrl)));
}

async function exchangeAnthropicCode(
  code: string,
  state: string,
  verifier: string,
  proxyUrl?: string,
): Promise<OAuthCredentials> {
  const tokenUrl = buildProxiedUrl(ANTHROPIC_TOKEN_URL, proxyUrl);
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: ANTHROPIC_CLIENT_ID,
      code,
      state,
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const data = await response.json();
  return {
    access: data.access_token,
    refresh: data.refresh_token || "",
    expires: Date.now() + (data.expires_in || 3600) * 1000 - 5 * 60 * 1000,
  };
}

async function exchangeOpenAICodexCode(
  code: string,
  verifier: string,
  proxyUrl?: string,
): Promise<OAuthCredentials> {
  const tokenUrl = buildProxiedUrl(OPENAI_TOKEN_URL, proxyUrl);
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: OPENAI_REDIRECT_URI,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const data = await response.json();
  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw new Error("Token response missing fields");
  }

  const accountId = getOpenAICodexAccountId(data.access_token);
  if (!accountId) {
    throw new Error("Failed to extract accountId from token");
  }

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
    accountId,
  };
}

async function startGitHubDeviceFlow(domain: string, proxyUrl?: string) {
  const urls = getGitHubUrls(domain);
  const deviceCodeUrl = buildProxiedUrl(urls.deviceCodeUrl, proxyUrl);
  const data = await fetchJson(deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "GitHubCopilotChat/0.35.0",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!data || typeof data !== "object") {
    throw new Error("Invalid device code response");
  }

  const deviceCode = (data as Record<string, unknown>).device_code;
  const userCode = (data as Record<string, unknown>).user_code;
  const verificationUri = (data as Record<string, unknown>).verification_uri;
  const interval = (data as Record<string, unknown>).interval;
  const expiresIn = (data as Record<string, unknown>).expires_in;

  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof interval !== "number" ||
    typeof expiresIn !== "number"
  ) {
    throw new Error("Invalid device code response fields");
  }

  return { deviceCode, userCode, verificationUri, interval, expiresIn };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }

    const timeout = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Login cancelled"));
      },
      { once: true },
    );
  });
}

async function pollForGitHubAccessToken(
  domain: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresIn: number,
  proxyUrl?: string,
  signal?: AbortSignal,
): Promise<string> {
  const urls = getGitHubUrls(domain);
  const deadline = Date.now() + expiresIn * 1000;
  let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error("Login cancelled");
    }

    const accessTokenUrl = buildProxiedUrl(urls.accessTokenUrl, proxyUrl);
    const raw = await fetchJson(accessTokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "GitHubCopilotChat/0.35.0",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (raw && typeof raw === "object" && typeof (raw as { access_token?: string }).access_token === "string") {
      return (raw as { access_token: string }).access_token;
    }

    if (raw && typeof raw === "object" && typeof (raw as { error?: string }).error === "string") {
      const err = (raw as { error: string }).error;
      if (err === "authorization_pending") {
        await abortableSleep(intervalMs, signal);
        continue;
      }
      if (err === "slow_down") {
        intervalMs += 5000;
        await abortableSleep(intervalMs, signal);
        continue;
      }
      throw new Error(`Device flow failed: ${err}`);
    }

    await abortableSleep(intervalMs, signal);
  }

  throw new Error("Device flow timed out");
}

async function refreshGitHubCopilotToken(
  refreshToken: string,
  enterpriseDomain?: string,
  proxyUrl?: string,
): Promise<OAuthCredentials> {
  const domain = enterpriseDomain || "github.com";
  const urls = getGitHubUrls(domain);
  const tokenUrl = buildProxiedUrl(urls.copilotTokenUrl, proxyUrl);
  const raw = await fetchJson(tokenUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${refreshToken}`,
      ...COPILOT_HEADERS,
    },
  });

  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid Copilot token response");
  }

  const token = (raw as Record<string, unknown>).token;
  const expiresAt = (raw as Record<string, unknown>).expires_at;

  if (typeof token !== "string" || typeof expiresAt !== "number") {
    throw new Error("Invalid Copilot token response fields");
  }

  return {
    refresh: refreshToken,
    access: token,
    expires: expiresAt * 1000 - 5 * 60 * 1000,
    enterpriseUrl: enterpriseDomain,
  };
}

export function OAuthLoginDialog({ provider, isOpen, onClose, onSuccess, proxyUrl }: OAuthLoginDialogProps) {
  const [flowState, setFlowState] = useState<FlowState>({ step: "idle" });
  const [manualCode, setManualCode] = useState("");
  const [enterpriseDomainInput, setEnterpriseDomainInput] = useState("");
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  const cancelPending = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPending();
    };
  }, [cancelPending]);

  useEffect(() => {
    if (!isOpen) {
      setFlowState({ step: "idle" });
      setManualCode("");
      setEnterpriseDomainInput("");
      cancelPending();
    }
  }, [isOpen, cancelPending]);

  const startAnthropicFlow = useCallback(async () => {
    setManualCode("");
    setFlowState({ step: "loading", message: "Generating authorization URL..." });

    try {
      const { verifier, challenge } = await generatePKCE();
      const state = verifier;

      const params = new URLSearchParams({
        code: "true",
        response_type: "code",
        client_id: ANTHROPIC_CLIENT_ID,
        redirect_uri: ANTHROPIC_REDIRECT_URI,
        scope: ANTHROPIC_SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      });

      const authUrl = `${ANTHROPIC_AUTH_URL}?${params.toString()}`;
      setFlowState({ step: "waiting_code", provider: "anthropic", authUrl, codeVerifier: verifier, state });
    } catch (err) {
      setFlowState({ step: "error", message: err instanceof Error ? err.message : "Failed to start authorization" });
    }
  }, []);

  const startOpenAICodexFlow = useCallback(async () => {
    setManualCode("");
    setFlowState({ step: "loading", message: "Generating authorization URL..." });

    try {
      const { verifier, challenge } = await generatePKCE();
      const state = generateState();

      const params = new URLSearchParams({
        response_type: "code",
        client_id: OPENAI_CLIENT_ID,
        redirect_uri: OPENAI_REDIRECT_URI,
        scope: OPENAI_SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: OPENAI_ORIGINATOR,
      });

      const authUrl = `${OPENAI_AUTHORIZE_URL}?${params.toString()}`;
      setFlowState({ step: "waiting_code", provider: "openai-codex", authUrl, codeVerifier: verifier, state });
    } catch (err) {
      setFlowState({ step: "error", message: err instanceof Error ? err.message : "Failed to start authorization" });
    }
  }, []);

  const startGitHubCopilotFlow = useCallback(
    async (inputDomain: string) => {
      setFlowState({ step: "loading", message: "Requesting device code..." });
      cancelPending();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const trimmed = inputDomain.trim();
        const normalized = normalizeDomain(inputDomain);
        if (trimmed && !normalized) {
          throw new Error("Invalid GitHub Enterprise URL/domain");
        }
        const domain = normalized || "github.com";

        const device = await startGitHubDeviceFlow(domain, proxyUrl);
        const expiresAt = Date.now() + device.expiresIn * 1000;

        setFlowState({
          step: "waiting_device",
          deviceCode: device.deviceCode,
          userCode: device.userCode,
          verificationUrl: device.verificationUri,
          expiresAt,
          domain,
        });

        const githubAccessToken = await pollForGitHubAccessToken(
          domain,
          device.deviceCode,
          device.interval,
          device.expiresIn,
          proxyUrl,
          controller.signal,
        );

        setFlowState({ step: "loading", message: "Finishing login..." });

        const credentials = await refreshGitHubCopilotToken(githubAccessToken, normalized || undefined, proxyUrl);
        await enableAllGitHubCopilotModels(credentials.access, normalized || undefined, proxyUrl);

        setFlowState({ step: "success" });
        setTimeout(() => {
          if (mountedRef.current) {
            onSuccess(credentials);
            onClose();
          }
        }, 1000);
      } catch (err) {
        if (!mountedRef.current) return;
        if ((err as Error).message === "Login cancelled") return;
        setFlowState({ step: "error", message: err instanceof Error ? err.message : "Failed to start device flow" });
      }
    },
    [cancelPending, proxyUrl, onClose, onSuccess],
  );

  const startFlow = useCallback(() => {
    if (provider === "anthropic") {
      startAnthropicFlow();
    } else if (provider === "github-copilot") {
      setFlowState({ step: "prompt_domain" });
    } else if (provider === "openai-codex") {
      startOpenAICodexFlow();
    }
  }, [provider, startAnthropicFlow, startGitHubCopilotFlow, startOpenAICodexFlow]);

  useEffect(() => {
    if (isOpen && flowState.step === "idle") {
      startFlow();
    }
  }, [isOpen, flowState.step, startFlow]);

  const handleSubmitCode = async () => {
    if (flowState.step !== "waiting_code") return;
    if (!manualCode.trim()) return;

    if (flowState.provider === "anthropic") {
      const [code, state] = manualCode.trim().split("#", 2);
      if (!code || !state) {
        setFlowState({ step: "error", message: "Paste the full code in the form code#state." });
        return;
      }
      if (state !== flowState.state) {
        setFlowState({ step: "error", message: "State mismatch. Please start the login again." });
        return;
      }

      try {
        setFlowState({ step: "exchanging" });
        const credentials = await exchangeAnthropicCode(code, state, flowState.codeVerifier, proxyUrl);
        setFlowState({ step: "success" });
        setTimeout(() => {
          if (mountedRef.current) {
            onSuccess(credentials);
            onClose();
          }
        }, 1000);
      } catch (err) {
        setFlowState({ step: "error", message: err instanceof Error ? err.message : "Token exchange failed" });
      }
      return;
    }

    if (flowState.provider === "openai-codex") {
      const parsed = parseAuthorizationInput(manualCode);
      if (!parsed.code) {
        setFlowState({ step: "error", message: "Missing authorization code." });
        return;
      }
      if (parsed.state && parsed.state !== flowState.state) {
        setFlowState({ step: "error", message: "State mismatch. Please start the login again." });
        return;
      }

      try {
        setFlowState({ step: "exchanging" });
        const credentials = await exchangeOpenAICodexCode(parsed.code, flowState.codeVerifier, proxyUrl);
        setFlowState({ step: "success" });
        setTimeout(() => {
          if (mountedRef.current) {
            onSuccess(credentials);
            onClose();
          }
        }, 1000);
      } catch (err) {
        setFlowState({ step: "error", message: err instanceof Error ? err.message : "Token exchange failed" });
      }
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
    }
  };

  if (!isOpen) return null;

  const providerName =
    provider === "anthropic" ? "Anthropic" : provider === "github-copilot" ? "GitHub Copilot" : "OpenAI Codex";

  const inputStyle = {
    borderRadius: "var(--chat-radius)",
    fontFamily: "var(--chat-font-mono)",
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div
        className="bg-(--chat-bg) border border-(--chat-border) max-w-md w-full p-6 relative"
        style={{ borderRadius: "var(--chat-radius)" }}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-(--chat-text-muted) hover:text-(--chat-text-secondary)"
        >
          <X size={16} />
        </button>

        <h2 className="text-sm font-medium text-(--chat-text-primary) mb-4">Login with {providerName}</h2>

        {flowState.step === "loading" && (
          <div className="flex items-center gap-3 text-(--chat-text-secondary)">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-xs">{flowState.message}</span>
          </div>
        )}

        {flowState.step === "prompt_domain" && (
          <div className="space-y-4">
            <p className="text-xs text-(--chat-text-secondary) leading-relaxed">
              If you use GitHub Enterprise, enter your domain. Leave blank for github.com.
            </p>
            <div>
              <label className="block text-xs text-(--chat-text-secondary) mb-1.5">Enterprise Domain (optional)</label>
              <input
                type="text"
                value={enterpriseDomainInput}
                onChange={(e) => setEnterpriseDomainInput(e.target.value)}
                placeholder="company.ghe.com"
                className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                           text-sm px-3 py-2 border border-(--chat-border)
                           placeholder:text-(--chat-text-muted)
                           focus:outline-none focus:border-(--chat-border-active)"
                style={inputStyle}
                onKeyDown={(e) => e.key === "Enter" && startGitHubCopilotFlow(enterpriseDomainInput)}
              />
            </div>
            <button
              onClick={() => startGitHubCopilotFlow(enterpriseDomainInput)}
              className="w-full py-2 text-xs bg-(--chat-accent) text-white
                         hover:opacity-90 transition-opacity"
              style={{ borderRadius: "var(--chat-radius)" }}
            >
              Continue
            </button>
          </div>
        )}

        {flowState.step === "waiting_code" && (
          <div className="space-y-4">
            {flowState.provider === "anthropic" ? (
              <p className="text-xs text-(--chat-text-secondary) leading-relaxed">
                1. Click the button below to open Anthropic&apos;s authorization page
                <br />
                2. Sign in and authorize the application
                <br />
                3. Copy the code shown in the form <code>code#state</code> and paste it here
              </p>
            ) : (
              <p className="text-xs text-(--chat-text-secondary) leading-relaxed">
                1. Click the button below to open OpenAI&apos;s authorization page
                <br />
                2. Sign in and authorize the application
                <br />
                3. You&apos;ll be redirected to <code>http://localhost:1455/auth/callback</code>. The page may fail to load
                <br />
                4. Copy the full URL from the address bar (or just the <code>code</code>) and paste it here
              </p>
            )}

            <a
              href={flowState.authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-2 text-xs
                         bg-(--chat-accent) text-white hover:opacity-90 transition-opacity"
              style={{ borderRadius: "var(--chat-radius)" }}
            >
              <ExternalLink size={14} />
              Open {flowState.provider === "anthropic" ? "Anthropic" : "OpenAI"} Authorization
            </a>

            <div>
              <label className="block text-xs text-(--chat-text-secondary) mb-1.5">
                {flowState.provider === "anthropic" ? "Authorization Code" : "Redirect URL or Code"}
              </label>
              <input
                type="text"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                placeholder={flowState.provider === "anthropic" ? "Paste code#state" : "Paste redirect URL or code"}
                className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                           text-sm px-3 py-2 border border-(--chat-border)
                           placeholder:text-(--chat-text-muted)
                           focus:outline-none focus:border-(--chat-border-active)"
                style={inputStyle}
                onKeyDown={(e) => e.key === "Enter" && handleSubmitCode()}
              />
            </div>

            <button
              onClick={handleSubmitCode}
              disabled={!manualCode.trim()}
              className="w-full py-2 text-xs bg-(--chat-accent) text-white
                         hover:opacity-90 transition-opacity disabled:opacity-50"
              style={{ borderRadius: "var(--chat-radius)" }}
            >
              Submit Code
            </button>
          </div>
        )}

        {flowState.step === "waiting_device" && (
          <div className="space-y-4">
            <p className="text-xs text-(--chat-text-secondary) leading-relaxed">
              1. Go to the verification URL below
              <br />
              2. Enter the code shown
              <br />
              3. Authorize the application
            </p>

            <div>
              <label className="block text-xs text-(--chat-text-secondary) mb-1.5">Verification URL</label>
              <a
                href={flowState.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-xs text-(--chat-accent) hover:underline"
              >
                <ExternalLink size={12} />
                {flowState.verificationUrl}
              </a>
            </div>

            <div>
              <label className="block text-xs text-(--chat-text-secondary) mb-1.5">Your Code</label>
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 bg-(--chat-input-bg) text-(--chat-text-primary)
                             text-lg font-mono px-4 py-3 text-center tracking-widest
                             border border-(--chat-border)"
                  style={{ borderRadius: "var(--chat-radius)" }}
                >
                  {flowState.userCode}
                </code>
                <button
                  onClick={() => copyToClipboard(flowState.userCode)}
                  className="p-3 text-(--chat-text-muted) hover:text-(--chat-text-secondary)
                             border border-(--chat-border) bg-(--chat-input-bg)"
                  style={{ borderRadius: "var(--chat-radius)" }}
                >
                  {copied ? <CheckCircle2 size={16} className="text-(--chat-success)" /> : <Copy size={16} />}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-(--chat-text-muted)">
              <Loader2 size={12} className="animate-spin" />
              <span>Waiting for authorization...</span>
            </div>
          </div>
        )}

        {flowState.step === "exchanging" && (
          <div className="flex items-center gap-3 text-(--chat-text-secondary)">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-xs">Exchanging code for tokens...</span>
          </div>
        )}

        {flowState.step === "success" && (
          <div className="flex items-center gap-3 text-(--chat-success)">
            <CheckCircle2 size={16} />
            <span className="text-xs">Successfully logged in!</span>
          </div>
        )}

        {flowState.step === "error" && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 text-(--chat-error)">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              <span className="text-xs">{flowState.message}</span>
            </div>
            <button
              onClick={startFlow}
              className="w-full py-2 text-xs bg-(--chat-accent) text-white
                         hover:opacity-90 transition-opacity"
              style={{ borderRadius: "var(--chat-radius)" }}
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
