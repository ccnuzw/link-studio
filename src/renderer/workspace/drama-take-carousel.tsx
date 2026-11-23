import { type JobStatus, jobIsTerminal } from "@link-studio/core";
import {
  animate,
  type MotionValue,
  motion,
  useDragControls,
  useMotionValue,
  useTransform,
} from "motion/react";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { AssetVideo } from "../asset-media";
import { initialTakeIndex, snapTakeIndex } from "./drama-take-index";
import { LocalVideoPoster } from "./local-video-poster";

export interface SegmentTake {
  taskId: string;
  status: JobStatus;
  errorMessage?: string;
  asset?: { projectHandle: string; assetId: string };
}

export function TakeVideo({ asset }: { asset: NonNullable<SegmentTake["asset"]> }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  if (url) return <AssetVideo className="nodrag" controls autoPlay src={url} />;
  return (
    <button
      type="button"
      className="drama-take-play"
      aria-label="播放视频"
      onClick={async () => {
        const result = await window.desktop.projects.getAssetPreview(asset);
        if (result.ok) setUrl(result.value.url);
        else setError(result.error.message ?? "读取视频失败");
      }}
    >
      <LocalVideoPoster {...asset} />
      <span>{error || "▶"}</span>
    </button>
  );
}

/** 吸附用的弹簧：略带回弹，像被磁铁吸过去再稳住 */
const MAGNET = { type: "spring", stiffness: 420, damping: 30, mass: 0.9 } as const;

/** 播放器最高多高（px），和原来的单播放器一致 */
const MAX_CARD_HEIGHT = 680;

/** 底部留给位置点的高度（px） */
const DOTS_SPACE = 22;

/** 横图时中间卡片最多占预览区宽度的比例，两边要留出露出邻居的位置 */
const MAX_CARD_WIDTH_RATIO = 0.62;

/** 相邻两版的间距是卡片宽度的多少：小于 1 让两边的卡片藏一点在中间那张后面 */
const STEP_RATIO = 0.86;

/** 滚轮 / 触控板横滑累积多少像素换一版，换完冷却多久（毫秒），免得一滑就跳好几版 */
const WHEEL_THRESHOLD = 60;
const WHEEL_COOLDOWN = 260;

const isPlayable = (take: SegmentTake) => take.status === "succeeded" && !!take.asset;
const isRunning = (take: SegmentTake) =>
  !isPlayable(take) && (!jobIsTerminal(take.status) || take.status === "succeeded");

/** 预览区的尺寸，用来算卡片大小 */
function useBoxSize() {
  const ref = useRef<HTMLFieldSetElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ w: width, h: height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}

/** 一张卡：按离中间的距离算位置、缩放、透明度和层级，拖动时跟着连续变化 */
function TakeCard({
  take,
  index,
  x,
  step,
  width,
  height,
  focused,
  chosen,
  onPick,
}: {
  take: SegmentTake;
  index: number;
  x: MotionValue<number>;
  step: number;
  width: number;
  height: number;
  focused: boolean;
  chosen: boolean;
  onPick: () => void;
}) {
  const offset = useTransform(x, (value) => index * step + value);
  const distance = useTransform(offset, (value) =>
    step > 0 ? Math.min(Math.abs(value) / step, 2) : 0,
  );
  const scale = useTransform(distance, [0, 1, 2], [1, 0.8, 0.66]);
  const opacity = useTransform(distance, [0, 1, 2], [1, 0.5, 0.18]);
  const zIndex = useTransform(distance, (value) => Math.round(20 - value * 8));
  const playable = isPlayable(take);

  return (
    <motion.div
      data-take-card
      style={{
        x: offset,
        scale,
        opacity,
        zIndex,
        width,
        height,
        marginLeft: -width / 2,
        marginTop: -height / 2,
      }}
      onClick={focused ? undefined : onPick}
      className={`drama-take-card ${focused ? "focused" : ""} ${chosen ? "chosen" : ""}`}
    >
      {playable && take.asset ? (
        focused ? (
          // 和画布视频节点同一个播放器：先显示封面、播放钮和时长，点了才加载；滑走时停播退回封面
          <TakeVideo key={take.taskId} asset={take.asset} />
        ) : (
          <LocalVideoPoster {...take.asset} />
        )
      ) : (
        <span role="status">
          {take.errorMessage || (isRunning(take) ? "生成中" : "生成未完成")}
        </span>
      )}
      {chosen && <span className="drama-take-chosen">采用</span>}
    </motion.div>
  );
}

/**
 * 片段的版本轮播：各版左右排开，正中是当前版本（放大、可播放），两边缩小变暗露出一截。
 * 中间那张用和画布视频节点相同的播放器（封面 + 播放钮 + 时长，点了才加载）。
 * 拖动（播放钮和控制条上不触发，免得和拖进度条打架）、滚轮横滑、← → 都能换版；
 * 松手后按位移加惯性算出最近的一版，用带回弹的弹簧「吸」到中间。
 * 吸到中间的是成功的版本就自动采用；生成中、失败的只是看，不会被采用。
 * 有采用变化（如第一版成功被自动采用）或新提交了一版时，自动滑过去。
 */
export function TakeCarousel({
  takes,
  chosenTaskId,
  aspect,
  onChoose,
}: {
  takes: readonly SegmentTake[];
  chosenTaskId: string;
  /** 宽 / 高 */
  aspect: number;
  onChoose: (taskId: string) => void;
}) {
  const box = useBoxSize();
  const [focus, setFocus] = useState(() => initialTakeIndex(takes, chosenTaskId));
  const focusRef = useRef(focus);
  const dragFrom = useRef(focus);
  const wheel = useRef({ total: 0, lockedUntil: 0 });
  const controls = useDragControls();

  // 卡片尺寸：竖图按高度定，横图不超过宽度的 62%，给两边留出位置
  const dots = takes.length > 1;
  let height = Math.min(box.h - (dots ? DOTS_SPACE : 0), MAX_CARD_HEIGHT);
  let width = height * aspect;
  if (width > box.w * MAX_CARD_WIDTH_RATIO) {
    width = box.w * MAX_CARD_WIDTH_RATIO;
    height = width / aspect;
  }
  const step = takes.length > 1 ? width * STEP_RATIO : 0;
  const x = useMotionValue(-focus * step);

  /** 滑到第 index 版；adopt 为真且是成功的版本时设为采用 */
  const goTo = useCallback(
    (index: number, adopt: boolean) => {
      const target = Math.min(takes.length - 1, Math.max(0, index));
      focusRef.current = target;
      setFocus(target);
      void animate(x, -target * step, MAGNET);
      const take = takes[target];
      if (adopt && take && isPlayable(take) && take.taskId !== chosenTaskId) onChoose(take.taskId);
    },
    [chosenTaskId, onChoose, step, takes, x],
  );

  // 尺寸变了：直接对齐到当前版本，不播动画
  useEffect(() => {
    x.set(-focusRef.current * step);
  }, [step, x]);

  // 采用在别处变了（第一版成功被自动采用、别的标签页改了）：滑过去
  const followChoice = useEffectEvent((taskId: typeof chosenTaskId) => {
    const index = takes.findIndex((take) => take.taskId === taskId);
    if (index >= 0 && index !== focusRef.current) goTo(index, false);
  });
  useEffect(() => {
    followChoice(chosenTaskId);
  }, [chosenTaskId]);

  // 新提交了一版：滑到最新那一版看进度
  const count = useRef(takes.length);
  useEffect(() => {
    if (takes.length > count.current) goTo(takes.length - 1, false);
    count.current = takes.length;
  }, [goTo, takes.length]);

  const onWheel = (event: React.WheelEvent) => {
    const delta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.shiftKey
          ? event.deltaY
          : 0;
    if (!delta) return;
    const now = performance.now();
    if (now < wheel.current.lockedUntil) return;
    wheel.current.total += delta;
    if (Math.abs(wheel.current.total) < WHEEL_THRESHOLD) return;
    goTo(focusRef.current + (wheel.current.total > 0 ? 1 : -1), true);
    wheel.current = { total: 0, lockedUntil: now + WHEEL_COOLDOWN };
  };

  return (
    <fieldset
      data-ui-group
      ref={box.ref}
      aria-roledescription="carousel"
      aria-label={`版本 ${focus + 1} / ${takes.length}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The focused carousel handles Left and Right to select a take.
      tabIndex={0}
      onWheel={onWheel}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") goTo(focusRef.current - 1, true);
        else if (event.key === "ArrowRight") goTo(focusRef.current + 1, true);
        else return;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        // 播放按钮、控制条（进度条、静音）自己处理点击和拖动；封面和其余地方按下就开始拖
        if ((event.target as Element).closest("button, input, .nodrag")) return;
        dragFrom.current = focusRef.current;
        controls.start(event);
      }}
      className="drama-take-carousel"
    >
      {/* 看不见的拖动把手：只负责把指针位移写进 x，卡片都从 x 读位置 */}
      <motion.div
        aria-hidden
        drag="x"
        dragControls={controls}
        dragListener={false}
        dragMomentum={false}
        dragElastic={0.18}
        dragConstraints={{ left: -(takes.length - 1) * step, right: 0 }}
        onDragEnd={(_, info) =>
          goTo(snapTakeIndex(x.get(), info.velocity.x, step, takes.length, dragFrom.current), true)
        }
        style={{ x }}
        className="drama-take-drag"
      />
      {width > 0 &&
        takes.map((take, index) => (
          <TakeCard
            key={take.taskId}
            take={take}
            index={index}
            x={x}
            step={step}
            width={width}
            height={height}
            focused={index === focus}
            chosen={take.taskId === chosenTaskId}
            onPick={() => goTo(index, true)}
          />
        ))}
      {/* 位置点：当前版本是长条，采用的标主色，失败的标红；点一下滑过去 */}
      {dots && (
        <div className="drama-take-dots">
          {takes.map((take, index) => (
            <button
              key={take.taskId}
              type="button"
              tabIndex={-1}
              aria-label={`第 ${index + 1} 版`}
              onClick={() => goTo(index, true)}
              className={`${index === focus ? "focused" : ""} ${take.taskId === chosenTaskId ? "chosen" : isPlayable(take) ? "ready" : isRunning(take) ? "running" : "failed"}`}
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}
