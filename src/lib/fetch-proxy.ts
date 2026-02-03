/**
 * Fetch Proxy Module
 *
 * Intercepts fetch requests to specific domains and routes them through a CORS proxy.
 * This is necessary because some API libraries (like pi-ai's openai-codex provider)
 * hardcode their API URLs and don't respect baseUrl overrides.
 */

// Domains that require proxying due to CORS restrictions in browser
const PROXY_DOMAINS = [
  "chatgpt.com",
  "api.anthropic.com",
  "console.anthropic.com",
];

let currentProxyUrl: string | null = null;
let isInstalled = false;
let originalFetch: typeof fetch | null = null;

/**
 * Proxied fetch that routes matching requests through the CORS proxy
 */
function proxiedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!originalFetch) {
    throw new Error("Fetch proxy not installed");
  }

  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  if (currentProxyUrl) {
    try {
      const parsedUrl = new URL(url);
      const shouldProxy = PROXY_DOMAINS.some((domain) => parsedUrl.hostname.includes(domain));

      if (shouldProxy) {
        const proxyBase = currentProxyUrl.replace(/\/+$/, "");
        const proxiedUrl = `${proxyBase}/${encodeURIComponent(url)}`;
        console.log("[FetchProxy] Routing through proxy:", parsedUrl.hostname);
        return originalFetch(proxiedUrl, init);
      }
    } catch {
      // Not a valid URL, pass through
    }
  }

  return originalFetch(input, init);
}

/**
 * Install the fetch proxy interceptor.
 * Call this once at app startup.
 */
export function installFetchProxy(): void {
  if (isInstalled) {
    return;
  }

  if (typeof window === "undefined" || !window.fetch) {
    console.warn("[FetchProxy] window.fetch not available, skipping installation");
    return;
  }

  originalFetch = window.fetch.bind(window);
  window.fetch = proxiedFetch;
  isInstalled = true;
  console.log("[FetchProxy] Installed");
}

/**
 * Uninstall the fetch proxy interceptor.
 * Restores the original fetch function.
 */
export function uninstallFetchProxy(): void {
  if (!isInstalled || !originalFetch) {
    return;
  }

  window.fetch = originalFetch;
  originalFetch = null;
  isInstalled = false;
  currentProxyUrl = null;
  console.log("[FetchProxy] Uninstalled");
}

/**
 * Enable proxying through the specified URL.
 * @param proxyUrl - The proxy base URL (e.g., "https://localhost:3000/proxy")
 */
export function enableProxy(proxyUrl: string): void {
  currentProxyUrl = proxyUrl;
  console.log("[FetchProxy] Enabled with proxy:", proxyUrl);
}

/**
 * Disable proxying. Requests will go directly to their original destinations.
 */
export function disableProxy(): void {
  currentProxyUrl = null;
  console.log("[FetchProxy] Disabled");
}

/**
 * Check if the proxy is currently enabled.
 */
export function isProxyEnabled(): boolean {
  return currentProxyUrl !== null;
}

/**
 * Get the current proxy URL, or null if disabled.
 */
export function getProxyUrl(): string | null {
  return currentProxyUrl;
}

/**
 * Add a domain to the proxy list.
 * @param domain - Domain to proxy (e.g., "api.example.com")
 */
export function addProxyDomain(domain: string): void {
  if (!PROXY_DOMAINS.includes(domain)) {
    PROXY_DOMAINS.push(domain);
    console.log("[FetchProxy] Added domain:", domain);
  }
}

/**
 * Remove a domain from the proxy list.
 * @param domain - Domain to remove
 */
export function removeProxyDomain(domain: string): void {
  const index = PROXY_DOMAINS.indexOf(domain);
  if (index !== -1) {
    PROXY_DOMAINS.splice(index, 1);
    console.log("[FetchProxy] Removed domain:", domain);
  }
}

/**
 * Get the list of domains being proxied.
 */
export function getProxyDomains(): readonly string[] {
  return PROXY_DOMAINS;
}
