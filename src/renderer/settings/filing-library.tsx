import type { ChannelView, SettingsValues } from "@link-studio/core";
import { ImagePlus, RotateCw, Star, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { FilingPersonalPicker } from "./filing-personal-picker";
import { FilingStorageDialog } from "./filing-storage-dialog";
import { ModelModal } from "./model-editor";
import { settingsError } from "./settings-page";
import { settingsRequests } from "./settings-request-log";
import { useFilingPoll } from "./use-filing-poll";

type Removal = { action: "removeHuman"; humanId: string } | { action: "remove"; assetId: string };

type Command =
  | Removal
  | { action: "rename"; humanId: string; name: string }
  | { action: "cover"; humanId: string; assetId: string }
  | { action: "create"; name: string; url: string; humanId?: string }
  | { action: "refresh" | "retry"; assetId: string };
const filterLabels = { all: "全部", active: "可用", processing: "备案中", failed: "失败" } as const;
type Filter = keyof typeof filterLabels;
function FilingStatus({ status }: { status: Exclude<Filter, "all"> }) {
  return (
    <span className="filing-state-pill" data-status={status}>
      {filterLabels[status]}
    </span>
  );
}
function FilingPreview({
  channel,
  asset,
}: {
  channel: ChannelView;
  asset: SettingsValues["filingAssets"][number];
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setUrl(null);
    void window.desktop.settings
      .filingPreview({ id: channel.id, expectedRevision: channel.revision, assetId: asset.id })
      .then((result) => {
        if (active && result.ok) setUrl(result.value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [channel.id, channel.revision, asset.id]);
  return url ? (
    <img className="filing-preview" alt={asset.name} src={url} onError={() => setUrl(null)} />
  ) : (
    <strong>{asset.name}</strong>
  );
}
export type RenderFilingPicker = (request: {
  channel: ChannelView;
  humanId: string;
  name: string;
  close: () => void;
  done: (message: string) => void;
}) => ReactNode;

export function FilingLibrary({
  channel,
  close,
  renderFilingPicker,
}: {
  channel: ChannelView;
  close: () => void;
  renderFilingPicker?: RenderFilingPicker;
}) {
  const [assets, setAssets] = useState<SettingsValues["filingAssets"]>([]);
  const [name, setName] = useState("");
  const [existing, setExisting] = useState(false);
  const [target, setTarget] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const personalDone = (message: string) => {
    setPicking(false);
    setNotice(message);
    void settingsRequests
      .filingAssets({ id: channel.id, expectedRevision: channel.revision, action: "list" })
      .then((result) => {
        if (result.ok) setAssets(result.value);
        else setNotice(`${message} ${settingsError(result.code)}`);
      });
  };
  const [storageOpen, setStorageOpen] = useState(false);
  const canFile = channel.filing?.enabled && channel.hasFilingKeys;
  const people = new Map<string, typeof assets>();
  for (const asset of assets) {
    const members = people.get(asset.humanId);
    if (members) members.push(asset);
    else people.set(asset.humanId, [asset]);
  }
  for (const members of people.values()) members.sort((left, right) => left.order - right.order);
  const groups = Array.from(people, ([id, members]) => {
    const ready = members.filter((asset) => asset.status === "active").length;
    const status = ready
      ? "active"
      : members.some((asset) => asset.status === "processing")
        ? "processing"
        : "failed";
    return { id, members, ready, status } as const;
  });
  const visible = groups.filter((group) => filter === "all" || group.status === filter);
  const selected = existing ? people.get(target) : undefined;
  const choosingExisting = existing && people.size > 0;
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const image =
    removal?.action === "remove" ? assets.find((asset) => asset.id === removal.assetId) : undefined;
  const membersToRemove = people.get(
    image?.humanId ?? (removal?.action === "removeHuman" ? removal.humanId : ""),
  );
  const lastImage = !!image && membersToRemove?.length === 1;
  const references = image?.refs ?? membersToRemove?.flatMap((member) => member.refs) ?? [];
  const blocking = Array.from(
    new Map(references.map((ref) => [JSON.stringify([ref.project, ref.node]), ref])).values(),
  );
  useEffect(() => {
    let active = true;
    void settingsRequests
      .filingAssets({ id: channel.id, expectedRevision: channel.revision, action: "list" })
      .then((result) => {
        if (!active) return;
        if (result.ok) setAssets(result.value);
        else setNotice(settingsError(result.code));
      });
    return () => {
      active = false;
    };
  }, [channel.id, channel.revision]);
  useFilingPoll(channel, assets, busy, setAssets, setNotice);
  const run = async (command: Command) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await settingsRequests.filingAssets({
        id: channel.id,
        expectedRevision: channel.revision,
        ...command,
      });
      if (!result.ok) {
        setNotice(settingsError(result.code));
        if (command.action === "removeHuman" || command.action === "remove") {
          const current = await settingsRequests.filingAssets({
            id: channel.id,
            expectedRevision: channel.revision,
            action: "list",
          });
          if (current.ok) setAssets(current.value);
        }
        return false;
      }
      setAssets(result.value);
      if (command.action === "removeHuman") setDetailId(null);
      setNotice(
        command.action === "create"
          ? result.value[0]?.status === "failed"
            ? "备案提交失败，可以重新提交。"
            : "已提交审核。"
          : command.action === "rename"
            ? "真人名称已更新。"
            : command.action === "cover"
              ? "封面已更新。"
              : command.action === "retry"
                ? "已重新提交审核。"
                : command.action === "refresh"
                  ? "审核状态已更新。"
                  : "素材已删除。",
      );
      if (command.action === "create") {
        setName("");
        setUrl("");
      }
      return true;
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModelModal
      title="虚拟人像库"
      subtitle={channel.name}
      close={() => {
        if (!busy) close();
      }}
    >
      {removal && membersToRemove && (
        <ModelModal
          variant="filing-remove"
          title={
            image ? `移除图片「${image.name}」？` : `移除真人「${membersToRemove[0]?.humanName}」？`
          }
          subtitle={
            blocking.length
              ? "正被以下角色卡使用，先在角色卡里换掉或删掉："
              : lastImage
                ? `这是「${image?.humanName}」唯一的图片，请改用「移除真人」。`
                : canFile
                  ? "方舟侧的素材会一起删除，不可恢复；个人资产库里的原图保留。"
                  : "当前没有此渠道的备案凭证，仅移除本地记录，保留方舟素材和原图。"
          }
          close={() => setRemoval(null)}
        >
          {!!blocking.length && (
            <ul className="filing-reference-list">
              {blocking.map((ref) => (
                <li key={JSON.stringify([ref.project, ref.node])}>
                  《{ref.title || "未命名画布"}》角色卡「{ref.name || "未命名"}」
                </li>
              ))}
            </ul>
          )}
          <footer className="model-dialog-footer">
            <button type="button" autoFocus onClick={() => setRemoval(null)}>
              取消
            </button>
            <button
              type="button"
              className="filing-destructive"
              disabled={!!blocking.length || lastImage || busy}
              onClick={() => {
                setRemoval(null);
                void run(removal);
              }}
            >
              确认移除
            </button>
          </footer>
        </ModelModal>
      )}
      <div className="model-dialog-body model-editor-form filing-library-body">
        <button type="button" disabled={busy} onClick={() => setStorageOpen(true)}>
          配置图片对象存储
        </button>
        {storageOpen && <FilingStorageDialog close={() => setStorageOpen(false)} />}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (choosingExisting && !selected?.length) return;
            void run({
              action: "create",
              name: selected?.[0]?.humanName ?? name,
              url,
              ...(selected && { humanId: target }),
            });
          }}
        >
          <fieldset disabled={busy || !canFile}>
            <legend>添加备案图片</legend>
            {people.size > 0 && (
              <div className="settings-actions" role="group" aria-label="加入方式">
                <button type="button" aria-pressed={!existing} onClick={() => setExisting(false)}>
                  新建真人
                </button>
                <button type="button" aria-pressed={existing} onClick={() => setExisting(true)}>
                  加到已有真人
                </button>
              </div>
            )}
            {choosingExisting ? (
              <div role="group" aria-label="选择真人" className="model-chips">
                {Array.from(people, ([id, members]) => (
                  <button
                    type="button"
                    key={id}
                    disabled={members.length >= 5}
                    aria-pressed={id === target}
                    onClick={() => setTarget(id)}
                  >
                    {members[0]?.humanName} {members.length}/5
                  </button>
                ))}
              </div>
            ) : (
              <label>
                真人名称
                <input
                  required
                  value={name}
                  maxLength={30}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
            <label>
              图片公网地址
              <input
                required
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <button
              type="submit"
              disabled={
                !channel.hasFilingKeys || (choosingExisting && (!selected || selected.length >= 5))
              }
            >
              加入并提交备案
            </button>
            {!renderFilingPicker && (
              <button
                type="button"
                disabled={choosingExisting ? !selected || selected.length >= 5 : !name.trim()}
                onClick={() => setPicking(true)}
              >
                从个人库选择图片
              </button>
            )}
          </fieldset>
        </form>
        {!channel.hasFilingKeys && <p>请先在渠道设置填写备案凭证。</p>}
        <div role="group" aria-label="按备案状态筛选" className="settings-actions">
          {(Object.keys(filterLabels) as Filter[]).map((key) => (
            <button
              type="button"
              key={key}
              aria-pressed={key === filter}
              onClick={() => setFilter(key)}
            >
              {filterLabels[key]}{" "}
              {key === "all"
                ? groups.length
                : groups.filter((group) => group.status === key).length}
            </button>
          ))}
        </div>
        {!visible.length && <p>暂无符合条件的真人</p>}
        {visible.map(({ id, members, ready, status }) => (
          <section key={id} aria-label={members[0]?.humanName}>
            <h3>
              {members[0]?.humanName} · {filterLabels[status]}
            </h3>
            <small>
              可用 {ready}/{members.length}
            </small>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setNotice("");
                setDetailId(id);
              }}
            >
              查看详情
            </button>
          </section>
        ))}
        {notice && !detailId && <p role="status">{notice}</p>}
      </div>
      {groups
        .filter((group) => group.id === detailId)
        .map(({ id, members, status }) => (
          <ModelModal
            key={id}
            variant="filing-detail"
            title={members[0]?.humanName ?? "真人详情"}
            close={() => {
              if (!busy) setDetailId(null);
            }}
          >
            <div className="filing-detail-name">
              <input
                key={members[0]?.humanName}
                aria-label="真人名称"
                disabled={busy}
                defaultValue={members[0]?.humanName}
                onBlur={async (event) => {
                  const field = event.currentTarget;
                  const previous = members[0]?.humanName ?? "";
                  const updated = field.value.trim();
                  if (updated === previous) {
                    field.value = previous;
                    return;
                  }
                  if (!updated || Array.from(updated).length > 30) {
                    setNotice(updated ? "名称最多 30 个字" : "请输入名称");
                    field.value = previous;
                    return;
                  }
                  if (!(await run({ action: "rename", humanId: id, name: updated })))
                    field.value = previous;
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing)
                    event.currentTarget.blur();
                }}
              />
              <FilingStatus status={status} />
            </div>
            <ul className="filing-detail-images" aria-label="真人图片">
              {members.map((asset) => (
                <li key={asset.id} className="adapter-field">
                  <div className="filing-tile-cover">
                    <FilingPreview channel={channel} asset={asset} />
                    {asset.cover && <span className="filing-cover-mark">封面</span>}
                    <FilingStatus status={asset.status} />
                  </div>
                  <div className="filing-tile-controls">
                    {asset.status === "failed" && asset.error && (
                      <small className="filing-error">{asset.error}</small>
                    )}
                    {!!asset.refs.length && <small>{asset.refs.length} 张角色卡在用</small>}
                    <div className="settings-actions">
                      {asset.status === "failed" && (
                        <button
                          type="button"
                          disabled={busy || !canFile || !asset.canRetry}
                          title={
                            !canFile
                              ? "管理员尚未配置虚拟人像库"
                              : !asset.canRetry
                                ? "没有可重新提交的原图"
                                : undefined
                          }
                          onClick={() => void run({ action: "retry", assetId: asset.id })}
                        >
                          <RotateCw />
                          重新提交
                        </button>
                      )}
                      {!asset.cover && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run({ action: "cover", humanId: id, assetId: asset.id })
                          }
                        >
                          <Star />
                          设为封面
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        aria-label="移除图片"
                        onClick={() => setRemoval({ action: "remove", assetId: asset.id })}
                      >
                        移除
                      </button>
                    </div>
                  </div>
                </li>
              ))}
              {canFile && members.length < 5 && (
                <li>
                  <button
                    type="button"
                    className="filing-add-tile"
                    disabled={busy}
                    onClick={() => {
                      setPicking(true);
                    }}
                  >
                    <ImagePlus size={20} />
                    添加图片
                  </button>
                </li>
              )}
            </ul>
            {notice && <p role="status">{notice}</p>}
            <footer className="model-dialog-footer">
              <button
                type="button"
                disabled={busy}
                className="model-danger"
                onClick={() => setRemoval({ action: "removeHuman", humanId: id })}
              >
                <Trash2 size={16} />
                移除真人
              </button>
              <button
                type="button"
                className="settings-primary"
                disabled={busy}
                onClick={() => setDetailId(null)}
              >
                完成
              </button>
            </footer>
            {picking &&
              (renderFilingPicker ? (
                renderFilingPicker({
                  channel,
                  humanId: id,
                  name: members[0]!.humanName,
                  close: () => setPicking(false),
                  done: personalDone,
                })
              ) : (
                <FilingPersonalPicker
                  channel={channel}
                  humanId={id}
                  name={members[0]!.humanName}
                  close={() => setPicking(false)}
                  done={personalDone}
                />
              ))}
          </ModelModal>
        ))}
      {picking && !detailId && !renderFilingPicker && (
        <FilingPersonalPicker
          channel={channel}
          humanId={choosingExisting ? target : undefined}
          name={selected?.[0]?.humanName ?? name.trim()}
          close={() => setPicking(false)}
          done={(message) => {
            personalDone(message);
            setName("");
          }}
        />
      )}
    </ModelModal>
  );
}
