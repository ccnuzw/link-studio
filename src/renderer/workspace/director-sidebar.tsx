import { type DirectorScene, directorAspects } from "@link-studio/core";
import {
  Box,
  ChevronDown,
  Eye,
  EyeOff,
  Layers,
  SlidersHorizontal,
  Users,
  Video,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { PROP_PRESETS } from "./director-prop-presets";
import type { CameraPose, CharacterPose } from "./director-sample";
import "./director-sidebar.css";

type DirectorCharacter = DirectorScene["characters"][number];
type DirectorProp = DirectorScene["props"][number];
type DirectorCamera = DirectorScene["cameras"][number];
type PoseId = DirectorCharacter["pose"];
type FigureModel = NonNullable<DirectorCharacter["model"]>;
type PropShape = DirectorProp["shape"];
type DirectorAspect = DirectorCamera["aspect"];
type DirectorAddKind = "character" | "camera" | "prop";
export type ObjectPatch = Partial<
  Pick<DirectorCharacter, "name" | "model" | "pose" | "color" | "scale" | "hidden"> &
    Pick<DirectorProp, "shape" | "w" | "h" | "d"> &
    Pick<DirectorCamera, "aspect" | "lookAt"> &
    CameraPose
>;
type SidebarProps = {
  scene: DirectorScene;
  selectedId: string;
  pending: boolean;
  t: number;
  pose: CharacterPose | CameraPose | undefined;
  select: (id: string) => void;
  removeObject: (id: string) => void;
  updateObject: (id: string, patch: ObjectPatch) => void;
  commitTransform: (
    id: string,
    patch: Partial<CameraPose> & Partial<Pick<DirectorProp, "w" | "h" | "d">>,
  ) => void;
  add: (kind: DirectorAddKind) => void;
};
const FIGURE_LABELS = { male: "男性", female: "女性" };
const PROP_CATEGORIES = [
  { id: "geometry", label: "几何体" },
  { id: "object", label: "物体" },
];
const cn = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");
const POSE_LABELS: Record<PoseId, string> = {
  stand: "站立",
  walk: "行走",
  run: "奔跑",
  sit: "坐",
  crouch: "蹲",
  point: "单手指向",
  armsCrossed: "双手抱胸",
  wave: "挥手",
  talk: "对话",
  raiseHand: "举手",
  lookBack: "回头",
  lying: "倒地",
};
const LENSES = [24, 35, 50, 85, 135].map((mm) => ({
  mm,
  fov: Math.round(((2 * Math.atan(12 / mm)) / Math.PI) * 180 * 10) / 10,
}));

const FIELD_CLASS = "ds-field";

export function DirectorSidebar(props: SidebarProps) {
  const [tab, setTab] = useState<"layers" | "props">("layers");
  const { selectedId } = props;

  const [seen, setSeen] = useState(selectedId);
  if (selectedId !== seen) {
    setSeen(selectedId);
    if (selectedId) setTab("props");
  }

  return (
    <aside className="ds-sidebar" aria-label="属性栏">
      <div className="ds-tabs">
        <TabButton active={tab === "layers"} onClick={() => setTab("layers")}>
          <Layers className="ds-icon" />
          图层
        </TabButton>
        <TabButton active={tab === "props"} onClick={() => setTab("props")}>
          <SlidersHorizontal className="ds-icon" />
          属性
        </TabButton>
      </div>
      <div className="ds-scroll">
        {tab === "layers" ? <LayerList {...props} /> : <Properties {...props} />}
      </div>
      <AddBar {...props} />
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className={cn("ds-tab", active && "ds-active")}>
      {children}
    </button>
  );
}

function AddBar({ scene, add }: SidebarProps) {
  const counts = {
    character: scene.characters.length,
    prop: scene.props.length,
    camera: scene.cameras.length,
  };
  const limits = { character: 8, prop: 30, camera: 6 };
  const button = (kind: DirectorAddKind, label: string) => {
    const allowed = counts[kind] < limits[kind];
    return (
      <button
        type="button"
        disabled={!allowed}
        title={allowed ? undefined : `最多 ${limits[kind]} 个${label}`}
        onClick={() => add(kind)}
        className="ds-add"
      >
        + {label}
      </button>
    );
  };
  return (
    <div className="ds-addbar">
      {button("character", "人物")}
      {button("prop", "道具")}
      {button("camera", "机位")}
    </div>
  );
}

function LayerList({ scene, selectedId, select, updateObject, removeObject }: SidebarProps) {
  const group = (
    title: string,
    icon: ReactNode,
    items: (DirectorCharacter | DirectorProp | DirectorCamera)[],
    swatch: (item: DirectorCharacter | DirectorProp | DirectorCamera) => string,
  ) => (
    <div className="ds-group">
      <div className="ds-group-name">
        <ChevronDown className="ds-icon" />
        {icon}
        {title} ({items.length})
      </div>
      {items.map((item) => {
        const keys = "keys" in item ? item.keys.length : 0;
        const hidden = "hidden" in item && item.hidden;
        return (
          <div
            key={item.id}
            role="button"
            tabIndex={0}
            onClick={() => select(item.id)}
            onKeyDown={(event) => event.key === "Enter" && select(item.id)}
            className={cn("ds-item", selectedId === item.id && "ds-active", hidden && "ds-dim")}
          >
            <span className="ds-swatch" style={{ background: swatch(item) }} />
            <span className="ds-name">{item.name}</span>
            {keys > 0 && <span className="ds-count">{keys} 帧</span>}
            <span className="ds-actions">
              {!("fov" in item) && (
                <RowAction
                  title={hidden ? "显示" : "隐藏"}
                  onClick={() => updateObject(item.id, { hidden: !hidden })}
                >
                  {hidden ? <EyeOff className="ds-icon" /> : <Eye className="ds-icon" />}
                </RowAction>
              )}
              <RowAction title="删除" onClick={() => removeObject(item.id)}>
                <X className="ds-icon" />
              </RowAction>
            </span>
          </div>
        );
      })}
    </div>
  );
  return (
    <>
      {group("人物", <Users className="ds-icon" />, scene.characters, (item) =>
        "color" in item ? item.color : "",
      )}
      {group("道具", <Box className="ds-icon" />, scene.props, () => "var(--muted-foreground)")}
      {group("机位", <Video className="ds-icon" />, scene.cameras, (item) =>
        item.id === scene.activeCameraId ? "var(--foreground)" : "var(--muted-foreground)",
      )}
    </>
  );
}

function RowAction({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="ds-action"
    >
      {children}
    </button>
  );
}

function Properties({
  scene,
  selectedId,
  pose,
  pending,
  t,
  updateObject,
  commitTransform,
}: SidebarProps) {
  if (!selectedId) {
    return <p className="ds-empty">在视口或图层里选中一个对象，这里显示它的参数。</p>;
  }
  const character = scene.characters.find((c) => c.id === selectedId);
  const prop = scene.props.find((p) => p.id === selectedId);
  const camera = scene.cameras.find((c) => c.id === selectedId);
  const update = (patch: ObjectPatch) => updateObject(selectedId, patch);
  const item = character ?? prop ?? camera;
  if (!item) return null;

  const keyHint = (keys: number) => (
    <p className={cn("ds-hint", pending ? "ds-running" : "ds-dim")}>
      {keys > 0
        ? pending
          ? `未记录：按 K 把改动写到 ${t.toFixed(2)}s 的关键帧`
          : `已有 ${keys} 个关键帧：在这里改是临时姿态，按 K 写到 ${t.toFixed(2)}s`
        : "没有关键帧：这里改的是静态站位"}
    </p>
  );

  return (
    <div className="ds-properties">
      <Row label="名称">
        <TextField
          key={item.id}
          value={item.name}
          onCommit={(name) => update({ name: name.slice(0, 20) })}
        />
      </Row>
      {character && (
        <>
          <Row label="模型">
            <select
              className={FIELD_CLASS}
              value={character.model ?? "male"}
              onChange={(event) => update({ model: event.target.value as FigureModel })}
            >
              {(Object.keys(FIGURE_LABELS) as FigureModel[]).map((model) => (
                <option key={model} value={model}>
                  {FIGURE_LABELS[model]}
                </option>
              ))}
            </select>
          </Row>
          <Row label="姿势">
            <select
              className={FIELD_CLASS}
              value={character.pose}
              onChange={(event) => update({ pose: event.target.value as PoseId })}
            >
              {(Object.keys(POSE_LABELS) as PoseId[]).map((id) => (
                <option key={id} value={id}>
                  {POSE_LABELS[id]}
                </option>
              ))}
            </select>
          </Row>
          <Row label="颜色">
            <input
              type="color"
              value={character.color}
              onChange={(event) => update({ color: event.target.value })}
              className="ds-color"
            />
          </Row>
          <NumberRow
            label="位置 X"
            unit="m"
            step={0.05}
            value={(pose as CharacterPose).x}
            onCommit={(x) => commitTransform(item.id, { x })}
          />
          <NumberRow
            label="位置 Z"
            unit="m"
            step={0.05}
            value={(pose as CharacterPose).z}
            onCommit={(z) => commitTransform(item.id, { z })}
          />
          <NumberRow
            label="朝向"
            unit="°"
            step={1}
            value={(pose as CharacterPose).yaw}
            onCommit={(yaw) => commitTransform(item.id, { yaw })}
          />
          <NumberRow
            label="体型"
            step={0.05}
            min={0.8}
            max={1.2}
            value={character.scale}
            onCommit={(scale) => update({ scale })}
          />
          <p className="ds-note">姿势在一段镜头内固定，不进时间轴。</p>
          {keyHint(character.keys.length)}
        </>
      )}
      {prop && (
        <>
          <Row label="形状">
            <select
              className={FIELD_CLASS}
              value={prop.shape}
              onChange={(event) => update({ shape: event.target.value as PropShape })}
            >
              {PROP_CATEGORIES.map((category) => (
                <optgroup key={category.id} label={category.label}>
                  {(Object.keys(PROP_PRESETS) as PropShape[])
                    .filter((shape) => PROP_PRESETS[shape].category === category.id)
                    .map((shape) => (
                      <option key={shape} value={shape}>
                        {PROP_PRESETS[shape].label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Row>
          <NumberRow
            label="位置 X"
            unit="m"
            step={0.05}
            value={prop.x}
            onCommit={(x) => commitTransform(prop.id, { x })}
          />
          <NumberRow
            label="位置 Z"
            unit="m"
            step={0.05}
            value={prop.z}
            onCommit={(z) => commitTransform(prop.id, { z })}
          />
          <NumberRow
            label="旋转"
            unit="°"
            step={1}
            value={prop.yaw}
            onCommit={(yaw) => commitTransform(prop.id, { yaw })}
          />
          <NumberRow
            label="宽"
            unit="m"
            step={0.1}
            min={0.05}
            max={20}
            value={prop.w}
            onCommit={(w) => commitTransform(prop.id, { w })}
          />
          <NumberRow
            label="高"
            unit="m"
            step={0.1}
            min={0.05}
            max={10}
            value={prop.h}
            onCommit={(h) => commitTransform(prop.id, { h })}
          />
          <NumberRow
            label="深"
            unit="m"
            step={0.1}
            min={0.02}
            max={20}
            value={prop.d}
            onCommit={(d) => commitTransform(prop.id, { d })}
          />
          <p className="ds-note ds-space">道具不打关键帧。物体的正面朝 -z，旋转可以调整朝向。</p>
        </>
      )}
      {camera && (
        <>
          <Row label="画幅">
            <select
              className={FIELD_CLASS}
              value={camera.aspect}
              onChange={(event) => update({ aspect: event.target.value as DirectorAspect })}
            >
              {directorAspects.map((aspect) => (
                <option key={aspect} value={aspect}>
                  {aspect}
                </option>
              ))}
            </select>
          </Row>
          <Row label="焦距">
            <select
              className={FIELD_CLASS}
              value=""
              onChange={(event) => {
                const fov = Number(event.target.value);
                if (fov) commitTransform(camera.id, { fov });
              }}
            >
              <option value="">选择镜头…</option>
              {LENSES.map((lens) => (
                <option key={lens.mm} value={lens.fov}>
                  {lens.mm}mm（FOV {lens.fov}°）
                </option>
              ))}
            </select>
          </Row>
          <Row label="看向">
            <select
              className={FIELD_CLASS}
              value={camera.lookAt ?? ""}
              onChange={(event) => update({ lookAt: event.target.value || undefined })}
            >
              <option value="">无</option>
              {scene.characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Row>
          <NumberRow
            label="FOV"
            unit="°"
            step={1}
            min={10}
            max={120}
            value={(pose as CameraPose).fov}
            onCommit={(fov) => commitTransform(camera.id, { fov })}
          />
          <NumberRow
            label="位置 X"
            unit="m"
            step={0.05}
            value={(pose as CameraPose).x}
            onCommit={(x) => commitTransform(camera.id, { x })}
          />
          <NumberRow
            label="高度"
            unit="m"
            step={0.05}
            min={0.1}
            value={(pose as CameraPose).y}
            onCommit={(y) => commitTransform(camera.id, { y })}
          />
          <NumberRow
            label="位置 Z"
            unit="m"
            step={0.05}
            value={(pose as CameraPose).z}
            onCommit={(z) => commitTransform(camera.id, { z })}
          />
          <NumberRow
            label="偏航"
            unit="°"
            step={1}
            value={(pose as CameraPose).yaw}
            onCommit={(yaw) => commitTransform(camera.id, { yaw })}
          />
          <NumberRow
            label="俯仰"
            unit="°"
            step={1}
            min={-85}
            max={85}
            value={(pose as CameraPose).pitch}
            onCommit={(pitch) => commitTransform(camera.id, { pitch })}
          />
          {keyHint(camera.keys.length)}
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ds-fieldrow">
      <span className="ds-dim">{label}</span>
      {children}
    </label>
  );
}

function TextField({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const next = draft?.trim();
    setDraft(null);
    if (next && next !== value) onCommit(next);
  };
  return (
    <input
      className={FIELD_CLASS}
      value={draft ?? value}
      maxLength={20}
      onFocus={() => setDraft(value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
    />
  );
}

function NumberRow({
  label,
  value,
  unit,
  step,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  unit?: string;
  step: number;
  min?: number;
  max?: number;
  onCommit: (value: number) => void;
}) {
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const shown = value.toFixed(decimals);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
    if (clamped.toFixed(decimals) !== shown) onCommit(clamped);
  };
  return (
    <Row label={label}>
      <span className="ds-unitrow">
        <input
          aria-label={label}
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          max={max}
          className={cn(FIELD_CLASS, "ds-number")}
          value={draft ?? shown}
          onFocus={() => setDraft(shown)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
        />
        {unit && <span className="ds-unit">{unit}</span>}
      </span>
    </Row>
  );
}
