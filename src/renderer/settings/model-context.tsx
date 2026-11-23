import { type ModelConfig, modelContextLimits, type SettingsValues } from "@link-studio/core";
import { Check, Sparkles } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

type Props = {
  config: ModelConfig;
  id: string;
  revision: number;
  name: string;
  gemini: boolean;
  patch: (next: Partial<ModelConfig>) => void;
};

function LimitsHint({ config, id, revision, name, gemini, patch }: Props) {
  const [result, setResult] = useState<SettingsValues["modelLimits"]>();
  const filled = useRef(false);
  const autofill = useEffectEvent(
    (limits: Extract<SettingsValues["modelLimits"], { found: true }>) => {
      if (!filled.current && !config.contextWindow && !config.maxOutputTokens)
        patch({ contextWindow: limits.window, maxOutputTokens: limits.output });
      filled.current = true;
    },
  );
  useEffect(() => {
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const response = await window.desktop.settings.modelLimits({
          id,
          expectedRevision: revision,
          name,
        });
        if (!current) return;
        const limits = response.ok ? response.value : ({ found: false } as const);
        setResult(limits);
        if (limits.found) autofill(limits);
      } catch {
        if (current) setResult({ found: false });
      }
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [id, revision, name]);
  if (!result?.found)
    return (
      <p className="model-limits-hint" role="status">
        {result ? "未识别出规格，请手动填写" : "正在识别上下文规格…"}
      </p>
    );
  const agent = config.kind === "agent";
  const media = {
    ...(agent && result.vision !== undefined && { vision: result.vision }),
    ...(agent && gemini && result.video !== undefined && { video: result.video }),
  };
  const differs =
    result.window !== config.contextWindow ||
    result.output !== config.maxOutputTokens ||
    (media.vision !== undefined && media.vision !== !!config.vision) ||
    (media.video !== undefined && media.video !== !!config.video);
  return (
    <div className="model-limits-hint" role="status">
      <span>
        <Sparkles size={14} />
        {result.source === "upstream" ? "渠道上游返回" : "内置模型库"}：上下文{" "}
        {result.window.toLocaleString("en-US")} · 最大输出 {result.output.toLocaleString("en-US")}
        {agent && result.vision !== undefined && ` · ${result.vision ? "能看图" : "不能看图"}`}
        {agent && result.video !== undefined && ` · ${result.video ? "能看视频" : "不能看视频"}`}
      </span>
      {differs && (
        <button
          type="button"
          onClick={() =>
            patch({ contextWindow: result.window, maxOutputTokens: result.output, ...media })
          }
        >
          应用识别值
        </button>
      )}
      {agent && result.video && !gemini && <p>OpenAI 兼容格式下「看视频」不会被应用</p>}
    </div>
  );
}

export function ModelContext(props: Props) {
  const { config, patch, gemini } = props;
  return (
    <section className="model-context-section">
      <h3>上下文能力</h3>
      <div className="model-context-fields">
        {(["contextWindow", "maxOutputTokens"] as const).map((field) => {
          const window = field === "contextWindow",
            label = window ? "上下文窗口" : "最大输出";
          const min = window ? 1 : modelContextLimits.minOutput,
            max = window ? modelContextLimits.window : modelContextLimits.output;
          const value = config[field] ?? 0;
          return (
            <label key={field}>
              {label}
              <input
                type="number"
                inputMode="numeric"
                aria-label={label}
                data-field={field}
                aria-invalid={value < min || value > max}
                title={`允许范围 ${min} – ${max}`}
                value={value}
                onChange={(event) => patch({ [field]: Math.trunc(Number(event.target.value)) })}
              />
              {window && <small>Token</small>}
            </label>
          );
        })}
      </div>
      {props.name && (
        <LimitsHint key={JSON.stringify([props.id, props.revision, props.name])} {...props} />
      )}
      {config.kind === "agent" &&
        (["vision", "video"] as const).map((field) => {
          const title = field === "vision" ? "看图" : "看视频";
          return (
            <div className="model-context-media" key={field}>
              <label htmlFor={field === "video" ? "model-video" : undefined}>{title}</label>
              <button
                type="button"
                id={`model-${field}`}
                aria-pressed={!!config[field]}
                disabled={field === "video" && !gemini && !config.video}
                onClick={() => patch({ [field]: !config[field] })}
              >
                {config[field] && <Check size={14} />}能{title}
              </button>
              {field === "video" && !gemini && <small>仅 Gemini 原生接口格式支持</small>}
            </div>
          );
        })}
    </section>
  );
}
