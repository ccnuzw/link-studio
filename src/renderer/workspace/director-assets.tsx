import { type DirectorScene, directorShapes } from "@link-studio/core";
import { Box, Camera, Search, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { PROP_PRESETS } from "./director-prop-presets";

type Tab = "character" | "prop" | "camera";
type Model = NonNullable<DirectorScene["characters"][number]["model"]>;
type Prop = DirectorScene["props"][number]["shape"];

const modelNames: Record<Model, string> = { male: "男性人台", female: "女性人台" };
const tabs: { id: Tab; label: string }[] = [
  { id: "character", label: "人物" },
  { id: "prop", label: "物体" },
  { id: "camera", label: "机位" },
];

export function DirectorAssets({
  addCharacter,
  addProp,
  addCamera,
}: {
  addCharacter: (model: Model) => void;
  addProp: (shape: Prop) => void;
  addCamera: () => void;
}) {
  const [tab, setTab] = useState<Tab>("character");
  const [query, setQuery] = useState("");
  const cards = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (tab === "character")
      return (Object.keys(modelNames) as Model[])
        .map((model) => ({ id: model, label: modelNames[model], icon: <UserRound /> }))
        .filter(({ label }) => !text || label.toLowerCase().includes(text));
    if (tab === "camera") return [{ id: "camera", label: "新建机位", icon: <Camera /> }];
    return directorShapes
      .map((shape) => ({ id: shape, label: PROP_PRESETS[shape].label, icon: <Box /> }))
      .filter(({ label }) => !text || label.toLowerCase().includes(text));
  }, [query, tab]);
  return (
    <aside className="director-assets" aria-label="导演台素材">
      <nav className="director-assets-tabs" aria-label="素材类别">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-label={`${label}素材`}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <label className="director-assets-search">
        <Search size={14} />
        <span className="sr-only">搜索素材</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索素材"
        />
      </label>
      <div className="director-assets-grid">
        {cards.map(({ id, label, icon }) => (
          <button
            type="button"
            key={id}
            className="director-asset-card"
            onClick={() =>
              tab === "character"
                ? addCharacter(id as Model)
                : tab === "prop"
                  ? addProp(id as Prop)
                  : addCamera()
            }
          >
            <span className="director-asset-icon">{icon}</span>
            <span>{label}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
