import { AnimatePresence } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";

export function ReferenceStrip({
  tiles,
  menu,
  error,
  notices = [],
}: {
  tiles: ReactNode[];
  menu: ReactNode;
  error?: string;
  notices?: readonly string[];
}) {
  const row = useRef<HTMLDivElement>(null);
  const count = tiles.length;
  const previous = useRef(count);
  useEffect(() => {
    if (count > previous.current && row.current)
      row.current.scrollTo({ left: row.current.scrollWidth, behavior: "smooth" });
    previous.current = count;
  }, [count]);
  return (
    <div className="reference-strip">
      <div ref={row} className="reference-scroll nowheel">
        <AnimatePresence initial={false}>{tiles}</AnimatePresence>
        {menu}
      </div>
      {error && <p role="alert">{error}</p>}
      {notices.map((notice) => (
        <p key={notice} data-slot="ref-notice">
          {notice}
        </p>
      ))}
    </div>
  );
}
