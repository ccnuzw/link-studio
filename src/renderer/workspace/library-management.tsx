import { Menu } from "@base-ui/react/menu";
import type { LibraryFolder, ProjectValues } from "@link-studio/core";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderPlus,
  House,
  LibraryBig,
  Loader2,
  Search,
  X,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ChoiceButton } from "../choice-button";
import { focusOnMount } from "../focus-on-mount";
import { Cover } from "./asset-picker-dialog";
import { BackdropDialog } from "./backdrop-dialog";
import { LibraryFolderForm } from "./library-folder-form";
import { usePersonalLibrary } from "./use-personal-library";
import "./library-management.css";

type Row = ProjectValues["listLibrary"]["items"][number];
const mediaLabels = { audio: "音频", image: "图片", video: "视频" };
function Surface({
  label,
  close,
  children,
  wide = false,
  alert = false,
}: {
  label: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  alert?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <BackdropDialog
      ref={ref}
      role={alert ? "alertdialog" : "dialog"}
      aria-label={label}
      className={
        wide
          ? "library-manager"
          : `library-folder-form library-management library-name-dialog ${alert ? "library-delete-dialog" : "library-location-dialog"}`
      }
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      dismiss={alert ? undefined : close}
    >
      {children}
    </BackdropDialog>
  );
}
function Actions({
  name,
  container,
  options,
}: {
  name: string;
  container: RefObject<HTMLDivElement | null>;
  options: [string, () => void][];
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger className="library-manager-action" aria-label={`${name} 操作`}>
        <Ellipsis size={17} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal container={container}>
        <Menu.Positioner align="end" sideOffset={5}>
          <Menu.Popup className="library-manager-menu">
            {options.map(([label, action]) => (
              <Menu.Item key={label} onClick={action}>
                {label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
export function LibraryLocationDialog({
  currentFolder,
  handle,
  close,
  confirm,
}: {
  currentFolder?: string | null;
  handle?: string;
  close: () => void;
  confirm: (folderId: string | null) => Promise<void>;
}) {
  const title = currentFolder === undefined ? "加入资产库" : "移动到";
  const [folders, setFolders] = useState<LibraryFolder[]>(),
    [failed, setFailed] = useState(false),
    [version, reload] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = () => reload((value) => value + 1);
    const unsubscribe = window.desktop.projectEvents?.onLibraryChanged?.(refresh);
    void window.desktop.projects
      .listLibraryFolders(handle ? { projectHandle: handle } : {})
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setFolders(result.value);
          setFailed(false);
        } else setFailed(true);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [handle, version]);
  const [destination, setDestination] = useState(currentFolder ?? null),
    [draft, setDraft] = useState<string | null>(null),
    [draftError, setDraftError] = useState(""),
    [error, setError] = useState(""),
    [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false);
  const locations = [{ id: null, name: "根目录", itemCount: 0 }, ...(folders ?? [])];
  return (
    <Surface
      label={title}
      close={() => {
        if (!busy) close();
      }}
    >
      <header>
        <h2>{title}</h2>
        <p>选择一个位置，文件夹只有一层。</p>
      </header>
      <div className="library-locations" role="radiogroup" aria-label="位置">
        {locations.map((location) => (
          <ChoiceButton
            type="button"
            key={location.id ?? "root"}
            role="radio"
            aria-checked={destination === location.id}
            onClick={() => setDestination(location.id)}
          >
            {location.id ? <Folder size={16} /> : <House size={16} />}
            <span>{location.name}</span>
            {(location.id !== null || currentFolder === null) && (
              <small>
                {location.id === currentFolder
                  ? "当前位置"
                  : location.id
                    ? `${location.itemCount} 项`
                    : ""}
              </small>
            )}
            {destination === location.id && <Check size={16} />}
          </ChoiceButton>
        ))}
        {!folders && !failed && (
          <div className="library-loading" aria-busy="true">
            <i />
            <i />
          </div>
        )}
        {failed && (
          <div className="library-location-error">
            文件夹加载失败
            <button type="button" onClick={() => reload((value) => value + 1)}>
              重试
            </button>
          </div>
        )}
      </div>
      {draft === null ? (
        <button
          type="button"
          className="library-inline-create"
          disabled={!folders || failed}
          onClick={() => {
            setDraft("");
            setDraftError("");
            setError("");
          }}
        >
          <FolderPlus size={16} />
          新建文件夹
        </button>
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (creating) return;
            const name = draft.trim();
            if (!name || Array.from(name).length > 30) {
              setDraftError(name ? "名称最多 30 个字" : "请输入文件夹名称");
              return;
            }
            setCreating(true);
            try {
              const result = await window.desktop.projects.createLibraryFolder({
                ...(handle && { projectHandle: handle }),
                name,
              });
              if (!result.ok) throw Error(result.error.message);
              setFolders((previous) => [
                ...(previous ?? []).filter((folder) => folder.id !== result.value.id),
                result.value,
              ]);
              setDestination(result.value.id);
              setDraft(null);
              setError("");
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : "无法创建文件夹");
            } finally {
              setCreating(false);
            }
          }}
        >
          <div className="library-draft-row">
            <input
              ref={focusOnMount}
              aria-label="新文件夹名称"
              aria-invalid={!!draftError}
              placeholder="新文件夹名称（最多 30 字）"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setDraftError("");
                setError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setDraft(null);
                  setError("");
                }
              }}
            />
            <button type="submit" disabled={creating}>
              {creating && <Loader2 size={16} />}创建
            </button>
          </div>
          {draftError && <span role="alert">{draftError}</span>}
        </form>
      )}
      {error && <span role="alert">{error}</span>}
      <footer>
        <button type="button" disabled={busy} onClick={close}>
          取消
        </button>
        <button
          type="button"
          disabled={busy || destination === currentFolder}
          onClick={async () => {
            setBusy(true);
            try {
              await confirm(destination);
              close();
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : `${title}失败`);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 size={16} />} {currentFolder === undefined ? "加入" : "移动"}
        </button>
      </footer>
      <button
        type="button"
        aria-label="Close"
        className="library-name-close"
        disabled={busy}
        onClick={close}
      >
        <X size={16} />
      </button>
    </Surface>
  );
}
export function DeleteLibraryFolder({
  folder,
  close,
  confirm,
}: {
  folder: LibraryFolder;
  close: () => void;
  confirm: () => void;
}) {
  return (
    <Surface alert label={`删除文件夹「${folder.name}」？`} close={close}>
      <header>
        <h2>删除文件夹「{folder.name}」？</h2>
        <p>将移除文件夹及其中 {folder.itemCount} 个素材；画布里已使用的素材不受影响。</p>
      </header>
      <footer>
        <button type="button" ref={focusOnMount} onClick={close}>
          取消
        </button>
        <button type="button" className="library-danger" onClick={confirm}>
          删除
        </button>
      </footer>
    </Surface>
  );
}
export function LibraryManagement({
  handle,
  close,
  openPicker,
  pickerDisabled,
}: {
  handle: string;
  close: () => void;
  openPicker: () => void;
  pickerDisabled?: boolean;
}) {
  const { items, folders, status, reload } = usePersonalLibrary(handle);
  const menuHost = useRef<HTMLDivElement>(null);
  const [folderId, setFolderId] = useState<string | null>(null),
    [input, setInput] = useState(""),
    [term, setTerm] = useState(""),
    [notice, setNotice] = useState("");
  const [edit, setEdit] = useState<LibraryFolder | "new">(),
    [deleting, setDeleting] = useState<LibraryFolder>(),
    [moving, setMoving] = useState<Row>();
  useEffect(() => {
    const timer = setTimeout(() => setTerm(input.trim().toLocaleLowerCase()), 300);
    return () => clearTimeout(timer);
  }, [input]);
  const current = folders.find((folder) => folder.id === folderId);
  useEffect(() => {
    if (status === "ready" && folderId && !current) {
      setFolderId(null);
      setInput("");
      setTerm("");
      setNotice("该内容已不存在");
    }
  }, [current, status, folderId]);
  const visible = items.filter((row) =>
    term ? row.asset.displayName.toLocaleLowerCase().includes(term) : row.folderId === folderId,
  );
  const shownFolders = !term && !folderId ? folders : [];
  const sources = new Map(folders.map((folder) => [folder.id, folder.name]));
  const emptyTitle = term ? "没有找到匹配的素材" : current ? "这个文件夹是空的" : "还没有素材";
  const emptyDetail = term
    ? "试试更短的文件名关键词。"
    : current
      ? "在素材的操作菜单中选择「移动到…」，即可整理到这里。"
      : "在画布选中素材节点，点击「加入资产库」即可保存。也可以在资产库中上传本地文件。";
  const clearSearch = () => {
    setInput("");
    setTerm("");
  };

  return (
    <>
      <Surface label="个人资产库管理" wide close={close}>
        <header className="library-manager-header">
          <span className="library-manager-mark" aria-hidden="true">
            <LibraryBig size={22} />
          </span>
          <div>
            <h2>个人资产库</h2>
            <p>整理常用图片、视频和音频，在不同项目的「资产库」中重复使用。</p>
          </div>
          <button
            type="button"
            className="library-manager-close"
            aria-label="关闭个人资产库管理"
            onClick={close}
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>
        <div className="library-manager-tools">
          <label className="library-manager-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索文件名"
              placeholder="搜索整个资产库的文件名"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
          </label>
          <button type="button" className="library-manager-button" onClick={() => setEdit("new")}>
            <FolderPlus size={17} aria-hidden="true" />
            新建文件夹
          </button>
        </div>
        <div className="library-manager-location">
          {term ? (
            <span>全库搜索</span>
          ) : current ? (
            <button
              type="button"
              className="library-manager-root"
              onClick={() => {
                setFolderId(null);
                clearSearch();
              }}
            >
              <House size={15} aria-hidden="true" />
              根目录
            </button>
          ) : (
            <span>
              <House size={15} aria-hidden="true" />
              根目录
            </span>
          )}
          {!term && current && (
            <>
              <ChevronRight size={14} aria-hidden="true" />
              <strong title={current.name}>{current.name}</strong>
            </>
          )}
          {status === "ready" && (
            <span className="library-manager-count">
              {shownFolders.length > 0 && `${shownFolders.length} 个文件夹 · `}
              {visible.length} 项素材
            </span>
          )}
        </div>
        <div className="library-manager-body" aria-busy={status === "loading"}>
          {status === "error" ? (
            <div className="library-manager-empty">
              <CircleAlert size={26} aria-hidden="true" />
              <strong>个人资产库加载失败</strong>
              <button
                type="button"
                className="library-manager-button"
                onClick={() => void reload()}
              >
                重试
              </button>
            </div>
          ) : status === "loading" ? (
            <div className="library-manager-empty">
              <Loader2 size={25} aria-hidden="true" />
              <p>正在加载资产库…</p>
            </div>
          ) : (
            <>
              {shownFolders.length > 0 && (
                <div className="library-manager-folders">
                  {shownFolders.map((folder) => (
                    <article key={folder.id} className="library-manager-folder">
                      <button
                        type="button"
                        className="library-manager-open"
                        onClick={() => setFolderId(folder.id)}
                        aria-label={`打开文件夹 ${folder.name}`}
                      >
                        <Folder size={20} aria-hidden="true" />
                        <span>
                          <strong title={folder.name}>{folder.name}</strong>
                          <small>{folder.itemCount} 项</small>
                        </span>
                      </button>
                      <Actions
                        container={menuHost}
                        name={folder.name}
                        options={[
                          ["重命名", () => setEdit(folder)],
                          ["删除", () => setDeleting(folder)],
                        ]}
                      />
                    </article>
                  ))}
                </div>
              )}
              {visible.length > 0 && (
                <div className="library-manager-assets">
                  {visible.map((row) => (
                    <article key={row.asset.assetId} className="library-manager-asset">
                      <div className="library-manager-cover" aria-hidden="true">
                        <Cover asset={row.asset} handle={handle} library />
                      </div>
                      <div className="library-manager-asset-info">
                        <div>
                          <strong title={row.asset.displayName}>{row.asset.displayName}</strong>
                          <small>
                            {mediaLabels[row.asset.mediaType]}
                            {term &&
                              ` · ${(row.folderId && sources.get(row.folderId)) || "根目录"}`}
                          </small>
                        </div>
                        <Actions
                          container={menuHost}
                          name={row.asset.displayName}
                          options={[
                            ["移动到…", () => setMoving(row)],
                            [
                              "移出资产库",
                              async () => {
                                try {
                                  const result = await window.desktop.projects.removeLibraryItem({
                                    projectHandle: handle,
                                    itemId: row.asset.assetId,
                                  });
                                  setNotice(
                                    result.ok
                                      ? "已移出资产库"
                                      : (result.error.message ?? "无法移出资产库"),
                                  );
                                } catch {
                                  setNotice("无法移出资产库");
                                }
                              },
                            ],
                          ]}
                        />
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {!visible.length && !shownFolders.length && (
                <div className="library-manager-empty">
                  <span className="library-manager-mark" aria-hidden="true">
                    {term ? <Search size={22} /> : <FolderOpen size={22} />}
                  </span>
                  <strong>{emptyTitle}</strong>
                  <p>{emptyDetail}</p>
                </div>
              )}
            </>
          )}
        </div>
        <footer className="library-manager-footer">
          {notice && <p role="status">{notice}</p>}
          <button
            type="button"
            className="library-manager-button library-manager-primary"
            disabled={pickerDisabled}
            onClick={openPicker}
          >
            打开选材与上传
            <ArrowUpRight size={16} aria-hidden="true" />
          </button>
        </footer>
        <div ref={menuHost} />
      </Surface>
      {edit && (
        <LibraryFolderForm
          handle={handle}
          folder={edit === "new" ? undefined : edit}
          close={() => setEdit(undefined)}
        />
      )}
      {moving && (
        <LibraryLocationDialog
          currentFolder={moving.folderId}
          handle={handle}
          close={() => setMoving(undefined)}
          confirm={async (folderId) => {
            const result = await window.desktop.projects.moveLibraryItem({
              projectHandle: handle,
              itemId: moving.asset.assetId,
              folderId,
            });
            if (!result.ok) throw Error(result.error.message ?? "无法移动");
            setNotice("已移动");
          }}
        />
      )}
      {deleting && (
        <DeleteLibraryFolder
          folder={deleting}
          close={() => setDeleting(undefined)}
          confirm={async () => {
            setDeleting(undefined);
            try {
              const result = await window.desktop.projects.deleteLibraryFolder({
                projectHandle: handle,
                folderId: deleting.id,
              });
              setNotice(
                result.ok
                  ? `已删除文件夹，移出 ${result.value.removed} 个素材`
                  : (result.error.message ?? "无法删除文件夹"),
              );
            } catch {
              setNotice("无法删除文件夹");
            }
          }}
        />
      )}
    </>
  );
}
