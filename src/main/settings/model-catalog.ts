import type { ProviderFields } from "../../../packages/link-studio-core/src/settings-api.ts";
import { authNameIssue } from "../../../packages/provider-runtime/src/auth-name.ts";
import type { PluginInfo } from "../../../packages/provider-runtime/src/plugin.ts";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";
import { providerTransport } from "./network.ts";

export async function fetchModelCatalog(...args: Parameters<typeof fetchCatalogEntries>) {
  const entries = await fetchCatalogEntries(...args);
  return { models: [...entries.keys()].sort((left, right) => left.localeCompare(right)) };
}

export async function fetchCatalogEntries(
  profile: ProviderFields,
  plugin: Pick<PluginInfo, "auth">,
  secret?: string,
  transport = providerTransport(profile.endpoint, profile.allowLocal),
) {
  if (plugin.auth.type === "custom") throw new ProviderError("PROVIDER_CATALOG_UNSUPPORTED");
  if (authNameIssue(plugin.auth.type, plugin.auth.name))
    throw new ProviderError("PROVIDER_CONFIG_INVALID");
  if (secret && (/[\r\n]/u.test(secret) || secret.includes(String.fromCharCode(0))))
    throw new ProviderError("PROVIDER_CONFIG_INVALID");
  const prefix = String(profile.channel.pathPrefix ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (prefix && !/^[\w-]+(?:\/[\w-]+)*$/.test(prefix))
    throw new ProviderError("PROVIDER_CONFIG_INVALID");
  const url = new URL(profile.endpoint);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path}${prefix ? `/${prefix}` : /\/v\d+[a-z]*$/.test(path) ? "" : "/v1"}/models`;
  const headers: Record<string, string> = Object.create(null);
  headers.accept = "application/json";
  if (secret) {
    if (plugin.auth.type === "bearer") headers.authorization = `Bearer ${secret}`;
    if (plugin.auth.type === "header" && plugin.auth.name) headers[plugin.auth.name] = secret;
    if (plugin.auth.type === "query" && plugin.auth.name)
      url.searchParams.set(plugin.auth.name, secret);
  }
  const response = await transport({
    method: "GET",
    url: url.href,
    headers,
    timeoutMs: 30000,
    responseType: "model_catalog",
  }).catch((error: unknown) => {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("PROVIDER_CATALOG_NETWORK_FAILED");
  });
  if (response.status === 401 || response.status === 403)
    throw new ProviderError("PROVIDER_CATALOG_AUTH_FAILED");
  if (response.status === 404 || response.status === 405)
    throw new ProviderError("PROVIDER_CATALOG_UNSUPPORTED");
  if (response.status < 200 || response.status >= 300)
    throw new ProviderError("PROVIDER_CATALOG_HTTP_FAILED");
  const body = response.body;
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data))
    throw new ProviderError("PROVIDER_CATALOG_INVALID");
  if (body.data.length > 2000) throw new ProviderError("PROVIDER_CATALOG_TOO_LARGE");
  const models = new Map<string, { window: number; output: number }>();
  const positive = (...values: unknown[]) =>
    values.find(
      (value): value is number =>
        typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    ) ?? 0;
  for (const item of body.data) {
    const model = typeof item?.id === "string" ? item.id.trim() : undefined;
    if (
      typeof model === "string" &&
      model.length &&
      model.length <= 200 &&
      !/[\p{Cc}\p{Cf}]/u.test(item.id) &&
      !(secret && model.includes(secret)) &&
      !models.has(model)
    )
      models.set(model, {
        window: positive(item.max_input_tokens, item.context_length, item.context_window),
        output: positive(
          item.top_provider?.max_completion_tokens,
          item.max_completion_tokens,
          item.max_output_tokens,
          item.max_tokens,
        ),
      });
  }
  return models;
}
