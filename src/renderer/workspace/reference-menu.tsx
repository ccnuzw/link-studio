import { Menu } from "@base-ui/react/menu";
import { Loader2, Plus, Upload } from "lucide-react";
import { type RefObject, useRef, useState } from "react";
import { Thumb, useThumbURL } from "./canvas-prompt-editor";
import type { MentionSource } from "./mention-sources";
import "./reference-menu.css";

type UploadKind = { kind: "image" | "video" | "audio"; label: string; maxBytes: number };

function Choice({
  source,
  handle,
  link,
}: {
  source: MentionSource;
  handle?: string;
  link: (id: string) => void;
}) {
  const url = useThumbURL(source.kind === "video" ? undefined : source, handle);
  return (
    <Menu.Item className="reference-menu-item" onClick={() => link(source.id)}>
      <Thumb source={source} url={url} projectHandle={handle} />
      <span>{source.label}</span>
    </Menu.Item>
  );
}

export function ReferenceMenu({
  candidates,
  handle,
  disabled,
  link,
  kinds,
  upload,
  voices,
  container,
  setError,
}: {
  candidates: MentionSource[];
  handle?: string;
  disabled: boolean;
  link: (id: string) => void;
  kinds: UploadKind[];
  voices?: () => void;
  upload: (file: File) => Promise<void>;
  container?: RefObject<HTMLElement | null>;
  setError: (error: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [choices, setChoices] = useState<MentionSource[]>([]);
  const [uploading, setUploading] = useState(false);
  async function select(file: File) {
    const type = kinds.find(({ kind }) => file.type.startsWith(`${kind}/`));
    if (!type) return setError("当前生成方式用不了这种文件");
    if (file.size > type.maxBytes)
      return setError(`单个参考${type.label}不能超过 ${type.maxBytes / 1048576} MB`);
    setUploading(true);
    setError("");
    try {
      await upload(file);
    } catch {
      setError("上传失败，请重试");
    } finally {
      setUploading(false);
    }
  }
  return (
    <>
      <Menu.Root
        modal={false}
        onOpenChange={(open, details) => {
          if (open) setChoices(candidates);
          else if (details.reason === "escape-key") {
            details.event.preventDefault();
            details.event.stopPropagation();
          }
        }}
      >
        <Menu.Trigger
          type="button"
          className="media-reference-add"
          disabled={disabled || uploading}
          aria-label="引用画布里的素材"
          title="引用画布里的素材（会自动连线）"
        >
          {uploading ? <Loader2 /> : <Plus />}
        </Menu.Trigger>
        <Menu.Portal container={container}>
          <Menu.Positioner
            className="reference-menu-positioner"
            align="start"
            sideOffset={6}
            collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
          >
            <Menu.Popup
              className="reference-menu nowheel nodrag nopan"
              aria-label="引用画布里的素材"
            >
              <Menu.Group>
                <Menu.GroupLabel className="reference-menu-label">
                  画布中可引用 · 选中后自动连线
                </Menu.GroupLabel>
                {!choices.length && (
                  <p className="reference-menu-empty">画布里没有能接进来的素材</p>
                )}
                {choices.map((source) => (
                  <Choice key={source.id} source={source} handle={handle} link={link} />
                ))}
              </Menu.Group>
              {voices && (
                <Menu.Item className="reference-menu-item" onClick={voices}>
                  从官方音色库选择
                </Menu.Item>
              )}
              {!!kinds.length && (
                <>
                  <Menu.Separator className="reference-menu-separator" />
                  <Menu.Item className="reference-menu-item" onClick={() => input.current?.click()}>
                    <Upload size={16} />
                    上传参考素材<small>{kinds.map((item) => item.label).join(" / ")}</small>
                  </Menu.Item>
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <input
        type="file"
        ref={input}
        hidden
        tabIndex={-1}
        accept={kinds.map(({ kind }) => `${kind}/*`).join(",")}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void select(file);
        }}
      />
    </>
  );
}
