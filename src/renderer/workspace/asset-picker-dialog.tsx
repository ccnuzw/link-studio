import type { GenerationJob, ProjectAsset } from "@link-studio/core";
import { ChevronRight, Clock, Folder, ListFilter, Loader2, Search, Upload, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AssetHumanPane, type FiledChoice } from "./asset-human-pane";
import { assetPickLimit, pickAsset } from "./asset-node-batch";
import { AssetUploadCard } from "./asset-upload-card";
import { useThumbURL } from "./canvas-prompt-editor";
import { type CharacterPick, characterPickReason, characterPickTitles } from "./character-pick";
import { FilingCover } from "./human-picker";
import { LocalVideoPoster } from "./local-video-poster";
import { formatMediaDuration } from "./node-video-state";
import { PickerEmptyLogo } from "./picker-empty-logo";
import { PickerFilter } from "./picker-filter";
import { type PickerUpload, pickerUploads } from "./picker-uploads";
import { usePersonalLibrary } from "./use-personal-library";
import "./asset-picker.css";

const kinds = { image: "图片", video: "视频", audio: "音频" } as const;
const ranges = { "0": "全部时间", "1": "今天", "7": "近 7 天", "30": "近 30 天" };
const pageSize = 40;

function PagedAssetGrid({
  items,
  card,
  pending,
}: {
  items: ProjectAsset[];
  card: (item: ProjectAsset) => ReactNode;
  pending?: ReactNode;
}) {
  const [count, setCount] = useState(pageSize);
  const footer = useRef<HTMLDivElement>(null);
  const more = count < items.length;
  useEffect(() => {
    if (!more || !footer.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          setCount((current) => current + pageSize);
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(footer.current);
    return () => observer.disconnect();
  }, [count, more]);
  return (
    <>
      <div className="asset-pick-grid">
        {pending}
        {items.slice(0, count).map(card)}
      </div>
      {more && <div className="asset-pick-more" ref={footer} />}
    </>
  );
}

export function Cover({
  asset,
  handle,
  library = false,
}: {
  asset: ProjectAsset;
  handle: string;
  library?: boolean;
}) {
  const thumb = useThumbURL(
    asset.mediaType === "image"
      ? { id: asset.assetId, assetId: asset.assetId, label: asset.displayName, kind: "image" }
      : undefined,
    handle,
    library,
  );
  if (asset.mediaType === "video")
    return <LocalVideoPoster assetId={asset.assetId} projectHandle={handle} library={library} />;
  if (asset.mediaType === "audio")
    return (
      <svg
        aria-hidden="true"
        className="asset-audio-cover"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="18" r="4" />
        <path d="M12 18V2l7 4" />
      </svg>
    );
  return thumb && <img src={thumb} alt={asset.displayName} draggable={false} />;
}

export function AssetPickerDialog({
  assets,
  jobs,
  handle,
  projectName,
  importing,
  capacity,
  lockedKind,
  character,
  attachFiled,
  attachLibrary,
  upload,
  close,
  confirm,
  feedback,
  dialogTitle,
  confirmLabel,
  reasonOf,
  filingChannelId,
}: {
  assets: ProjectAsset[];
  jobs: GenerationJob[];
  handle: string;
  projectName: string;
  importing: boolean;
  capacity: number;
  lockedKind?: ProjectAsset["mediaType"];
  character?: CharacterPick;
  attachFiled?: (file: FiledChoice["filed"]) => Promise<ProjectAsset>;
  attachLibrary?: (itemId: string) => Promise<ProjectAsset>;
  upload: PickerUpload;
  close: () => void;
  confirm: (assets: ProjectAsset[]) => void | Promise<string | void>;
  dialogTitle?: string;
  confirmLabel?: string;
  reasonOf?: (asset: ProjectAsset) => string | undefined;
  filingChannelId?: string;
  feedback?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<"library" | "history" | "humans">("library");
  const [kind, setKind] = useState<ProjectAsset["mediaType"]>(lockedKind ?? "image");
  const limit =
    character?.purpose === "extra"
      ? Math.max(1, 4 - character.extras.length)
      : lockedKind
        ? 1
        : assetPickLimit;
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const slideId = useId();
  useEffect(() => {
    const timeout = window.setTimeout(() => setSearch(query), 300);
    return () => window.clearTimeout(timeout);
  }, [query]);
  const [range, setRange] = useState("0");
  const [filter, setFilter] = useState("all");
  const [selected, renderSelection] = useState<(ProjectAsset | FiledChoice)[]>([]);
  const selection = useRef(selected);
  function setSelected(
    change: (current: (ProjectAsset | FiledChoice)[]) => (ProjectAsset | FiledChoice)[],
  ) {
    selection.current = change(selection.current);
    renderSelection(selection.current);
  }
  const [notice, setNotice] = useState<{ text: string }>();
  const {
    items: libraryRows,
    folders,
    removedSourceIds,
    status: libraryLoad,
    reload,
  } = usePersonalLibrary(handle, !!attachLibrary, filingChannelId);
  const removedSources = useMemo(() => new Set(removedSourceIds), [removedSourceIds]);
  const [folderId, setFolder] = useState<string>();
  useEffect(() => {
    if (libraryLoad === "ready" && folderId && !folders.some((folder) => folder.id === folderId)) {
      setFolder(undefined);
      setQuery("");
      setSearch("");
      setNotice({ text: "该内容已不存在" });
    }
  }, [libraryLoad, folders, folderId]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const services = useRef({ upload, lockedKind, character, limit, reasonOf });
  useLayoutEffect(() => {
    services.current = { upload, lockedKind, character, limit, reasonOf };
  }, [upload, lockedKind, character, limit, reasonOf]);
  const [uploads] = useState(() =>
    pickerUploads(
      (...args) => services.current.upload(...args),
      (asset) => {
        const { lockedKind, character, limit } = services.current;
        if (
          (lockedKind && asset.mediaType !== lockedKind) ||
          characterPickReason(character, asset.assetId) ||
          services.current.reasonOf?.(asset)
        )
          return;
        const current = selection.current;
        if (current.length >= limit && !current.some((item) => item.assetId === asset.assetId))
          setNotice({ text: `已选满，「${asset.displayName}」已上传但没有勾选` });
        else setSelected((items) => pickAsset(items, asset, true, limit));
      },
      attachLibrary
        ? async (asset, destination) => {
            const result = await window.desktop.projects.registerLibrary({
              projectHandle: handle,
              assetId: asset.assetId,
              ...(destination && { folderId: destination }),
            });
            if (!result.ok) throw new Error("登记到个人资产库失败，请重试");
            if (live.current) await reload();
          }
        : undefined,
    ),
  );
  const tasks = useSyncExternalStore(uploads.subscribe, uploads.snapshot);
  const [resolving, setResolving] = useState(false);
  const [pickError, setPickError] = useState("");
  const live = useRef(false);
  const library = source === "library";
  const humans = source === "humans";
  const title = library ? "搜索文件名" : humans ? "搜索真人名称" : "搜索提示词";
  const keyword = search.trim().toLocaleLowerCase();
  const pending = library && !keyword ? tasks.filter((task) => task.folderId === folderId) : [];
  const shownFolders = library && !keyword && !folderId ? folders : [];
  const folderOf = useMemo(
    () =>
      new Map(
        libraryRows.flatMap((row) =>
          [row.asset.assetId, ...(row.sourceId ? [row.sourceId] : [])].map(
            (id) => [id, row.folderId] as const,
          ),
        ),
      ),
    [libraryRows],
  );
  const history = useMemo(
    () =>
      new Map(
        jobs.flatMap((job) =>
          job.outputs.flatMap((output) =>
            output.kind === "text" ? [] : [[output.assetId, job] as const],
          ),
        ),
      ),
    [jobs],
  );
  const today = new Date();
  const from =
    Number(range) &&
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - Number(range) + 1).getTime();
  const remoteItems = useMemo(() => {
    const localIds = new Set(
      assets
        .filter((item) => item.availability === "ready")
        .flatMap((item) => [item.assetId, item.metadata.libraryItemId]),
    );
    return new Map(
      libraryRows
        .filter(
          ({ asset, sourceId }) =>
            !localIds.has(asset.assetId) && !(sourceId && localIds.has(sourceId)),
        )
        .map(({ asset }) => [asset.assetId, asset]),
    );
  }, [assets, libraryRows]);
  const visible = (library ? [...assets, ...remoteItems.values()] : assets)
    .filter((asset) => {
      if (asset.availability !== "ready" || (lockedKind && asset.mediaType !== lockedKind))
        return false;
      const job = history.get(asset.assetId);
      if (library)
        return (
          (folderOf.has(String(asset.metadata.libraryItemId ?? asset.assetId)) ||
            (!removedSources.has(asset.assetId) &&
              !asset.metadata.libraryUpload &&
              !asset.metadata.libraryItemId &&
              asset.origin !== "generated" &&
              !job)) &&
          (!!keyword ||
            (folderOf.get(String(asset.metadata.libraryItemId ?? asset.assetId)) ?? null) ===
              (folderId ?? null)) &&
          asset.displayName.toLocaleLowerCase().includes(keyword)
        );
      return (
        (asset.origin === "generated" || job) &&
        asset.mediaType === kind &&
        filter !== "conversation" &&
        (!from || Date.parse(asset.createdAt ?? job?.updatedAt ?? "") >= from) &&
        (!keyword || job?.outputPrompt?.toLocaleLowerCase().includes(keyword))
      );
    })
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  useLayoutEffect(() => {
    const element = dialog.current;
    live.current = true;
    element?.showModal();
    return () => {
      live.current = false;
      uploads.clear();
      element?.close();
    };
  }, [uploads]);
  const remoteChoices = useRef(new WeakSet<ProjectAsset>());
  const toggle = (asset: ProjectAsset | FiledChoice) => {
    if (!("filed" in asset) && remoteItems.has(asset.assetId)) remoteChoices.current.add(asset);
    setSelected((current) => pickAsset(current, asset, false, limit));
  };
  const full = limit !== 1 && selected.length >= limit;
  const hint = !selected.length
    ? "请先选择素材"
    : selected.length > capacity
      ? "画布节点数量已达上限"
      : full
        ? character
          ? `最多再选 ${limit} 个`
          : "一次最多引入 20 个"
        : "";
  const filtered = !library && (keyword || range !== "0" || filter !== "all");
  return (
    <dialog
      ref={dialog}
      aria-label={dialogTitle ?? (character ? characterPickTitles[character.purpose] : "资产库")}
      className="asset-pick"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!resolving) close();
      }}
      onClick={(event) => {
        if (resolving || event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          close();
      }}
    >
      <header inert={resolving}>
        <div className="asset-pick-line">
          <div role="tablist" aria-label="资产来源" className="asset-pick-tabs">
            {(["library", "history", "humans"] as const)
              .filter((value) => value !== "humans" || (character && character.purpose !== "voice"))
              .map((value) => (
                <motion.button
                  type="button"
                  role="tab"
                  whileTap={{ scale: 0.96 }}
                  key={value}
                  aria-selected={source === value}
                  onClick={() => {
                    setSource(value);
                    setFolder(undefined);
                    setQuery("");
                  }}
                >
                  {source === value && (
                    <motion.span
                      className="asset-source-slide"
                      layoutId={slideId}
                      transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
                    />
                  )}
                  <span>
                    {value === "library"
                      ? "个人资产库"
                      : value === "humans"
                        ? "真人库"
                        : "生成历史"}
                  </span>
                </motion.button>
              ))}
          </div>
          <div className="asset-pick-actions">
            <label>
              <Search size={16} />
              <input
                value={query}
                aria-label={title}
                placeholder={title}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.preventDefault();
                    setQuery("");
                  }
                }}
              />
            </label>
            {library ? (
              <button type="button"
                className="asset-pick-upload"
                disabled={importing}
                onClick={() => fileInput.current?.click()}
              >
                <Upload size={16} />
                上传
              </button>
            ) : humans ? null : (
              <>
                <PickerFilter
                  label="时间"
                  icon={<Clock size={16} />}
                  options={ranges}
                  value={range}
                  change={setRange}
                  container={dialog}
                />
                <PickerFilter
                  label="筛选"
                  canvasGroup
                  icon={<ListFilter size={16} />}
                  options={{ all: "全部来源", conversation: "首页对话", canvas: projectName }}
                  value={filter}
                  change={setFilter}
                  container={dialog}
                />
              </>
            )}
            <i role="separator" aria-orientation="vertical" />
            <motion.button
              className="asset-pick-icon"
              aria-label="关闭"
              whileTap={{ scale: 0.96 }}
              onClick={close}
            >
              <X size={16} />
            </motion.button>
          </div>
        </div>
        {source === "history" && !lockedKind && (
          <div role="group" aria-label="内容类型" className="asset-pick-kinds">
            {(Object.keys(kinds) as (keyof typeof kinds)[]).map((value) => (
              <button type="button" key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>
                {kinds[value]}
              </button>
            ))}
          </div>
        )}
      </header>
      <input
        type="file"
        hidden
        ref={fileInput}
        aria-label="选择要上传的文件"
        accept={lockedKind ? `${lockedKind}/*` : "image/*,video/*,audio/*"}
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) uploads.add(files, folderId);
        }}
      />
      <section key={source} className="asset-pick-body" inert={resolving}>
        {feedback}
        {notice && (
          <p role="status" className="asset-upload-notice">
            {notice.text}
          </p>
        )}
        {tasks.map(
          (task) =>
            task.choose && (
              <fieldset key={task.id} aria-label="处理重复素材">
                <legend>{task.file.name} 已存在</legend>
                <button type="button" onClick={() => task.choose?.("reuse")}>复用现有素材</button>
                <button type="button" onClick={() => task.choose?.("independent")}>保留独立记录</button>
                <button type="button" onClick={() => task.choose?.("cancel")}>跳过此文件</button>
              </fieldset>
            ),
        )}
        {pickError && <p role="alert">{pickError}</p>}
        {library && (keyword || folderId) && (
          <nav aria-label="当前位置">
            <button type="button"
              onClick={() => {
                setQuery("");
                setFolder(undefined);
              }}
            >
              个人资产库
            </button>
            <ChevronRight size={16} />
            <b>
              {keyword
                ? "搜索结果"
                : (folders.find((folder) => folder.id === folderId)?.name ?? "…")}
            </b>
          </nav>
        )}
        {humans ? (
          <AssetHumanPane
            query={search}
            assets={assets}
            selected={selected}
            toggle={toggle}
            reason={(id) => characterPickReason(character, id) ?? (full ? "已达上限" : undefined)}
          />
        ) : library && libraryLoad !== "ready" ? (
          libraryLoad === "loading" ? (
            <div className="asset-pick-empty" role="status" aria-label="加载中">
              <Loader2 className="asset-pick-spinner" size={24} />
            </div>
          ) : (
            <div className="asset-pick-empty" role="alert">
              <PickerEmptyLogo />
              <strong>加载失败</strong>
              <span>
                <button type="button" className="asset-pick-reload" onClick={() => void reload()}>
                  重试
                </button>
              </span>
            </div>
          )
        ) : visible.length || pending.length || shownFolders.length ? (
          <PagedAssetGrid
            key={JSON.stringify([source, kind, keyword, range, filter, folderId])}
            items={visible}
            pending={
              <>
                {shownFolders.map((folder) => {
                  const day = new Date(folder.createdAt);
                  const stamp = `${day.getFullYear() === today.getFullYear() ? "" : `${day.getFullYear()}年`}${day.getMonth() + 1}月${day.getDate()}日`;
                  return (
                    <motion.div
                      className="asset-folder-card"
                      key={folder.id}
                      whileTap={{ scale: 0.985 }}
                    >
                      <button
                        type="button"
                        aria-label={`打开文件夹 ${folder.name}`}
                        onClick={() => {
                          setFolder(folder.id);
                          setQuery("");
                        }}
                      >
                        <Folder strokeWidth={1.5} />
                        <span>
                          <strong>{folder.name}</strong>
                          <small>
                            {libraryRows.filter((item) => item.folderId === folder.id).length} 项 ·{" "}
                            {stamp}
                          </small>
                        </span>
                      </button>
                    </motion.div>
                  );
                })}
                {pending.map((task) => (
                  <AssetUploadCard
                    key={task.id}
                    task={task}
                    container={dialog}
                    cancel={() => uploads.cancel(task.id)}
                    retry={() => uploads.retry(task.id)}
                  />
                ))}
              </>
            }
            card={(asset) => {
              const order = selected.findIndex((item) => item.assetId === asset.assetId) + 1;
              const reason =
                !order &&
                ((filingChannelId &&
                remoteItems.has(asset.assetId) &&
                asset.metadata.filingHumanName
                  ? "已在真人库"
                  : undefined) ??
                  reasonOf?.(asset) ??
                  characterPickReason(character, asset.assetId) ??
                  (character && full ? "已达上限" : undefined));
              const disabled = !order && (full || !!reason);
              const duration =
                asset.mediaType !== "image" &&
                formatMediaDuration(Number(asset.metadata.durationMs));
              const job = history.get(asset.assetId);
              const label = library ? asset.displayName : job?.outputPrompt || asset.displayName;
              const day = new Date(asset.createdAt ?? job?.updatedAt ?? "");
              const dateLabel = Number.isNaN(day.getTime())
                ? ""
                : `${day.getFullYear() === today.getFullYear() ? "" : `${day.getFullYear()}年`}${day.getMonth() + 1}月${day.getDate()}日`;
              return (
                <motion.div
                  key={asset.assetId}
                  className="asset-pick-card"
                  data-kind={asset.mediaType}
                  data-source={source}
                  data-selected={!!order || undefined}
                  data-disabled={disabled || undefined}
                  whileTap={disabled ? undefined : { scale: 0.985 }}
                >
                  <div className="asset-pick-cover">
                    <Cover asset={asset} handle={handle} library={remoteItems.has(asset.assetId)} />
                  </div>
                  <button
                    type="button"
                    className="asset-pick-hit"
                    aria-label={label}
                    aria-description={reason || undefined}
                    aria-pressed={!!order}
                    disabled={disabled}
                    onClick={() => toggle(asset)}
                  />
                  {reason && <span className="asset-pick-reason">{reason}</span>}
                  <b aria-hidden>{order || ""}</b>
                  {duration && <small>{duration}</small>}
                  <span className="asset-card-name">
                    {label}
                    {!library && (
                      <small>{[job?.model, dateLabel].filter(Boolean).join(" · ")}</small>
                    )}
                  </span>
                </motion.div>
              );
            }}
          />
        ) : (
          <div className="asset-pick-empty">
            <PickerEmptyLogo />
            <strong>
              {library
                ? keyword
                  ? `没有找到“${search.trim()}”`
                  : folderId
                    ? "这个文件夹是空的"
                    : "还没有资产"
                : filtered
                  ? "没有符合条件的素材"
                  : "暂无相关资产"}
            </strong>
            {filtered ? (
              <button type="button"
                onClick={() => {
                  setRange("0");
                  setFilter("all");
                  setQuery("");
                }}
              >
                清除筛选
              </button>
            ) : (
              <span>
                {library
                  ? keyword
                    ? "换个关键词试试"
                    : folderId
                      ? "点右上角「上传」添加素材"
                      : "点右上角「上传」，或先在资产页把生成历史加入资产库"
                  : "在「创作」里生成的内容会出现在这里"}
              </span>
            )}
          </div>
        )}
        {!!(pending.length || shownFolders.length) && !visible.length && (
          <p className="asset-upload-no-items">这里还没有素材</p>
        )}
      </section>
      <footer inert={resolving} aria-busy={resolving}>
        {!!selected.length && (
          <ul aria-label="已选素材">
            <AnimatePresence initial={false}>
              {selected.slice(0, 8).map((asset) => (
                <motion.li
                  layout
                  key={asset.assetId}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.126 } }}
                  transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                >
                  <button type="button"
                    aria-label={`取消选择 ${asset.displayName}`}
                    title={asset.displayName}
                    onClick={() => toggle(asset)}
                  >
                    {"filed" in asset ? (
                      <FilingCover channel={asset.filed.channel} imageId={asset.filed.image.id} />
                    ) : (
                      <Cover
                        asset={asset}
                        handle={handle}
                        library={remoteChoices.current.has(asset)}
                      />
                    )}
                    <span>
                      <X size={16} />
                    </span>
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
            {selected.length > 8 && <li>+{selected.length - 8}</li>}
          </ul>
        )}
        <p aria-live="polite">
          <strong>{`已选择 ${selected.length} 个素材`}</strong>
          {hint && <small>{hint}</small>}
        </p>
        <span title={!selected.length ? hint : undefined}>
          <button type="button"
            className="asset-pick-confirm"
            disabled={resolving || importing || !selected.length || selected.length > capacity}
            onClick={async () => {
              if (resolving) return;
              setPickError("");
              setResolving(true);
              try {
                const batch: ProjectAsset[] = [];
                for (const choice of selected) {
                  if (!live.current) return;
                  const asset =
                    "filed" in choice
                      ? await attachFiled?.(choice.filed)
                      : remoteChoices.current.has(choice)
                        ? await attachLibrary?.(choice.assetId)
                        : assets.find(
                            (item) =>
                              item.assetId === choice.assetId && item.availability === "ready",
                          );
                  if (!asset || characterPickReason(character, asset.assetId)) throw new Error();
                  const reason = reasonOf?.(asset);
                  if (reason) {
                    setPickError(reason);
                    return;
                  }
                  if (!live.current) return;
                  if ("filed" in choice || remoteChoices.current.has(choice))
                    setSelected((current) =>
                      current.map((item) => (item.assetId === choice.assetId ? asset : item)),
                    );
                  if (!batch.some((item) => item.assetId === asset.assetId)) batch.push(asset);
                }
                if (live.current) {
                  const issue = await confirm(batch);
                  if (issue && live.current) setPickError(issue);
                }
              } catch {
                if (live.current) setPickError("无法引入所选素材，请检查素材状态后重试。");
              } finally {
                if (live.current) setResolving(false);
              }
            }}
          >
            {confirmLabel ?? (character ? "确定" : lockedKind ? "放进节点" : "确认")}
          </button>
        </span>
      </footer>
    </dialog>
  );
}
