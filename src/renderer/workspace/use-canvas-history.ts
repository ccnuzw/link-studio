import type { EditableCanvasNode, GenerationJob, ProjectCanvasView } from "@link-studio/core";
import { jobIsTerminal } from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { canvasDiff } from "./canvas-model";
import { generatedFields, generatedHistoryUpdate, restoreTaskMedia } from "./generated-history";
import { liveUploadFields, uploadTransition } from "./upload-history";

const LIMIT = 100;
type HistorySelection = { nodes: ReadonlySet<string>; edges: ReadonlySet<string> };

function isContentEdit(
  before: ProjectCanvasView["nodes"][number] | undefined,
  after: EditableCanvasNode,
) {
  if (!before || before.type !== after.type || !Value.Equal(before.position, after.position))
    return false;
  if (after.type === "group" && before.type === "group")
    return before.width === after.width && before.height === after.height;
  if (after.type !== "creative" || before.type !== "creative" || before.parentId !== after.parentId)
    return false;
  const { kind, uploaded, assetId, outputs, activeOutputId, shotId, director } = before.data;
  const current = after.data;
  return (
    kind === current.kind &&
    uploaded === current.uploaded &&
    assetId === current.assetId &&
    Value.Equal(outputs, current.outputs) &&
    shotId === current.shotId &&
    Value.Equal(director, current.director) &&
    (activeOutputId === current.activeOutputId ||
      (!current.activeOutputId && current.text !== before.data.text))
  );
}

export function useCanvasHistory(
  canvas: ProjectCanvasView,
  apply: (canvas: ProjectCanvasView, selection?: HistorySelection) => void,
  dragging: boolean,
  jobs: GenerationJob[],
  selection?: HistorySelection,
) {
  const last = useRef(canvas);
  const selections = useRef(new WeakMap<ProjectCanvasView, HistorySelection>());
  const merge = useRef<number | null>(null);
  const mentionEdge = useRef<string | null>(null);
  const generated = useRef(new Map<string, Set<string>>());
  const pendingVoices = useRef(new WeakMap<ProjectCanvasView, Map<string, string>>());
  const filledVoices = useRef(new Map<string, { jobId: string; assetId: string }>());
  const trackVoices = useEffectEvent((snapshot: ProjectCanvasView) => {
    const voices = jobs.filter(
      (job) => job.purpose === "character-voice" && !jobIsTerminal(job.status),
    );
    if (voices.length)
      pendingVoices.current.set(snapshot, new Map(voices.map((job) => [job.nodeId, job.id])));
  });
  const [undo, setUndo] = useState<ProjectCanvasView[]>([]);
  const [redo, setRedo] = useState<ProjectCanvasView[]>([]);
  const acceptGeneratedChanges = (next: ProjectCanvasView, jobs: GenerationJob[]) => {
    const update = generatedHistoryUpdate(last.current, next, jobs);
    if (!update) {
      generated.current.clear();
      return false;
    }
    for (const [id, versions] of update) {
      const known = generated.current.get(id);
      generated.current.set(
        id,
        new Set(
          versions.current.filter((version) => known?.has(version) || versions.added.has(version)),
        ),
      );
    }
    return true;
  };
  useEffect(() => {
    if (dragging) return;
    if (selection && (selection.edges.size || selection.nodes.size))
      selections.current.set(canvas, selection);
    else selections.current.delete(canvas);
    const previous = last.current;
    const beforeNodes = new Map(previous.nodes.map((node) => [node.id, node]));
    const changes = canvasDiff(previous, canvas).filter((change) => {
      if (change.type === "setViewport") return false;
      if (change.type !== "putNode" || change.node.type !== "creative") return true;
      const before = beforeNodes.get(change.node.id);
      const after = change.node;
      if (
        before?.type === "creative" &&
        uploadTransition(before.data, after.data) &&
        Value.Equal({ ...before, data: liveUploadFields(before.data, after.data) }, after)
      )
        return false;
      if (before?.type !== "creative" || !before.data.director || !after.data.director) return true;
      const { director: _scene, directorThumbnailId: _thumbnail, ...beforeFields } = before.data;
      const {
        director: _newScene,
        directorThumbnailId: _newThumbnail,
        ...afterFields
      } = after.data;
      return !Value.Equal({ ...before, data: beforeFields }, { ...after, data: afterFields });
    });
    last.current = canvas;
    if (!changes.length) return;
    const content = changes.every(
      (change) =>
        change.type === "putNode" && isContentEdit(beforeNodes.get(change.node.id), change.node),
    );
    const now = performance.now();
    const linkedWhileTyping = changes.some(
      (change) => change.type === "putEdge" && change.edge.id === mentionEdge.current,
    );
    if ((!content && !linkedWhileTyping) || merge.current === null || now - merge.current >= 800) {
      trackVoices(previous);
      setUndo((stack) => [...stack.slice(1 - LIMIT), previous]);
    }
    merge.current = content ? now : null;
    if (!content) mentionEdge.current = null;
    setRedo([]);
  }, [canvas, dragging, selection]);

  const restore = (direction: "undo" | "redo") => {
    const stack = direction === "undo" ? undo : redo;
    const next = stack.at(-1);
    if (!next || dragging) return;
    if (direction === "undo") {
      setUndo(stack.slice(0, -1));
      setRedo((current) => [...current.slice(1 - LIMIT), canvas]);
    } else {
      setRedo(stack.slice(0, -1));
      setUndo((current) => [...current.slice(1 - LIMIT), canvas]);
    }
    const live = new Map(canvas.nodes.map((node) => [node.id, node]));
    const nodes = next.nodes.map((node) => {
      const current = live.get(node.id);
      if (node.type !== "creative" || current?.type !== "creative") return node;
      const taskVersions = generated.current.get(node.id);
      let data = uploadTransition(node.data, current.data)
        ? liveUploadFields(node.data, current.data)
        : node.data;
      data = restoreTaskMedia(data, current.data, jobs, node.id);
      if (
        taskVersions &&
        current.data.outputs?.some(
          (output) =>
            taskVersions.has(output.id) && !data.outputs?.some((saved) => saved.id === output.id),
        )
      ) {
        data = generatedFields(data, current.data);
      }
      if (current.data.director)
        data = {
          ...data,
          director: current.data.director,
          directorThumbnailId: current.data.directorThumbnailId,
        };
      const voice = filledVoices.current.get(node.id);
      if (
        voice &&
        data.character &&
        pendingVoices.current.get(next)?.get(node.id) === voice.jobId &&
        current.data.character?.voice?.assetId === voice.assetId
      ) {
        data = { ...data, character: { ...data.character, voice: current.data.character.voice } };
      }
      return data === node.data ? node : { ...node, data };
    });
    last.current = { ...next, nodes, viewport: canvas.viewport };
    const selection = selections.current.get(next);
    if (selection) selections.current.set(last.current, selection);
    merge.current = null;
    apply(last.current, selection);
  };

  return {
    canUndo: undo.length > 0 && !dragging,
    canRedo: redo.length > 0 && !dragging,
    restore,
    absorbTyping(edgeId: string) {
      mentionEdge.current = edgeId;
    },
    syncGenerated(next: ProjectCanvasView, jobs: GenerationJob[]) {
      const previous = last.current;
      const priorNodes = new Map(previous.nodes.map((node) => [node.id, node]));
      const voices = new Map<string, { jobId: string; assetId: string }>();
      const nodes = next.nodes.map((node) => {
        const old = priorNodes.get(node.id);
        if (
          node.type !== "creative" ||
          old?.type !== "creative" ||
          !old.data.character ||
          !node.data.character
        )
          return node;
        const assetId = node.data.character.voice?.assetId;
        if (!assetId || old.data.character.voice?.assetId === assetId) return node;
        const job = jobs.find(
          (candidate) =>
            candidate.nodeId === node.id &&
            candidate.purpose === "character-voice" &&
            candidate.status === "succeeded" &&
            candidate.bound &&
            candidate.outputs.some(
              (output) => output.kind === "audio" && output.assetId === assetId,
            ),
        );
        if (!job) return node;
        voices.set(node.id, { jobId: job.id, assetId });
        const character = { ...node.data.character };
        if (old.data.character.voice) character.voice = old.data.character.voice;
        else delete character.voice;
        return { ...node, data: { ...node.data, character } };
      });
      const continuous = acceptGeneratedChanges(voices.size ? { ...next, nodes } : next, jobs);
      last.current = next;
      if (!continuous) {
        filledVoices.current.clear();
        setUndo([]);
        setRedo([]);
        merge.current = null;
      } else if (voices.size) {
        for (const [id, voice] of voices) filledVoices.current.set(id, voice);
        pendingVoices.current.set(
          previous,
          new Map(Array.from(voices, ([id, voice]) => [id, voice.jobId])),
        );
        setUndo((stack) => [...stack.slice(1 - LIMIT), previous]);
        setRedo([]);
        merge.current = null;
      }
    },
    recordSynced(before: ProjectCanvasView, after: ProjectCanvasView, jobs: GenerationJob[]) {
      const continuous = acceptGeneratedChanges(before, jobs);
      const base = continuous ? last.current : before;
      last.current = after;
      merge.current = null;
      setUndo((stack) => [...(continuous ? stack.slice(1 - LIMIT) : []), base]);
      setRedo([]);
    },
    reset(next: ProjectCanvasView) {
      filledVoices.current.clear();
      generated.current.clear();
      last.current = next;
      merge.current = null;
      setUndo([]);
      setRedo([]);
    },
  };
}
