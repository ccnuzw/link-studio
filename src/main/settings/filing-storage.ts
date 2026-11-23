import { Sha256 } from "@smithy/core/checksum";
import { HttpRequest } from "@smithy/core/transport";
import { SignatureV4 } from "@smithy/signature-v4";
import { isPublicReferenceURL } from "../../../packages/link-studio-core/src/media-generation.ts";
import type { SettingsInput } from "../../../packages/link-studio-core/src/settings-api.ts";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";
import { openProviderResponse } from "./network.ts";

type Config = SettingsInput<"filingStorageSave">;

export function storageFields(input: Config) {
  const provider = input.provider ?? "s3";
  let endpoint = input.endpoint.trim().replace(/\/+$/, "");
  const publicBase = input.publicBase.trim().replace(/\/+$/, "");
  const bucket = input.bucket.trim();
  const region = provider === "r2" ? "auto" : input.region.trim();
  const accountId = provider === "r2" ? input.accountId?.trim() : undefined;
  let addressing = input.addressing ?? "path";
  if (provider === "r2") {
    if (!accountId || !/^[a-f0-9]{32}$/.test(accountId))
      throw new ProviderError("FILING_STORAGE_INVALID");
    endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    addressing = "path";
  } else if (provider === "aliyun_oss" || provider === "tencent_cos") {
    if (provider === "tencent_cos" && !/^[a-z0-9][a-z0-9-]*-\d{10}$/.test(bucket))
      throw new ProviderError("FILING_STORAGE_INVALID");
    endpoint =
      provider === "aliyun_oss"
        ? `https://oss-${region}.aliyuncs.com`
        : `https://cos.${region}.myqcloud.com`;
    addressing = "virtual";
  } else if (!endpoint) endpoint = `https://s3.${region}.amazonaws.com`;
  if (
    !isPublicReferenceURL(endpoint) ||
    new URL(endpoint).origin !== endpoint ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.includes("..") ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(region) ||
    (publicBase && (!isPublicReferenceURL(publicBase) || new URL(publicBase).search))
  )
    throw new ProviderError("FILING_STORAGE_INVALID");
  return {
    provider,
    addressing,
    endpoint,
    region,
    bucket,
    publicBase,
    ...(accountId && { accountId }),
  };
}

function requestFor(config: Config, key: string, method: string) {
  if (!/^link-studio\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(key))
    throw new ProviderError("FILING_STORAGE_INVALID");
  const normalized = storageFields(config);
  const url = new URL(normalized.endpoint);
  const virtual =
    normalized.addressing === "virtual" ||
    (normalized.addressing === "auto" &&
      /^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname) &&
      !normalized.bucket.includes("."));
  if (virtual) url.hostname = `${normalized.bucket}.${url.hostname}`;
  url.pathname = virtual ? `/${key}` : `/${normalized.bucket}/${key}`;
  const request = new HttpRequest({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    headers: { host: url.host },
    method,
    path: url.pathname,
  });
  const signer = new SignatureV4({
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    service: "s3",
    region: normalized.region,
    sha256: Sha256,
    uriEscapePath: false,
  });
  return { url, request, signer };
}

export async function storageReadURL(config: Config, key: string, date = new Date()) {
  const { url, request, signer } = requestFor(config, key, "GET");
  if (config.publicBase) return `${config.publicBase}/${key}`;
  request.headers["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD";
  const signed = await signer.presign(request, { expiresIn: 3600, signingDate: date });
  for (const [name, value] of Object.entries(signed.query ?? {}))
    if (typeof value === "string") url.searchParams.set(name, value);
  return url.href;
}

export async function uploadFilingImage(
  config: Config,
  key: string,
  bytes: Buffer,
  mime: string,
  signal?: AbortSignal,
  send = openProviderResponse,
) {
  const { url, request, signer } = requestFor(config, key, "PUT");
  request.headers["content-type"] = mime;
  request.body = bytes;
  const signed = await signer.sign(request);
  const response = await send(
    url.origin,
    false,
    {
      url: url.href,
      headers: signed.headers,
      method: "PUT",
      body: bytes,
      responseType: "text",
      timeoutMs: 60000,
    },
    signal,
  );
  try {
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300)
      throw new ProviderError("FILING_STORAGE_UPLOAD_FAILED");
  } finally {
    response.destroy();
  }
}
