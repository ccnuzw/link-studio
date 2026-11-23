import type { DirectorScene } from "@link-studio/core";
import { Video } from "lucide-react";
import "./director-node-body.css";

export function DirectorNodeBody({
  scene,
  thumbnail,
  enter,
  disabled,
}: {
  scene: DirectorScene;
  thumbnail?: string;
  enter: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="director-node-body" data-thumbnail={thumbnail ? true : undefined}>
      {thumbnail && (
        <>
          <img src={thumbnail} alt="" draggable={false} />
          <div className="director-node-mask" />
        </>
      )}
      <div className="director-node-center">
        {!thumbnail && (
          <>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3.4 8.6 19.9 4.2a1 1 0 0 1 1.2.7l.6 2.2-17.6 4.7-.6-2.2a1 1 0 0 1 .7-1.2Z" />
              <path d="M3 11.8h18v7A2.2 2.2 0 0 1 18.8 21H5.2A2.2 2.2 0 0 1 3 18.8v-7Z" />
            </svg>
            <p>在 3D 空间中设计角色、机位与镜头</p>
          </>
        )}
        <button className="nodrag" type="button" disabled={disabled} onClick={enter}>
          进入导演台
        </button>
      </div>
      {!!scene.cameras.length && (
        <div className="director-node-cameras">
          {scene.cameras.map((camera) => (
            <span key={camera.id}>
              <Video />
              {camera.name}
              <span>{scene.duration.toFixed(1)}s</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
