import { sourceWebUrl } from "@link-studio/core";
import {
  ArrowUpRight,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Info,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import {
  type CardRef,
  type CardTone,
  validateCard,
} from "../../../packages/agent-runtime/upstream/src/card";
import { keyedItems } from "../occurrence-keys";
import "./info-card.css";

const tones = {
  info: { icon: Info, label: "信息" },
  ok: { icon: CircleCheck, label: "正常" },
  warn: { icon: TriangleAlert, label: "注意" },
  bad: { icon: CircleX, label: "异常" },
};

function Tone({ tone, note }: { tone: CardTone; note?: boolean }) {
  const Icon = note && tone === "info" ? CircleAlert : tones[tone].icon;
  return <Icon aria-hidden data-tone={tone} size={note ? 14 : 16} />;
}

export type CardJump = (ref: CardRef) => (() => void) | undefined;

export function InfoCard({ raw, resolveJump }: { raw: unknown; resolveJump?: CardJump }) {
  const [expanded, setExpanded] = useState(false);
  const [sourceError, setSourceError] = useState(false);
  const parsed = validateCard(raw);
  if (!parsed.ok) return null;
  const { card } = parsed;
  const reference = (text: string, ref?: CardRef) => {
    const jump = ref && resolveJump?.(ref);
    return jump ? (
      <button type="button" className="card-reference" onClick={jump}>
        <span>{text}</span>
        <ArrowUpRight aria-hidden size={12} />
      </button>
    ) : (
      text
    );
  };
  return (
    <section className="agent-info-card" aria-label={card.title}>
      <h3>
        <Tone tone={card.tone} />
        <span>{card.title}</span>
        <span className="sr-only">（{tones[card.tone].label}）</span>
      </h3>
      {card.kind === "summary" ? (
        <dl>
          {keyedItems(card.rows, (row) => row.label).map(({ item: row, key }) => (
            <div key={key}>
              <dt>{row.label}</dt>
              <dd>
                {reference(row.value, row.ref)}
                {row.sub && <small>{row.sub}</small>}
              </dd>
              <dd>
                {row.badge && (
                  <span className="card-badge" data-tone={row.tone}>
                    {row.badge}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="card-table-body">
          <div className="card-table-scroll">
            <table>
              <thead>
                <tr>
                  {keyedItems(card.columns, (column) => column).map(({ item: column, key }) => (
                    <th key={key} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keyedItems(card.rows.slice(0, expanded ? undefined : 6), (row) =>
                  JSON.stringify(row.cells),
                ).map(({ item: row, key }) => (
                  <tr key={key}>
                    {keyedItems(row.cells, (cell) => cell.text).map(({ item: cell, key }) => (
                      <td key={key}>
                        <span className="card-cell">
                          {cell.tone && (
                            <>
                              <i aria-hidden data-tone={cell.tone} />
                              <span className="sr-only">{tones[cell.tone].label}</span>
                            </>
                          )}
                          {reference(cell.text, cell.ref)}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!expanded && card.rows.length > 6 && (
            <button type="button" className="card-more" onClick={() => setExpanded(true)}>
              <ChevronDown size={14} aria-hidden />
              还有 {card.rows.length - 6} 项
            </button>
          )}
        </div>
      )}
      {card.notes && (
        <ul aria-label="提示" className="card-notes">
          {keyedItems(card.notes, (note) => note.text).map(({ item: note, key }) => (
            <li key={key} data-tone={note.tone}>
              <Tone tone={note.tone} note />
              {note.text}
            </li>
          ))}
        </ul>
      )}
      {card.sources && (
        <ul aria-label="来源" className="card-sources">
          {keyedItems(card.sources, (source) => source.url).map(({ item: source, key }) => {
            const url = sourceWebUrl(source.url);
            return (
              <li key={key}>
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={async (event) => {
                      event.preventDefault();
                      setSourceError(
                        !(await window.desktop.app.openSource(url).catch(() => false)),
                      );
                    }}
                  >
                    {source.title}
                    <ArrowUpRight size={12} aria-hidden />
                  </a>
                ) : (
                  source.title
                )}
              </li>
            );
          })}
        </ul>
      )}
      {sourceError && <small role="alert">无法打开来源链接。</small>}
    </section>
  );
}
