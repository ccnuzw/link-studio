import { type SkillItem, type SkillScope, skillScopes } from "@link-studio/core";
import { Lightbulb } from "lucide-react";
import { useCompactLayout } from "./use-compact-layout";

const shortScopes = {
  agent: "画布 Agent",
  plan: "规划",
  scripts: "剧本",
  assets: "拆解",
  asset_prompts: "资产图",
  video: "视频",
};

export function activeDescription(item: SkillItem) {
  return item.versions.find(({ version }) => version === item.activeVersion)?.description ?? "";
}

function Updated({ item }: { item: SkillItem }) {
  if (!item.updatedAt || item.origin === "builtin") return <>—</>;
  const date = new Date(item.updatedAt);
  if (!Number.isFinite(date.getTime())) return <>{item.updatedAt}</>;
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  const text =
    minutes < 1
      ? "刚刚"
      : minutes < 60
        ? `${minutes} 分钟前`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)} 小时前`
          : minutes < 10080
            ? `${Math.floor(minutes / 1440)} 天前`
            : day;
  return (
    <time
      dateTime={item.updatedAt}
      title={`${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`}
    >
      {text}
    </time>
  );
}

function Name({ item }: { item: SkillItem }) {
  return (
    <div className="skill-list-name">
      <span className="skill-list-icon">
        <Lightbulb size={16} />
      </span>
      <span>
        <strong>
          {item.title}
          {item.origin === "builtin" && <small>内置</small>}
        </strong>
        {item.title !== item.name && <code>{item.name}</code>}
      </span>
    </div>
  );
}

function Scopes({ item }: { item: SkillItem }) {
  const scopes = (Object.keys(shortScopes) as SkillScope[]).filter((scope) =>
    item.scopes.includes(scope),
  );
  if (!scopes.length) return <span className="skill-list-unused">未使用</span>;
  return (
    <div className="skill-list-tags">
      {scopes.map((scope) => (
        <small
          key={scope}
          data-tone={scope === "agent" ? "info" : "violet"}
          title={scope === "agent" ? skillScopes.agent : `短剧 · ${skillScopes[scope]}`}
        >
          {shortScopes[scope]}
        </small>
      ))}
    </div>
  );
}

function Version({ item }: { item: SkillItem }) {
  const latest = item.versions[0]?.version ?? item.activeVersion;
  return (
    <div className="skill-list-version">
      <code>{item.origin === "builtin" ? "—" : `v${item.activeVersion}`}</code>
      {item.origin !== "builtin" && latest > item.activeVersion && (
        <small data-tone="warning">v{latest} 待生效</small>
      )}
    </div>
  );
}

export function SkillList({ items, open }: { items: SkillItem[]; open: (name: string) => void }) {
  const mobile = useCompactLayout();
  if (mobile)
    return (
      <ul className="skill-list-cards">
        {items.map((item) => (
          <li key={item.name}>
            <button
              type="button"
              data-skill-name={item.name}
              className="skill-list-card"
              onClick={() => open(item.name)}
            >
              <div>
                <Name item={item} />
                <Version item={item} />
              </div>
              <p>{activeDescription(item)}</p>
              <Scopes item={item} />
            </button>
          </li>
        ))}
      </ul>
    );
  return (
    <table className="skill-list-table">
      <thead>
        <tr>
          {["技能", "说明", "用在哪里", "版本", "更新"].map((label) => (
            <th key={label} scope="col">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr
            key={item.name}
            data-skill-name={item.name}
            tabIndex={0}
            onClick={() => open(item.name)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.target === event.currentTarget) {
                event.preventDefault();
                open(item.name);
              }
            }}
          >
            <td>
              <Name item={item} />
            </td>
            <td>
              <p>{activeDescription(item)}</p>
            </td>
            <td>
              <Scopes item={item} />
            </td>
            <td>
              <Version item={item} />
            </td>
            <td>
              <Updated item={item} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
