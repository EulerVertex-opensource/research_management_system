import React, { useState, useEffect } from 'react';
import { LayoutMode, ProjectPathSummary } from '../../src/models/types';
import { MarkdownEditor } from './MarkdownEditor';

interface Props {
  content: string | null;
  projectRoot: string;
  initialized: boolean;
  paths: ProjectPathSummary | null;
  layoutMode: LayoutMode;
  splitRatio: number;
  onLayoutChange: (mode: LayoutMode) => void;
  onSplitRatioChange: (ratio: number) => void;
  onSave: (content: string) => void;
  onOpenNodeLink?: (href: string) => boolean;
  onInitProject: () => void;
  onRefreshProject: () => void;
}

export function ProjectView({
  content,
  projectRoot,
  initialized,
  paths,
  layoutMode,
  splitRatio,
  onLayoutChange,
  onSplitRatioChange,
  onSave,
  onOpenNodeLink,
  onInitProject,
  onRefreshProject,
}: Props) {
  const [text, setText] = useState(content ?? '');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (content !== null) {
      setText(content);
      setDirty(false);
    }
  }, [content]);

  if (!initialized || content === null) {
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ fontSize: 15, marginBottom: 12 }}>Project</h2>
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
          Root: <code>{projectRoot}</code>
        </p>
        {paths?.layout === 'legacy' ? (
          <p style={{ fontSize: 13, opacity: 0.75, marginBottom: 16, maxWidth: 680, lineHeight: 1.6 }}>
            Research Assistant found the existing legacy layout with <code>{paths.mainTex}</code> and{' '}
            <code>{paths.bibliography}</code>. Initialization records that layout without moving or replacing files
            and regenerates local agent setup. Authored research context remains shareable through Git.
          </p>
        ) : (
          <p style={{ fontSize: 13, opacity: 0.75, marginBottom: 16, maxWidth: 680, lineHeight: 1.6 }}>
            Research Assistant found <code>{paths?.mainTex ?? 'main.tex'}</code> as the Overleaf main document
            and <code>{paths?.bibliography ?? 'references.bib'}</code> as the bibliography. Initialization preserves
            those files and adds authored <code>research/</code> context and path configuration for Git. Reproducible
            agent guidance, bundled skills, editor settings, and PDFs stay local.
          </p>
        )}
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
          Initialize Shared Research Scaffold
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
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{paths?.projectMd ?? 'research/project.md'}</span>
        {dirty && <span style={{ fontSize: 11, opacity: 0.5 }}>Unsaved changes</span>}
        <button
          onClick={onRefreshProject}
          title="Reinstall Codex and Claude Code skills and regenerate agent guidance"
          style={{
            padding: '3px 12px',
            fontSize: 12,
            background: 'var(--vscode-button-secondaryBackground)',
            color: 'var(--vscode-button-secondaryForeground)',
            border: 'none',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          Refresh Project Setup
        </button>
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
          onOpenNodeLink={onOpenNodeLink}
        />
      </div>
    </div>
  );
}
