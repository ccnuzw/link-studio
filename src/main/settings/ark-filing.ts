import { createHash, createHmac } from "node:crypto";
import type { Transport } from "../../../packages/provider-runtime/src/host.ts";
import { ProviderError, record } from "../../../packages/provider-runtime/src/runner.ts";
import { providerTransport } from "./network.ts";

export type ArkAction = "CreateAsset" | "GetAsset" | "DeleteAsset";
export type FilingStatus = "processing" | "active" | "failed";
export function filingStatus(status: unknown): FilingStatus {
  const normalized = String(status).toLowerCase();
  if (normalized === "active") return "active";
  return ["failed", "error", "canceled", "cancelled", "expired"].includes(normalized)
    ? "failed"
    : "processing";
}
export async function arkFiling(
  endpoint: string,
  keys: { accessKey: string; secretKey: string },
  action: ArkAction,
  payload: Record<string, string>,
  options: { now?: Date; transport?: Transport; signal?: AbortSignal } = {},
) {
  const hostname = new URL(endpoint).hostname;
  if (!["ark.cn-beijing.volces.com", "ark.ap-southeast.bytepluses.com"].includes(hostname))
    throw new ProviderError("CHANNEL_FILING_INVALID");
  const international = hostname === "ark.ap-southeast.bytepluses.com";
  const region = international ? "ap-southeast-1" : "cn-beijing";
  const host = international
    ? "ark.ap-southeast-1.byteplusapi.com"
    : "ark.cn-beijing.volcengineapi.com";
  const origin = `https://${host}`;
  const date = (options.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const query = new URLSearchParams({ Action: action, Version: "2024-01-01" }).toString();
  const body = Buffer.from(JSON.stringify(payload));
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const contentHash = hash(body);
  const signed = "content-type;host;x-content-sha256;x-date";
  const headers = `content-type:application/json\nhost:${host}\nx-content-sha256:${contentHash}\nx-date:${date}\n`;
  const canonical = ["POST", "/", query, headers, signed, contentHash].join("\n");
  const scope = `${day}/${region}/ark/request`;
  const hmac = (key: string | Buffer, value: string) =>
    createHmac("sha256", key).update(value).digest();
  const key = hmac(hmac(hmac(hmac(keys.secretKey, day), region), "ark"), "request");
  const signature = hmac(key, ["HMAC-SHA256", date, scope, hash(canonical)].join("\n")).toString(
    "hex",
  );
  const send = options.transport ?? providerTransport(origin, false);
  const response = await send(
    {
      method: "POST",
      url: `${origin}/?${query}`,
      headers: {
        "content-type": "application/json",
        host,
        "x-date": date,
        "x-content-sha256": contentHash,
        authorization: `HMAC-SHA256 Credential=${keys.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
      },
      body,
      timeoutMs: 30000,
      responseType: "json",
    },
    options.signal,
  );
  if (response.status !== 200 || !response.body || typeof response.body !== "object")
    throw new ProviderError("CHANNEL_FILING_FAILED");
  const result = record(response.body);
  if (result.ResponseMetadata && record(result.ResponseMetadata).Error)
    throw new ProviderError("CHANNEL_FILING_FAILED");
  return record(result.Result ?? result);
}
