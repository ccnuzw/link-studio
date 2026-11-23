import { sourceWebUrl } from "@link-studio/core";
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm, remarkBreaks];
const components: Components = {
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
  h4: ({ children }) => <h4>{children}</h4>,
  table: ({ children }) => (
    <div className="canvas-text-table">
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children, title }) => {
    const url = sourceWebUrl(href);
    if (!url) return <span>{children}</span>;
    return (
      <a
        href={url}
        title={title}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(event) => {
          event.preventDefault();
          void window.desktop.app.openSource(url);
        }}
      >
        {children}
      </a>
    );
  },
  img: ({ alt }) => <span>{alt}</span>,
};

export const CanvasTextMarkdown = memo(function CanvasTextMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {text}
    </ReactMarkdown>
  );
});
