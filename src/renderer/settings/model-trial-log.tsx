import { Trash2 } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { clearSettingsLog, getSettingsLog, subscribeSettingsLog } from "./settings-request-log";

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
              <time dateTime={new Date(entry.time).toISOString()}>
                {new Date(entry.time).toLocaleTimeString()}
              </time>
              <code>{entry.method}</code>
              <span>{entry.result}</span>
              <small>{entry.elapsed} ms</small>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
