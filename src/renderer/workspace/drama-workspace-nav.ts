import type { DramaDocument } from "@link-studio/core";
import { useEffect, useState } from "react";

export const stages = {
  overview: "总览",
  script: "剧本",
  assets: "资产管理",
  studio: "片场",
  final: "成片",
} as const;
export type Stage = keyof typeof stages;
export type ScriptDoc = "characters" | "outline";
type Route = { stage: Stage; ep: number; paper?: ScriptDoc };

function readRoute(doc: DramaDocument, project: string): Route {
  const saved = history.state?.dramaWorkspace,
    restore = saved?.project === project;
  const area = restore ? saved.area : null;
  const stage: Stage =
    area === null
      ? !doc.episodes.length && !doc.outline_md
        ? "script"
        : "overview"
      : area === "board" || area === "episodes"
        ? "studio"
        : Object.hasOwn(stages, area)
          ? (area as Stage)
          : "overview";
  const number = restore ? saved.ep : 0;
  const ep = doc.episodes.some((item) => item.episode_no === number)
    ? number
    : stage === "assets"
      ? 0
      : (doc.episodes[0]?.episode_no ?? 1);
  const paper = restore ? saved.doc : null;
  return {
    stage,
    ep,
    ...(stage === "script" && {
      paper:
        paper === "characters"
          ? "characters"
          : paper === "episode" && doc.episodes.length
            ? undefined
            : "outline",
    }),
  };
}

export function useDramaNav(doc: DramaDocument | null | undefined, project: string) {
  const [route, setRoute] = useState<Route>();
  const current = route ?? (doc ? readRoute(doc, project) : { stage: "script" as const, ep: 1 });
  const first = doc?.episodes[0]?.episode_no ?? 1;
  const ep = doc?.episodes.some((item) => item.episode_no === current.ep)
    ? current.ep
    : current.stage === "assets"
      ? 0
      : first;
  const { stage, paper } = current;
  const go = (target: Stage, number?: number) =>
    setRoute({
      stage: target,
      ep: number ?? (target !== "assets" && !ep ? first : ep),
      ...(target === "script" && !doc?.episodes.length && { paper: "outline" }),
    });
  const pick = (next: number | ScriptDoc) =>
    typeof next === "number"
      ? go(stage, next)
      : setRoute({ stage: "script", ep: ep || first, paper: next });
  useEffect(() => {
    if (doc && !route) setRoute(readRoute(doc, project));
  }, [doc, project, route]);
  useEffect(() => {
    if (route)
      history.replaceState(
        {
          ...history.state,
          dramaWorkspace: {
            project,
            area: stage,
            ep,
            ...(stage === "script" && { doc: paper ?? "episode" }),
          },
        },
        "",
      );
  }, [route, stage, ep, paper, project]);
  useEffect(
    () => () => {
      if (history.state?.dramaWorkspace?.project === project) {
        const state = { ...history.state };
        delete state.dramaWorkspace;
        history.replaceState(state, "");
      }
    },
    [project],
  );
  return {
    stage,
    ep,
    paper,
    pick,
    go,
    afterDelete(no: number, total: number) {
      setRoute({ ...current, ep: !ep ? 0 : ep > no ? ep - 1 : Math.max(1, Math.min(ep, total)) });
    },
  };
}
