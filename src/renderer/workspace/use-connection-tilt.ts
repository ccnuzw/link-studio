import { useStoreApi } from "@xyflow/react";
import { useReducedMotion, useSpring, useTransform } from "motion/react";
import { useEffect } from "react";
import type { LinkKind } from "./link-rules";

const spring = { stiffness: 260, damping: 26, mass: 0.6 };

export function useConnectionTilt(nodeId: string, kind: LinkKind) {
  const store = useStoreApi();
  const reduced = useReducedMotion();
  const rotateX = useSpring(0, spring);
  const rotateY = useSpring(0, spring);
  const scale = useSpring(1, spring);
  const opacity = useSpring(1, spring);
  const transformPerspective = useTransform([rotateX, rotateY, scale], ([pitch, yaw, depth]) =>
    pitch !== 0 || yaw !== 0 || depth !== 1 ? 900 : 0,
  );
  useEffect(() => {
    const unsubscribe = store.subscribe((state, previous) => {
      const connection = state.connection;
      if (connection === previous.connection) return;
      let pitch = 0,
        yaw = 0,
        depth = 1,
        alpha = 1;
      if (connection.inProgress && connection.fromNode.id !== nodeId) {
        const outward = connection.fromHandle.type === "source";
        const checksLink = kind === "image" || kind === "video" || kind === "audio";
        const accepted =
          !checksLink ||
          (state.isValidConnection?.({
            source: outward ? connection.fromNode.id : nodeId,
            target: outward ? nodeId : connection.fromNode.id,
            sourceHandle: null,
            targetHandle: null,
          }) ??
            true);
        if (!accepted) alpha = 0.35;
        const node = state.nodeLookup.get(nodeId);
        if (accepted && !reduced && node?.measured.width && node.measured.height) {
          const [left, top, zoom] = state.transform;
          const x =
            (2 * ((connection.pointer.x - left) / zoom - node.internals.positionAbsolute.x)) /
              node.measured.width -
            1;
          const y =
            (2 * ((connection.pointer.y - top) / zoom - node.internals.positionAbsolute.y)) /
              node.measured.height -
            1;
          if (Math.abs(x) <= 1 && Math.abs(y) <= 1) {
            yaw = x * 7;
            pitch = -y * 7;
            depth = 0.985;
          }
        }
      }
      rotateX.set(pitch);
      rotateY.set(yaw);
      scale.set(depth);
      opacity.set(alpha);
    });
    return () => {
      unsubscribe();
      rotateX.set(0);
      rotateY.set(0);
      scale.set(1);
      opacity.set(1);
    };
  }, [store, nodeId, kind, reduced, rotateX, rotateY, scale, opacity]);
  return { rotateX, rotateY, scale, opacity, transformPerspective };
}
