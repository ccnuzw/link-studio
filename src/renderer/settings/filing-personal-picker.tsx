import type { ChannelView, ProjectValues } from "@link-studio/core";
import {
  ChevronRight,
  Clock,
  Folder,
  Library,
  ListFilter,
  Loader2,
  Search,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AssetUploadCard } from "../workspace/asset-upload-card";
import { PickerEmptyLogo } from "../workspace/picker-empty-logo";
import { PickerFilter } from "../workspace/picker-filter";
import { pickerUploads } from "../workspace/picker-uploads";
import "../workspace/asset-picker.css";
import { settingsError } from "./settings-page";

function folderDate(value: string) {
  const day = new Date(value);
  if (!Number.isFinite(day.getTime())) return value;
  return `${day.getFullYear() === new Date().getFullYear() ? "" : `${day.getFullYear()}年`}${day.getMonth() + 1}月${day.getDate()}日`;
}

function LibraryMore({ load }: { load: () => Promise<void> }) {
  const footer = useRef<HTMLDivElement>(null),
    pending = useRef(false),
    latest = useRef(load);
  const [state, setState] = useState<"ready" | "loading" | "failed">("ready");
  useLayoutEffect(() => {
    latest.current = load;
  }, [load]);
  async function readMore() {
    if (pending.current) return;
    pending.current = true;
    setState("loading");
    try {
      await latest.current();
    } catch {
      pending.current = false;
      setState("failed");
    }
  }
  useEffect(() => {
    if (!footer.current || state !== "ready") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void readMore();
      },
      { root: footer.current.parentElement, rootMargin: "400px 0px" },
    );
    observer.observe(footer.current);
    return () => observer.disconnect();
  }, [state]);
  return (
    <div className="asset-pick-more filing-library-more" ref={footer}>
      {state === "loading" && (
        <Loader2 role="status" aria-label="加载中" size={16} className="asset-pick-spinner" />
      )}
      {state === "failed" && (
        <>
          <span role="alert">加载失败</span>
          <button className="asset-pick-reload" type="button" onClick={() => void readMore()}>
            重试
          </button>
        </>
      )}
    </div>
  );
}

export function FilingPersonalPicker({
  channel,
  name,
  humanId,
  close,
  done,
}: {
  channel: ChannelView;
  name: string;
  humanId?: string;
  close: () => void;
  done: (message: string) => void;
}) {
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<ProjectValues["filingLibraryPage"]>();
  const [selected, setSelected] = useState<ProjectValues["filingLibraryPage"]["selected"]>();
  const choice = selected?.choice;
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploadNotice, setUploadNotice] = useState("");
  const uploadInput = useRef<HTMLInputElement>(null);
  const grant = useRef<{ page: string; folder?: string; destination: string }>(undefined);
  const uploadSession = useRef("");
  const receipts = useRef(new Map<string, string>());
  const carry = useRef<ProjectValues["filingLibraryPage"]["selected"]>(undefined);
  const loadQueue = useRef(Promise.resolve());
  const lifetime = useRef(0);
  function pick(item?: NonNullable<typeof carry.current>) {
    carry.current = item;
    setSelected(item);
  }
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState<string>();
  const [history, setHistory] = useState(false),
    [range, setRange] = useState("0"),
    [source, setSource] = useState("all");
  const [canvases, setCanvases] = useState<{ id: string; name: string }[]>([]);
  const searchLabel = history ? "搜索提示词" : "搜索文件名";
  const filtered = !!search || range !== "0" || source !== "all";
  function changeSource(next: boolean) {
    if (history !== next) {
      setHistory(next);
      setQuery("");
      setSearch("");
      setFolder(undefined);
    }
  }
  const target = useRef({ id: channel.id, revision: channel.revision, search });
  useLayoutEffect(() => {
    target.current = { id: channel.id, revision: channel.revision, search };
  }, [channel.id, channel.revision, search]);
  async function publishReceipts() {
    const current = grant.current,
      session = uploadSession.current;
    if (!current || !session) return;
    const { id: channelId, revision: channelRevision, search } = target.current;
    for (const [receipt, destination] of receipts.current) {
      const result = await window.desktop.projects.filingLibraryUploaded({
        page: current.page,
        channelId,
        channelRevision,
        receipt,
      });
      if (session !== uploadSession.current) return;
      if (!result.ok) {
        setUploadNotice(result.error.message ?? "图片已上传，但无法勾选");
        receipts.current.delete(receipt);
        continue;
      }
      receipts.current.delete(receipt);
      const { item, folders } = result.value;
      setPage((previous) =>
        previous?.page !== current.page
          ? previous
          : {
              ...previous,
              folders,
              items:
                !search && destination === current.destination
                  ? [item, ...previous.items.filter((entry) => entry.choice !== item.choice)]
                  : previous.items,
            },
      );
      if (item.reason) setUploadNotice(item.reason);
      else if (!carry.current) pick(item);
      else
        setUploadNotice((previous) =>
          [previous, `已选满，「${item.name}」已上传但没有勾选`].filter(Boolean).join("；"),
        );
    }
  }
  const [uploads] = useState(() =>
    pickerUploads(
      async (file, signal, progress, _duplicate, destination) => {
        const session = uploadSession.current,
          { id: channelId, revision: channelRevision } = target.current;
        if (!session || !destination) throw Error("图片选择已失效，请重新选择");
        if (!file.size || file.size > 10 * 1024 * 1024)
          throw Error("单张备案图片须大于零且不超过 10 MiB");
        const bytes = new Uint8Array(await file.arrayBuffer());
        signal.throwIfAborted();
        const uploadId = crypto.randomUUID(),
          api = window.desktop.projects;
        const cancel = () => {
          void api.filingLibraryCancelUpload({ session, uploadId }).catch(() => {});
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          progress({ status: "registering", percent: 100 });
          const result = await api.filingLibraryUpload({
            session,
            destination,
            channelId,
            channelRevision,
            uploadId,
            name: file.name,
            bytes,
          });
          if (!result.ok) throw Error(result.error.message ?? "无法导入图片");
          return { session, destination, receipt: result.value.receipt };
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      },
      ({ session, destination, receipt }) => {
        if (uploadSession.current !== session) return;
        receipts.current.set(receipt, destination);
        loadQueue.current = loadQueue.current
          .then(publishReceipts)
          .catch(() => setUploadNotice("图片已上传，但无法勾选"));
      },
    ),
  );
  const allTasks = useSyncExternalStore(uploads.subscribe, uploads.snapshot);
  const tasks =
    history || search ? [] : allTasks.filter((task) => task.folderId === page?.destination);
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current,
      previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(
    () => () => {
      lifetime.current++;
      uploads.clear();
      if (uploadSession.current)
        void window.desktop.projects.filingLibraryClose({ session: uploadSession.current });
      grant.current = undefined;
      uploadSession.current = "";
      receipts.current.clear();
      pick();
    },
    [channel.id, channel.revision, uploads],
  );
  useEffect(() => {
    let active = true;
    const epoch = lifetime.current;
    const api = window.desktop.projects;
    setPage(undefined);
    setError("");
    setUploadNotice("");
    loadQueue.current = loadQueue.current
      .then(async () => {
        if (!active) return;
        const prior = carry.current;
        const result = await api.filingLibraryPage({
          channelId: channel.id,
          channelRevision: channel.revision,
          search,
          folder,
          ...(history && {
            history: {
              ...(range !== "0" && { days: Number(range) as 1 | 7 | 30 }),
              ...(source === "conversation"
                ? { conversation: true }
                : source !== "all"
                  ? { canvas: source }
                  : {}),
            },
          }),
          ...(uploadSession.current && { session: uploadSession.current }),
          ...(prior &&
            grant.current && { carry: { page: grant.current.page, choice: prior.choice } }),
        });
        if (epoch !== lifetime.current) {
          if (result.ok) void api.filingLibraryClose({ page: result.value.page });
          return;
        }
        if (result.ok) {
          grant.current = {
            page: result.value.page,
            folder,
            destination: result.value.destination,
          };
          uploadSession.current = result.value.session;
          if (carry.current === prior) pick(result.value.selected);
        } else if (result.error.code === "ASSET_NOT_FOUND") {
          grant.current = undefined;
          pick();
          uploadSession.current = "";
          uploads.clear();
          receipts.current.clear();
        }
        if (!active) return;
        if (result.ok && folder && !result.value.folders.some((entry) => entry.id === folder))
          setFolder(undefined);
        else if (result.ok) {
          setPage(result.value);
          if (result.value.canvases) setCanvases(result.value.canvases);
          await publishReceipts();
        } else setError(result.error.message ?? "无法读取个人库");
      })
      .catch(() => {
        if (active) setError("无法读取个人库");
      });
    return () => {
      active = false;
    };
  }, [channel.id, channel.revision, retry, search, folder, uploads, history, range, source]);

  async function loadMore() {
    if (!page?.next) return;
    const result = await window.desktop.projects.filingLibraryMore({
      page: page.page,
      before: page.next,
      channelId: channel.id,
      channelRevision: channel.revision,
    });
    if (!result.ok) throw Error(result.error.message ?? "加载失败");
    setPage((current) =>
      current?.page === page.page && current.next === page.next
        ? { ...current, next: result.value.next, items: [...current.items, ...result.value.items] }
        : current,
    );
  }

  function submit() {
    if (!choice || saving) return;
    setSaving(true);
    setUploadNotice("");
    const epoch = lifetime.current;
    loadQueue.current = loadQueue.current
      .then(async () => {
        if (!grant.current || !carry.current || epoch !== lifetime.current) return;
        const result = await window.desktop.projects.filingLibraryEnroll({
          page: grant.current.page,
          choice: carry.current.choice,
          channelId: channel.id,
          channelRevision: channel.revision,
          name,
          humanId,
          confirmed: true,
        });
        if (epoch !== lifetime.current) return;
        if (!result.ok) setUploadNotice(result.error.message ?? "无法提交图片");
        else if ("error" in result.value) setUploadNotice(settingsError(result.value.error));
        else
          done(
            result.value.status === "failed"
              ? "图片已加入真人库，提交方舟失败，可在详情重新提交。"
              : "图片已加入真人库并提交审核。",
          );
      })
      .catch(() => {
        if (epoch === lifetime.current) setUploadNotice("无法提交图片");
      })
      .finally(() => {
        if (epoch === lifetime.current) setSaving(false);
      });
  }
  const destination = grant.current?.folder === folder ? grant.current?.destination : undefined;
  const visibleItems = page?.items ?? [];
  const folders = !history && !folder && !search ? (page?.folders ?? []) : [];
  const preview = (token: string) => `link-media://filing-library/${grant.current?.page}/${token}`;
  return createPortal(
    <dialog
      ref={dialog}
      className="asset-pick filing-personal-picker"
      aria-label="选择图片"
      closedby="any"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!saving) close();
      }}
    >
      <header inert={saving}>
        <div className="asset-pick-line">
          <div className="asset-pick-tabs" role="tablist" aria-label="资产来源">
            {["个人资产库", "生成历史"].map((label, index) => (
              <button
                key={label}
                type="button"
                role="tab"
                aria-selected={history === !!index}
                onClick={() => changeSource(!!index)}
              >
                {history === !!index && <span className="asset-source-slide" />}
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div className="asset-pick-actions">
            <label>
              <Search size={16} />
              <input
                disabled={saving}
                type="search"
                maxLength={255}
                value={query}
                aria-label={searchLabel}
                placeholder={searchLabel}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {history ? (
              <>
                <PickerFilter
                  label="时间"
                  icon={<Clock size={16} />}
                  options={{ 0: "全部时间", 1: "今天", 7: "近 7 天", 30: "近 30 天" }}
                  value={range}
                  change={setRange}
                  container={dialog}
                />
                <PickerFilter
                  canvasGroup
                  label="筛选"
                  icon={<ListFilter size={16} />}
                  options={{
                    all: "全部来源",
                    conversation: "首页对话",
                    ...Object.fromEntries(canvases.map((entry) => [entry.id, entry.name])),
                  }}
                  value={source}
                  change={setSource}
                  container={dialog}
                />
              </>
            ) : (
              <button
                type="button"
                className="asset-pick-upload"
                disabled={!destination || saving}
                onClick={() => uploadInput.current?.click()}
              >
                <Upload size={16} />
                上传
              </button>
            )}
            <i role="separator" aria-orientation="vertical" />
            <button
              type="button"
              aria-label="关闭"
              className="asset-pick-icon"
              disabled={saving}
              onClick={close}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </header>
      <input
        ref={uploadInput}
        hidden
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp"
        aria-label="选择要上传的文件"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (destination && !saving) {
            setUploadNotice("");
            uploads.add(files, destination);
          }
        }}
      />
      <section className="asset-pick-body" inert={saving}>
        {!history && (folder || search) && (
          <nav aria-label="当前位置" className="asset-library-crumb">
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setQuery("");
                setSearch("");
                setFolder(undefined);
              }}
            >
              个人资产库
            </button>
            <ChevronRight size={16} />
            <b>
              {search
                ? "搜索结果"
                : (page?.folders.find((entry) => entry.id === folder)?.name ?? "…")}
            </b>
          </nav>
        )}
        {!page && !error && (
          <div className="asset-pick-empty" role="status" aria-label="加载中">
            <Loader2 className="asset-pick-spinner" size={24} />
          </div>
        )}
        {!page && error && (
          <div className="asset-pick-empty" role="alert" aria-description={error}>
            <PickerEmptyLogo />
            <strong>加载失败</strong>
            <span>
              <button
                className="asset-pick-reload"
                type="button"
                onClick={() => setRetry((value) => value + 1)}
              >
                重试
              </button>
            </span>
          </div>
        )}
        {page && !visibleItems.length && !folders.length && !tasks.length && (
          <div className="asset-pick-empty">
            <PickerEmptyLogo />
            <strong>
              {history
                ? filtered
                  ? "没有符合条件的素材"
                  : "暂无相关资产"
                : search
                  ? `没有找到“${search}”`
                  : folder
                    ? "这个文件夹是空的"
                    : "还没有资产"}
            </strong>
            <span>
              {history ? (
                filtered ? (
                  <button
                    type="button"
                    className="asset-pick-reload"
                    onClick={() => {
                      setQuery("");
                      setSearch("");
                      setRange("0");
                      setSource("all");
                    }}
                  >
                    清除筛选
                  </button>
                ) : (
                  "在「创作」里生成的内容会出现在这里"
                )
              ) : search ? (
                "换个关键词试试"
              ) : folder ? (
                "点右上角「上传」添加素材"
              ) : (
                "点右上角「上传」，或先在资产页把生成历史加入资产库"
              )}
            </span>
          </div>
        )}
        {page && (
          <div className="asset-pick-grid">
            {folders.map((entry) => (
              <div key={entry.id} className="asset-folder-card">
                <button
                  type="button"
                  disabled={saving}
                  aria-label={`打开文件夹 ${entry.name}`}
                  onClick={() => setFolder(entry.id)}
                >
                  <Folder strokeWidth={1.5} />
                  <span>
                    <strong>{entry.name}</strong>
                    <small>
                      {entry.itemCount} 项 · {folderDate(entry.createdAt)}
                    </small>
                  </span>
                </button>
              </div>
            ))}
            {tasks.map((task) => (
              <AssetUploadCard
                key={task.id}
                task={task}
                container={dialog}
                cancel={() => uploads.cancel(task.id)}
                retry={() => uploads.retry(task.id)}
              />
            ))}
            {visibleItems.map((item) => (
              <div
                key={item.choice}
                className="asset-pick-card"
                data-source={history ? "history" : "library"}
                data-kind="image"
                data-selected={item.choice === choice || undefined}
                data-disabled={!!item.reason || undefined}
              >
                <div className="asset-pick-cover">
                  <img loading="lazy" alt={item.name} src={preview(item.choice)} />
                </div>
                {item.inLibrary && (
                  <span className="asset-history-library-badge">
                    <Library size={12} />
                    已在资产库
                  </span>
                )}
                <button
                  type="button"
                  className="asset-pick-hit"
                  aria-label={item.prompt || item.name}
                  aria-description={item.reason}
                  aria-pressed={choice === item.choice}
                  disabled={saving || !!item.reason}
                  onClick={() => pick(choice === item.choice ? undefined : item)}
                />
                <b aria-hidden>{choice === item.choice ? "1" : ""}</b>
                <span className="asset-card-name">
                  {item.prompt || item.name}
                  {item.createdAt && (
                    <small>
                      {[item.model, folderDate(item.createdAt)].filter(Boolean).join(" · ")}
                    </small>
                  )}
                </span>
                {item.reason && <span className="asset-pick-reason">{item.reason}</span>}
              </div>
            ))}
          </div>
        )}
        {(folders.length > 0 || tasks.length > 0) && !visibleItems.length && (
          <p className="asset-upload-no-items">{search ? "没有符合的素材" : "这里还没有素材"}</p>
        )}
        {page && error && (
          <p role="alert">
            {error}{" "}
            <button type="button" disabled={saving} onClick={() => setRetry((value) => value + 1)}>
              重新读取
            </button>
          </p>
        )}
        {page?.next && <LibraryMore key={`${page.page}:${page.next}`} load={loadMore} />}
      </section>
      {uploadNotice && (
        <p role="status" className="asset-upload-notice">
          {uploadNotice}
        </p>
      )}
      <footer>
        {selected && (
          <ul aria-label="已选素材">
            <li>
              <button
                type="button"
                aria-label={`取消选择 ${selected.name}`}
                title={selected.name}
                disabled={saving}
                onClick={() => pick()}
              >
                <img alt="" src={preview(selected.choice)} />
                <span>
                  <X size={16} />
                </span>
              </button>
            </li>
          </ul>
        )}
        <p aria-live="polite">
          <strong>已选择 {selected ? 1 : 0} 个素材</strong>
          {!selected && <small>请先选择素材</small>}
        </p>
        <span title={!selected ? "请先选择素材" : undefined}>
          <button
            type="button"
            className="asset-pick-confirm"
            disabled={!selected || saving}
            onClick={() => void submit()}
          >
            {saving ? "正在提交…" : "添加并提交备案"}
          </button>
        </span>
      </footer>
    </dialog>,
    document.body,
  );
}
