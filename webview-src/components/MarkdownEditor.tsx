import React, { useRef, useCallback } from 'react';
import { LayoutMode } from '../../src/models/types';
import { MarkdownPreview } from './MarkdownPreview';

interface Props {
  value: string;
  onChange: (v: string) => void;
  layoutMode: LayoutMode;
  splitRatio: number;
  onLayoutChange: (mode: LayoutMode) => void;
  onSplitRatioChange: (ratio: number) => void;
  onOpenNodeLink?: (href: string) => boolean;
}

const MODES: LayoutMode[] = ['editor', 'split', 'preview'];

export function MarkdownEditor({
  value,
  onChange,
  layoutMode,
  splitRatio,
  onLayoutChange,
  onSplitRatioChange,
  onOpenNodeLink,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleSplitterMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const onMouseMove = (ev: MouseEvent) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const ratio = (ev.clientX - rect.left) / rect.width;
        onSplitRatioChange(Math.max(0.2, Math.min(0.8, ratio)));
      };
      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [onSplitRatioChange]
  );

  const editorPane = (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      style={{
        width: '100%',
        height: '100%',
        padding: '12px 14px',
        background: 'var(--vscode-editor-background)',
        color: 'var(--vscode-editor-foreground)',
        border: 'none',
        outline: 'none',
        resize: 'none',
        fontFamily: 'var(--vscode-editor-font-family, monospace)',
        fontSize: 13,
        lineHeight: 1.7,
      }}
    />
  );

  const previewPane = (
    <MarkdownPreview
      content={value}
      onOpenNodeLink={onOpenNodeLink}
      style={{ height: '100%', overflow: 'auto', padding: '12px 18px' }}
    />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Layout toggle */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          gap: 2,
          padding: '4px 10px',
          borderBottom: '1px solid var(--vscode-panel-border)',
        }}
      >
        {MODES.map((mode) => (
          <button
            key={mode}
            onClick={() => onLayoutChange(mode)}
            style={{
              padding: '3px 10px',
              fontSize: 11,
              border: '1px solid var(--vscode-input-border)',
              borderRadius: 3,
              background: layoutMode === mode ? 'var(--vscode-button-background)' : 'transparent',
              color: layoutMode === mode ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)',
              cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >
            {mode}
          </button>
        ))}
      </div>

      {/* Content */}
      <div ref={containerRef} style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {layoutMode === 'editor' && (
          <div style={{ flex: 1, overflow: 'hidden' }}>{editorPane}</div>
        )}

        {layoutMode === 'preview' && (
          <div style={{ flex: 1, overflow: 'hidden' }}>{previewPane}</div>
        )}

        {layoutMode === 'split' && (
          <>
            <div style={{ width: `${splitRatio * 100}%`, overflow: 'hidden' }}>
              {editorPane}
            </div>

            <div
              onMouseDown={handleSplitterMouseDown}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--vscode-focusBorder)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--vscode-panel-border)')}
              style={{ width: 4, flexShrink: 0, cursor: 'col-resize', background: 'var(--vscode-panel-border)' }}
            />

            <div style={{ flex: 1, overflow: 'hidden' }}>{previewPane}</div>
          </>
        )}
      </div>
    </div>
  );
}
