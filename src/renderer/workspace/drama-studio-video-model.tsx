import type { PluginView, ProviderView } from "@link-studio/core";
import { Check } from "lucide-react";
import { videoNote } from "./drama-start-model";
import { BarPicker } from "./drama-studio-seconds";
import { ShotModelLogo } from "./shot-model-picker";

export function StudioVideoModel({
  model,
  models,
  loading,
  issues,
  plugins,
  pick,
}: {
  model?: ProviderView;
  models: ProviderView[];
  loading: boolean;
  issues: ReadonlyMap<string, string>;
  plugins: PluginView[];
  pick: (id: string) => void;
}) {
  return (
    <BarPicker
      modelMenu
      name="视频模型"
      title="生成片段视频用的模型"
      icon={model && <ShotModelLogo logo={model.config?.logo} />}
      label={model?.config?.name ?? model?.label ?? (loading ? "加载模型…" : "没有可用的视频模型")}
    >
      {(close) => (
        <>
          {!models.length && (
            <div className="studio-model-empty">{loading ? "加载中…" : "暂无可用的视频模型"}</div>
          )}
          {models.map((entry) => {
            const issue = issues.get(entry.id);
            const name = entry.config?.name ?? entry.label;
            const active = entry.id === model?.id;
            const note = issue || videoNote(entry, plugins);
            return (
              <button
                type="button"
                key={entry.id}
                disabled={!!issue}
                title={issue || undefined}
                aria-pressed={active}
                onClick={() => {
                  close();
                  pick(entry.id);
                }}
              >
                <ShotModelLogo logo={entry.config?.logo} />
                <span className="studio-model-name">
                  <span>{name}</span>
                  {note && <small>{note}</small>}
                </span>
                {active && <Check size={16} />}
              </button>
            );
          })}
        </>
      )}
    </BarPicker>
  );
}
