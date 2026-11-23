import { Popover } from "@base-ui/react/popover";
import {
  type CreativeData,
  type DramaDocument,
  dramaAssetMeta,
  dramaBoardMeta,
  type GenerationJob,
  type ProjectCanvasView,
} from "@link-studio/core";
import {
  AudioLines,
  CalendarRange,
  Check,
  CircleX,
  FolderOpen,
  Frame,
  Gem,
  Image,
  LayoutGrid,
  Loader2,
  Mountain,
  PencilLine,
  Plus,
  Search,
  Type,
  Upload,
  UserRound,
  Video,
} from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useLocalPreviewResult } from "./character-card-body";
import { characterShowsGenerator } from "./character-pick";
import { useAssetMarquee } from "./drama-asset-marquee";
import { assetPoster, dramaAssetStatus } from "./drama-asset-status";
import { BreakdownProgress, breakdownBlocked } from "./drama-breakdown";
import { episodeLabel } from "./episode-label";
import { ImagePlaceholderShape } from "./media-node-placeholder";
import "./drama-asset-browser.css";

const types = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  text: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
} as const;
const icons = {
  character: UserRound,
  scene: Mountain,
  prop: Gem,
  text: Type,
  image: Image,
  video: Video,
  audio: AudioLines,
};
type AssetType = keyof typeof types;
const keys = Object.keys(types) as AssetType[];
type Creative = Extract<ProjectCanvasView["nodes"][number], { type: "creative" }>;
export type DramaAssetEditor = {
  graph: ProjectCanvasView;
  ready: boolean;
  selected?: string;
  toolbar: HTMLDivElement | null;
  jobs: ReadonlyMap<string, GenerationJob[]>;
  progress: ReadonlyMap<string, number | "interrupted">;
  activeImport?: { id: string; percent: number };
  mount: (element: HTMLDivElement | null) => void;
  focus: (id: string) => boolean;
  clearSelection: () => void;
  classify: (id: string, patch: CreativeData["drama"]) => void;
  create: (type: AssetType, episode: number) => void;
  canCreate: boolean;
  prompt: (id: string, close: () => void, locate: (id: string) => void) => ReactNode;
  character: (id: string) => void;
  fill: (node: Creative, source: "upload" | "library") => void;
  drop: (
    type: Exclude<AssetType, "text">,
    episode: number,
    files: File[],
    target?: Creative,
  ) => void;
  generate: (ids: string[], withVoice: boolean) => Promise<void>;
  estimate: (node: Creative) => number;
  voiceUnit: number;
  batching: boolean;
};

export function DramaAssetViewToggle({
  view,
  change,
}: {
  view: "list" | "canvas";
  change: (view: "list" | "canvas") => void;
}) {
  return (
    <fieldset className="drama-asset-toggle" aria-label="视图">
      {(
        [
          ["list", "列表", LayoutGrid],
          ["canvas", "画布", Frame],
        ] as const
      ).map(([key, label, Icon]) => (
        <button key={key} type="button" aria-pressed={key === view} onClick={() => change(key)}>
          <Icon size={16} />
          {label}
        </button>
      ))}
    </fieldset>
  );
}

export function DramaNodeEpisodes({
  node,
  episodes,
  change,
}: {
  node: Creative;
  episodes: DramaDocument["episodes"];
  change: (patch: CreativeData["drama"]) => void;
}) {
  const { data } = node,
    meta = dramaAssetMeta(data),
    numbers = data.drama?.episodes ?? null;
  const choices: [string, string][] = data.character
    ? [["character", "角色"]]
    : data.kind === "image"
      ? [
          ["", "图片"],
          ["scene", "场景"],
          ["prop", "道具"],
        ]
      : [["", "已分类"]];
  function classify(type: string) {
    if (!type) return change({ episodes: numbers ?? [] });
    if (type === "prop" || type === "character" || type === "scene")
      change({
        name: meta?.name || data.character?.name || data.label.slice(0, 64),
        look: meta?.look ?? "",
        description: meta?.description ?? "",
        aliases: meta?.aliases ?? [],
        type,
        episodes: numbers ?? [],
      });
  }
  return (
    <Popover.Root>
      <Popover.Trigger className="drama-asset-episodes" aria-label="出现集数" title="出现集数">
        <CalendarRange size={16} />
        出现集数 · {episodeLabel(numbers)}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="start"
          sideOffset={10}
          className="drama-asset-pop-position"
        >
          <Popover.Popup className="drama-asset-pop" aria-label="编辑出现集数">
            <span>资产类型</span>
            <div>
              {choices.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={!!numbers && (meta?.type ?? "") === key}
                  onClick={() => classify(key)}
                >
                  {label}
                </button>
              ))}
              <button type="button" aria-pressed={!numbers} onClick={() => change(undefined)}>
                未分类
              </button>
            </div>
            <span>出现集数 · 都不勾 = 全集</span>
            <div className="drama-asset-ep-grid">
              {episodes.map((ep) => (
                <button
                  key={ep.episode_no}
                  type="button"
                  disabled={!numbers}
                  title={numbers ? ep.title : "先选资产类型"}
                  aria-pressed={numbers?.includes(ep.episode_no) ?? false}
                  onClick={() => {
                    if (!numbers || !data.drama) return;
                    change({
                      ...data.drama,
                      episodes: numbers.includes(ep.episode_no)
                        ? numbers.filter((no) => no !== ep.episode_no)
                        : [...numbers, ep.episode_no].sort((first, second) => first - second),
                    });
                  }}
                >
                  {ep.episode_no}
                </button>
              ))}
            </div>
            {!episodes.length && <span>还没有分集，研读完成后可以选择。</span>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function assetItem(node: Creative) {
  const data = node.data,
    meta = dramaAssetMeta(data),
    type: AssetType =
      meta?.type ?? (data.character ? "character" : data.kind === "script" ? "text" : data.kind);
  return {
    node,
    type,
    name: meta?.name || data.label,
    look: meta?.look,
    numbers: data.drama?.episodes ?? null,
  };
}
type Item = ReturnType<typeof assetItem>;
function CoverImage({ url, name }: { url: string | null | undefined; name: string }) {
  const [phase, setPhase] = useState<"pending" | "loaded" | "failed">("pending");
  if (url === null || phase === "failed")
    return (
      <div role="img" aria-label={name} className="drama-cover-broken">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <ImagePlaceholderShape />
        </svg>
      </div>
    );
  return (
    <>
      {url && (
        <img
          alt={name}
          src={url}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setPhase("loaded")}
          onError={() => setPhase("failed")}
          data-loaded={phase === "loaded"}
        />
      )}
      {phase === "pending" && <div className="drama-cover-skeleton" aria-hidden />}
    </>
  );
}

function assetState(editor: DramaAssetEditor, node: Creative, analyzing: boolean) {
  return dramaAssetStatus(
    node.id,
    node.data,
    editor.jobs.get(node.id) ?? [],
    analyzing,
    editor.activeImport?.id === node.id
      ? editor.activeImport.percent
      : editor.progress.get(node.id),
  );
}
function canReceiveFile(data: CreativeData, state: ReturnType<typeof assetState>["state"]) {
  return (
    data.kind !== "script" &&
    !data.assetId &&
    !data.outputs?.length &&
    state !== "uploading" &&
    state !== "running"
  );
}

export function AssetFileOverlay() {
  return (
    <div aria-hidden className="drama-asset-file-overlay">
      <span>
        <Upload size={16} />
        松手上传
      </span>
    </div>
  );
}

export function AssetBatchToolbar({
  count,
  selectAll,
  cancel,
  run,
  character,
  estimate,
  voiceEstimate,
  busy,
}: {
  count: number;
  selectAll?: () => void;
  cancel: () => void;
  run: (voice: boolean) => void;
  character: boolean;
  estimate: number;
  voiceEstimate: number;
  busy: boolean;
}) {
  const credits = (value: number) =>
    value > 0 ? (
      <>
        {" · 约 "}
        <span>{value}</span> 积分起
      </>
    ) : null;
  return (
    <div className="drama-batch-position">
      <div className="drama-asset-batch" role="toolbar" aria-label="批量操作">
        <span>
          已选 <b>{count}</b> 个
        </span>
        {selectAll && (
          <button type="button" onClick={selectAll}>
            全选
          </button>
        )}
        <button type="button" onClick={cancel}>
          取消
        </button>
        {character ? (
          <>
            <button
              type="button"
              data-outline
              disabled={busy}
              title="只生成角色形象图"
              onClick={() => run(false)}
            >
              生成角色图{credits(estimate)}
            </button>
            <button
              type="button"
              data-primary
              disabled={busy}
              title="生成角色形象图，并按音色描述生成声音"
              onClick={() => run(true)}
            >
              生成（含音色）{credits(voiceEstimate)}
            </button>
          </>
        ) : (
          <button type="button" data-primary disabled={busy} onClick={() => run(false)}>
            生成 {count} 个{credits(estimate)}
          </button>
        )}
      </div>
    </div>
  );
}

export function AssetCard({
  item,
  handle,
  editor,
  open,
  edit,
  analyzing,
  multi = false,
  checked = false,
  toggle,
  index = 0,
}: {
  item: Item;
  handle: string;
  editor: DramaAssetEditor;
  open: () => void;
  edit: () => void;
  analyzing: boolean;
  multi?: boolean;
  checked?: boolean;
  toggle?: () => void;
  index?: number;
}) {
  const { node, type, name, look, numbers } = item,
    Icon = icons[type],
    { data } = node;
  const status = assetState(editor, node, analyzing);
  const url = useLocalPreviewResult(
    handle,
    status.state === "done" && data.kind !== "audio" ? data.assetId : undefined,
  );
  const uploaded = data.uploaded || (!!data.character && !characterShowsGenerator(data));
  const fillable = canReceiveFile(data, status.state);
  return (
    <motion.li
      data-asset-id={node.id}
      data-status={status.state}
      aria-label={name}
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay: Math.min(index, 6) * 0.03 }}
    >
      <motion.div
        className="drama-asset-cover"
        data-checked={checked || undefined}
        whileTap={multi && toggle ? { scale: 0.985 } : undefined}
      >
        {status.state === "done" ? (
          <>
            {data.kind === "script" ? (
              <div className="drama-cover-script">{data.text.slice(0, 160)}</div>
            ) : data.kind === "image" ? (
              <CoverImage key={data.assetId} url={url} name={name} />
            ) : url && data.kind === "video" ? (
              <video src={url} muted preload="metadata" />
            ) : (
              <div
                className="drama-cover-poster"
                style={{ backgroundImage: assetPoster(name + (look ?? "")) }}
              />
            )}
            {uploaded && <span className="drama-cover-uploaded">上传</span>}
            <div className="drama-cover-scrim">
              <strong>{name}</strong>
            </div>
          </>
        ) : (
          <div className="drama-cover-empty" data-error={status.state === "error" || undefined}>
            <div>
              {status.state === "idle" ? (
                <Icon size={20} />
              ) : status.state === "error" ? (
                <CircleX size={20} />
              ) : (
                <Loader2 size={20} className="drama-cover-spin" />
              )}
              {status.state === "idle" ? (
                type === "character" ? (
                  "待生成形象"
                ) : (
                  "待生成"
                )
              ) : status.state === "running" ? (
                "生成中"
              ) : status.state === "analyzing" ? (
                "正在分析设定"
              ) : status.state === "uploading" ? (
                <span className="drama-cover-progress">上传中 {status.progress}%</span>
              ) : status.upload ? (
                "上传失败"
              ) : (
                "生成失败"
              )}
              {status.state === "error" && (
                <small>{status.message?.slice(0, 24) || "可以重试"}</small>
              )}
            </div>
          </div>
        )}
        {!multi && fillable && (
          <div className="drama-asset-fill-anchor">
            <div className="drama-asset-fill">
              <button type="button" onClick={() => editor.fill(node, "upload")}>
                <Upload size={14} />
                上传
              </button>
              <i />
              <button type="button" onClick={() => editor.fill(node, "library")}>
                <FolderOpen size={14} />
                素材库
              </button>
            </div>
          </div>
        )}
        {multi && toggle && (
          <button
            type="button"
            className="drama-asset-check"
            aria-pressed={checked}
            aria-label={checked ? "取消选择" : "选择"}
            onClick={toggle}
          >
            <span>{checked && <Check size={14} />}</span>
          </button>
        )}
        {!multi && (
          <button
            type="button"
            title="在画布中打开"
            aria-label={`在画布中打开 ${name}`}
            onClick={open}
          />
        )}
      </motion.div>
      <div className="drama-asset-title">
        <div className="drama-asset-caption">
          {name}
          {look && <span> · {look}</span>}
        </div>
        {!uploaded && ["character", "scene", "prop"].includes(type) && (
          <button
            type="button"
            aria-label={`编辑 ${name} 的提示词`}
            title="提示词与生成设置"
            onClick={edit}
          >
            <PencilLine size={14} />
          </button>
        )}
        {data.character && (
          <button
            type="button"
            aria-label={`编辑 ${name} 的角色详情与音色`}
            title="角色详情与音色"
            onClick={() => editor.character(node.id)}
          >
            <AudioLines size={14} />
          </button>
        )}
      </div>
      <div className="drama-asset-badges">
        {data.character?.voice && <AudioLines size={12} aria-label="已设定音色" />}
        {numbers?.length ? (
          numbers.map((no) => <i key={no}>{no}</i>)
        ) : (
          <span className={numbers ? "drama-cover-all" : "drama-cover-none"}>
            {episodeLabel(numbers)}
          </span>
        )}
      </div>
    </motion.li>
  );
}

export function StageAssets({
  saved,
  openBreakdown,
  doc,
  ep,
  editor,
  handle,
}: {
  doc: DramaDocument;
  ep: number;
  editor: DramaAssetEditor;
  handle: string;
  saved: (doc: DramaDocument) => void;
  openBreakdown: () => void;
}) {
  const blocked = breakdownBlocked(doc);
  const [view, setView] = useState<"list" | "canvas">("list"),
    [type, setType] = useState<AssetType>("character"),
    [query, setQuery] = useState(""),
    [pending, setPending] = useState(""),
    [editing, setEditing] = useState("");
  const items = useMemo(
    () =>
      editor.graph.nodes.flatMap((node) =>
        node.type === "creative" && !node.data.director && !dramaBoardMeta(node.data)
          ? [assetItem(node)]
          : [],
      ),
    [editor.graph.nodes],
  );
  const filtered = items.filter(
    (item) => !ep || (item.numbers && (!item.numbers.length || item.numbers.includes(ep))),
  );
  const visible = filtered.filter((item) => item.type === type);
  const [fileOver, setFileOver] = useState(false);
  const analyzing = !!doc.jobs?.some(
    (job) =>
      (job.step === "asset_prompts" || job.step === "breakdown") &&
      (job.status === "queued" || job.status === "running"),
  );
  const selected = items.find((item) => item.node.id === editor.selected);
  const [multi, setMulti] = useState(false),
    [checked, setChecked] = useState<Set<string>>(() => new Set());
  const clear = () => {
    setMulti(false);
    setChecked(new Set());
  };
  const candidates = items.filter((item) => {
    if (
      item.type !== type ||
      !["character", "scene", "prop"].includes(type) ||
      item.numbers === null
    )
      return false;
    const data = item.node.data;
    return (
      !data.uploaded &&
      (!data.character || characterShowsGenerator(data)) &&
      ["idle", "error", "done"].includes(assetState(editor, item.node, analyzing).state)
    );
  });
  const pendingCards = candidates.filter(
    (item) => assetState(editor, item.node, analyzing).state !== "done",
  );
  const selectedItems = candidates.filter((item) => checked.has(item.node.id));
  const visibleIds = new Set(visible.map((item) => item.node.id));
  const selectable = new Set(
    candidates.map((item) => item.node.id).filter((id) => visibleIds.has(id)),
  );
  const marquee = useAssetMarquee(
    selectable,
    checked,
    (next) => {
      if (next.size) setMulti(true);
      setChecked(next);
    },
    clear,
  );
  const estimate = selectedItems.reduce((sum, item) => sum + editor.estimate(item.node), 0);
  const run = (voice: boolean) => {
    const ids = selectedItems.map((item) => item.node.id);
    clear();
    void editor.generate(ids, voice);
  };
  useEffect(() => {
    if (!multi) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('dialog[open],[role="dialog"]'))
        clear();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [multi]);
  const library = items.filter(
    (item) =>
      (!ep || item.numbers !== null) &&
      (item.name + (item.look ?? "")).toLowerCase().includes(query.trim().toLowerCase()),
  );
  useLayoutEffect(() => {
    if (!pending || view !== "canvas") return;
    const frame = requestAnimationFrame(() => {
      if (editor.focus(pending)) setPending("");
    });
    return () => cancelAnimationFrame(frame);
  }, [view, pending, editor]);
  const breaking = doc.jobs?.some(
    (job) =>
      job.step === "breakdown" &&
      ["queued", "running"].includes(job.status) &&
      (!ep || job.episodes.includes(ep)),
  );
  return (
    <section className="drama-asset-browser" aria-label="资产列表">
      <h2 className="sr-only">资产管理 · {ep ? `第 ${ep} 集` : "全集"}</h2>
      {editing && (
        <div className="canvas-workspace drama-asset-prompt-host">
          {editor.prompt(
            editing,
            () => setEditing(""),
            (id) => {
              setEditing("");
              setView("canvas");
              setPending(id);
            },
          )}
        </div>
      )}
      {view === "canvas" &&
        editor.toolbar &&
        selected &&
        createPortal(
          <DramaNodeEpisodes
            key={selected.node.id}
            node={selected.node}
            episodes={doc.episodes}
            change={(patch) => editor.classify(selected.node.id, patch)}
          />,
          editor.toolbar,
        )}
      <div className="drama-asset-bar">
        <DramaAssetViewToggle
          view={view}
          change={(next) => {
            clear();
            setView(next);
            setPending("");
            setQuery("");
            if (next === "list") editor.clearSelection();
          }}
        />
        <span className="drama-asset-bar-spacer" />
        <BreakdownProgress
          doc={doc}
          cancel={async (id) => {
            const result = await window.desktop.projects.drama({
              projectHandle: handle,
              cancelBreakdown: id,
            });
            if (!result.ok) throw Error(result.error.message ?? result.error.code);
            if (result.value) saved(result.value);
          }}
        />
        <div className="drama-asset-generate-slot">
          {view === "list" && !multi && pendingCards.length > 0 && (
            <button
              type="button"
              className="drama-generate-all"
              onClick={() => {
                setMulti(true);
                setChecked(new Set(pendingCards.map((item) => item.node.id)));
              }}
            >
              全部生成
            </button>
          )}
        </div>
        <button
          className="drama-generate-all"
          type="button"
          disabled={!!blocked}
          title={blocked ?? "从已写好的剧本里拆出角色、场景和道具"}
          onClick={openBreakdown}
        >
          资产拆解
        </button>
      </div>
      {view === "canvas" ? (
        <div className="drama-asset-surface">
          <div className="drama-canvas-slot" ref={editor.mount} />
          <aside aria-label="画布资产定位" className="drama-asset-float">
            <label>
              <Search size={14} />
              <input
                aria-label="搜索资产"
                placeholder="搜索资产"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {keys.map((key) => {
              const group = library.filter((item) => item.type === key);
              return (
                group.length > 0 && (
                  <div key={key}>
                    <small>
                      {types[key]} {group.length}
                    </small>
                    {group.map((item) => (
                      <button
                        type="button"
                        key={item.node.id}
                        onClick={() => setPending(item.node.id)}
                      >
                        {item.name}
                        {item.look && ` · ${item.look}`}
                        {assetState(editor, item.node, analyzing).state !== "done" && (
                          <span className="drama-cover-missing">无图</span>
                        )}
                      </button>
                    ))}
                  </div>
                )
              );
            })}
            {!library.length && <p>这个筛选下没有资产</p>}
          </aside>
        </div>
      ) : (
        <>
          <div role="tablist" aria-label="资产类型">
            {keys.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={type === key}
                onClick={() => {
                  setType(key);
                  clear();
                }}
              >
                {types[key]} <small>{filtered.filter((item) => item.type === key).length}</small>
              </button>
            ))}
          </div>
          {!editor.ready ? (
            <p>正在读取资产…</p>
          ) : (
            <div className="drama-asset-drop-scroll">
              <div
                className="drama-asset-drop-zone"
                {...marquee.handlers}
                data-selecting={marquee.box ? true : undefined}
                data-batch={selectedItems.length ? true : undefined}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes("Files")) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = type === "text" ? "none" : "copy";
                  setFileOver(type !== "text");
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    setFileOver(false);
                }}
                onDrop={(event) => {
                  setFileOver(false);
                  if (!event.dataTransfer.types.includes("Files")) return;
                  event.preventDefault();
                  const files = Array.from(event.dataTransfer.files);
                  if (type === "text" || !files.length) return;
                  const targetId = (event.target as Element)
                    .closest("[data-asset-id]")
                    ?.getAttribute("data-asset-id");
                  const node =
                    files.length === 1
                      ? visible.find((item) => item.node.id === targetId)?.node
                      : undefined;
                  editor.drop(
                    type,
                    ep,
                    files,
                    node && canReceiveFile(node.data, assetState(editor, node, analyzing).state)
                      ? node
                      : undefined,
                  );
                }}
              >
                <ul>
                  {visible.map((item, index) => (
                    <AssetCard
                      key={item.node.id}
                      index={index}
                      item={item}
                      analyzing={analyzing}
                      editor={editor}
                      multi={multi}
                      checked={checked.has(item.node.id)}
                      toggle={
                        selectable.has(item.node.id)
                          ? () => {
                              const next = new Set(checked);
                              if (!next.delete(item.node.id)) next.add(item.node.id);
                              if (next.size) setChecked(next);
                              else clear();
                            }
                          : undefined
                      }
                      handle={handle}
                      edit={() => setEditing(item.node.id)}
                      open={() => {
                        setView("canvas");
                        setPending(item.node.id);
                      }}
                    />
                  ))}
                  <li>
                    <button
                      type="button"
                      className="drama-asset-add"
                      disabled={!editor.canCreate}
                      onClick={() => editor.create(type, ep)}
                    >
                      <Plus size={20} />
                      {type === "character" ? "引入角色卡" : `新建${types[type]}`}
                      <span>{ep ? `出现在第 ${ep} 集` : "全集出现"}</span>
                    </button>
                  </li>
                </ul>
                {!visible.length && (
                  <p>
                    {breaking
                      ? `资产正在拆解，拆出的${types[type]}会出现在这里`
                      : `这个筛选下还没有${types[type]}`}
                  </p>
                )}
                {fileOver && type !== "text" && <AssetFileOverlay />}
                {marquee.box && (
                  <div aria-hidden className="drama-asset-marquee" style={marquee.box} />
                )}
              </div>
            </div>
          )}
        </>
      )}
      {multi && selectedItems.length > 0 && (
        <AssetBatchToolbar
          count={selectedItems.length}
          character={type === "character"}
          estimate={estimate}
          voiceEstimate={estimate + selectedItems.length * editor.voiceUnit}
          busy={editor.batching}
          run={run}
          cancel={clear}
          selectAll={
            selectedItems.length < selectable.size
              ? () => setChecked(new Set([...checked, ...selectable]))
              : undefined
          }
        />
      )}
    </section>
  );
}
