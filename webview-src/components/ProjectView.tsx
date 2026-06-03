import React, { useState, useEffect } from 'react';
import { LayoutMode } from '../../src/models/types';
import { MarkdownEditor } from './MarkdownEditor';

interface Props {
  content: string | null;
  projectRoot: string;
  layoutMode: LayoutMode;
  splitRatio: number;
  onLayoutChange: (mode: LayoutMode) => void;
  onSplitRatioChange: (ratio: number) => void;
  onSave: (content: string) => void;
  onInitProject: () => void;
}

export function ProjectView({
  content,
  projectRoot,
  layoutMode,
  splitRatio,
  onLayoutChange,
  onSplitRatioChange,
  onSave,
  onInitProject,
}: Props) {
  const [text, setText] = useState(content ?? '');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (content !== null) {
      setText(content);
      setDirty(false);
    }
  }, [content]);

  if (content === null) {
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ fontSize: 15, marginBottom: 12 }}>Project</h2>
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
          Root: <code>{projectRoot}</code>
        </p>
        <button
          onClick={onInitProject}
          style={{
            padding: '7px 14px',
            background: 'var(--vscode-button-background)',
            color: 'var(--vscode-button-foreground)',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          Initialize Project Structure
        </button>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div
        style={{
          flexShrink: 0,
          padding: '8px 14px',
          borderBottom: '1px solid var(--vscode-panel-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>project.md</span>
        {dirty && <span style={{ fontSize: 11, opacity: 0.5 }}>Unsaved changes</span>}
        <button
          onClick={() => { onSave(text); setDirty(false); }}
          disabled={!dirty}
          style={{
            padding: '3px 12px',
            fontSize: 12,
            background: dirty ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)',
            color: dirty ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)',
            border: 'none',
            borderRadius: 3,
            cursor: dirty ? 'pointer' : 'default',
            opacity: dirty ? 1 : 0.5,
          }}
        >
          Save
        </button>
      </div>

      {/* Editor */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <MarkdownEditor
          value={text}
          onChange={(v) => { setText(v); setDirty(true); }}
          layoutMode={layoutMode}
          splitRatio={splitRatio}
          onLayoutChange={onLayoutChange}
          onSplitRatioChange={onSplitRatioChange}
        />
      </div>
    </div>
  );
}
