import { modelGenerationOptions, type PluginView, type ProviderView } from "@link-studio/core";
import { Check } from "lucide-react";
import type { RefObject } from "react";
import { FieldMenu } from "./drama-start-style";
import { ShotModelLogo } from "./shot-model-picker";

function videoNote(model: ProviderView, plugins: PluginView[]) {
  const plugin = plugins.find((item) => item.hash === model.pluginHash);
  const options = modelGenerationOptions(
    "video",
    plugin?.origin === "builtin" ? plugin.key : undefined,
    model.model,
    model.channel,
    model.config,
  );
  const seconds = options.durationRange?.max ?? Math.max(0, ...options.durations);
  return [
    model.config?.promptFormat === "seedance"
      ? "Seedance"
      : model.config?.promptFormat === "h3"
        ? "MiniMax H3"
        : "",
    options.references.image && `参考图 ≤${options.references.image}`,
    options.references.audio && "参考音频",
    seconds && `≤${seconds}s`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function DramaStartModel({
  container,
  kind,
  prefix,
  models,
  plugins,
  issues,
  loading,
  value,
  change,
}: {
  container: RefObject<HTMLDialogElement | null>;
  kind: "文本" | "视频" | "图片";
  prefix?: string;
  models: ProviderView[];
  plugins: PluginView[];
  issues?: Map<string, string>;
  loading: boolean;
  value: string;
  change: (id: string) => void;
}) {
  const text = kind === "文本";
  const selected = models.find((model) => model.id === value);
  const shown =
    selected ?? (text && value ? undefined : models.find((model) => !issues?.get(model.id)));
  const name =
    shown?.config?.name ??
    shown?.label ??
    (text
      ? value
        ? `${value}${loading ? "" : "（已停用）"}`
        : "Agent 模型"
      : loading
        ? "加载模型…"
        : "跟随默认");
  return (
    <FieldMenu
      container={container}
      label={`${prefix ?? ""}${kind}模型`}
      kind={text ? "agent" : "media"}
      value={prefix ? `${prefix} · ${name}` : name}
      icon={shown && <ShotModelLogo logo={shown.config?.logo} />}
    >
      {(close) => {
        function choose(id: string) {
          change(id);
          close();
        }
        return (
          <>
            {!text && (
              <button
                type="button"
                className="drama-menu-row"
                aria-pressed={!selected}
                onClick={() => choose("")}
              >
                跟随默认{!selected && <Check size={16} />}
              </button>
            )}
            {!models.length && (
              <p className="drama-model-empty">
                {loading ? "加载中…" : `暂无可用的${text ? " Agent " : kind}模型`}
              </p>
            )}
            {models.map((model, index) => {
              const title = model.config?.name ?? model.label;
              const active = text ? shown?.id === model.id : selected?.id === model.id;
              const issue = issues?.get(model.id);
              const note = issue || (kind === "视频" ? videoNote(model, plugins) : "");
              return (
                <button
                  key={model.id}
                  type="button"
                  className="drama-menu-row"
                  aria-label={title}
                  aria-pressed={active}
                  disabled={!!issue}
                  title={issue || undefined}
                  onClick={() => choose(text && index === 0 ? "" : model.id)}
                >
                  <ShotModelLogo logo={model.config?.logo} />
                  <span className="drama-model-name">
                    {title}
                    {note && <small>{note}</small>}
                  </span>
                  {text && index === 0 && <small>默认</small>}
                  {active && <Check size={16} />}
                </button>
              );
            })}
          </>
        );
      }}
    </FieldMenu>
  );
}
