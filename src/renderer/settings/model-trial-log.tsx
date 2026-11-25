import { ChevronRight, Trash2 } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { clearSettingsLog, getSettingsLog, subscribeSettingsLog } from "./settings-request-log";
import { TrialFoldableCode } from "./trial-request-preview";

export function ModelTrialLog({ modelId }: { modelId: string }) {
  const entries = useSyncExternalStore(subscribeSettingsLog, getSettingsLog);
  const [current, setCurrent] = useState(true);
  const shown = current ? entries.filter((entry) => entry.modelId === modelId) : entries;
  return (
    <div className="model-trial-log">
      <div className="model-trial-log-tools">
        <label>
          <input
            type="checkbox"
            role="switch"
            aria-checked={current}
            checked={current}
            onChange={(event) => setCurrent(event.target.checked)}
          />
          只看当前模型
        </label>
        <button type="button" onClick={clearSettingsLog} disabled={!entries.length}>
          <Trash2 size={13} />
          清空
        </button>
      </div>
      {!shown.length ? (
        <p>还没有请求</p>
      ) : (
        <ol aria-label="管理请求">
          {shown.map((entry) => (
            <li key={entry.key}>
              <details>
                <summary>
                  <ChevronRight size={14} />
                  <code>{entry.method}</code>
                  <span>{entry.result}</span>
                  <small>
                    {entry.elapsed >= 1000
                      ? `${(entry.elapsed / 1000).toFixed(1)}s`
                      : `${entry.elapsed}ms`}
                  </small>
                </summary>
                <div>
                  <time dateTime={new Date(entry.time).toISOString()}>
                    {new Date(entry.time).toLocaleTimeString()}
                  </time>
                  {entry.request && (
                    <>
                      <span>请求体</span>
                      <TrialFoldableCode
                        limit={800}
                        text={JSON.stringify(entry.request, null, 2)}
                      />
                    </>
                  )}
                  <span>响应</span>
                  <TrialFoldableCode
                    limit={800}
                    text={entry.response ? JSON.stringify(entry.response, null, 2) : entry.result}
                  />
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
