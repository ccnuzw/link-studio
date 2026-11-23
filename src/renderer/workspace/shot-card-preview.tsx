import type { CanvasShot } from "@link-studio/core";

export function StoryboardPlaceholder() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="40" height="40" fill="currentColor">
      {[2, 9, 16].map((offset) => (
        <rect key={offset} x={offset} y="7" width="6" height="10" rx="1.4" />
      ))}
    </svg>
  );
}

export function newShot(id: string): CanvasShot {
  return { id, scene: "", action: "", dialogue: "", shot: "中景", camera: "固定", duration: 3 };
}

export function ShotStats({ shots }: { shots: CanvasShot[] }) {
  const total = Number(shots.reduce((sum, shot) => sum + shot.duration, 0).toFixed(1));
  const seconds = Math.round(total);
  const clock = [Math.floor(seconds / 60), seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return (
    <span className="storyboard-stats" title={`共 ${total} 秒`}>
      {shots.length} 镜 · {clock}
    </span>
  );
}

export function ShotCardPreview({ shots, running }: { shots: CanvasShot[]; running?: boolean }) {
  const visible = shots.slice(0, 5);
  const remaining = shots.length - visible.length;
  return (
    <section className="shot-card-preview" aria-label="分镜摘要" aria-busy={running || undefined}>
      <div className="shot-card-thumbs">
        {visible.map((shot, index) => (
          <div key={shot.id}>
            <b>{String(index + 1).padStart(2, "0")}</b>
            <small>{shot.shot}</small>
            {index === 4 && remaining > 0 && <strong>+{remaining}</strong>}
          </div>
        ))}
      </div>
      <div className="shot-card-summary">
        {visible.map((shot, index) => (
          <div key={shot.id}>
            <b>{String(index + 1).padStart(2, "0")}</b>
            {(shot.shot || shot.camera) && (
              <span>{[shot.shot, shot.camera].filter(Boolean).join(" / ")}</span>
            )}
            <p>{shot.scene}</p>
            <time>{shot.duration}s</time>
          </div>
        ))}
        {remaining > 0 && <small>还有 {remaining} 镜</small>}
      </div>
    </section>
  );
}
