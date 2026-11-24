import type { ChannelView, ProjectValues, SettingsValues } from "@link-studio/core";
import { useEffect, useState } from "react";
import { ModelModal } from "../settings/model-editor";
export function HomeAssetEnroll({
  channels,
  item,
  close,
  done,
}: {
  channels: ChannelView[];
  item: { id: string; name: string; src: string };
  close: () => void;
  done: (message: string) => void;
}) {
  const [channelId, setChannel] = useState(channels[0]?.id),
    channel = channels.find((ch) => ch.id === channelId);
  const [page, setPage] = useState<ProjectValues["filingLibraryPage"]>(),
    [members, setMembers] = useState<SettingsValues["filingAssets"]>([]),
    [human, setHuman] = useState(""),
    [name, setName] = useState(item.name.replace(/\.[^.]+$/, "")),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!channel) return;
    let active = true,
      token: string | undefined;
    setPage(undefined);
    setError("");
    setMembers([]);
    setHuman("");
    const scope = { channelId: channel.id, channelRevision: channel.revision };
    void window.desktop.projects
      .filingLibraryPage({ ...scope, initialItem: item.id })
      .then((result) => {
        if (!result.ok) {
          if (active) setError(result.error.message ?? "无法读取素材");
          return;
        }
        token = result.value.page;
        if (!active) {
          void window.desktop.projects.filingLibraryClose({ page: token });
          return;
        }
        setPage(result.value);
        if (!result.value.selected)
          setError("图片已备案或不符合要求（PNG、JPEG、WebP，最大 10 MiB）。");
      })
      .catch(() => {
        if (active) setError("无法读取素材");
      });
    void window.desktop.settings
      .filingAssets({ id: channel.id, expectedRevision: channel.revision, action: "list" })
      .then((result) => {
        if (active && result.ok) setMembers(result.value);
      })
      .catch(() => {
        if (active) setError("无法读取已有真人，请重新打开后重试");
      });
    return () => {
      active = false;
      if (token) void window.desktop.projects.filingLibraryClose({ page: token });
    };
  }, [channel, item.id]);
  const people = new Map(members.map((member) => [member.humanId, member.humanName]));
  const submit = async () => {
    if (!page?.selected || !channel || busy) return;
    setBusy(true);
    try {
      const result = await window.desktop.projects.filingLibraryEnroll({
        page: page.page,
        choice: page.selected.choice,
        channelId: channel.id,
        channelRevision: channel.revision,
        confirmed: true,
        name: people.get(human) ?? name.trim(),
        ...(human && { humanId: human }),
      });
      if (!result.ok) throw Error(result.error.message ?? "备案提交失败");
      if ("error" in result.value) throw Error(result.value.error);
      done(
        result.value.status === "failed"
          ? "图片已加入真人库，可在详情重新提交。"
          : "图片已加入真人库并提交审核。",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "备案提交失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="model-settings">
      <ModelModal
        variant="human-enroll"
        title="加入真人库"
        close={() => {
          if (!busy) close();
        }}
      >
        <form
          className="model-editor-form model-dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <img
            src={item.src}
            alt={item.name}
            style={{ maxWidth: 160, maxHeight: 120, objectFit: "contain" }}
          />
          {channels.length > 1 && (
            <label>
              备案渠道
              <select
                disabled={busy}
                value={channelId}
                onChange={(event) => setChannel(event.target.value)}
              >
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            加入到
            <select
              disabled={busy}
              value={human}
              onChange={(event) => setHuman(event.target.value)}
            >
              <option value="">新建真人</option>
              {Array.from(people, ([id, label]) => (
                <option
                  key={id}
                  value={id}
                  disabled={members.filter((member) => member.humanId === id).length >= 5}
                >
                  {label}
                </option>
              ))}
            </select>
          </label>
          {!human && (
            <label>
              真人名称
              <input
                value={name}
                disabled={busy}
                maxLength={30}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          {error && <p role="alert">{error}</p>}
          <footer>
            <button type="button" disabled={busy} onClick={close}>
              取消
            </button>
            <button type="submit" disabled={busy || !page?.selected || (!human && !name.trim())}>
              提交备案
            </button>
          </footer>
        </form>
      </ModelModal>
    </div>
  );
}
