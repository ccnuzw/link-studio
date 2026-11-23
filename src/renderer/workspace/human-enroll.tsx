import type { ChannelView, ProjectAsset, SettingsValues } from "@link-studio/core";
import { Check, LoaderCircle } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { ModelModal } from "../settings/model-editor";
import { settingsError } from "../settings/settings-page";
import { FilingCover } from "./human-picker";

export function HumanEnroll({
  projectHandle,
  asset,
  close,
  done,
}: {
  projectHandle: string;
  asset: ProjectAsset;
  close: () => void;
  done: (message: string) => void;
}) {
  const [channel, setChannel] = useState<ChannelView>();
  const [images, setImages] = useState<SettingsValues["filingAssets"]>([]);
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const thumb = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mode === "new") nameInput.current?.focus();
  }, [mode]);
  const [name, setName] = useState(
    asset.displayName
      .replace(/\.[^.]+$/, "")
      .split(/[_\-\s]/)[0]
      ?.slice(0, 30) ?? "",
  );
  const [target, setTarget] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const nameIssue = !name.trim()
    ? "请输入名称"
    : Array.from(name.trim()).length > 30
      ? "名称最多 30 个字"
      : "";
  useEffect(() => {
    let active = true;
    void window.desktop.projects
      .getAssetPreview({ projectHandle, assetId: asset.assetId })
      .then((result) => {
        if (active && result.ok) setUrl(result.value.url);
      });
    async function load() {
      const channels = await window.desktop.settings.channelList({});
      const current =
        channels.ok &&
        channels.value.find((channel) => channel.filing?.enabled && channel.hasFilingKeys);
      if (!current) throw new Error("管理员尚未配置虚拟人像库");
      const result = await window.desktop.settings.filingAssets({
        id: current.id,
        expectedRevision: current.revision,
        action: "list",
      });
      if (!result.ok) throw new Error(settingsError(result.code));
      if (active) {
        setImages(result.value);
        setChannel(current);
      }
    }
    void load().catch((error) => {
      if (active) setNotice(error.message);
    });
    return () => {
      active = false;
    };
  }, [asset.assetId, projectHandle]);
  const people = new Map<string, { name: string; count: number; cover: (typeof images)[number] }>();
  for (const image of images) {
    const person = people.get(image.humanId);
    people.set(image.humanId, {
      name: image.humanName,
      count: (person?.count ?? 0) + 1,
      cover: image.cover ? image : (person?.cover ?? image),
    });
  }
  return (
    <ModelModal
      title="加入真人库"
      variant="human-enroll"
      close={() => {
        if (!saving) close();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!channel || saving) return;
          const humanName = mode === "new" ? name.trim() : people.get(target)?.name;
          setTouched(true);
          if (!humanName || (mode === "new" && nameIssue)) return;
          setSaving(true);
          try {
            const result = await window.desktop.projects.enrollImage({
              projectHandle,
              assetId: asset.assetId,
              channelId: channel.id,
              channelRevision: channel.revision,
              name: humanName,
              ...(mode === "existing" && { humanId: target }),
            });
            if (!result.ok) setNotice(result.error.message ?? "图片备案失败");
            else if ("error" in result.value) setNotice(settingsError(result.value.error));
            else {
              done(
                result.value.status === "failed"
                  ? "图片已加入真人库，提交方舟失败，可在详情重新提交。"
                  : "图片已加入真人库并提交审核。",
              );
              close();
            }
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="human-enroll-body">
          <div className="human-enroll-source">
            {url && <img src={url} alt="" />}
            <span>{asset.displayName}</span>
          </div>
          {!!people.size && (
            <div className="human-enroll-tabs" role="tablist" aria-label="加入方式">
              {(["new", "existing"] as const).map((value) => (
                <motion.button
                  type="button"
                  role="tab"
                  key={value}
                  disabled={saving}
                  aria-selected={mode === value}
                  whileTap={{ scale: 0.96 }}
                  onClick={() => setMode(value)}
                >
                  {mode === value && (
                    <motion.i
                      layoutId={thumb}
                      transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
                    />
                  )}
                  <span>{value === "new" ? "新建真人" : "加到已有真人"}</span>
                </motion.button>
              ))}
            </div>
          )}
          <div className="human-enroll-scroll">
            {mode === "new" ? (
              <div className="human-enroll-field">
                <input
                  ref={nameInput}
                  aria-label="真人名称"
                  aria-invalid={touched && !!nameIssue}
                  placeholder="名称"
                  value={name}
                  disabled={saving}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setName(event.target.value)}
                />
                {touched && nameIssue && <small role="alert">{nameIssue}</small>}
              </div>
            ) : (
              <ul aria-label="选择真人" className="human-enroll-people">
                {Array.from(people, ([id, person]) => (
                  <li key={id}>
                    <button
                      type="button"
                      disabled={saving || person.count >= 5}
                      aria-pressed={target === id}
                      title={person.count >= 5 ? "已有 5 张图片" : undefined}
                      onClick={() => setTarget(id)}
                    >
                      {channel && person.cover.hasSource && (
                        <FilingCover channel={channel} imageId={person.cover.id} />
                      )}
                      {target === id && (
                        <i>
                          <Check size={12} />
                        </i>
                      )}
                      <span>
                        <span>{person.name}</span>
                        <span>{person.count}/5</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {notice && <p role="alert">{notice}</p>}
        </div>
        <footer className="model-dialog-footer">
          <button type="button" disabled={saving} onClick={close}>
            取消
          </button>
          <button
            type="submit"
            disabled={
              !channel ||
              saving ||
              (mode === "new" && touched && !!nameIssue) ||
              (mode === "existing" && !target)
            }
          >
            {saving && <LoaderCircle size={16} className="human-enroll-loading" />}加入并提交备案
          </button>
        </footer>
      </form>
    </ModelModal>
  );
}
