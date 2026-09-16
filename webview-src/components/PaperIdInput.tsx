import React, { useState } from 'react';
import { PaperEntry } from '../../src/models/types';

interface Props {
  value: string;
  onChange: (value: string) => void;
  papers: PaperEntry[];
  onOpenPdf: (slug: string) => void;
  sourcePdfDirectory: string;
  inputStyle: React.CSSProperties;
}

export function PaperIdInput({ value, onChange, papers, onOpenPdf, sourcePdfDirectory, inputStyle }: Props) {
  const [open, setOpen] = useState(false);

  const trimmed = value.trim();
  const exactMatch = trimmed ? papers.find((p) => p.slug === trimmed) ?? null : null;

  const suggestions = trimmed && !exactMatch
    ? papers.filter((p) => p.slug.includes(trimmed)).slice(0, 8)
    : [];

  const showDropdown = open && suggestions.length > 0;

  // Determine text color — never leave it undefined (undefined in a spread overrides
  // the base style's color and falls back to browser-default black).
  const textColor = exactMatch
    ? 'var(--vscode-testing-iconPassed, #4ec9b0)'                       // green: valid match
    : trimmed && suggestions.length === 0
      ? 'var(--vscode-inputValidation-errorForeground, #f48771)'          // red: no match
      : 'var(--vscode-input-foreground)';                                 // normal: empty or suggestions present

  return (
    <div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="paper_id"
          style={{ ...inputStyle, flex: 1, color: textColor }}
        />
        {exactMatch && (
          <button
            onClick={() => onOpenPdf(exactMatch.slug)}
            title={`Open ${sourcePdfDirectory}/${exactMatch.slug}.pdf`}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--vscode-textLink-foreground)',
              fontSize: 11,
              padding: '0 2px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            Open PDF ↗
          </button>
        )}
      </div>

      {showDropdown && (
        <div
          style={{
            background: 'var(--vscode-dropdown-background)',
            border: '1px solid var(--vscode-dropdown-border)',
            borderRadius: 3,
            marginTop: 2,
          }}
        >
          {suggestions.map((p) => (
            <div
              key={p.slug}
              onMouseDown={(e) => { e.preventDefault(); onChange(p.slug); setOpen(false); }}
              style={{ padding: '4px 8px', cursor: 'pointer', fontSize: 12, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '')}
            >
              {p.slug}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
