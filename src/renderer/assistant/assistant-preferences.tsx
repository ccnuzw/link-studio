import { sourceWebUrl } from "@link-studio/core";
import { ChevronRight, Copy, Settings } from "lucide-react";
import { type ReactNode, useId, useState, useSyncExternalStore } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { copySettingsText } from "../settings/copy-settings-text";
import "./assistant-preferences.css";

let snapshot = { enabled: false, modelId: "", ready: false, busy: false, failed: false };
let selectionRevision = 0;
const read = () => snapshot;
const listeners = new Set<() => void>();
function publish(patch: Partial<typeof snapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((notify) => {
    notify();
  });
}
async function sync(showThinking?: boolean) {
  if (snapshot.busy) return;
  const revision = selectionRevision;
  publish({ busy: true, failed: false });
  try {
    const result = await window.desktop.settings.agentPreferences({ showThinking });
    if (!result.ok) throw new Error(result.code);
    publish({
      enabled: result.value.showThinking,
      ...(revision === selectionRevision && { modelId: result.value.modelId }),
      ready: true,
      busy: false,
    });
  } catch {
    publish({ busy: false, failed: true });
  }
}

async function selectModel(modelId: string) {
  const revision = ++selectionRevision;
  try {
    const result = await window.desktop.settings.agentPreferences({ modelId });
    if (!result.ok) throw new Error(result.code);
    if (revision === selectionRevision) publish({ modelId: result.value.modelId, failed: false });
  } catch {
    if (revision === selectionRevision) publish({ failed: true });
  }
}

export function useAssistantModelPreference() {
  return [useSyncExternalStore(subscribe, read).modelId, selectModel] as const;
}
function subscribe(notify: () => void) {
  listeners.add(notify);
  if (!snapshot.ready && !snapshot.failed) void sync();
  return () => {
    listeners.delete(notify);
  };
}

export function AssistantPreferences({ children }: { children?: ReactNode }) {
  const id = useId();
  const { enabled, ready, busy, failed } = useSyncExternalStore(subscribe, read);
  return (
    <>
      <button
        type="button"
        className="agent-settings-trigger"
        aria-label="Agent 设置"
        title="设置"
        popoverTarget={id}
        onClick={() => {
          if (failed) void sync();
        }}
      >
        <Settings size={16} />
      </button>
      <div id={id} popover="auto" className="agent-settings-menu">
        <section>
          <label htmlFor={`${id}-thinking`}>显示思考过程</label>
          <button
            type="button"
            id={`${id}-thinking`}
            role="switch"
            aria-checked={enabled}
            disabled={!ready || busy}
            onClick={() => void sync(!enabled)}
          >
            <span />
          </button>
        </section>
        <section>
          <span>生成前确认</span>
          <small>固定开</small>
        </section>
        <p>Agent 模型和上下文用量在输入框右下角</p>
        {children}
        {failed && <p role="alert">设置未同步，请重新打开设置重试。</p>}
      </div>
    </>
  );
}

const markdown: Components = {
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
  table: ({ children }) => (
    <div className="agent-reply-table">
      <table>{children}</table>
    </div>
  ),
  img: ({ alt }) => <span>{alt}</span>,
  a: ({ children, href }) => {
    const url = href && sourceWebUrl(href);
    return url ? (
      <a
        href={url}
        rel="noreferrer noopener"
        onClick={(event) => {
          event.preventDefault();
          void window.desktop.app.openSource(url);
        }}
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
};
const plugins = [remarkGfm];

export function AssistantReply({
  text,
  thinking,
  streaming = false,
  copyInFooter = false,
}: {
  text: string;
  thinking?: string | boolean;
  streaming?: boolean;
  copyInFooter?: boolean;
}) {
  const { enabled } = useSyncExternalStore(subscribe, read);
  const [expanded, setExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  if (!text && !(enabled && thinking)) return null;
  return (
    <article className="agent-reply" aria-live={streaming ? "off" : undefined}>
      {enabled && thinking && (
        <div className="agent-thinking">
          {streaming ? (
            <span className="agent-thinking-pending">
              <span>思考中</span>
            </span>
          ) : (
            <>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                <ChevronRight size={14} />
                已思考
              </button>
              {expanded && <p>{thinking}</p>}
            </>
          )}
        </div>
      )}
      {text && (
        <div className="agent-reply-text">
          <ReactMarkdown components={markdown} remarkPlugins={plugins}>
            {text}
          </ReactMarkdown>
        </div>
      )}
      {text && !streaming && !copyInFooter && (
        <button
          type="button"
          aria-label="复制"
          title="复制"
          className="agent-reply-copy"
          onClick={async () => {
            try {
              await copySettingsText(text);
              setCopyStatus("已复制");
            } catch {
              setCopyStatus("复制失败");
            }
          }}
        >
          <Copy size={14} />
        </button>
      )}
      {copyStatus && (
        <span className="sr-only" role="status">
          {copyStatus}
        </span>
      )}
    </article>
  );
}
