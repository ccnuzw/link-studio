import type { ProviderFields } from "../../../packages/link-studio-core/src/settings-api.ts";
import type { PluginInfo } from "../../../packages/provider-runtime/src/plugin.ts";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";
import { providerTransport } from "./network.ts";

export async function fetchModelCatalog(
  profile: ProviderFields,
  plugin: Pick<PluginInfo, "auth">,
  secret?: string,
  transport = providerTransport(profile.endpoint, profile.allowLocal),
) {
  if (plugin.auth.type === "custom") throw new ProviderError("PROVIDER_CATALOG_UNSUPPORTED");
  if (secret && (/[\r\n]/u.test(secret) || secret.includes(String.fromCharCode(0))))
    throw new ProviderError("PROVIDER_CONFIG_INVALID");
  const prefix = String(profile.channel.pathPrefix ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (prefix && !/^[\w-]+(?:\/[\w-]+)*$/.test(prefix))
    throw new ProviderError("PROVIDER_CONFIG_INVALID");
  const url = new URL(profile.endpoint);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path}${prefix ? `/${prefix}` : path.endsWith("/v1") ? "" : "/v1"}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
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
    timeoutMs: 12000,
    responseType: "json",
  }).catch((error: unknown) => {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("PROVIDER_CATALOG_NETWORK_FAILED");
  });
  if (response.status === 401 || response.status === 403)
    throw new ProviderError("PROVIDER_CATALOG_AUTH_FAILED");
  if (response.status === 404 || response.status === 405)
    throw new ProviderError("PROVIDER_CATALOG_UNSUPPORTED");
  if (response.status !== 200) throw new ProviderError("PROVIDER_CATALOG_HTTP_FAILED");
  const body = response.body;
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data))
    throw new ProviderError("PROVIDER_CATALOG_INVALID");
  const models = new Set<string>();
  for (const item of body.data) {
    const model = item?.id;
    if (
      typeof model === "string" &&
      model === model.trim() &&
      model.length &&
      model.length <= 200 &&
      !/[\p{Cc}\p{Cf}]/u.test(model) &&
      !(secret && model.includes(secret))
    )
      models.add(model);
  }
  return { models: [...models].sort((left, right) => left.localeCompare(right)) };
}
