import React, { useEffect, useState } from 'react';
import { ResearchNode, ResearchStatus } from '../../src/models/types';
import { StatusBadge } from './StatusBadge';
import { IDEA_STATUS_LIST, NODE_STATUS_LIST, PLAN_STATUS_LIST } from '../../src/domain/nodeKinds';

interface Props {
  nodes: ResearchNode[];
  selectedId: string | null;
  onSelect: (node: ResearchNode) => void;
  filterType?: string; // 'idea' | 'plan' | 'asset' | 'definition' | 'library' | undefined = all
  definitionPath?: string;
  /** Library view only: approve the listed draft results together. */
  onApprove?: (ids: string[], label: string) => void;
}

const STATUS_ORDER: ResearchStatus[] = ['pending', 'failed', 'succeeded', 'abandoned', 'approved', 'draft', 'deprecated', 'archived'];

export function NodeList({ nodes, selectedId, onSelect, filterType, definitionPath = 'research/definitions', onApprove }: Props) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ResearchStatus | 'all'>('all');
  const [collection, setCollection] = useState<string>('all');
  useEffect(() => { setStatusFilter('all'); setCollection('all'); }, [filterType]);
  const isLibrary = filterType === 'library';
  const collections = [...new Set(nodes.filter((n) => n.origin === 'library').map((n) => n.collection ?? ''))].sort();

  const filtered = nodes.filter((n) => {
    const isDefinition = n.filePath.startsWith(`${definitionPath}/`);
    // Library results have their own view so they do not crowd the project's assets and definitions.
    if (isLibrary !== (n.origin === 'library')) return false;
    if (isLibrary && collection !== 'all' && n.collection !== collection) return false;
    if (filterType === 'idea' && n.type !== 'idea') return false;
    if (filterType === 'plan' && n.type !== 'plan') return false;
    if (filterType === 'definition' && !isDefinition) return false;
    if (filterType === 'asset' && (n.type === 'idea' || n.type === 'plan' || isDefinition)) return false;
    if (statusFilter !== 'all' && n.status !== statusFilter) return false;
    if (search && !n.title.toLowerCase().includes(search.toLowerCase()) && !n.tags.join(' ').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (isLibrary && a.collection !== b.collection) return (a.collection ?? '').localeCompare(b.collection ?? '');
    // Assets and definitions follow dependency order, derived by the extension; inactive ones come last.
    if (filterType === 'asset' || filterType === 'definition' || isLibrary) {
      if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
      if (a.order !== undefined || b.order !== undefined) return a.order !== undefined ? -1 : 1;
    }
    const sa = a.status ? STATUS_ORDER.indexOf(a.status) : STATUS_ORDER.length;
    const sb = b.status ? STATUS_ORDER.indexOf(b.status) : STATUS_ORDER.length;
    if (sa !== sb) return sa - sb;
    return a.title.localeCompare(b.title);
  });

  const drafts = isLibrary ? sorted.filter((n) => n.status === 'draft') : [];

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
          onChange={(e) => setStatusFilter(e.target.value as ResearchStatus | 'all')}
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
          {(filterType === 'idea' ? IDEA_STATUS_LIST : filterType === 'plan' ? PLAN_STATUS_LIST : NODE_STATUS_LIST).map((status) => (
            <option key={status} value={status}>{status[0].toUpperCase()}{status.slice(1)}</option>
          ))}
        </select>
      </div>
      {isLibrary && (
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--vscode-panel-border)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            title="Collection"
            style={{ flex: 1, padding: '4px 6px', background: 'var(--vscode-dropdown-background)', color: 'var(--vscode-dropdown-foreground)', border: '1px solid var(--vscode-dropdown-border)', borderRadius: 4, fontSize: 12 }}
          >
            <option value="all">All collections</option>
            {collections.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          {onApprove && drafts.length > 0 && (
            <button
              onClick={() => onApprove(drafts.map((n) => n.id), collection === 'all' ? 'the library' : `collection ${collection}`)}
              title="Approve every listed draft library result; each is then used as known and never re-proved"
              style={{ padding: '3px 8px', fontSize: 12, background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', borderRadius: 3, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              Approve {drafts.length} draft{drafts.length > 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}

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
                {node.type === 'idea' ? 'idea' : node.type === 'plan' ? 'plan' : node.type}
              </span>
              {node.status && <StatusBadge status={node.status} />}
            </div>
            {isLibrary && <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 2 }}>{node.collection} · {node.id}</div>}
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
              {node.order !== undefined && (filterType === 'asset' || filterType === 'definition') && <span style={{ opacity: 0.5, marginRight: 6, fontVariantNumeric: 'tabular-nums' }}>{node.order}.</span>}
              {node.title}
            </div>
            {node.tags.length > 0 && (
              <div style={{ fontSize: 11, opacity: 0.6 }}>{node.tags.join(', ')}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
