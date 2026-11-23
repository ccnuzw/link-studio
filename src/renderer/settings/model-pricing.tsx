import {
  type PriceDimension as Dimension,
  defaultPriceSpec,
  type ModelConfig,
  type ModelPricing,
  matchPriceTier,
  modelModeLabels,
  type PriceTier,
  quoteModel,
  stalePriceCondition,
} from "@link-studio/core";
import { Check, Plus, Star, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { wireParamName } from "./model-document";
import { SettingsSwitch } from "./settings-switch";

function valueText(dim: Dimension, value: Dimension["initial"]) {
  if (typeof value === "boolean")
    return dim.key === "ref_video" ? (value ? "有" : "没有") : value ? "开启" : "关闭";
  return dim.key === "op"
    ? modelModeLabels[value as keyof typeof modelModeLabels]
    : `${value}${dim.unit ?? ""}`;
}

function PriceAmount({
  label,
  unit,
  value,
  change,
}: {
  label: string;
  unit: string;
  value?: number;
  change: (value: number) => void;
}) {
  return (
    <div className="price-amount">
      <input
        aria-label={label}
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        aria-invalid={
          value !== undefined && (!Number.isInteger(value) || value < 0 || value > 1000000)
        }
        value={value ?? ""}
        onChange={(event) => change(Math.trunc(Number(event.target.value)) || 0)}
      />
      <span>{unit}</span>
    </div>
  );
}

function MarginBadge({ price, cost }: { price: number; cost: number }) {
  const margin = price > 0 ? (price - cost) / price : null;
  return (
    <small
      className="price-margin"
      data-tone={
        margin === null ? "neutral" : margin < 0 ? "danger" : margin < 0.2 ? "warning" : "success"
      }
      title="利润率 =（价格 − 成本）÷ 价格"
    >
      利润率 {margin === null ? "-" : `${Math.round(margin * 100)}%`}
    </small>
  );
}

function CostEditor({
  label,
  unit,
  pricing,
  cost,
  change,
}: {
  label: string;
  unit: string;
  pricing: { input: number; output?: number };
  cost: ModelPricing["cost"];
  change: (next: ModelPricing["cost"]) => void;
}) {
  const token = unit === "积分/百万 Token";
  return (
    <div className="price-cost">
      <div className="price-cost-head">
        <span>积分成本</span>
        <small>仅管理员可见</small>
        <SettingsSwitch
          label={token ? "积分成本" : `${label}积分成本`}
          checked={!!cost}
          onChange={(on) => change(on ? {} : undefined)}
        />
      </div>
      {cost && (
        <div className="price-cost-values" data-token={token}>
          {(token ? (["input", "output"] as const) : (["input"] as const)).map((side) => (
            <PriceAmount
              key={side}
              label={token ? (side === "input" ? "输入成本" : "输出成本") : `${label}积分成本`}
              unit={token ? `${side === "input" ? "输入" : "输出"} ${unit}` : unit}
              value={token ? cost[side] : (cost.input ?? 0)}
              change={(value) =>
                change({ ...(token && { input: 0, output: 0 }), ...cost, [side]: value })
              }
            />
          ))}
          {token &&
            (["input", "output"] as const).map((side) => (
              <MarginBadge key={side} price={pricing[side] ?? 0} cost={cost[side] ?? 0} />
            ))}
        </div>
      )}
    </div>
  );
}

export function PricingRules({
  pricing,
  dimensions,
  kind,
  timed,
  hint,
  tierError,
  change,
}: {
  pricing: ModelPricing;
  dimensions: Dimension[];
  kind?: ModelConfig["kind"];
  timed: boolean;
  hint: ReactNode;
  tierError: (index: number) => string | undefined;
  change: (price: ModelPricing) => void;
}) {
  const tiers = pricing.tiers ?? [];
  const [wantSpec, setWantSpec] = useState(false);
  const token = pricing.unit === "token";
  const spec = !token && (wantSpec || !!tiers.length);
  const suffix = token ? "积分/百万 Token" : pricing.unit === "second" ? "积分/秒" : "积分/次";
  const blocked = (unit: ModelPricing["unit"]) =>
    unit === "second" && !timed
      ? "按秒计费需要一个名为 duration 的数字参数（在「能力与参数」里添加视频时长）"
      : kind === "agent" && unit !== "token"
        ? "Agent 模型只能按 Token 计费"
        : unit === "token" && kind !== "text" && kind !== "agent"
          ? "只有文本、Agent 模型按 Token 计费"
          : undefined;
  const [rowKeys, setRowKeys] = useState(() => tiers.map(() => crypto.randomUUID()));
  const setTiers = (next: PriceTier[]) => {
    const enabled = next.filter((tier) => tier.on);
    const pool = enabled.length ? enabled : next;
    change({
      ...pricing,
      ...(pool.length && pool.every((tier) => tier.unit > 0) ? { pending: undefined } : {}),
      tiers: next.length ? next : undefined,
      input: pool.length ? Math.min(...pool.map((tier) => tier.unit)) : pricing.input,
    });
  };
  const replace = (index: number, value: PriceTier) =>
    setTiers(tiers.map((tier, i) => (i === index ? value : tier)));
  const condition = (index: number, key: string, value: Dimension["initial"] | undefined) => {
    const tier = tiers[index]!;
    const when = { ...tier.when };
    if (value === undefined) delete when[key];
    else when[key] = value;
    replace(index, { ...tier, when });
  };
  return (
    <>
      <div className="price-setup" data-field="pricing" tabIndex={-1}>
        <div>
          <span>
            计费方式 <em>*</em>
          </span>
          <fieldset className="price-segments" data-ui-group aria-label="计费方式">
            {(["request", "second", "token"] as const).map((unit) => (
              <button
                key={unit}
                type="button"
                aria-pressed={unit === pricing.unit}
                disabled={unit !== pricing.unit && !!blocked(unit)}
                title={blocked(unit)}
                onClick={() => {
                  if (unit !== pricing.unit)
                    change({
                      unit,
                      input: 0,
                      ...(unit === "token" && { output: 0 }),
                      ...(pricing.cost && { cost: {} }),
                    });
                }}
              >
                {unit === "token" ? "Token" : unit === "second" ? "按秒" : "按次"}
              </button>
            ))}
          </fieldset>
        </div>
        {!token && (
          <div>
            <span>适用范围</span>
            <fieldset className="price-segments" data-ui-group aria-label="适用范围">
              <button
                type="button"
                aria-pressed={!spec}
                onClick={() => {
                  if (spec) {
                    setWantSpec(false);
                    setRowKeys([]);
                    setTiers([]);
                  }
                }}
              >
                统一价格
              </button>
              <button
                type="button"
                aria-pressed={spec}
                disabled={!dimensions.length && !spec}
                title={
                  !dimensions.length
                    ? "没有可区分价格的维度：在「能力与参数」里把清晰度、生成音频等参数设为规格价格维度"
                    : undefined
                }
                onClick={() => setWantSpec(true)}
              >
                按规格定价
              </button>
            </fieldset>
          </div>
        )}
        {spec && <small>未命中规格时按最低规格价收取</small>}
      </div>
      {!spec && (
        <div className="price-default">
          <div className="price-default-head">
            <code>01</code>
            <b>默认价格</b>
            {!token && pricing.cost && (
              <MarginBadge price={pricing.input} cost={pricing.cost.input ?? 0} />
            )}
          </div>
          <div className="price-default-body">
            <div className="price-values">
              {(token ? (["input", "output"] as const) : (["input"] as const)).map((side) => {
                const label = token
                  ? side === "input"
                    ? "输入价"
                    : "输出价"
                  : pricing.unit === "second"
                    ? "每秒消耗积分"
                    : "每次消耗积分";
                return (
                  <label key={side}>
                    {label} <em>*</em>
                    <PriceAmount
                      label={token ? label : "默认价格"}
                      unit={suffix}
                      value={pricing.pending ? undefined : (pricing[side] ?? 0)}
                      change={(value) =>
                        change({
                          ...pricing,
                          [side]:
                            pricing.pending && side === "output" && !value ? undefined : value,
                          ...(value > 0 && { pending: undefined }),
                        })
                      }
                    />
                  </label>
                );
              })}
            </div>
            {hint}
            <CostEditor
              label="默认价格"
              unit={suffix}
              pricing={pricing}
              cost={pricing.cost}
              change={(cost) => change({ ...pricing, cost })}
            />
          </div>
        </div>
      )}
      {spec && (
        <div className="price-tier-list">
          {hint}
          {tiers.map((tier, index) => {
            const problem =
              tierError(index) ??
              Object.entries(tier.when)
                .map(([key, value]) => stalePriceCondition(key, value, dimensions))
                .find(Boolean);
            return (
              <div
                key={rowKeys[index]}
                className="price-default price-tier"
                data-field={`tier-${index}`}
                data-off={!tier.on}
                data-invalid={!!problem}
                tabIndex={-1}
              >
                <div className="price-default-head">
                  <code>{String(index + 1).padStart(2, "0")}</code>
                  <b>规格价格 {index + 1}</b>
                  {tier.cost && <MarginBadge price={tier.unit} cost={tier.cost.input ?? 0} />}
                  <SettingsSwitch
                    label={`第 ${index + 1} 条规格价格可供用户使用`}
                    text="可供用户使用"
                    checked={tier.on}
                    onChange={(on) => replace(index, { ...tier, on })}
                  />
                  <button
                    type="button"
                    aria-label={`删除第 ${index + 1} 条规格价格`}
                    onClick={() => {
                      setRowKeys(rowKeys.filter((_, position) => position !== index));
                      setTiers(tiers.filter((_, position) => position !== index));
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="price-default-body">
                  {dimensions.map((dim) => (
                    <fieldset
                      className="price-condition"
                      key={dim.key}
                      data-ui-group
                      aria-label={dim.label}
                    >
                      <span>{dim.label}</span>
                      {[undefined, ...dim.values].map((value) => {
                        const active =
                          value === undefined
                            ? tier.when[dim.key] === undefined
                            : String(tier.when[dim.key]) === String(value);
                        return (
                          <button
                            key={value === undefined ? "any" : `${typeof value}:${value}`}
                            type="button"
                            aria-pressed={active}
                            onClick={() => condition(index, dim.key, value)}
                          >
                            {active && <Check size={14} />}
                            {value === undefined ? "任意" : valueText(dim, value)}
                          </button>
                        );
                      })}
                    </fieldset>
                  ))}
                  {Object.keys(tier.when)
                    .filter((key) => !dimensions.some((dim) => dim.key === key))
                    .map((key) => (
                      <div className="price-condition price-condition-stale" key={key}>
                        <span>{wireParamName(key)}</span>
                        <small>{String(tier.when[key])}</small>
                        <button type="button" onClick={() => condition(index, key, undefined)}>
                          移除条件
                        </button>
                      </div>
                    ))}
                  <div className="price-condition price-tier-amount">
                    <span>价格</span>
                    <PriceAmount
                      label={`第 ${index + 1} 条规格价格`}
                      unit={suffix}
                      value={tier.unit}
                      change={(unit) => replace(index, { ...tier, unit })}
                    />
                  </div>
                  <CostEditor
                    label={`第 ${index + 1} 条规格价格`}
                    pricing={{ input: tier.unit }}
                    cost={tier.cost}
                    unit={suffix}
                    change={(cost) => replace(index, { ...tier, cost })}
                  />
                  {problem && <p className="price-tier-problem">{problem}</p>}
                </div>
              </div>
            );
          })}
          <button
            type="button"
            className="price-tier-add"
            disabled={!dimensions.length || tiers.length >= 100}
            onClick={() => {
              setRowKeys([...rowKeys, crypto.randomUUID()]);
              setTiers([...tiers, { on: true, when: {}, unit: pricing.input }]);
            }}
          >
            <Plus size={16} /> 新增规格价格
          </button>
          {tiers.length > 1 && <small>多条命中时取条件最多的一条，相同则取靠前的</small>}
        </div>
      )}
    </>
  );
}

export function PricingPreview({
  config,
  dimensions,
}: {
  config: ModelConfig;
  dimensions: Dimension[];
}) {
  const pricing = config.pricing;
  if (!pricing) return <small>还没有配置定价。</small>;
  const base = defaultPriceSpec(config);
  const duration = Object.hasOwn(base.params, "duration") ? config.params?.duration : undefined;
  base.op ??= dimensions.find((dim) => dim.key === "op")?.initial.toString();
  if (pricing.unit === "token") {
    const output = config.maxOutputTokens ?? 0;
    const sample = quoteModel(pricing, { ...base, promptChars: 1000, outputTokens: output }) ?? 0;
    return (
      <div className="price-quote-card price-token-quote">
        <div>
          <span>输入</span>
          <span>{pricing.input} 积分 / 百万 Token</span>
        </div>
        <div>
          <span>输出</span>
          <span>{pricing.output ?? 0} 积分 / 百万 Token</span>
        </div>
        <small>
          1000 字提示词 + {output} Token 输出：最多冻结 <b>{sample}</b> 积分
        </small>
      </div>
    );
  }
  const specs = dimensions.filter((dim) => !["op", "ref_video"].includes(dim.key));
  const [row, column] = specs;
  const seconds = pricing.unit === "second";
  if (!row && !seconds)
    return (
      <div className="price-quote-card">
        <small>默认参数下每次消耗</small>
        <p>
          <strong>{quoteModel(pricing, base) ?? 0}</strong> 积分
        </p>
      </div>
    );
  type Col = { label: string; params: Record<string, unknown>; mark: boolean };
  const columns: Col[] = [];
  if (seconds) {
    columns.push({ label: "每秒", params: { duration: 1 }, mark: true });
    const times = {
      最短: duration?.range?.min,
      默认: duration ? Number(duration.default) : undefined,
      最长: duration?.range?.max,
    };
    for (const [label, value] of Object.entries(times))
      if (value !== undefined)
        columns.push({ label: `${label} ${value}秒`, params: { duration: value }, mark: false });
  } else if (column) {
    for (const value of column.values)
      columns.push({
        label: display(value),
        params: { [column.key]: value },
        mark: value === column.initial,
      });
  } else columns.push({ label: "积分", params: {}, mark: true });
  return (
    <>
      <div className="price-quote-grid">
        <table aria-label="规格报价">
          <thead>
            <tr>
              <th>
                {row?.label ?? "规格"}
                {!seconds && column && ` \\ ${column.label}`}
              </th>
              {columns.map((col) => (
                <th key={col.label}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(row?.values ?? ["全部"]).map((value) => (
              <tr key={`${typeof value}-${value}`}>
                <th scope="row">{display(value)}</th>
                {columns.map((col) => {
                  const spec = {
                    ...base,
                    params: { ...base.params, ...(row && { [row.key]: value }), ...col.params },
                  };
                  return (
                    <td key={col.label} data-tier={Boolean(matchPriceTier(pricing, spec))}>
                      {quoteModel(pricing, spec) ?? 0}
                      {col.mark && (!row || value === row.initial) && (
                        <Star size={12} role="img" aria-label="默认参数" />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="price-quote-legend">
        <span>
          <Star size={12} />
          默认参数
        </span>
        <span>规格价</span>
        <span>单位：积分{!seconds && " / 次"}</span>
      </div>
    </>
  );
}

function display(value: Dimension["initial"]) {
  return typeof value === "boolean" ? (value ? "开" : "关") : String(value);
}
