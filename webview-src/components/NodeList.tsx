import React, { useState } from 'react';
import { ResearchNode, NodeStatus } from '../../src/models/types';
import { StatusBadge } from './StatusBadge';

interface Props {
  nodes: ResearchNode[];
  selectedId: string | null;
  onSelect: (node: ResearchNode) => void;
  filterType?: string; // 'idea' | asset types | undefined = all
}

const STATUS_ORDER: NodeStatus[] = ['approved', 'draft', 'deprecated', 'archived'];

export function NodeList({ nodes, selectedId, onSelect, filterType }: Props) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<NodeStatus | 'all'>('all');

  const filtered = nodes.filter((n) => {
    if (filterType === 'idea' && n.type !== 'idea') return false;
    if (filterType === 'asset' && n.type === 'idea') return false;
    if (statusFilter !== 'all' && n.status !== statusFilter) return false;
    if (search && !n.title.toLowerCase().includes(search.toLowerCase()) && !n.tags.join(' ').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const sa = STATUS_ORDER.indexOf(a.status);
    const sb = STATUS_ORDER.indexOf(b.status);
    if (sa !== sb) return sa - sb;
    return a.title.localeCompare(b.title);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--vscode-panel-border)', display: 'flex', gap: 8 }}>
        <input
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            padding: '4px 8px',
            background: 'var(--vscode-input-background)',
            color: 'var(--vscode-input-foreground)',
            border: '1px solid var(--vscode-input-border)',
            borderRadius: 4,
            fontSize: 12,
          }}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as NodeStatus | 'all')}
          style={{
            padding: '4px 6px',
            background: 'var(--vscode-dropdown-background)',
            color: 'var(--vscode-dropdown-foreground)',
            border: '1px solid var(--vscode-dropdown-border)',
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          <option value="all">All status</option>
          <option value="approved">Approved</option>
          <option value="draft">Draft</option>
          <option value="deprecated">Deprecated</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {sorted.length === 0 && (
          <div style={{ padding: '24px 16px', opacity: 0.5, fontSize: 13, textAlign: 'center' }}>
            No nodes found.
          </div>
        )}
        {sorted.map((node) => (
          <button
            key={node.id}
            onClick={() => onSelect(node)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '10px 14px',
              border: 'none',
              borderBottom: '1px solid var(--vscode-panel-border)',
              background: selectedId === node.id ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
              color: selectedId === node.id ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
              cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {node.type}
              </span>
              <StatusBadge status={node.status} />
            </div>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{node.title}</div>
            {node.tags.length > 0 && (
              <div style={{ fontSize: 11, opacity: 0.6 }}>{node.tags.join(', ')}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
