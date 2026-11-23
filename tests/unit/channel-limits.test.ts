import { describe, expect, it, vi } from "vitest";
import { ChannelLimits, GatewayLimits } from "../../src/main/settings/network";

describe("渠道限流", () => {
  it("Agent 单渠道 FIFO 交接并发名额，跳过已取消请求，配置换代隔离", async () => {
    const limits = new GatewayLimits(),
      live = AbortSignal.timeout(3000),
      cancel = new AbortController();
    const first = await limits.acquire("channel", 1, 0, live);
    const order: number[] = [];
    const second = limits.acquire("channel", 1, 0, live).then((release) => {
      order.push(2);
      return release;
    });
    const third = limits.acquire("channel", 1, 0, cancel.signal);
    const fourth = limits.acquire("channel", 1, 0, live).then((release) => {
      order.push(4);
      return release;
    });
    cancel.abort();
    await expect(third).rejects.toMatchObject({ name: "AbortError" });
    const nextConfig = await limits.acquire("channel", 2, 0, live);
    nextConfig();
    expect(order).toEqual([]);
    first();
    first();
    const releaseSecond = await second;
    expect(order).toEqual([2]);
    releaseSecond();
    (await fourth)();
    expect(order).toEqual([2, 4]);
  });

  it("Agent 不预充令牌桶：同渠道按间隔预约，取消不挤占后续排期", async () => {
    const limits = new GatewayLimits(),
      live = AbortSignal.timeout(3000),
      cancel = new AbortController();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      (await limits.acquire("one", 0, 2.5, live))();
      const second = limits.acquire("one", 0, 2.5, cancel.signal);
      cancel.abort();
      await expect(second).rejects.toMatchObject({ name: "AbortError" });
      now.mockReturnValue(400);
      const waiting = limits.acquire("one", 0, 2.5, AbortSignal.timeout(40));
      (await limits.acquire("two", 0, 2.5, live))();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      now.mockReturnValue(1200);
      (await limits.acquire("one", 0, 2.5, live))();
    } finally {
      now.mockRestore();
    }
  });
  it("按 ceil(rps) 突发，空闲最多补满一桶，各渠道独立", async () => {
    const limits = new ChannelLimits();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      for (const time of [0, 10000]) {
        now.mockReturnValue(time);
        for (const id of ["one", "two"]) {
          for (let token = 0; token < 3; token++) (await limits.acquire(id, 0, 2.5))();
          const abort = new AbortController();
          const waiting = limits.acquire(id, 0, 2.5, abort.signal);
          abort.abort();
          await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
        }
      }
      now.mockReturnValue(10400);
      (await limits.acquire("one", 0, 2.5))();
    } finally {
      now.mockRestore();
    }
  });

  it("修改配置立即更换桶，释放旧请求不影响新并发名额", async () => {
    const limits = new ChannelLimits();
    const previous = await limits.acquire("one", 1, 1);
    const current = await limits.acquire("one", 1, 2);
    previous();
    const abort = new AbortController();
    const waiting = limits.acquire("one", 1, 2, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    current();
    (await limits.acquire("one", 1, 2))();
  });

  it("取消令牌等待归还并发名额", async () => {
    const limits = new ChannelLimits();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      (await limits.acquire("one", 1, 0.5))();
      const abort = new AbortController();
      const waiting = limits.acquire("one", 1, 0.5, abort.signal);
      abort.abort();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      now.mockReturnValue(2000);
      (await limits.acquire("one", 1, 0.5, AbortSignal.timeout(500)))();
    } finally {
      now.mockRestore();
    }
  });

  it("生成名额按渠道计数，重复释放不撤销其他任务", () => {
    const limits = new ChannelLimits();
    const first = limits.tryAcquire("one", 1);
    expect(first).toBeTypeOf("function");
    expect(limits.tryAcquire("one", 1)).toBeUndefined();
    const other = limits.tryAcquire("two", 1);
    first?.();
    const next = limits.tryAcquire("one", 1);
    first?.();
    expect(limits.tryAcquire("one", 1)).toBeUndefined();
    expect(limits.tryAcquire("two", 1)).toBeUndefined();
    next?.();
    other?.();
  });
});
