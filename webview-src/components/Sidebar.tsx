import React from 'react';
import type { SyncBadge } from '../../src/models/sync';

export type SidebarView = 'project' | 'graph' | 'needs' | 'results' | 'team' | 'activity' | 'papers' | 'assets' | 'definitions' | 'library' | 'ideas' | 'remarks' | 'plans' | 'manuscript' | 'settings';

// 'graph' is the Overview tab; the id is kept for saved state and the extension's "show the Overview" message.
const GROUPS: { title: string; items: { id: SidebarView; label: string }[] }[] = [
  { title: 'Work', items: [{ id: 'graph', label: 'Overview' }, { id: 'needs', label: 'Needs you' }, { id: 'results', label: 'Results' }, { id: 'team', label: 'Team' }, { id: 'activity', label: 'Activity' }] },
  { title: 'Research', items: [{ id: 'definitions', label: 'Definitions' }, { id: 'library', label: 'Library' }, { id: 'assets', label: 'Assets' }, { id: 'ideas', label: 'Ideas' }, { id: 'remarks', label: 'Remarks' }, { id: 'plans', label: 'Plans' }] },
  { title: 'Writing', items: [{ id: 'papers', label: 'Papers' }, { id: 'manuscript', label: 'Manuscript' }] },
];

interface Props {
  active: SidebarView;
  onChange: (view: SidebarView) => void;
  refreshing: boolean;
  onRefresh: () => void;
  sync: SyncBadge | null;
  onSync: () => void;
  /** The number on Needs you. */
  needsCount?: number;
  /** Problems in the research files; a click shows them. */
  problems?: number;
  onProblems?: () => void;
}

function itemStyle(selected: boolean): React.CSSProperties {
  return {
    display: 'block',
    padding: '7px 14px',
    border: 'none',
    background: selected ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
    color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: 13,
    width: '100%',
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One line under the Sync button, in words a non-git user understands. */
function syncSubtitle(sync: SyncBadge | null): string {
  if (!sync) return 'Checking…';
  if (sync.busy) return 'Syncing…';
  if (!sync.available) return 'Not set up';
  if (sync.conflict) return 'Conflict: needs resolving';
  const parts: string[] = [];
  if (sync.changed) parts.push(`${plural(sync.changed, 'change')} to share`);
  else if (sync.ahead) parts.push(`${plural(sync.ahead, 'commit')} to share`);
  if (sync.behind) parts.push(`${plural(sync.behind, 'update')} to pull`);
  return parts.length ? parts.join(' · ') : 'Up to date';
}

function syncTitle(sync: SyncBadge | null): string {
  if (!sync) return 'Sync with collaborators';
  if (!sync.available) return sync.reason ?? 'Git sync is not set up for this project.';
  return `Pull collaborators' changes and share yours with ${sync.remote}/${sync.branch}. You confirm before anything is pushed.`;
}

export function Sidebar({ active, onChange, refreshing, onRefresh, sync, onSync, needsCount = 0, problems = 0, onProblems }: Props) {
  const syncDisabled = !sync || sync.busy || !sync.available;
  const pending = !!sync?.available && !sync.busy && (sync.conflict || sync.changed > 0 || sync.ahead > 0 || sync.behind > 0);
  return (
    <nav
      style={{
        width: 160,
        flexShrink: 0,
        borderRight: '1px solid var(--vscode-panel-border)',
        display: 'flex',
        flexDirection: 'column',
        padding: '8px 0',
        background: 'var(--vscode-sideBar-background)',
      }}
    >
      {GROUPS.map((group) => (
        <div key={group.title} style={{ marginBottom: 10 }}>
          <div style={{ padding: '6px 14px 4px', fontWeight: 700, fontSize: 11, opacity: 0.5, letterSpacing: 1, textTransform: 'uppercase' }}>
            {group.title}
          </div>
          {group.items.map((item) => (
            <button key={item.id} onClick={() => onChange(item.id)} style={{ ...itemStyle(active === item.id), display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>{item.label}</span>
              {item.id === 'needs' && needsCount > 0 && (
                <span style={{ marginLeft: 'auto', fontSize: 11, padding: '0 7px', borderRadius: 9, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)' }}>{needsCount}</span>
              )}
            </button>
          ))}
        </div>
      ))}
      <div style={{ marginTop: 'auto', borderTop: '1px solid var(--vscode-panel-border)', paddingTop: 4 }}>
        {problems > 0 && (
          <button onClick={onProblems} title="Something in the research files does not fit together. Click to see what." style={{ ...itemStyle(false), fontSize: 12, color: 'var(--vscode-editorWarning-foreground)' }}>
            ⚠ {problems === 1 ? '1 file problem' : `${problems} file problems`}
          </button>
        )}
        <button onClick={() => onChange('project')} style={itemStyle(active === 'project')}>Project goals</button>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          title="Reload research files from disk (e.g. after the agent wrote new assets)"
          style={{ ...itemStyle(false), cursor: refreshing ? 'default' : 'pointer', opacity: refreshing ? 0.6 : 1 }}
        >
          {refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}
        </button>
        <button
          onClick={onSync}
          disabled={syncDisabled}
          title={syncTitle(sync)}
          style={{ ...itemStyle(false), cursor: syncDisabled ? 'default' : 'pointer', opacity: sync && !sync.available ? 0.6 : 1 }}
        >
          <span style={{ display: 'block' }}>⇅ Sync</span>
          <span style={{ display: 'block', fontSize: 11, marginTop: 2, opacity: pending ? 1 : 0.65, color: sync?.conflict ? 'var(--vscode-errorForeground)' : pending ? 'var(--vscode-textLink-foreground)' : undefined }}>
            {syncSubtitle(sync)}
          </span>
        </button>
        <button onClick={() => onChange('settings')} style={itemStyle(active === 'settings')}>⚙ Settings</button>
      </div>
    </nav>
  );
}
