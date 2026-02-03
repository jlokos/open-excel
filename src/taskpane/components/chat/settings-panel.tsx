import { Check, Eye, EyeOff, LogIn, LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { type ThinkingLevel, useChat } from "./chat-context";
import { OAuthLoginDialog, type OAuthCredentials } from "./oauth-login-dialog";
import type { AuthMethod, BrowserOAuthProviderId, CustomEndpointConfig, ExtendedProviderConfig } from "./types";

const STORAGE_KEY = "openexcel-provider-config";
const CUSTOM_PROVIDER_ID = "custom";

interface SavedConfig extends ExtendedProviderConfig {}

function loadSavedConfig(): SavedConfig | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const config = JSON.parse(saved);
      // Migrate old format
      if (config.proxyUrl === undefined) config.proxyUrl = "";
      if (config.authMethod === undefined) config.authMethod = "apiKey";
      return config;
    }
  } catch {}
  return null;
}

function saveConfig(config: SavedConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

const THINKING_LEVELS: { value: ThinkingLevel; label: string }[] = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const OAUTH_PROVIDERS: { id: BrowserOAuthProviderId; name: string; description: string; forProviders: string[] }[] = [
  { id: "anthropic", name: "Anthropic", description: "Use your Claude Pro/Max subscription", forProviders: ["anthropic"] },
  { id: "github-copilot", name: "GitHub Copilot", description: "Use your Copilot subscription", forProviders: ["github-copilot"] },
  { id: "openai-codex", name: "OpenAI Codex", description: "Use your ChatGPT Plus/Pro subscription", forProviders: ["openai-codex"] },
];

export function SettingsPanel() {
  const {
    state,
    setProviderConfig,
    availableProviders,
    getModelsForProvider,
    oauthStatus,
    loginWithOAuth,
    logoutOAuth,
  } = useChat();

  const [saved] = useState(loadSavedConfig);
  const isLocalhost = typeof window !== "undefined" && /^(localhost|127\\.0\\.0\\.1)$/.test(window.location.hostname);
  const defaultProxyUrl = isLocalhost ? `${window.location.origin}/proxy` : "";
  const [provider, setProvider] = useState(() => saved?.provider || "");
  const [apiKey, setApiKey] = useState(() => saved?.apiKey || "");
  const [model, setModel] = useState(() => saved?.model || "");
  const [showKey, setShowKey] = useState(false);
  const [useProxy, setUseProxy] = useState(() => saved?.useProxy !== false);
  const [proxyUrl, setProxyUrl] = useState(() => saved?.proxyUrl || defaultProxyUrl);
  const [thinking, setThinking] = useState<ThinkingLevel>(() => saved?.thinking || "none");
  const [authMethod, setAuthMethod] = useState<AuthMethod>(() => saved?.authMethod || "apiKey");
  const [oauthProvider, setOauthProvider] = useState<BrowserOAuthProviderId | undefined>(
    () => saved?.oauthProvider,
  );

  // Custom endpoint state
  const [customBaseUrl, setCustomBaseUrl] = useState(() => saved?.customEndpoint?.baseUrl || "");
  const [customModelId, setCustomModelId] = useState(() => saved?.customEndpoint?.modelId || "");
  const [customModelName, setCustomModelName] = useState(() => saved?.customEndpoint?.modelName || "");
  const [customContextWindow, setCustomContextWindow] = useState(
    () => saved?.customEndpoint?.contextWindow?.toString() || "128000",
  );
  const [customSupportsImages, setCustomSupportsImages] = useState(
    () => saved?.customEndpoint?.supportsImages ?? false,
  );

  // OAuth dialog state
  const [oauthDialogProvider, setOauthDialogProvider] = useState<BrowserOAuthProviderId | null>(null);

  const isCustomProvider = provider === CUSTOM_PROVIDER_ID;
  const allProviders = [...availableProviders, CUSTOM_PROVIDER_ID];
  const proxyRequired = provider === "anthropic" || provider === "openai-codex";
  const missingProxy = proxyRequired && (!useProxy || !proxyUrl.trim());

  // Filter OAuth providers based on selected provider
  const availableOAuthProviders = OAUTH_PROVIDERS.filter((op) => op.forProviders.includes(provider));
  const supportsOAuth = availableOAuthProviders.length > 0;


  useEffect(() => {
    const isValid = isCustomProvider
      ? customBaseUrl && customModelId
      : provider && model && (authMethod === "oauth" ? oauthProvider : apiKey);

    if (isValid) {
      const customEndpoint: CustomEndpointConfig | undefined = isCustomProvider
        ? {
            baseUrl: customBaseUrl,
            modelId: customModelId,
            modelName: customModelName || undefined,
            contextWindow: parseInt(customContextWindow, 10) || 128000,
            supportsImages: customSupportsImages,
          }
        : undefined;

      const config: ExtendedProviderConfig = {
        provider,
        model: isCustomProvider ? customModelId : model,
        authMethod,
        apiKey: authMethod === "apiKey" ? apiKey : undefined,
        oauthProvider: authMethod === "oauth" ? oauthProvider : undefined,
        customEndpoint,
        useProxy: isCustomProvider ? false : useProxy,
        proxyUrl,
        thinking,
      };

      saveConfig(config);
      setProviderConfig(config);
    }
  }, [
    provider,
    apiKey,
    model,
    useProxy,
    proxyUrl,
    thinking,
    authMethod,
    oauthProvider,
    isCustomProvider,
    customBaseUrl,
    customModelId,
    customModelName,
    customContextWindow,
    customSupportsImages,
    setProviderConfig,
  ]);

  const models = provider && !isCustomProvider ? getModelsForProvider(provider) : [];

  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    if (newProvider === CUSTOM_PROVIDER_ID) {
      setModel("");
      setUseProxy(false);
    } else {
      const providerModels = newProvider ? getModelsForProvider(newProvider) : [];
      setModel(providerModels[0]?.id || "");
    }
    // Reset auth method if new provider doesn't support OAuth
    const newSupportsOAuth = OAUTH_PROVIDERS.some((op) => op.forProviders.includes(newProvider));
    if (!newSupportsOAuth && authMethod === "oauth") {
      setAuthMethod("apiKey");
      setOauthProvider(undefined);
    }
  };

  const handleSwitchToOAuth = () => {
    setAuthMethod("oauth");
    // Auto-select OAuth provider if user is logged into one
    const loggedInProvider = availableOAuthProviders.find((op) => oauthStatus[op.id]);
    if (loggedInProvider && !oauthProvider) {
      setOauthProvider(loggedInProvider.id);
    }
  };

  const handleOAuthLogin = (providerId: BrowserOAuthProviderId) => {
    setOauthDialogProvider(providerId);
  };

  const handleOAuthSuccess = async (providerId: BrowserOAuthProviderId, credentials: OAuthCredentials) => {
    await loginWithOAuth(providerId, credentials);
    setOauthProvider(providerId);
    setOauthDialogProvider(null);
  };

  const handleOAuthLogout = async (providerId: BrowserOAuthProviderId) => {
    await logoutOAuth(providerId);
    if (oauthProvider === providerId) {
      setOauthProvider(undefined);
    }
  };

  const isConfigured = state.providerConfig !== null;

  const inputStyle = {
    borderRadius: "var(--chat-radius)",
    fontFamily: "var(--chat-font-sans)",
  };

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-6" style={{ fontFamily: "var(--chat-font-sans)" }}>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-(--chat-text-muted) mb-4">api configuration</div>

        <div className="space-y-4">
          <label className="block">
            <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Provider</span>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                         text-sm px-3 py-2 border border-(--chat-border)
                         focus:outline-none focus:border-(--chat-border-active)"
              style={inputStyle}
            >
              <option value="">Select provider...</option>
              {allProviders.map((p) => (
                <option key={p} value={p}>
                  {p === CUSTOM_PROVIDER_ID ? "Custom (OpenAI-compatible)" : p}
                </option>
              ))}
            </select>
          </label>

          {isCustomProvider ? (
            <>
              <label className="block">
                <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Base URL</span>
                <input
                  type="text"
                  value={customBaseUrl}
                  onChange={(e) => setCustomBaseUrl(e.target.value)}
                  placeholder="http://localhost:11434/v1"
                  className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                             text-sm px-3 py-2 border border-(--chat-border)
                             placeholder:text-(--chat-text-muted)
                             focus:outline-none focus:border-(--chat-border-active)"
                  style={inputStyle}
                />
                <p className="text-[10px] text-(--chat-text-muted) mt-1">
                  OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, etc.)
                </p>
              </label>

              <label className="block">
                <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Model ID</span>
                <input
                  type="text"
                  value={customModelId}
                  onChange={(e) => setCustomModelId(e.target.value)}
                  placeholder="llama3.1"
                  className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                             text-sm px-3 py-2 border border-(--chat-border)
                             placeholder:text-(--chat-text-muted)
                             focus:outline-none focus:border-(--chat-border-active)"
                  style={inputStyle}
                />
              </label>

              <label className="block">
                <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Display Name (optional)</span>
                <input
                  type="text"
                  value={customModelName}
                  onChange={(e) => setCustomModelName(e.target.value)}
                  placeholder="Llama 3.1 8B"
                  className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                             text-sm px-3 py-2 border border-(--chat-border)
                             placeholder:text-(--chat-text-muted)
                             focus:outline-none focus:border-(--chat-border-active)"
                  style={inputStyle}
                />
              </label>

              <label className="block">
                <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Context Window</span>
                <input
                  type="number"
                  value={customContextWindow}
                  onChange={(e) => setCustomContextWindow(e.target.value)}
                  placeholder="128000"
                  className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                             text-sm px-3 py-2 border border-(--chat-border)
                             placeholder:text-(--chat-text-muted)
                             focus:outline-none focus:border-(--chat-border-active)"
                  style={inputStyle}
                />
              </label>

              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs text-(--chat-text-secondary)">Supports Images</span>
                  <p className="text-[10px] text-(--chat-text-muted) mt-0.5">Enable for vision models</p>
                </div>
                <button
                  type="button"
                  onClick={() => setCustomSupportsImages(!customSupportsImages)}
                  className={`
                    w-10 h-5 rounded-full transition-colors relative
                    ${customSupportsImages ? "bg-(--chat-accent)" : "bg-(--chat-border)"}
                  `}
                >
                  <span
                    className={`
                      absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform
                      ${customSupportsImages ? "left-5" : "left-0.5"}
                    `}
                  />
                </button>
              </div>
            </>
          ) : (
            <label className="block">
              <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Model</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={!provider}
                className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                           text-sm px-3 py-2 border border-(--chat-border)
                           focus:outline-none focus:border-(--chat-border-active)
                           disabled:opacity-50 disabled:cursor-not-allowed"
                style={inputStyle}
              >
                <option value="">Select model...</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {!isCustomProvider && (
            <>
              {supportsOAuth && (
                <div>
                  <span className="block text-xs text-(--chat-text-secondary) mb-2">Authentication</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setAuthMethod("apiKey")}
                      className={`
                        flex-1 py-1.5 text-xs border transition-colors
                        ${
                          authMethod === "apiKey"
                            ? "bg-(--chat-accent) border-(--chat-accent) text-white"
                            : "bg-(--chat-input-bg) border-(--chat-border) text-(--chat-text-secondary) hover:border-(--chat-border-active)"
                        }
                      `}
                      style={{ borderRadius: "var(--chat-radius)" }}
                    >
                      API Key
                    </button>
                    <button
                      type="button"
                      onClick={handleSwitchToOAuth}
                      className={`
                        flex-1 py-1.5 text-xs border transition-colors
                        ${
                          authMethod === "oauth"
                            ? "bg-(--chat-accent) border-(--chat-accent) text-white"
                            : "bg-(--chat-input-bg) border-(--chat-border) text-(--chat-text-secondary) hover:border-(--chat-border-active)"
                        }
                      `}
                      style={{ borderRadius: "var(--chat-radius)" }}
                    >
                      OAuth
                    </button>
                  </div>
                </div>
              )}

              {(authMethod === "apiKey" || !supportsOAuth) && (
                <label className="block">
                  <span className="block text-xs text-(--chat-text-secondary) mb-1.5">API Key</span>
                  <div className="relative">
                    <input
                      type={showKey ? "text" : "password"}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="Enter your API key"
                      className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                                 text-sm px-3 py-2 pr-10 border border-(--chat-border)
                                 placeholder:text-(--chat-text-muted)
                                 focus:outline-none focus:border-(--chat-border-active)"
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-(--chat-text-muted)
                                 hover:text-(--chat-text-secondary)"
                    >
                      {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </label>
              )}

              {authMethod === "oauth" && supportsOAuth && (
                <div className="space-y-3">
                  <span className="block text-xs text-(--chat-text-secondary)">Login with OAuth</span>
                  {availableOAuthProviders.map((op) => {
                    const isLoggedIn = oauthStatus[op.id];
                    const isSelected = oauthProvider === op.id;
                    return (
                      <div
                        key={op.id}
                        className={`
                          p-3 border transition-colors
                          ${isSelected ? "border-(--chat-accent)" : "border-(--chat-border)"}
                        `}
                        style={{ borderRadius: "var(--chat-radius)" }}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-xs text-(--chat-text-primary) font-medium">{op.name}</div>
                            <div className="text-[10px] text-(--chat-text-muted)">{op.description}</div>
                          </div>
                          {isLoggedIn ? (
                            <div className="flex items-center gap-2">
                              {!isSelected && (
                                <button
                                  onClick={() => setOauthProvider(op.id)}
                                  className="text-[10px] text-(--chat-accent) hover:underline"
                                >
                                  Use
                                </button>
                              )}
                              <button
                                onClick={() => handleOAuthLogout(op.id)}
                                className="flex items-center gap-1 px-2 py-1 text-[10px]
                                           text-(--chat-text-muted) hover:text-(--chat-error)
                                           border border-(--chat-border) hover:border-(--chat-error)"
                                style={{ borderRadius: "var(--chat-radius)" }}
                              >
                                <LogOut size={10} />
                                Logout
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleOAuthLogin(op.id)}
                              className="flex items-center gap-1 px-2 py-1 text-[10px]
                                         bg-(--chat-accent) text-white hover:opacity-90"
                              style={{ borderRadius: "var(--chat-radius)" }}
                            >
                              <LogIn size={10} />
                              Login
                            </button>
                          )}
                        </div>
                        {isSelected && isLoggedIn && (
                          <div className="mt-2 pt-2 border-t border-(--chat-border) flex items-center gap-1 text-[10px] text-(--chat-success)">
                            <Check size={10} />
                            Currently active
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {!isCustomProvider && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs text-(--chat-text-secondary)">CORS Proxy</span>
                  <p className="text-[10px] text-(--chat-text-muted) mt-0.5">
                    Required for Anthropic and OpenAI Codex in the browser
                  </p>
                  {missingProxy && (
                    <p className="text-[10px] text-(--chat-error) mt-0.5">Proxy is required for this provider.</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setUseProxy(!useProxy)}
                  className={`
                    w-10 h-5 rounded-full transition-colors relative
                    ${useProxy ? "bg-(--chat-accent)" : "bg-(--chat-border)"}
                  `}
                >
                  <span
                    className={`
                      absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform
                      ${useProxy ? "left-5" : "left-0.5"}
                    `}
                  />
                </button>
              </div>

              {useProxy && (
                <label className="block">
                  <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Proxy URL</span>
                  <input
                    type="text"
                    value={proxyUrl}
                    onChange={(e) => setProxyUrl(e.target.value)}
                    placeholder="https://your-proxy.com/proxy"
                    className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                               text-sm px-3 py-2 border border-(--chat-border)
                               placeholder:text-(--chat-text-muted)
                               focus:outline-none focus:border-(--chat-border-active)"
                    style={inputStyle}
                  />
                  <p className="text-[10px] text-(--chat-text-muted) mt-1">
                    Your proxy should accept ?url=encoded_url format
                  </p>
                  {isLocalhost && (
                    <button
                      type="button"
                      onClick={() => setProxyUrl(`${window.location.origin}/proxy`)}
                      className="mt-2 text-[10px] text-(--chat-accent) hover:underline"
                    >
                      Use local dev proxy
                    </button>
                  )}
                </label>
              )}
            </>
          )}

          <div>
            <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Thinking Level</span>
            <div className="flex gap-1">
              {THINKING_LEVELS.map((level) => (
                <button
                  key={level.value}
                  type="button"
                  onClick={() => setThinking(level.value)}
                  className={`
                    flex-1 py-1.5 text-xs border transition-colors
                    ${
                      thinking === level.value
                        ? "bg-(--chat-accent) border-(--chat-accent) text-white"
                        : "bg-(--chat-input-bg) border-(--chat-border) text-(--chat-text-secondary) hover:border-(--chat-border-active)"
                    }
                  `}
                  style={{ borderRadius: "var(--chat-radius)" }}
                >
                  {level.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-(--chat-text-muted) mt-1">Extended thinking for supported models</p>
          </div>
        </div>
      </div>

      <div className="border-t border-(--chat-border) pt-4">
        <div className="flex items-center gap-2 text-xs">
          {isConfigured ? (
            <>
              <Check size={12} className="text-(--chat-success)" />
              <span className="text-(--chat-text-secondary)">
                Using {state.providerConfig?.provider === CUSTOM_PROVIDER_ID ? "Custom" : state.providerConfig?.provider}
              </span>
            </>
          ) : (
            <span className="text-(--chat-text-muted)">Fill in all fields above to get started</span>
          )}
        </div>
      </div>

      <div className="border-t border-(--chat-border) pt-4">
        <div className="text-[10px] uppercase tracking-widest text-(--chat-text-muted) mb-2">about</div>
        <p className="text-xs text-(--chat-text-secondary) leading-relaxed">
          OpenExcel uses your own API key or OAuth to connect to LLM providers. Your credentials are stored locally in
          the browser.
        </p>
        {useProxy && !isCustomProvider && (
          <p className="text-xs text-(--chat-text-muted) leading-relaxed mt-2">
            CORS Proxy: Requests route through your proxy to bypass browser CORS restrictions. Required for Claude OAuth
            and OpenAI Codex.
          </p>
        )}
      </div>

      {oauthDialogProvider && (
        <OAuthLoginDialog
          provider={oauthDialogProvider}
          isOpen={true}
          onClose={() => setOauthDialogProvider(null)}
          onSuccess={(credentials) => handleOAuthSuccess(oauthDialogProvider, credentials)}
          proxyUrl={proxyUrl}
        />
      )}
    </div>
  );
}
