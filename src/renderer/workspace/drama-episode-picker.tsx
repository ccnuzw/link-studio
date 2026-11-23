import { Check, Lock } from "lucide-react";
import { useState } from "react";

export function DramaEpisodePicker({
  choices,
  selection,
  setSelected,
  busy,
  mode,
}: {
  choices: { no: number; title: string; reason: string; ready?: boolean }[];
  selection: number[];
  setSelected: (numbers: number[]) => void;
  busy: boolean;
  mode: "scripts" | "breakdown" | "storyboard";
}) {
  const limit = mode === "storyboard" ? 50 : 200;
  const available = choices.filter((item) => !item.reason),
    chosen = new Set(selection);
  const unscripted = available
    .filter((item) => !item.ready)
    .slice(0, 200)
    .map((item) => item.no);
  const [scrollTop, setScrollTop] = useState(0);
  const rows = Math.ceil(choices.length / 3),
    firstRow = Math.max(0, Math.floor(scrollTop / 42) - 6),
    lastRow = Math.min(rows, Math.ceil((scrollTop + 288) / 42) + 6);
  const max = choices.at(-1)?.no ?? 1;
  const [from, setFrom] = useState("1"),
    [to, setTo] = useState(String(Math.min(10, max)));
  return (
    <fieldset disabled={busy}>
      <div className="script-selection">
        <b>{mode === "breakdown" ? "解析范围" : "选择集数"}</b>
        <small>已选 {selection.length} 集</small>
        <span />
        {mode === "scripts" && (
          <button
            type="button"
            disabled={!unscripted.length}
            onClick={() => setSelected(unscripted)}
          >
            没有剧本的
          </button>
        )}
        <button
          type="button"
          disabled={!available.length}
          onClick={() => setSelected(available.slice(0, limit).map((item) => item.no))}
        >
          {mode === "scripts" ? "全选" : "全选可用"}
        </button>
        <button type="button" disabled={!selection.length} onClick={() => setSelected([])}>
          清空
        </button>
      </div>
      <div className="script-range">
        按范围选：第{" "}
        <input
          type="number"
          min={1}
          max={max}
          aria-label="起始集"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />{" "}
        –{" "}
        <input
          type="number"
          min={1}
          max={max}
          aria-label="结束集"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />{" "}
        集{" "}
        <button
          type="button"
          onClick={() => {
            const bounds = [from, to].map((value) => Math.max(1, Math.floor(Number(value) || 1)));
            setSelected(
              available
                .filter((item) => item.no >= Math.min(...bounds) && item.no <= Math.max(...bounds))
                .map((item) => item.no),
            );
          }}
        >
          选中
        </button>
      </div>
      <div
        className="script-episodes"
        data-slot="episode-grid"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: rows * 42 }}>
          {Array.from({ length: lastRow - firstRow }, (_, index) => firstRow + index).map((row) => (
            <div
              key={row}
              className="script-episode-window"
              style={{ top: 0, height: 36, transform: `translateY(${row * 42}px)` }}
            >
              {choices.slice(row * 3, row * 3 + 3).map((item) => (
                <button
                  type="button"
                  key={item.no}
                  disabled={!!item.reason}
                  title={item.reason || undefined}
                  aria-pressed={chosen.has(item.no)}
                  onClick={() =>
                    setSelected(
                      chosen.has(item.no)
                        ? selection.filter((no) => no !== item.no)
                        : [...selection, item.no],
                    )
                  }
                >
                  <i>
                    {chosen.has(item.no) ? (
                      <Check size={12} />
                    ) : item.reason === "已拆解" ? (
                      <Lock size={10} />
                    ) : null}
                  </i>
                  <span>{item.no}.</span>
                  <span>{item.title}</span>
                  {mode === "scripts" && item.ready && !item.reason && <small>已有剧本</small>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </fieldset>
  );
}
