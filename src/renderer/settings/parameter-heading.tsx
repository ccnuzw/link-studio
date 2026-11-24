import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { SettingsSwitch } from "./settings-switch";

type Controls = { label: string; open: boolean; spec?: boolean };

export function ParameterHeading({
  name,
  kind,
  order,
  controls,
  change,
  children,
  fanout,
}: {
  name: string;
  kind: "枚举" | "数字" | "开关";
  controls: Controls;
  order: { first: boolean; last: boolean; move: (direction: number) => void; remove: () => void };
  change: (patch: Partial<Controls>) => void;
  children: ReactNode;
  fanout?: boolean;
}) {
  return (
    <>
      <div className="parameter-heading">
        <input
          aria-label={`${name} 的展示名`}
          value={controls.label}
          maxLength={64}
          onChange={(event) => change({ label: event.target.value })}
        />
        <code>{name}</code>
        <small>{kind}</small>
        {fanout && <small className="model-fanout-badge">拆成 N 个任务</small>}
        {controls.spec && <small className="model-spec-badge">规格价格维度</small>}
        <SettingsSwitch
          label={`${controls.label || name} 开放给用户`}
          text="开放给用户"
          checked={controls.open}
          onChange={(open) => change({ open })}
        />
        <button
          type="button"
          aria-label="上移"
          disabled={order.first}
          onClick={() => order.move(-1)}
        >
          <ArrowUp size={14} />
        </button>
        <button type="button" aria-label="下移" disabled={order.last} onClick={() => order.move(1)}>
          <ArrowDown size={14} />
        </button>
        <button type="button" aria-label={`删除参数 ${name}`} onClick={order.remove}>
          <Trash2 size={14} />
        </button>
      </div>
      {children}
      {(controls.spec !== undefined || !controls.open) && (
        <div className="model-param-footer">
          {controls.spec !== undefined && (
            <SettingsSwitch
              label={`${controls.label || name} 作为规格价格维度`}
              text="作为规格价格维度"
              checked={controls.spec}
              onChange={(spec) => change({ spec })}
            />
          )}
          {!controls.open && <small>不开放，按默认值发送</small>}
        </div>
      )}
    </>
  );
}
