import React, { useState } from 'react';
import { RemarkView } from '../../src/models/types';
import { COLOR } from '../graph/colors';

/** Which remarks the list shows; remarks have no status workflow beyond active and archived. */
export type RemarkFilter = 'active' | 'unchecked' | 'researcher' | 'agents' | 'approved' | 'stale' | 'archived' | 'all';
const FILTERS: Array<{ id: RemarkFilter; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'unchecked', label: 'To check' },
  { id: 'researcher', label: 'Yours' },
  { id: 'agents', label: "The loop's and agents'" },
  { id: 'approved', label: 'Approved for the paper' },
  { id: 'stale', label: 'For an earlier version' },
  { id: 'archived', label: 'Archived' },
  { id: 'all', label: 'All' },
];

function matches(remark: RemarkView, filter: RemarkFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'archived') return remark.status === 'archived';
  if (remark.status === 'archived') return false;
  if (filter === 'unchecked') return !remark.checked;
  if (filter === 'researcher') return remark.origin === 'researcher';
  if (filter === 'agents') return remark.origin === 'agent';
  if (filter === 'approved') return remark.approved;
  if (filter === 'stale') return remark.stale;
  return true;
}

/** Small outlined label, in the style of the status badges. */
export function RemarkBadge({ color, children, title }: { color: string; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} style={{ display: 'inline-block', padding: '0 6px', borderRadius: 10, fontSize: 10.5, fontWeight: 600, color, border: `1px solid ${color}`, textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

export function remarkBadges(remark: RemarkView): React.ReactNode {
  return (
    <>
      {remark.origin === 'researcher'
        ? <RemarkBadge color={COLOR.link} title="The researcher's remark">Yours</RemarkBadge>
        : remark.checked
          ? <RemarkBadge color={COLOR.approved} title="Written by an agent; you checked it as worded now">{remark.from === 'loop' ? 'Loop · checked' : 'Agent · checked'}</RemarkBadge>
          : <RemarkBadge color={COLOR.waiting} title="Written by an agent; you have not checked it yet (Mark as checked)">{remark.from === 'loop' ? 'Loop · unchecked' : 'Agent · unchecked'}</RemarkBadge>}
      {remark.approved && <RemarkBadge color={COLOR.approved} title="You approved this text for the paper">For the paper</RemarkBadge>}
      {remark.stale && remark.status === 'active' && <RemarkBadge color={COLOR.waiting} title="The result changed after this remark was written">Earlier version</RemarkBadge>}
      {remark.status === 'archived' && <RemarkBadge color={COLOR.inactive}>Archived</RemarkBadge>}
    </>
  );
}

interface Props {
  remarks: RemarkView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** The Remarks view's list: every remark, newest first, with the result each is on. */
export function RemarkList({ remarks, selectedId, onSelect }: Props) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<RemarkFilter>('active');
  const query = search.trim().toLowerCase();
  const shown = remarks
    .filter((remark) => matches(remark, filter))
    .filter((remark) => !query || [remark.title, remark.body, remark.targetTitle ?? '', remark.target, remark.anchor ?? ''].join(' ').toLowerCase().includes(query))
    .sort((a, b) => b.at.localeCompare(a.at));
  const control: React.CSSProperties = { padding: '4px 6px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: 4, fontSize: 12 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--vscode-panel-border)', display: 'flex', gap: 8 }}>
        <input placeholder="Search..." value={search} onChange={(event) => setSearch(event.target.value)} style={{ ...control, flex: 1, minWidth: 0, padding: '4px 8px' }} />
        <select value={filter} onChange={(event) => setFilter(event.target.value as RemarkFilter)} style={{ ...control, background: 'var(--vscode-dropdown-background)', color: 'var(--vscode-dropdown-foreground)', border: '1px solid var(--vscode-dropdown-border)' }}>
          {FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {shown.length === 0 && (
          <div style={{ padding: '24px 16px', opacity: 0.5, fontSize: 13, textAlign: 'center' }}>
            {remarks.length ? 'No remarks match.' : 'No remarks yet. They are written in the teaching chat, by the loop, or with + here.'}
          </div>
        )}
        {shown.map((remark) => {
          const selected = remark.id === selectedId;
          return (
            <button key={remark.id} onClick={() => onSelect(remark.id)} aria-current={selected}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', borderRadius: 6, cursor: 'pointer', flexShrink: 0,
                border: `1px solid ${selected ? 'var(--vscode-focusBorder)' : 'var(--vscode-panel-border)'}`,
                boxShadow: selected ? '0 0 0 1px var(--vscode-focusBorder)' : undefined,
                background: selected ? 'var(--vscode-list-activeSelectionBackground)' : 'var(--vscode-editorWidget-background, transparent)',
                color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
                opacity: remark.status === 'archived' ? 0.65 : 1,
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Remark</span>
                {remarkBadges(remark)}
              </div>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{remark.title}</div>
              <div style={{ fontSize: 11, opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                on {remark.targetTitle ?? remark.target}{remark.anchor ? ` · ${remark.anchor}` : ''}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
