export const quoteVideoModel = {
  key: "video",
  kind: "video",
  label: "测试模型",
  channels: [
    { channel: "main", upstream_model: "test", protocol: { plugin: "test", version: "1.0.0" } },
  ],
  capabilities: {
    prompt: { max_length: 2000 },
    ops: ["i2v"],
    refs: { image: { on: true, max: 1, max_mb: 10 } },
    params: {
      size: {
        type: "enum",
        label: "规格",
        open: true,
        spec: true,
        options: ["small", "large"],
        default: "small",
      },
      duration: { type: "number", label: "时长", open: true, min: 1, max: 10, default: 4 },
      count: { type: "enum", label: "数量", open: true, options: [1, 3], default: 1, fanout: true },
    },
  },
  pricing: {
    billing: "per_second",
    per_second: 2,
    tiers: [{ on: true, when: { size: "large" }, unit: 5 }],
  },
};
