import { create } from "zustand";

export const NODE_KINDS = ["script", "image", "video", "audio"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export type SidePanel = "assistant" | "runtime";

export const NODE_LABELS: Record<NodeKind, string> = {
  script: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
};

type WorkspaceState = {
  sidePanel: SidePanel;
  setSidePanel: (panel: SidePanel) => void;
};

export const useWorkspace = create<WorkspaceState>((set) => ({
  sidePanel: "assistant",
  setSidePanel: (sidePanel) => set({ sidePanel }),
}));
