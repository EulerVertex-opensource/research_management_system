import React, { useState } from 'react';
import { ResearchNode } from '../../src/models/types';

interface Props {
  values: string[];
  onChange: (values: string[]) => void;
  nodes: ResearchNode[];
  excludeId?: string;
  onNavigateNode?: (node: ResearchNode) => void;
}

export function NodeTagInput({ values, onChange, nodes, excludeId, onNavigateNode }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const q = query.trim().toLowerCase();
  const suggestions = q
    ? nodes.filter(
        (n) =>
          n.id !== excludeId &&
          !values.includes(n.id) &&
          (n.id.toLowerCase().includes(q) || n.title.toLowerCase().includes(q))
      ).slice(0, 10)
    : [];

  const showDropdown = open && suggestions.length > 0;

  const add = (id: string) => {
    if (!values.includes(id)) onChange([...values, id]);
    setQuery('');
    setOpen(false);
  };

  const remove = (id: string) => onChange(values.filter((v) => v !== id));

  return (
    <div>
      {/* Chip + input container */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          padding: '3px 5px',
          background: 'var(--vscode-input-background)',
          border: '1px solid var(--vscode-input-border)',
          borderRadius: 3,
          minHeight: 26,
          alignItems: 'center',
          cursor: 'text',
        }}
        onClick={(e) => {
          // Focus the hidden input when clicking the container
          const input = (e.currentTarget as HTMLElement).querySelector('input');
          input?.focus();
        }}
      >
        {values.map((id) => {
          const node = nodeMap.get(id);
          const valid = nodeMap.has(id);
          return (
            <span
              key={id}
              title={
                valid
                  ? `${node!.type}: ${node!.title}`
                  : `Unknown node id: "${id}"`
              }
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                background: valid
                  ? 'var(--vscode-badge-background)'
                  : 'var(--vscode-inputValidation-errorBackground)',
                color: valid
                  ? 'var(--vscode-badge-foreground)'
                  : 'var(--vscode-inputValidation-errorForeground)',
                border: valid
                  ? 'none'
                  : '1px solid var(--vscode-inputValidation-errorBorder)',
                borderRadius: 3,
                padding: '1px 5px 1px 6px',
                fontSize: 11,
                maxWidth: 180,
                flexShrink: 0,
              }}
            >
              {valid && onNavigateNode ? (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => { e.stopPropagation(); onNavigateNode(node!); }}
                  title={`Open ${node!.title}`}
                  style={{ border: 'none', background: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >{id}</button>
              ) : (
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{id}</span>
              )}
              <button
                onMouseDown={(e) => { e.preventDefault(); remove(id); }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'inherit', padding: 0, lineHeight: 1,
                  fontSize: 12, opacity: 0.7, flexShrink: 0,
                }}
              >
                ×
              </button>
            </span>
          );
        })}

        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !query && values.length > 0) {
              remove(values[values.length - 1]);
            }
            if (e.key === 'Escape') { setOpen(false); setQuery(''); }
          }}
          placeholder={values.length === 0 ? 'Search nodes…' : ''}
          style={{
            background: 'none', border: 'none', outline: 'none',
            color: 'var(--vscode-input-foreground)',
            fontSize: 11, flex: 1, minWidth: 80, padding: '1px 2px',
          }}
        />
      </div>

      {showDropdown && (
        <div
          style={{
            background: 'var(--vscode-dropdown-background)',
            border: '1px solid var(--vscode-dropdown-border)',
            borderRadius: 3,
            marginTop: 2,
            maxHeight: 150,
            overflowY: 'auto',
          }}
        >
          {suggestions.map((n) => (
            <div
              key={n.id}
              onMouseDown={(e) => { e.preventDefault(); add(n.id); }}
              style={{ padding: '4px 8px', cursor: 'pointer', fontSize: 12, display: 'flex', gap: 8, alignItems: 'baseline' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '')}
            >
              <span style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 11, opacity: 0.6, flexShrink: 0 }}>
                {n.id}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.9 }}>
                {n.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
