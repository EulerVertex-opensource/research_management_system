import React from 'react';
import { PaperEntry } from '../../src/models/types';

interface Props {
  papers: PaperEntry[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}

export function PaperList({ papers, selectedSlug, onSelect }: Props) {
  if (papers.length === 0) {
    return (
      <div style={{ padding: '16px 12px', fontSize: 12, opacity: 0.4, textAlign: 'center' }}>
        No papers yet. Add a PDF to get started.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      {papers.map((p) => {
        const selected = p.slug === selectedSlug;
        return (
          <button
            key={p.slug}
            onClick={() => onSelect(p.slug)}
            style={{
              display: 'block',
              width: '100%',
              padding: '8px 12px',
              textAlign: 'left',
              border: 'none',
              borderBottom: '1px solid var(--vscode-panel-border)',
              background: selected
                ? 'var(--vscode-list-activeSelectionBackground)'
                : 'transparent',
              color: selected
                ? 'var(--vscode-list-activeSelectionForeground)'
                : 'var(--vscode-foreground)',
              cursor: 'pointer',
              fontSize: 12,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {p.slug}
          </button>
        );
      })}
    </div>
  );
}
