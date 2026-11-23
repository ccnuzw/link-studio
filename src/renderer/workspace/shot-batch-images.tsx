import { useEffect, useRef, useState } from "react";
import { ShotConfirm } from "./shot-confirm";

type ImagePlan = { targets: string[]; missingScene: number };

export function BatchShotImages({
  plan,
  generate,
}: {
  plan: () => ImagePlan;
  generate: (targets: string[]) => Promise<string | undefined>;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  const [current, setCurrent] = useState<ImagePlan>();
  const [opened, setOpened] = useState(false);
  const [notice, setNotice] = useState<{ text: string }>();
  const submitting = useRef(false);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(timeout);
  }, [notice]);
  const open = () => {
    if (submitting.current) return;
    const next = plan();
    if (next.targets.length) {
      setNotice(undefined);
      setCurrent(next);
      setOpened(true);
    } else {
      setNotice({
        text: next.missingScene
          ? `还有 ${next.missingScene} 镜没写画面描述，写好再生成`
          : "每一镜都有分镜图了",
      });
    }
  };
  const start = async () => {
    if (!current || submitting.current) return;
    submitting.current = true;
    setOpened(false);
    try {
      const eligible = new Set(plan().targets);
      const remaining = current.targets.filter((id) => eligible.has(id));
      const error = remaining.length ? await generate(remaining) : undefined;
      if (error) setNotice({ text: error });
    } catch {
      setNotice({ text: "暂时无法生成分镜图，请重试。" });
    } finally {
      submitting.current = false;
    }
  };
  return (
    <>
      <div className="storyboard-batch-pill">
        <button type="button" title="批量生成分镜图" onClick={open}>
          批量生成分镜图
        </button>
      </div>
      {notice && (
        <div role="status" className="shot-batch-notice">
          {notice.text}
        </div>
      )}
      <ShotConfirm
        open={opened}
        change={setOpened}
        focus={confirm}
        title={<>生成 {current?.targets.length ?? 0} 张分镜图？</>}
        description={
          <>
            给还没有分镜图的镜头生成，已有图和正在生成的不动，会消耗积分。
            {!!current?.missingScene && `另有 ${current.missingScene} 镜没写画面描述，这次先跳过。`}
          </>
        }
      >
        <button type="button" data-primary ref={confirm} onClick={() => void start()}>
          开始生成
        </button>
      </ShotConfirm>
    </>
  );
}
