import type { DirectorScene } from "@link-studio/core";
import { useEffect, useState } from "react";
import { loadFigureModel } from "./director-figures";

export function useDirectorModels(characters: DirectorScene["characters"]) {
  const key = [...new Set(characters.map((actor) => actor.model ?? "male"))].sort().join(",");
  const [attempt, setAttempt] = useState(0),
    [status, setStatus] = useState<"loading" | "ready" | "simplified">("loading");
  useEffect(() => {
    let current = true;
    setStatus("loading");
    void Promise.all(
      key
        .split(",")
        .filter((model): model is "male" | "female" => model === "male" || model === "female")
        .map(loadFigureModel),
    ).then((results) => {
      if (current) setStatus(results.every(Boolean) ? "ready" : "simplified");
    });
    return () => {
      current = false;
    };
  }, [key, attempt]);
  return { status, retry: () => setAttempt((previous) => previous + 1) };
}
