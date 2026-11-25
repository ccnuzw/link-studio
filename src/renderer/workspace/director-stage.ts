import type { DirectorScene } from "@link-studio/core";
import { requirePresent } from "@link-studio/core";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  PlaneGeometry,
  Vector3,
} from "three";
import { createFigure, disposeDirectorMesh, figureModelStatus } from "./director-figures";

import { directorAspectRatio } from "./director-frame-size";
import { buildPropObject } from "./director-prop-object";
import type { CameraPose, CharacterPose } from "./director-sample";
import { DEG, sampleCamera, sampleCharacter } from "./director-sample";

export const STAGE_BACKGROUND = 0x141417;

const SELECTED = 0xfbbf24;
const ACTIVE = 0xffffff;
const IDLE = 0x7c7c88;

export type PoseLookup = (id: string) => CharacterPose | CameraPose | undefined;

type Entry = {
  key: string;
  group: Group;
  materials: MeshStandardMaterial[];
  frustum?: LineSegments;
  body?: Object3D;
};

export type DirectorStage = {
  root: Group;
  guides: Group;
  helpers: Group;
  sync: (
    scene: DirectorScene,
    poseOf: PoseLookup,
    options?: { selectedId?: string | null },
  ) => void;
  objectOf: (id: string) => Group | undefined;
  idOf: (object: Object3D) => string | undefined;
  pickables: () => Object3D[];
  dispose: () => void;
};

function disposeTree(object: Object3D) {
  object.removeFromParent();
  object.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.geometry) disposeDirectorMesh(mesh);
    const material = mesh.material;
    if (material) for (const item of [material].flat()) item.dispose();
  });
}

function createCameraModel() {
  const group = new Group();
  group.rotation.order = "YXZ";
  const material = new MeshStandardMaterial({ color: 0xd4d4d8, roughness: 0.5 });
  const body = new Mesh(new BoxGeometry(0.24, 0.17, 0.32), material);
  body.position.z = 0.14;
  const lens = new Mesh(new CylinderGeometry(0.06, 0.075, 0.12, 18), material);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = -0.06;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(16 * 3), 3));
  const frustum = new LineSegments(
    geometry,
    new LineBasicMaterial({ color: ACTIVE, transparent: true, opacity: 0.75 }),
  );
  group.add(body, lens, frustum);
  return { group, materials: [material], frustum, body };
}

function updateFrustum(frustum: LineSegments, fov: number, aspect: number, length = 1.5) {
  const h = Math.tan((fov / 2) * DEG) * length;
  const w = h * aspect;
  const corners: [number, number, number][] = [
    [-w, h, -length],
    [w, h, -length],
    [w, -h, -length],
    [-w, -h, -length],
  ];
  const position = frustum.geometry.attributes.position as BufferAttribute;
  const array = position.array as Float32Array;
  let i = 0;
  const put = (p: [number, number, number]) => {
    array[i++] = p[0];
    array[i++] = p[1];
    array[i++] = p[2];
  };
  for (let k = 0; k < 4; k++) {
    put([0, 0, 0]);
    put(requirePresent(corners[k], "corners[k]"));
  }
  for (let k = 0; k < 4; k++) {
    put(requirePresent(corners[k], "corners[k]"));
    put(requirePresent(corners[(k + 1) % 4], "corners[(k + 1) % 4]"));
  }
  position.needsUpdate = true;
  frustum.geometry.computeBoundingSphere();
}

export function applyCameraPose(camera: PerspectiveCamera, pose: CameraPose, aspect: number) {
  camera.position.set(pose.x, pose.y, pose.z);
  camera.rotation.set(pose.pitch * DEG, -pose.yaw * DEG, 0, "YXZ");
  camera.fov = pose.fov;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
}

export function createStage(options: { helpers: boolean }): DirectorStage {
  const root = new Group();
  root.add(new HemisphereLight(0xe4e8ff, 0x1c1c20, 1.15));
  const sun = new DirectionalLight(0xffffff, 1.7);
  sun.position.set(5, 10, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, {
    left: -12,
    right: 12,
    top: 12,
    bottom: -12,
    near: 1,
    far: 35,
  });
  root.add(sun);
  const ground = new Mesh(
    new PlaneGeometry(80, 80),
    new MeshStandardMaterial({ color: 0x1b1b20, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);

  const guides = new Group();
  const grid = new GridHelper(24, 24, 0x3b3b46, 0x2a2a31);
  grid.position.y = 0.003;
  guides.add(grid);
  const axis = (to: [number, number, number], color: number) => {
    const line = new Line(
      new BufferGeometry().setFromPoints([
        new Vector3(-to[0], 0, -to[2]),
        new Vector3(to[0], 0, to[2]),
      ]),
      new LineBasicMaterial({ color }),
    );
    line.position.y = 0.006;
    guides.add(line);
  };
  axis([12, 0, 0], 0xc0392b);
  axis([0, 0, 12], 0x3557d6);
  guides.visible = options.helpers;

  const content = new Group();
  const helpers = new Group();
  helpers.visible = options.helpers;
  root.add(guides, content, helpers);

  const entries = new Map<string, Entry>();
  const trails = new Map<string, { key: string; line: Line }>();

  const put = (id: string, key: string, parent: Group, build: () => Omit<Entry, "key">) => {
    let entry = entries.get(id);
    if (!entry || entry.key !== key) {
      if (entry) disposeTree(entry.group);
      entry = { key, ...build() };
      entry.group.userData.directorId = id;
      parent.add(entry.group);
      entries.set(id, entry);
    }
    return entry;
  };

  const syncTrails = (scene: DirectorScene) => {
    const wanted = new Set<string>();
    for (const item of [...scene.cameras, ...scene.characters]) {
      if (item.keys.length < 2) continue;
      wanted.add(item.id);
      const key = JSON.stringify(item.keys) + scene.duration;
      const existing = trails.get(item.id);
      if (existing?.key === key) continue;
      if (existing) disposeTree(existing.line);
      const isCamera = "fov" in item;
      const points: Vector3[] = [];
      for (let i = 0; i <= 60; i++) {
        const t = (scene.duration * i) / 60;
        if (isCamera) {
          const p = sampleCamera(item, t);
          points.push(new Vector3(p.x, p.y, p.z));
        } else {
          const p = sampleCharacter(item, t);
          points.push(new Vector3(p.x, 0.03, p.z));
        }
      }
      const line = new Line(
        new BufferGeometry().setFromPoints(points),
        new LineDashedMaterial({
          color: isCamera ? ACTIVE : new Color(item.color),
          dashSize: 0.18,
          gapSize: 0.1,
          transparent: true,
          opacity: 0.8,
        }),
      );
      line.computeLineDistances();
      helpers.add(line);
      trails.set(item.id, { key, line });
    }
    for (const [id, trail] of trails) {
      if (wanted.has(id)) continue;
      disposeTree(trail.line);
      trails.delete(id);
    }
  };

  const sync: DirectorStage["sync"] = (scene, poseOf, opts = {}) => {
    const seen = new Set<string>();
    for (const character of scene.characters) {
      seen.add(character.id);
      const entry = put(
        character.id,
        `${character.pose}|${character.color}|${character.model ?? "male"}|${figureModelStatus(character.model)}`,
        content,
        () => {
          const figure = createFigure({
            pose: character.pose,
            color: character.color,
            model: character.model,
          });
          figure.group.rotation.order = "YXZ";
          return { group: figure.group, materials: [figure.material] };
        },
      );
      const pose = (poseOf(character.id) ?? character) as CharacterPose;
      entry.group.position.set(pose.x, 0, pose.z);
      entry.group.rotation.set(0, -pose.yaw * DEG, 0);
      entry.group.scale.setScalar(character.scale || 1);
      entry.group.visible = !character.hidden;
    }
    for (const prop of scene.props) {
      seen.add(prop.id);
      const entry = put(prop.id, prop.shape, content, () => {
        const material = new MeshStandardMaterial({ color: 0x8796a8, roughness: 0.85 });
        const body = buildPropObject(prop.shape, material);
        const group = new Group();
        group.rotation.order = "YXZ";
        group.add(body);
        return { group, materials: [material], body };
      });
      entry.group.position.set(prop.x, 0, prop.z);
      entry.group.rotation.set(0, -prop.yaw * DEG, 0);
      requirePresent(entry.body, "entry.body").scale.set(prop.w, prop.h, prop.d);
      entry.group.visible = !prop.hidden;
    }
    if (options.helpers) {
      for (const camera of scene.cameras) {
        seen.add(camera.id);
        const entry = put(camera.id, "camera", helpers, createCameraModel);
        const pose = (poseOf(camera.id) ?? camera) as CameraPose;
        entry.group.position.set(pose.x, pose.y, pose.z);
        entry.group.rotation.set(pose.pitch * DEG, -pose.yaw * DEG, 0);
        updateFrustum(
          requirePresent(entry.frustum, "entry.frustum"),
          pose.fov,
          directorAspectRatio(camera.aspect),
        );
        const active = camera.id === scene.activeCameraId;
        const color = opts.selectedId === camera.id ? SELECTED : active ? ACTIVE : IDLE;
        (requirePresent(entry.frustum, "entry.frustum").material as LineBasicMaterial).color.setHex(
          color,
        );
        requirePresent(entry.materials[0], "entry.materials[0]").color.setHex(
          active ? 0xe4e4e7 : 0x8a8a94,
        );
      }
      syncTrails(scene);
    }
    for (const [id, entry] of entries) {
      if (seen.has(id)) continue;
      disposeTree(entry.group);
      entries.delete(id);
    }
    for (const [id, entry] of entries) {
      for (const material of entry.materials) {
        material.emissive.setHex(opts.selectedId === id ? 0x5a3a00 : 0x000000);
      }
    }
  };

  return {
    root,
    guides,
    helpers,
    sync,
    objectOf: (id) => entries.get(id)?.group,
    idOf: (object) => {
      for (let node: Object3D | null = object; node; node = node.parent) {
        const id = node.userData.directorId;
        if (typeof id === "string") return id;
      }
      return undefined;
    },
    pickables: () => [...entries.values()].map((entry) => entry.group).filter((g) => g.visible),
    dispose: () => {
      for (const entry of entries.values()) disposeTree(entry.group);
      for (const trail of trails.values()) disposeTree(trail.line);
      entries.clear();
      trails.clear();
      sun.shadow.dispose();
      disposeTree(root);
    },
  };
}
