import type { DirectorScene } from "@link-studio/core";
import { requirePresent } from "@link-studio/core";
import { Aperture, Box, PanelLeftClose, Search, UserRound, Video } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { assetThumbs, characterThumbKey, propThumbKey } from "./director-asset-thumbs";
import { PROP_PRESETS, type PropCategory } from "./director-prop-presets";
import "./director-assets-panel.css";
export type AssetTab = "character" | "prop" | "camera";
type DirectorAddKind = AssetTab;
type PropShape = DirectorScene["props"][number]["shape"];
type FigureModel = NonNullable<DirectorScene["characters"][number]["model"]>;
type AddOptions = { model?: FigureModel; shape?: PropShape };
const FIGURE_MODELS: FigureModel[] = ["male", "female"];
const FIGURE_LABELS = { male: "男性", female: "女性" };
const PROP_CATEGORIES: { id: PropCategory; label: string }[] = [
  { id: "geometry", label: "几何体" },
  { id: "object", label: "物体" },
];
const shapesOf = (category: PropCategory) =>
  (Object.keys(PROP_PRESETS) as PropShape[]).filter(
    (shape) => PROP_PRESETS[shape].category === category,
  );
const propLabel = (shape: PropShape) => PROP_PRESETS[shape].label;
const cn = (...styles: (string | false)[]) => styles.filter(Boolean).join(" ");
type Card = {
  id: string;
  name: string;

  category: string;

  tag: string;
  kind: DirectorAddKind;
  options?: AddOptions;

  hint?: string;

  run?: () => void;

  thumbKey?: string;
  icon: ReactNode;
};

const TABS: { id: AssetTab; label: string; icon: ReactNode }[] = [
  { id: "character", label: "人物", icon: <UserRound className="asset-icon" /> },
  { id: "prop", label: "物体", icon: <Box className="asset-icon" /> },
  { id: "camera", label: "机位", icon: <Video className="asset-icon" /> },
];

const ALL = "all";

const characterCards = (): Card[] =>
  FIGURE_MODELS.map((model: FigureModel) => ({
    id: model,
    name: FIGURE_LABELS[model],
    category: model,
    tag: "预设",
    kind: "character",
    options: { model },
    thumbKey: characterThumbKey(model),
    icon: <UserRound className="card-icon" />,
  }));

const propCard = (shape: PropShape, category: string): Card => ({
  id: shape,
  name: propLabel(shape),
  category,
  tag: "预设",
  kind: "prop",
  options: { shape },
  thumbKey: propThumbKey(shape),
  icon: <Box className="card-icon" />,
});

export function DirectorAssets({
  scene,
  tab,
  setTab,
  toggle,
  addCharacter,
  addProp,
  addCamera,
  onCameraFromView,
}: {
  scene: DirectorScene;
  tab: AssetTab;
  setTab: (tab: AssetTab) => void;
  toggle: () => void;
  addCharacter: (model: FigureModel) => void;
  addProp: (shape: PropShape) => void;
  addCamera: () => void;
  onCameraFromView: () => void;
}) {
  const [query, setQuery] = useState("");

  const [filters, setFilters] = useState<Record<AssetTab, string>>({
    character: ALL,
    prop: ALL,
    camera: ALL,
  });
  const filter = filters[tab];
  const text = query.trim().toLowerCase();

  const sections = useMemo(() => {
    const matches = (card: Card) =>
      !text || card.name.toLowerCase().includes(text) || card.category.toLowerCase().includes(text);
    if (tab === "character") {
      const cards = characterCards().filter(
        (card) => (filter === ALL || card.id === filter) && matches(card),
      );
      return cards.length ? [{ title: null as string | null, cards }] : [];
    }
    if (tab === "prop") {
      return PROP_CATEGORIES.filter((c) => filter === ALL || c.id === filter)
        .map((c) => ({
          title: filter === ALL ? c.label : null,
          cards: shapesOf(c.id)
            .map((shape) => propCard(shape, c.label))
            .filter(matches),
        }))
        .filter((section) => section.cards.length > 0);
    }
    const cameraCards: Card[] = [
      {
        id: "new",
        name: "新建机位",
        category: "机位",
        tag: "预设",
        kind: "camera",
        icon: <Video className="card-icon" />,
      },
      {
        id: "view",
        name: "当前视角机位",
        category: "机位",
        tag: "预设",
        kind: "camera",
        hint: "把当前导演视角变成一台机位",
        run: onCameraFromView,
        icon: <Aperture className="card-icon" />,
      },
    ];
    const cards = cameraCards.filter(matches);
    return cards.length ? [{ title: null as string | null, cards }] : [];
  }, [filter, onCameraFromView, tab, text]);

  const chips: { id: string; label: string }[] =
    tab === "character"
      ? [
          { id: ALL, label: "全部" },
          ...FIGURE_MODELS.map((m) => ({ id: m, label: FIGURE_LABELS[m] })),
        ]
      : tab === "prop"
        ? [
            { id: ALL, label: "全部" },
            ...PROP_CATEGORIES.map((c: { id: PropCategory; label: string }) => ({
              id: c.id,
              label: c.label,
            })),
          ]
        : [];

  const add = (card: Card) => {
    if (card.run) return card.run();
    if (card.kind === "character")
      addCharacter(
        requirePresent(requirePresent(card.options, "card.options").model, "card.options.model"),
      );
    else if (card.kind === "prop")
      addProp(
        requirePresent(requirePresent(card.options, "card.options").shape, "card.options.shape"),
      );
    else addCamera();
  };

  return (
    <motion.aside
      aria-label="资产"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
      className="asset-library"
    >
      <div className="asset-heading">
        <Box className="asset-icon muted" />
        <span className="asset-heading-text">资产</span>
        <button
          type="button"
          title="折叠资产面板"
          aria-label="折叠资产面板"
          onClick={() => toggle()}
          className="asset-close"
        >
          <PanelLeftClose className="asset-icon" />
        </button>
      </div>

      <div role="tablist" aria-label="资产类型" className="asset-tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            title={item.label}
            onClick={() => setTab(item.id)}
            className={cn("asset-tab", tab === item.id && "selected")}
          >
            {item.icon}
            {item.label}
            {tab === item.id && (
              <motion.span layoutId="director-asset-tab" className="asset-tab-marker" />
            )}
          </button>
        ))}
      </div>

      <div className="asset-filters">
        <label className="asset-search">
          <Search className="asset-icon muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索素材"
            className="asset-input"
          />
        </label>
        {chips.length > 0 && (
          <div className="asset-chips">
            {chips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                aria-pressed={filter === chip.id}
                onClick={() => setFilters((prev) => ({ ...prev, [tab]: chip.id }))}
                className={cn("asset-chip", filter === chip.id && "selected")}
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="director-asset-scroll">
        {sections.length === 0 ? (
          <p className="asset-empty">没有匹配的素材</p>
        ) : (
          sections.map((section) => (
            <section key={section.title ?? "list"} className="asset-section">
              {section.title && <h3 className="asset-section-title">{section.title}</h3>}
              <div className="asset-grid">
                {section.cards.map((card) => {
                  const limit =
                    card.kind === "character"
                      ? scene.characters.length >= 8 && "最多 8 个人物"
                      : card.kind === "camera"
                        ? scene.cameras.length >= 6 && "最多 6 个机位"
                        : scene.props.length >= 30 && "最多 30 个道具";
                  return (
                    <AssetCard
                      key={card.id}
                      card={card}
                      disabled={!!limit}
                      title={limit || (card.hint ?? `添加${card.name}`)}
                      onClick={() => add(card)}
                    />
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </motion.aside>
  );
}

function AssetCard({
  card,
  disabled,
  title,
  onClick,
}: {
  card: Card;
  disabled: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      title={title}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.985 }}
      onClick={onClick}
      className="asset-card"
    >
      <div className="asset-photo">
        {card.thumbKey ? <Thumb thumbKey={card.thumbKey} fallback={card.icon} /> : card.icon}
      </div>
      <div className="asset-caption">
        <div className="asset-name">{card.name}</div>
        <div className="asset-tag">{card.tag}</div>
      </div>
    </motion.button>
  );
}

function Thumb({ thumbKey, fallback }: { thumbKey: string; fallback: ReactNode }) {
  const state = useSyncExternalStore(
    assetThumbs.subscribe,
    () => assetThumbs.get(thumbKey),
    () => assetThumbs.get(thumbKey),
  );
  useEffect(() => {
    void assetThumbs.request(thumbKey);
  }, [thumbKey]);
  if (state.status === "ready") {
    return <img src={state.url} alt="" draggable={false} className="asset-img" />;
  }
  if (state.status === "failed") return fallback;
  return <span className="asset-skeleton" />;
}
