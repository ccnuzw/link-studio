import type { RecentProject } from "@link-studio/core";
import {
  ArrowRight,
  Clapperboard,
  FileUp,
  Film,
  FolderOpen,
  PanelsTopLeft,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import brandIcon from "../../../resources/brand/icon.svg";
import { ChoiceButton } from "../choice-button";
import { BackdropDialog } from "./backdrop-dialog";
import { GlobalAssets } from "./global-assets";
import { homeAssetRoute, navigateHomeAssets } from "./home-asset-route";

export type CreationMode = "canvas" | "drama";

export function CreationHome({
  recent,
  busy,
  error,
  create,
  importCanvas,
  open,
  resume,
  remove,
  settings,
}: {
  recent: RecentProject[];
  busy: boolean;
  error: string;
  importCanvas: (file: File) => Promise<void>;
  create: (mode: CreationMode, name: string) => Promise<void>;
  open: () => Promise<void>;
  resume: (id: string, asDrama?: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  settings: () => void;
}) {
  const [section, setSection] = useState<"recent" | "assets" | CreationMode>(() =>
    homeAssetRoute() ? "assets" : "recent",
  );
  useEffect(() => {
    const sync = () =>
      setSection((current) =>
        homeAssetRoute() ? "assets" : current === "assets" ? "recent" : current,
      );
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const [overviewMode, setOverviewMode] = useState<CreationMode>("canvas");
  const overview = section === "recent";
  const mode = overview || section === "assets" ? overviewMode : section;
  const category = mode === "canvas" ? "画布" : "短剧";
  const visibleProjects = overview
    ? recent
    : recent.filter((project) => (project.projectKind ?? "canvas") === section);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [recentErrorId, setRecentErrorId] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (creating) dialog.current?.showModal();
  }, [creating]);
  const exchangeFile = useRef<HTMLInputElement>(null);
  const ModeIcon = mode === "canvas" ? PanelsTopLeft : Clapperboard;
  const start = (
    <section className="home-create" aria-label="开始创作">
      <div className="home-heading">
        <h2>开始创作</h2>
        {overview && (
          <div className="desk-segments" role="radiogroup" aria-label="创作方式">
            {(
              [
                ["canvas", "画布"],
                ["drama", "短剧"],
              ] as const
            ).map(([value, label]) => (
              <ChoiceButton
                key={value}
                aria-checked={mode === value}
                tabIndex={mode === value ? 0 : -1}
                onClick={() => setOverviewMode(value)}
              >
                {label}
              </ChoiceButton>
            ))}
          </div>
        )}
      </div>
      <button
        className="home-new"
        type="button"
        onClick={() => {
          setName("");
          setCreating(true);
        }}
      >
        <span className="home-new-icon">
          <ModeIcon size={25} />
        </span>
        <span>
          <strong>{mode === "canvas" ? "新建画布项目" : "新建短剧项目"}</strong>
          <small>
            {mode === "canvas" ? "导入素材，自由编排镜头" : "从剧本开始，组织分集与分镜"}
          </small>
        </span>
        <Plus size={20} />
      </button>
      {mode === "canvas" && (
        <>
          <button
            className="home-import"
            type="button"
            disabled={busy}
            onClick={() => exchangeFile.current?.click()}
          >
            <FileUp size={17} aria-hidden="true" />
            <span>导入为新画布…</span>
          </button>
          <input
            ref={exchangeFile}
            type="file"
            hidden
            accept=".json,application/json"
            onChange={({ currentTarget }) => {
              const file = currentTarget.files?.[0];
              currentTarget.value = "";
              if (file) void importCanvas(file);
            }}
          />
        </>
      )}
    </section>
  );
  const recentList = (
    <section className="home-recent" aria-label="最近打开">
      <h2>{overview && visibleProjects.length ? "继续上次工作" : "最近打开"}</h2>
      {visibleProjects.length === 0 && (
        <p className="home-muted">
          {overview
            ? "打开或创建本地项目后，可以从这里继续编辑。"
            : `还没有最近打开的${category}项目。`}
        </p>
      )}
      {visibleProjects.map((project) => (
        <div className="home-record" key={project.recentEntryId}>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setRecentErrorId(project.recentEntryId);
              void resume(project.recentEntryId);
            }}
          >
            {project.projectKind === "drama" ? (
              <Clapperboard size={19} />
            ) : (
              <FolderOpen size={19} />
            )}
            <span>
              <strong>{project.displayName}</strong>
              {project.activity && (
                <small className="home-project-activity">
                  {project.activity.label}
                  {project.activity.progress !== undefined && (
                    <>
                      {" "}
                      · {project.activity.progress}%{" "}
                      <progress
                        aria-label={`${project.displayName}任务进度`}
                        max={100}
                        value={project.activity.progress}
                      />
                    </>
                  )}
                  {project.activity.count > 1 && ` · ${project.activity.count} 项任务`}
                </small>
              )}
              <small title={project.displayPath}>{project.displayPath}</small>
            </span>
            <ArrowRight size={16} />
          </button>
          <div className="home-record-actions">
            {!project.projectKind && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setRecentErrorId(project.recentEntryId);
                  void resume(project.recentEntryId, true);
                }}
              >
                作为短剧打开
              </button>
            )}
            <button
              type="button"
              title={project.activity ? "任务结束后可移除记录" : "从最近列表移除"}
              aria-label={`移除${project.displayName}最近记录`}
              disabled={busy || !!project.activity}
              onClick={() => void remove(project.recentEntryId)}
            >
              <Trash2 size={15} />
            </button>
          </div>
          {error && recentErrorId === project.recentEntryId && <p role="alert">{error}</p>}
        </div>
      ))}
    </section>
  );
  return (
    <main className="creation-home">
      <aside className="home-rail">
        <div className="home-brand">
          <img src={brandIcon} width="32" height="32" alt="" />
          <strong>灵可</strong>
        </div>
        <nav className="home-nav" aria-label="创作导航">
          {(
            [
              ["recent", "继续创作", Film],
              ["assets", "资产", FolderOpen],
              ["canvas", "画布", PanelsTopLeft],
              ["drama", "短剧", Clapperboard],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              aria-current={section === value ? "page" : undefined}
              onClick={() => {
                if (value === "assets") {
                  if (!homeAssetRoute()) navigateHomeAssets("history");
                } else if (homeAssetRoute())
                  history.pushState(history.state, "", location.href.split("#")[0]);
                setSection(value);
              }}
            >
              <Icon size={17} aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => {
            setRecentErrorId("");
            void open();
          }}
          disabled={busy}
        >
          <FolderOpen size={17} />
          打开项目
        </button>
        <button className="home-settings" type="button" onClick={settings}>
          <Settings2 size={17} />
          应用设置
        </button>
      </aside>
      <div className="home-sheet">
        <header>Link Studio</header>
        {section === "assets" ? (
          <GlobalAssets settings={settings} resume={resume} />
        ) : (
          <div className="home-content">
            <h1>{overview ? "创作工作台" : `${category}项目`}</h1>
            {overview && recent.length ? (
              <>
                {recentList}
                {start}
              </>
            ) : (
              <>
                {start}
                {recentList}
              </>
            )}
            {error &&
              !creating &&
              !visibleProjects.some((item) => item.recentEntryId === recentErrorId) && (
                <p role="alert">{error}</p>
              )}
          </div>
        )}
      </div>
      {creating && (
        <BackdropDialog
          ref={dialog}
          className="home-create-dialog"
          aria-labelledby="create-title"
          onClose={() => setCreating(false)}
          dismiss={() => {
            if (!busy) dialog.current?.close();
          }}
          onCancel={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create(mode, name);
            }}
          >
            <h2 id="create-title">{mode === "canvas" ? "新建画布项目" : "新建短剧项目"}</h2>
            <label htmlFor="project-name">新项目名称</label>
            <input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              placeholder="未命名项目"
            />
            {error && <p role="alert">{error}</p>}
            <footer>
              <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>
                取消
              </button>
              <button className="desk-primary" type="submit" disabled={busy}>
                选择保存位置…
              </button>
            </footer>
          </form>
        </BackdropDialog>
      )}
    </main>
  );
}
