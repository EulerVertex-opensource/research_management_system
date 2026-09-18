import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';

interface Props {
  content: string;
  style?: React.CSSProperties;
  onOpenNodeLink?: (href: string) => boolean;
}

export function MarkdownPreview({ content, style, onOpenNodeLink }: Props) {
  return (
    <div className="md-preview" style={style}>
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ node: _node, href, children, ...props }) => (
            <a href={href} {...props} onClick={(event) => {
              if (!href || !onOpenNodeLink) return;
              // Relative Markdown and PDF links name research files, which cannot be opened
              // through the webview's own URL. Route them through the dashboard.
              if (!/\.(?:md|pdf)(?:[?#]|$)/i.test(href) || href.startsWith('/') || href.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(href)) return;
              event.preventDefault();
              onOpenNodeLink(href);
            }}>{children}</a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
