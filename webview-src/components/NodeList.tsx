import React, { useEffect, useState } from 'react';
import { ResearchNode, ResearchStatus } from '../../src/models/types';
import { StatusBadge } from './StatusBadge';
import { CITED_SOURCE_KINDS, IDEA_STATUS_LIST, NODE_STATUS_LIST, PLAN_STATUS_LIST } from '../../src/domain/nodeKinds';
import { CITED_COLOR, tint } from '../graph/colors';

interface Props {
  nodes: ResearchNode[];
  selectedId: string | null;
  onSelect: (node: ResearchNode) => void;
  filterType?: string; // 'idea' | 'plan' | 'asset' | 'definition' | 'library' | undefined = all
  definitionPath?: string;
}

/**
 * One badge for a result taken from the literature, in place of its status:
 * purple with a check once the researcher checked it against the source, grey
 * until then. Retired ones keep their ordinary status badge.
 */
function citedBadge(node: ResearchNode): React.ReactNode {
  const library = node.origin === 'library';
  const cited = !library && node.source && CITED_SOURCE_KINDS.has(node.source.kind);
  if ((!library && !cited) || (node.status !== 'approved' && node.status !== 'draft')) return undefined;
  const checked = node.status === 'approved';
  const where = cited ? `${node.source!.paper_id ?? `a ${node.source!.kind}`}${node.source!.location ? `, ${node.source!.location}` : ''}` : `the library${node.collection ? ` (${node.collection})` : ''}`;
  const color = checked ? CITED_COLOR : 'var(--vscode-descriptionForeground)';
  // The state goes first, so it stays visible when a long source name is cut off.
  const label = `${checked ? '✓ ' : 'NOT CHECKED · '}${cited ? `CITED${node.source!.paper_id ? ` · ${node.source!.paper_id}` : ''}` : 'KNOWN RESULT'}`;
  return (
    <span title={`${cited ? 'Cited from' : 'Known result from'} ${where}; not proved in this project. ${checked ? 'You checked it against the source.' : 'Not checked against the source yet.'}`}
      style={{ fontSize: 10, fontWeight: 600, padding: '0 6px', borderRadius: 8, color, border: `1px ${checked ? 'solid' : 'dashed'} ${color}`, background: checked ? tint(CITED_COLOR, 10) : 'transparent', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {label}
    </span>
  );
}

/** The card style of every Research list: a thin neutral border, the widget background, the editor's selection when chosen. */
export function researchCardStyle(selected = false): React.CSSProperties {
  return {
    border: `1px solid ${selected ? 'var(--vscode-focusBorder)' : 'var(--vscode-panel-border)'}`,
    borderRadius: 6,
    boxShadow: selected ? '0 0 0 1px var(--vscode-focusBorder)' : undefined,
    background: selected ? 'var(--vscode-list-activeSelectionBackground)' : 'var(--vscode-editorWidget-background, transparent)',
    color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
    flexShrink: 0,
  };
}

/** The small uppercase label above a card's title. */
export const kindLabelStyle: React.CSSProperties = { fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5, flexShrink: 0 };

interface ItemProps {
  node: ResearchNode;
  selected: boolean;
  onSelect: (node: ResearchNode) => void;
  /** Position in dependency order, shown before the title. */
  order?: number;
  /** A small line above the title (the library shows the collection and ID). */
  meta?: string;
  innerRef?: (element: HTMLElement | null) => void;
}

/** One node as a card of a Research list: its type and state, its title, its tags. */
export function NodeListItem({ node, selected, onSelect, order, meta, innerRef }: ItemProps) {
  return (
    <button
      ref={innerRef}
      onClick={() => onSelect(node)}
      aria-current={selected}
      style={{ ...researchCardStyle(selected), display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, minWidth: 0 }}>
        <span style={kindLabelStyle}>{node.type}</span>
        {citedBadge(node) ?? (node.status && <StatusBadge status={node.status} />)}
      </div>
      {meta && <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 2 }}>{meta}</div>}
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
        {order !== undefined && <span style={{ opacity: 0.5, marginRight: 6, fontVariantNumeric: 'tabular-nums' }}>{order}.</span>}
        {node.title}
      </div>
      {node.tags.length > 0 && <div style={{ fontSize: 11, opacity: 0.6 }}>{node.tags.join(', ')}</div>}
    </button>
  );
}

const STATUS_ORDER: ResearchStatus[] = ['pending', 'failed', 'succeeded', 'abandoned', 'approved', 'draft', 'deprecated', 'archived'];

export function NodeList({ nodes, selectedId, onSelect, filterType, definitionPath = 'research/definitions' }: Props) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ResearchStatus | 'all'>('all');
  useEffect(() => { setStatusFilter('all'); }, [filterType]);
  const isLibrary = filterType === 'library';

  const filtered = nodes.filter((n) => {
    const isDefinition = n.filePath.startsWith(`${definitionPath}/`);
    // Library results have their own view so they do not crowd the project's assets and definitions.
    if (isLibrary !== (n.origin === 'library')) return false;
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
      {/* List */}
      <div style={{ flex: 1, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sorted.length === 0 && (
          <div style={{ padding: '24px 16px', opacity: 0.5, fontSize: 13, textAlign: 'center' }}>
            No nodes found.
          </div>
        )}
        {sorted.map((node) => (
          <NodeListItem
            key={node.id}
            node={node}
            selected={selectedId === node.id}
            onSelect={onSelect}
            order={filterType === 'asset' || filterType === 'definition' ? node.order : undefined}
            meta={isLibrary ? `${node.collection} · ${node.id}` : undefined}
          />
        ))}
      </div>
    </div>
  );
}
