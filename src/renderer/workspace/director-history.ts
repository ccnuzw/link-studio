import type { DirectorScene } from "@link-studio/core";

export type SceneEdit = DirectorScene | ((current: DirectorScene) => DirectorScene);
type Action =
  | { type: "edit"; update: SceneEdit }
  | { type: "selectCamera"; id: string }
  | { type: "begin" | "end" | "undo" | "redo" };
type History = {
  scene: DirectorScene;
  past: DirectorScene[];
  future: DirectorScene[];
  base?: DirectorScene;
};

export function initDirectorHistory(scene: DirectorScene): History {
  return { scene, past: [], future: [] };
}

export function directorHistory(state: History, action: Action): History {
  const { scene, past, future, base } = state;
  switch (action.type) {
    case "selectCamera":
      return scene.activeCameraId === action.id
        ? state
        : { ...state, scene: { ...scene, activeCameraId: action.id } };
    case "edit": {
      const next = typeof action.update === "function" ? action.update(scene) : action.update;
      if (next === scene) return state;
      if (base) return { ...state, scene: next };
      return { scene: next, past: [...past, scene].slice(-100), future: [] };
    }
    case "begin":
      return base ? state : { ...state, base: scene };
    case "end":
      return !base
        ? state
        : base === scene
          ? { ...state, base: undefined }
          : { scene, past: [...past, base].slice(-100), future: [] };
    case "undo": {
      const previous = past.at(-1);
      return !previous || base
        ? state
        : { scene: previous, past: past.slice(0, -1), future: [scene, ...future] };
    }
    case "redo":
      return !future[0] || base
        ? state
        : { scene: future[0], past: [...past, scene], future: future.slice(1) };
  }
}
