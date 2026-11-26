import type { ChannelView, ProjectAsset, ProjectValues } from "@link-studio/core";
import { requirePresent } from "@link-studio/core";
import {
  ChevronRight,
  ExternalLink,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Library,
  Music2,
  Pencil,
  Plus,
  Trash2,
  Unlink,
  Upload,
  UserRound,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AssetVideo } from "../asset-media";
import { ChoiceButton } from "../choice-button";
import { FilingLibrary } from "../settings/filing-library";
import { AudioPreview } from "./audio-preview";
import { AssetActions, AssetFilter, AssetSearch, AssetToolbar } from "./home-asset-controls";
import { HomeAssetEnroll } from "./home-asset-enroll";
import { homeAssetRoute, navigateHomeAssets } from "./home-asset-route";
import { ImportCard, useHomeAssetUploads } from "./home-asset-uploads";
import { VoiceLibrary } from "./home-asset-voices";
import { LibraryFolderForm } from "./library-folder-form";
import { DeleteLibraryFolder, LibraryLocationDialog } from "./library-management";
import { formatMediaDuration } from "./node-video-state";
import { ShotImagePreview } from "./shot-image-preview";
import { usePersonalLibrary } from "./use-personal-library";
import "./global-assets.css";

type Media = ProjectAsset["mediaType"];
type HistoryPage = ProjectValues["globalHistory"];
const sections = {
  history: "生成历史",
  personal: "个人资产库",
  voices: "音色库",
  humans: "真人库",
} as const;
const kinds = { image: "图片", video: "视频", audio: "音频" } as const;

function Choices<Key extends string>({
  label,
  names,
  value,
  change,
}: {
  label: string;
  names: Record<Key, string>;
  value: Key;
  change: (value: Key) => void;
}) {
  return (
    <div className="desk-segments" role="radiogroup" aria-label={label}>
      {(Object.keys(names) as Key[]).map((key) => (
        <ChoiceButton
          key={key}
          aria-checked={key === value}
          tabIndex={key === value ? 0 : -1}
          onClick={() => change(key)}
        >
          {names[key]}
        </ChoiceButton>
      ))}
    </div>
  );
}

type Entry = {
  id: string;
  name: string;
  media: Media;
  src: string;
  prompt?: string;
  bytes?: number;
  aspect?: number;
  durationMs?: number;
  saved?: boolean;
  model?: string;
  createdAt?: string;
  humanName?: string;
};
function assetDay(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${date.getFullYear() === new Date().getFullYear() ? "" : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`;
}
function MediaCard({
  entry,
  history,
  open,
  actions,
}: {
  entry: Entry;
  history?: boolean;
  open: () => void;
  actions: Parameters<typeof AssetActions>[0]["actions"];
}) {
  const duration = formatMediaDuration(entry.durationMs);
  return (
    <article className="global-card" data-history={!!history}>
      <button
        type="button"
        className="global-cover"
        aria-label={entry.prompt || entry.name}
        onClick={open}
        style={{
          aspectRatio:
            entry.media === "audio"
              ? 1.6
              : entry.aspect
                ? Math.min(21 / 9, Math.max(9 / 16, entry.aspect))
                : entry.media === "video"
                  ? 1.6
                  : 1,
        }}
      >
        {entry.media === "image" ? (
          <img loading="lazy" alt="" src={entry.src} />
        ) : entry.media === "video" ? (
          <AssetVideo muted preload="metadata" src={entry.src} />
        ) : (
          <Music2 width="25%" height="25%" />
        )}
      </button>
      <div className="global-badges">
        {entry.humanName && (
          <small>
            <UserRound size={12} />
            真人 · {entry.humanName}
          </small>
        )}
        {duration && <small>{duration}</small>}
        {entry.saved && (
          <small>
            <Library size={12} />
            已在资产库
          </small>
        )}
      </div>
      <div className="global-caption">
        <span>{entry.prompt || entry.name}</span>
        {history && (
          <small>{[entry.model, assetDay(entry.createdAt)].filter(Boolean).join(" · ")}</small>
        )}
      </div>
      <AssetActions label={`${entry.name} 操作`} actions={actions} />
    </article>
  );
}
function Gallery({
  entries,
  id,
  select,
  action,
  library,
}: {
  entries: Entry[];
  id: string;
  select: (id: string) => void;
  action?: (id: string) => ReactNode;
  library: "history" | "personal";
}) {
  const [downloadError, setDownloadError] = useState("");
  const active = entries.find((entry) => entry.id === id);
  if (!active) return null;
  return active.media === "audio" ? (
    <AudioPreview name={active.name} src={active.src} close={() => select("")} />
  ) : (
    <ShotImagePreview
      items={entries.flatMap((entry) =>
        entry.media === "audio"
          ? []
          : [
              {
                id: entry.id,
                assetId: entry.id,
                src: entry.src,
                label: entry.prompt || entry.name,
                fileName: entry.name,
                bytes: entry.bytes,
                kind: entry.media,
              },
            ],
      )}
      activeId={id}
      select={select}
      projectHandle=""
      countLabel="本页"
      close={() => select("")}
      download={async (assetId) => {
        setDownloadError("");
        try {
          const result = await window.desktop.projects.saveAssetCopy({ library, assetId });
          if (!result.ok) setDownloadError(result.error.message ?? "下载失败");
        } catch {
          setDownloadError("下载失败，请重试");
        }
      }}
      renderAction={(id) => (
        <>
          {downloadError && <span role="alert">{downloadError}</span>}
          {action?.(id)}
        </>
      )}
    />
  );
}
function HistoryResults({
  media,
  query,
  canvas,
  days,
  oldest,
  sources,
  resume,
  reset,
}: {
  resume: (id: string) => void;
  reset: () => void;
  media: Media;
  query: string;
  canvas: string;
  days: 1 | 7 | 30 | undefined;
  oldest: boolean;
  sources: (items: HistoryPage["canvases"]) => void;
}) {
  const [items, setItems] = useState<HistoryPage["items"]>([]);
  const [cursor, setCursor] = useState<HistoryPage["next"]>();
  const [next, setNext] = useState<HistoryPage["next"]>();
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    window.desktop.projects
      .globalHistory({
        filter: {
          ...(canvas === "conversation" ? { conversation: true } : canvas ? { canvas } : {}),
          ...(days && { days }),
        },
        search: query,
        media,
        oldest,
        ...(cursor && { before: cursor }),
      })
      .then((result) => {
        if (!active) return;
        if (!result.ok) throw Error();
        sources(result.value.canvases);
        setItems((current) => (cursor ? [...current, ...result.value.items] : result.value.items));
        setNext(result.value.next);
      })
      .catch(() => {
        if (active) setError("生成历史加载失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canvas, cursor, days, media, oldest, query, retry, sources]);
  const [preview, setPreview] = useState(""),
    [adding, setAdding] = useState("");
  const more = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!next || loading || error || !more.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setCursor(next);
      },
      { rootMargin: "400px" },
    );
    observer.observe(more.current);
    return () => observer.disconnect();
  }, [next, loading, error]);
  async function collect(id: string, folderId: string | null) {
    setSaving(id);
    setNotice("");
    try {
      const result = await window.desktop.projects.collectHistory({
        id,
        ...(folderId && { folderId }),
      });
      if (!result.ok) throw Error(result.error.message ?? "无法加入资产库");
      setItems((current) =>
        current.map((item) => (item.id === id ? { ...item, saved: true } : item)),
      );
      setNotice("已加入个人资产库");
      setAdding("");
    } finally {
      setSaving("");
    }
  }
  const entries = items.map((item) => ({
    ...item,
    media,
    src: `link-media://global-assets/history/${item.id}`,
  }));
  return (
    <>
      <div className="global-masonry">
        {entries.map((entry) => (
          <MediaCard
            key={entry.id}
            entry={entry}
            history
            open={() => setPreview(entry.id)}
            actions={[
              ...(!entry.saved
                ? [{ label: "加入资产库…", icon: FolderPlus, run: () => setAdding(entry.id) }]
                : []),
              { label: "在画布中打开", icon: ExternalLink, run: () => resume(entry.canvasId) },
            ]}
          />
        ))}
      </div>
      {!!preview && (
        <Gallery
          library="history"
          entries={entries}
          id={preview}
          select={setPreview}
          action={(id) => (
            <button
              type="button"
              disabled={items.find((item) => item.id === id)?.saved || !!saving}
              onClick={() => setAdding(id)}
            >
              {items.find((item) => item.id === id)?.saved ? "已在资产库" : "加入资产库…"}
            </button>
          )}
        />
      )}
      {adding && (
        <LibraryLocationDialog
          close={() => setAdding("")}
          confirm={(folder) => collect(adding, folder)}
        />
      )}
      {!loading && !error && !items.length && (
        <Empty>
          没有符合条件的生成记录
          {(query || days || canvas) && (
            <button type="button" onClick={reset}>
              清除筛选
            </button>
          )}
        </Empty>
      )}
      {loading && <p role="status">正在加载…</p>}
      {error ? (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </p>
      ) : (
        next &&
        !loading && (
          <button ref={more} type="button" onClick={() => setCursor(next)}>
            加载更多
          </button>
        )
      )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="global-empty">
      <FolderOpen aria-hidden="true" size={30} />
      <p>{children}</p>
    </div>
  );
}

function MediaLibrary({
  history,
  resume,
  folder,
  setFolder,
}: {
  history: boolean;
  resume: (id: string) => void;
  folder: string;
  setFolder: (folder: string) => void;
}) {
  const [media, setMedia] = useState<Media>("image"),
    [input, setInput] = useState(""),
    [query, setQuery] = useState("");
  const [canvas, setCanvas] = useState(""),
    [days, setDays] = useState<1 | 7 | 30>(),
    [oldest, setOldest] = useState(false);
  const [sources, setSources] = useState<HistoryPage["canvases"]>([]);
  const [notice, setNotice] = useState("");
  const picker = useRef<HTMLInputElement>(null),
    uploads = useHomeAssetUploads();
  const pending = uploads.tasks.filter((task) => !query && task.folder === folder);
  const library = usePersonalLibrary(undefined, !history);
  useEffect(() => {
    if (
      !history &&
      folder &&
      library.status === "ready" &&
      !library.folders.some((item) => item.id === folder)
    ) {
      setNotice("该内容已不存在");
      navigateHomeAssets("personal", "", true);
    }
  }, [history, folder, library.status, library.folders]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 180);
    return () => clearTimeout(timer);
  }, [input]);
  const [edit, setEdit] = useState<NonNullable<(typeof library.folders)[number]> | "new">(),
    [deleting, setDeleting] = useState<(typeof library.folders)[number]>(),
    [move, setMove] = useState<(typeof library.items)[number]>(),
    [preview, setPreview] = useState("");
  const run = async (task: Promise<{ ok: boolean }>, label: string) => {
    try {
      if (!(await task).ok) throw Error();
      await library.reload();
      setNotice(label);
    } catch {
      setNotice("操作失败，请重试");
    }
  };
  const [drag, setDrag] = useState(false),
    [channels, setChannels] = useState<ChannelView[]>([]),
    [enroll, setEnroll] = useState<Entry>();
  useEffect(() => {
    if (history) return;
    let active = true;
    void window.desktop.settings
      .channelList({})
      .then((result) => {
        if (active && result.ok)
          setChannels(result.value.filter((ch) => ch.filing?.enabled && ch.hasFilingKeys));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [history]);
  const rows = library.items.filter(
    (row) =>
      (query ? true : (row.folderId ?? "") === folder) &&
      row.asset.displayName.toLowerCase().includes(query.toLowerCase()),
  );
  const entries = rows.map(({ asset }) => ({
    id: asset.assetId,
    name: asset.displayName,
    src: `link-media://global-assets/personal/${asset.assetId}`,
    media: asset.mediaType,
    humanName:
      typeof asset.metadata.filingHumanName === "string"
        ? asset.metadata.filingHumanName
        : undefined,
    bytes: asset.sizeBytes,
    aspect: Number(asset.metadata.width) / Number(asset.metadata.height) || 0,
    durationMs: Number(asset.metadata.durationMs),
  }));
  return (
    <section
      aria-label={history ? "生成记录" : "个人资产库"}
      className="home-media-library"
      data-drag={drag}
      onDragOver={(event) => {
        if (!history && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrag(false);
      }}
      onDrop={(event) => {
        if (!history) {
          event.preventDefault();
          setDrag(false);
          uploads.add(Array.from(event.dataTransfer.files), folder);
        }
      }}
    >
      {!history && (
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept=".png,.jpeg,.jpg,.webp,.mp4,.mov,.webm,.wav,.mp3,.m4a,.ogg"
          onChange={(event) => {
            uploads.add(Array.from(event.target.files ?? []), folder);
            event.target.value = "";
          }}
        />
      )}
      {drag && (
        <div className="asset-drop-hint">
          松开上传到{library.folders.find((item) => item.id === folder)?.name ?? "根目录"}
        </div>
      )}
      {enroll && (
        <HomeAssetEnroll
          channels={channels}
          item={enroll}
          close={() => setEnroll(undefined)}
          done={(message) => {
            setEnroll(undefined);
            setNotice(message);
            void library.reload();
          }}
        />
      )}
      <AssetToolbar>
        {!history && (
          <div className="home-breadcrumb">
            <button
              type="button"
              onClick={() => {
                setFolder("");
                setInput("");
              }}
            >
              个人资产库
            </button>
            {(folder || query) && (
              <>
                <ChevronRight size={14} />
                {query ? "搜索结果" : library.folders.find((f) => f.id === folder)?.name}
              </>
            )}
          </div>
        )}
        {history && (
          <fieldset data-ui-group className="home-asset-kinds" aria-label="内容类型">
            {(Object.keys(kinds) as Media[]).map((key) => (
              <button
                type="button"
                key={key}
                aria-pressed={media === key}
                onClick={() => setMedia(key)}
              >
                {kinds[key]}
              </button>
            ))}
          </fieldset>
        )}
        {history && (
          <>
            <i className="home-asset-divider" />
            <AssetFilter
              label="来源"
              value={canvas}
              change={setCanvas}
              options={[
                { value: "", label: "全部来源" },
                { value: "conversation", label: "首页对话" },
                ...sources.map((item, index) => ({
                  value: item.id,
                  label: item.name,
                  heading: index === 0 ? "画布" : undefined,
                })),
              ]}
            />
            <AssetFilter
              label="时间"
              value={String(days ?? "")}
              change={(value) => setDays((Number(value) as 1 | 7 | 30) || undefined)}
              options={[
                { value: "", label: "全部时间" },
                { value: "1", label: "今天" },
                { value: "7", label: "近 7 天" },
                { value: "30", label: "近 30 天" },
              ]}
            />
            <AssetFilter
              label="排序"
              value={oldest ? "old" : ""}
              change={(value) => setOldest(value === "old")}
              options={[
                { value: "", label: "最新优先" },
                { value: "old", label: "最早优先" },
              ]}
            />
          </>
        )}
        <AssetSearch
          value={input}
          change={setInput}
          label={history ? "搜索提示词" : "搜索文件名"}
        />
        {!history && (
          <AssetActions
            label="新建"
            trigger={
              <>
                <Plus size={15} />
                新建
              </>
            }
            actions={[
              ...(!folder
                ? [{ label: "新建文件夹", icon: FolderPlus, run: () => setEdit("new") }]
                : []),
              { label: "上传资产", icon: Upload, run: () => picker.current?.click() },
            ]}
          />
        )}
      </AssetToolbar>
      {!history && !folder && !query && (
        <div className="home-folder-grid">
          {library.folders.map((item) => (
            <article key={item.id}>
              <button
                type="button"
                aria-label={`打开文件夹 ${item.name}`}
                onClick={() => setFolder(item.id)}
              >
                <Folder />
                <strong>{item.name}</strong>
                <small>
                  {item.itemCount} 项 · {assetDay(item.createdAt)}
                </small>
              </button>
              <AssetActions
                label={`${item.name} 操作`}
                actions={[
                  { label: "重命名", icon: Pencil, run: () => setEdit(item) },
                  { label: "删除", icon: Trash2, destructive: true, run: () => setDeleting(item) },
                ]}
              />
            </article>
          ))}
        </div>
      )}
      {edit && (
        <LibraryFolderForm
          folder={edit === "new" ? undefined : edit}
          close={() => {
            setEdit(undefined);
            void library.reload();
          }}
        />
      )}
      {deleting && (
        <DeleteLibraryFolder
          folder={deleting}
          close={() => setDeleting(undefined)}
          confirm={() => {
            void run(
              window.desktop.projects.deleteLibraryFolder({ folderId: deleting.id }),
              "已删除文件夹",
            );
            setDeleting(undefined);
          }}
        />
      )}
      {move && (
        <LibraryLocationDialog
          currentFolder={move.folderId ?? null}
          close={() => setMove(undefined)}
          confirm={async (folderId) => {
            const result = await window.desktop.projects.moveLibraryItem({
              itemId: move.asset.assetId,
              folderId,
            });
            if (!result.ok) throw Error(result.error.message);
            setMove(undefined);
            await library.reload();
          }}
        />
      )}
      {history ? (
        <HistoryResults
          key={JSON.stringify([media, query, canvas, days, oldest])}
          {...{ media, query, canvas, days, oldest }}
          sources={setSources}
          resume={resume}
          reset={() => {
            setCanvas("");
            setDays(undefined);
            setInput("");
            setQuery("");
          }}
        />
      ) : (
        <>
          {library.status === "error" ? (
            <p role="alert">
              个人资产库加载失败{" "}
              <button type="button" onClick={() => void library.reload()}>
                重试
              </button>
            </p>
          ) : library.status === "loading" ? (
            <p role="status">正在加载…</p>
          ) : rows.length || pending.length ? (
            <div className="global-masonry">
              {pending.map((task) => (
                <ImportCard
                  key={task.id}
                  task={task}
                  cancel={() => uploads.cancel(task.id)}
                  retry={() => uploads.retry(task.id)}
                />
              ))}
              {entries.map((entry, index) => (
                <MediaCard
                  key={entry.id}
                  entry={entry}
                  open={() => setPreview(entry.id)}
                  actions={[
                    ...(channels.length && entry.media === "image" && !entry.humanName
                      ? [{ label: "加入真人库", icon: UserRound, run: () => setEnroll(entry) }]
                      : []),
                    { label: "移动到…", icon: FolderInput, run: () => setMove(rows[index]) },
                    {
                      label: "移出资产库",
                      icon: Unlink,
                      run: () =>
                        void run(
                          window.desktop.projects.removeLibraryItem({ itemId: entry.id }),
                          "已移出资产库",
                        ),
                    },
                  ]}
                />
              ))}
            </div>
          ) : (
            !(!folder && !query && library.folders.length) && (
              <Empty>
                {query ? `没有找到“${query}”` : folder ? "这个文件夹是空的" : "还没有资产"}
                <small>
                  {query ? "换个关键词试试" : "点右上角「新建」上传，或在生成历史里加入资产库"}
                </small>
              </Empty>
            )
          )}
          {!!preview && (
            <Gallery library="personal" entries={entries} id={preview} select={setPreview} />
          )}
          {notice && <p role="status">{notice}</p>}
        </>
      )}
    </section>
  );
}

function HumanLibrary({ settings }: { settings: () => void }) {
  const [channels, setChannels] = useState<ChannelView[]>(),
    [channel, setChannel] = useState<ChannelView>();
  const [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    window.desktop.settings
      .channelList({})
      .then((result) => {
        if (!result.ok) throw Error();
        if (active) setChannels(result.value.filter((item) => item.filing?.enabled));
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [retry]);
  return (
    <>
      {failed ? (
        <p role="alert">
          真人库加载失败{" "}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </p>
      ) : !channels ? (
        <p role="status">正在加载…</p>
      ) : channels.length ? (
        <>
          {channels.length > 1 && (
            <AssetFilter
              label="备案渠道"
              value={channel?.id ?? requirePresent(channels[0], "channels[0]").id}
              options={channels.map((ch) => ({ value: ch.id, label: ch.name }))}
              change={(id) => setChannel(channels.find((ch) => ch.id === id))}
            />
          )}
          <FilingLibrary
            key={channel?.id ?? requirePresent(channels[0], "channels[0]").id}
            channel={channel ?? requirePresent(channels[0], "channels[0]")}
            home
            close={() => {}}
          />
        </>
      ) : (
        <Empty>
          请先在应用设置中启用备案渠道。
          <button type="button" onClick={settings}>
            打开应用设置
          </button>
        </Empty>
      )}
    </>
  );
}

export function GlobalAssets({
  settings,
  resume,
}: {
  settings: () => void;
  resume: (id: string) => void;
}) {
  const [route, setRoute] = useState(
    () => homeAssetRoute() ?? { section: "history" as const, folder: "" },
  );
  const { section, folder } = route;
  useEffect(() => {
    const sync = () => setRoute(homeAssetRoute() ?? { section: "history", folder: "" });
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return (
    <section className="global-assets" aria-label="全局资产库">
      <div className="global-heading">
        <h1>资产</h1>
        <Choices
          label="资产范围"
          names={sections}
          value={section}
          change={(tab) => navigateHomeAssets(tab)}
        />
      </div>
      {section === "humans" ? (
        <HumanLibrary settings={settings} />
      ) : section === "voices" ? (
        <VoiceLibrary />
      ) : (
        <MediaLibrary
          key={section}
          history={section === "history"}
          resume={resume}
          folder={folder}
          setFolder={(value) => navigateHomeAssets("personal", value)}
        />
      )}
    </section>
  );
}
