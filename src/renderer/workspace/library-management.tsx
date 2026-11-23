import { Menu } from "@base-ui/react/menu";
import type { LibraryFolder, ProjectValues } from "@link-studio/core";
import { Check, Ellipsis, Folder, FolderPlus, House, Loader2, X } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Cover } from "./asset-picker-dialog";
import { LibraryFolderForm } from "./library-folder-form";
import { usePersonalLibrary } from "./use-personal-library";

type Row = ProjectValues["listLibrary"]["items"][number];
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
    <dialog
      ref={ref}
      role={alert ? "alertdialog" : "dialog"}
      aria-label={label}
      className={`library-folder-form library-management ${wide ? "library-manager" : `library-name-dialog ${alert ? "library-delete-dialog" : "library-location-dialog"}`}`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      onClick={(event) => {
        if (alert || event.target !== event.currentTarget) return;
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
      {children}
    </dialog>
  );
}
function Actions({ name, options }: { name: string; options: [string, () => void][] }) {
  const container = useRef<HTMLSpanElement>(null);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger aria-label={`${name} 操作`}>
        <Ellipsis size={16} />
      </Menu.Trigger>
      <span ref={container} />
      <Menu.Portal container={container}>
        <Menu.Positioner align="end" sideOffset={4}>
          <Menu.Popup className="library-actions">
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
  handle: string;
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
      .listLibraryFolders({ projectHandle: handle })
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
          <button
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
          </button>
        ))}
        {!folders && !failed && (
          <div className="library-loading" aria-busy="true">
            <i />
            <i />
          </div>
        )}
        {failed && (
          <div className="library-location-error">
            文件夹加载失败<button type="button" onClick={() => reload((value) => value + 1)}>重试</button>
          </div>
        )}
      </div>
      {draft === null ? (
        <button type="button"
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
                projectHandle: handle,
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
              autoFocus
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
            <button type="submit" disabled={creating}>{creating && <Loader2 size={16} />}创建</button>
          </div>
          {draftError && <span role="alert">{draftError}</span>}
        </form>
      )}
      {error && <span role="alert">{error}</span>}
      <footer>
        <button type="button" disabled={busy} onClick={close}>
          取消
        </button>
        <button type="button"
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
      <button type="button" aria-label="Close" className="library-name-close" disabled={busy} onClick={close}>
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
        <button type="button" autoFocus onClick={close}>
          取消
        </button>
        <button type="button" className="library-danger" onClick={confirm}>
          删除
        </button>
      </footer>
    </Surface>
  );
}
export function LibraryManagement({ handle, close }: { handle: string; close: () => void }) {
  const { items, folders, status, reload } = usePersonalLibrary(handle);
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
  return (
    <Surface label="个人资产库管理" wide close={close}>
      <header>
        <h2>
          <button type="button"
            onClick={() => {
              setFolderId(null);
              setInput("");
            }}
          >
            个人资产库
          </button>
          {current && ` › ${current.name}`}
        </h2>
        <button type="button" aria-label="关闭个人资产库管理" onClick={close}>
          <X size={16} />
        </button>
      </header>
      <div className="library-tools">
        <input
          aria-label="搜索文件名"
          placeholder="搜索文件名"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <button type="button" onClick={() => setEdit("new")}>新建文件夹</button>
      </div>
      <div className="library-cards">
        {shownFolders.map((folder) => (
          <article key={folder.id}>
            <button type="button" onClick={() => setFolderId(folder.id)} aria-label={`打开文件夹 ${folder.name}`}>
              <Folder />
              <strong>{folder.name}</strong>
              <small>{folder.itemCount} 项</small>
            </button>
            <Actions
              name={folder.name}
              options={[
                ["重命名", () => setEdit(folder)],
                ["删除", () => setDeleting(folder)],
              ]}
            />
          </article>
        ))}
        {visible.map((row) => (
          <article key={row.asset.assetId}>
            <div className="library-cover">
              <Cover asset={row.asset} handle={handle} library />
            </div>
            <strong>{row.asset.displayName}</strong>
            <Actions
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
                        result.ok ? "已移出资产库" : (result.error.message ?? "无法移出资产库"),
                      );
                    } catch {
                      setNotice("无法移出资产库");
                    }
                  },
                ],
              ]}
            />
          </article>
        ))}
      </div>
      {status === "error" ? (
        <button type="button" onClick={() => void reload()}>加载失败，重试</button>
      ) : status === "loading" ? (
        <p>加载中…</p>
      ) : (
        !visible.length &&
        !shownFolders.length && (
          <p>{term ? "没有找到匹配的素材" : folderId ? "这个文件夹是空的" : "还没有素材"}</p>
        )
      )}
      {notice && <p role="status">{notice}</p>}
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
    </Surface>
  );
}
