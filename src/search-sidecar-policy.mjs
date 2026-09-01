export const TRUSTED_SEARCH_ORIGIN = "https://api.perplexity.ai";
export const TRUSTED_TAVILY_SEARCH_ORIGIN = "https://api.tavily.com";
export const TRUSTED_SEARCH_ADAPTERS = Object.freeze({
  "perplexity-search": Object.freeze({ origin: TRUSTED_SEARCH_ORIGIN }),
  "tavily-search": Object.freeze({ origin: TRUSTED_TAVILY_SEARCH_ORIGIN }),
});

function trustedSearchProviderBase(provider, { requireGeneric = false } = {}) {
  let endpoint;
  try {
    endpoint = new URL(provider?.baseUrl);
  } catch {
    return undefined;
  }
  if (
    (requireGeneric && provider?.generic !== true) ||
    provider?.enabled !== true ||
    provider.adapter !== "openai-chat" ||
    provider.allowPrivate !== false ||
    typeof provider.credentialRef !== "string" ||
    provider.credentialRef.length === 0 ||
    !["", "/"].includes(endpoint.pathname) ||
    endpoint.search ||
    endpoint.hash
  ) {
    return undefined;
  }
  return Object.entries(TRUSTED_SEARCH_ADAPTERS).find(([, policy]) => (
    endpoint.origin === policy.origin
  ))?.[0];
}

export function trustedSearchAdapterForProvider(provider, options) {
  return trustedSearchProviderBase(provider, options);
}

// Keep this module dependency-light. Catalog construction and doctor import it
// before the request stack is necessarily installed or initialized.
export function trustedSearchProviderDescriptor(provider, {
  requireGeneric = false,
  adapter,
} = {}) {
  const resolved = trustedSearchProviderBase(provider, { requireGeneric });
  return Boolean(resolved && (!adapter || resolved === adapter));
}
