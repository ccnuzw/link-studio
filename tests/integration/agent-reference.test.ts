import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { readAgentReference } from "../../src/main/settings/agent-reference";
import { queryAgentWeb } from "../../src/main/settings/agent-web";
import { openProviderResponse } from "../../src/main/settings/network";

vi.mock("../../src/main/settings/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/main/settings/network")>()),
  openProviderResponse: vi.fn(),
}));

const address = "https://example.com/reference.md";
const redact = (text: string) => text.replaceAll("fixture-secret", "[已脱敏]");
const transport = vi.mocked(openProviderResponse);
afterEach(() => transport.mockReset());

function respond(body: Buffer, mime = "text/markdown; charset=utf-8") {
  transport.mockResolvedValue(
    Object.assign(Readable.from([body]), {
      statusCode: 200,
      headers: { "content-type": mime },
    }) as unknown as IncomingMessage,
  );
}

it("读取指定 HTTPS 文本，不携带凭证，资料引用由地址与正文确定", async () => {
  respond(Buffer.from("# 分镜资料\nfixture-secret"));
  const attachment = await readAgentReference(address, redact);
  expect(attachment).toMatchObject({
    kind: "document",
    name: "example.com",
    mime_type: "text/markdown",
    url: address,
    text: "# 分镜资料\n[已脱敏]",
  });
  expect(transport).toHaveBeenCalledWith("https://example.com", false, {
    url: address,
    method: "GET",
    headers: { accept: "text/plain, text/markdown" },
    timeoutMs: 5000,
    responseType: "text",
  });
  respond(Buffer.from("# 分镜资料\nfixture-secret"));
  expect((await readAgentReference(address, redact)).asset_id).toBe(attachment.asset_id);
});

it.each([
  ["超限响应", Buffer.alloc(32 * 1024 + 1), "text/plain"],
  ["不支持的 MIME", Buffer.from("<html></html>"), "text/html"],
  ["不是 UTF-8", Buffer.from([0xff]), "text/plain"],
])("拒绝%s", async (_label, body, mime) => {
  respond(body, mime);
  await expect(readAgentReference(address, redact)).rejects.toThrow();
});

it("含凭证的资料地址在发起请求前拒绝", async () => {
  await expect(readAgentReference(`${address}/fixture-secret`, redact)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it("小灵检索只向对应语言的维基百科发送关键词，返回来源和纯文本摘要", async () => {
  respond(
    Buffer.from(
      JSON.stringify({
        query: { search: [{ title: "分鏡", snippet: "<span>分鏡</span> &amp; 構圖" }] },
      }),
    ),
    "application/json",
  );
  expect(await queryAgentWeb("web_search", { query: "分镜", limit: 1 }, redact)).toEqual({
    source: "Wikipedia",
    results: [
      {
        title: "分鏡",
        url: "https://zh.wikipedia.org/wiki/%E5%88%86%E9%8F%A1",
        snippet: "分鏡 & 構圖",
      },
    ],
  });
  const [origin, allowLocal, request] = transport.mock.calls[0] ?? [];
  expect(origin).toBe("https://zh.wikipedia.org");
  expect(allowLocal).toBe(false);
  expect(new URL(request?.url ?? "").searchParams.get("srsearch")).toBe("分镜");
  expect(request?.headers).not.toHaveProperty("authorization");
});

it("网页只提取文本并脱敏，拒绝超限正文", async () => {
  respond(
    Buffer.from(
      "<head>hidden</head><p>轨道 &amp; 镜头</p><script>ignored</script><p>fixture-secret</p>",
    ),
    "text/html",
  );
  expect(await queryAgentWeb("web_fetch", { url: address }, redact)).toEqual({
    url: address,
    text: "轨道 & 镜头\n[已脱敏]",
    truncated: false,
  });
  respond(Buffer.alloc(512 * 1024 + 1), "text/plain");
  await expect(queryAgentWeb("web_fetch", { url: address }, redact)).rejects.toThrow();
});

it("拒绝私有或携带凭证的目标与关键词", async () => {
  for (const url of [
    "http://example.com",
    "https://127.0.0.1",
    "https://example.com:9443",
    "https://service.internal",
    "https://example.com/?private=1",
    "https://user:pass@example.com",
    `${address}/fixture%2Dsecret`,
  ])
    await expect(queryAgentWeb("web_fetch", { url }, redact)).rejects.toThrow();
  for (const query of ["fixture-secret", "/private/work.md", "https://example.com/file"]) {
    await expect(queryAgentWeb("web_search", { query }, redact)).rejects.toThrow();
  }
  expect(transport).not.toHaveBeenCalled();
});
