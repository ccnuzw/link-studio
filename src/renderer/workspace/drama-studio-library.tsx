import { jobIsTerminal, requirePresent } from "@link-studio/core";
import { AudioLines, Box, GripVertical, Image, User } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useThumbURL } from "./canvas-prompt-editor";
import type { DramaAssetEditor } from "./drama-asset-browser";
import { studioAssetDragType, studioAssets } from "./drama-studio-assets";
import "./drama-studio-library.css";

const categories = [
  ["character", "角色", User],
  ["scene", "场景", Image],
  ["prop", "道具", Box],
  ["audio", "音频", AudioLines],
] as const;
type Asset = ReturnType<typeof studioAssets>[number];

function LibraryItem({
  asset,
  projectHandle,
  running,
}: {
  asset: Asset;
  projectHandle: string;
  running: boolean;
}) {
  const Icon = requirePresent(
    categories.find(([type]) => type === asset.type),
    "categories.find(([type]) => type === asset.type)",
  )[2];
  const preview = useThumbURL(asset.source, projectHandle);
  return (
    <li
      className="studio-lib-item"
      title="拖到提示词里"
      draggable
      onDragStart={(event) => {
        const { id, label } = asset.source;
        event.dataTransfer.setData(studioAssetDragType, JSON.stringify({ id, label }));
        event.dataTransfer.setData("text/plain", label);
        event.dataTransfer.effectAllowed = "copy";
      }}
    >
      <span className="studio-lib-thumb">
        {preview && asset.type !== "audio" ? (
          <img src={preview} alt="" draggable={false} />
        ) : (
          <Icon />
        )}
      </span>
      <span className="studio-lib-label">{asset.source.label}</span>
      {asset.voice && <small>{asset.voice.name?.trim() || "音色"}</small>}
      {(!asset.source.assetId || running) && (
        <small data-warning>
          {running ? "生成中" : asset.type === "audio" ? "无音频" : "无图"}
        </small>
      )}
      <GripVertical />
    </li>
  );
}

export function StudioLibrary({
  editor,
  projectHandle,
  episodeNo,
  hidden,
  error,
  extracting,
}: {
  editor: DramaAssetEditor;
  projectHandle: string;
  episodeNo: number;
  hidden: boolean;
  error: string;
  extracting: readonly number[];
}) {
  const [all, setAll] = useState(false);
  const [limit, setLimit] = useState(14);
  const available = useMemo(() => studioAssets(editor.graph, episodeNo), [editor.graph, episodeNo]);
  const groups = useMemo(() => {
    const assets = available.filter((asset) => all || asset.here);
    return categories.map(([type, label, Icon]) => ({
      type,
      label,
      Icon,
      items: assets.filter((asset) => asset.type === type),
    }));
  }, [available, all]);
  const count = groups.reduce((total, group) => total + group.items.length, 0);
  useEffect(() => {
    if (limit >= count) return;
    const frame = requestAnimationFrame(() => setLimit(Math.min(count, limit + 10)));
    return () => cancelAnimationFrame(frame);
  }, [limit, count]);
  let left = limit;
  return (
    <aside aria-label="资产库" className="studio-lib" hidden={hidden}>
      <header>
        <b>资产库</b>
        <fieldset data-ui-group aria-label="资产范围">
          {[false, true].map((scope) => (
            <button
              type="button"
              key={String(scope)}
              aria-pressed={scope === all}
              onClick={() => setAll(scope)}
            >
              {scope === all && (
                <motion.span
                  className="studio-lib-selection"
                  layoutId="studio-lib-scope"
                  transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
                />
              )}
              <span>{scope ? "全集" : "本集"}</span>
            </button>
          ))}
        </fieldset>
      </header>
      <div className="studio-lib-scroll">
        {groups.map(({ type, label, Icon, items }) => {
          const shown = items.slice(0, Math.max(left, 0));
          left -= shown.length;
          return shown.length ? (
            <div key={type}>
              <div className="studio-lib-group">
                <Icon />
                {label}
                <span>{items.length}</span>
              </div>
              <ul className="studio-lib-items" aria-label={label}>
                {shown.map((asset) => (
                  <LibraryItem
                    key={asset.source.id}
                    asset={asset}
                    projectHandle={projectHandle}
                    running={
                      editor.jobs
                        .get(asset.source.id)
                        ?.some(
                          (job) => job.purpose !== "character-voice" && !jobIsTerminal(job.status),
                        ) ?? false
                    }
                  />
                ))}
              </ul>
            </div>
          ) : null;
        })}
        {!count && (
          <p>
            {error
              ? "资产读取失败"
              : !editor.ready
                ? "加载中…"
                : extracting.includes(episodeNo) || (all && extracting.length > 0)
                  ? "正在拆解资产…"
                  : available.length > 0 && !all
                    ? "本集没有关联资产，可切换到「全集」"
                    : "暂无资产"}
          </p>
        )}
      </div>
    </aside>
  );
}
