import React from 'react';

export type SidebarView = 'project' | 'graph' | 'papers' | 'assets' | 'definitions' | 'library' | 'ideas' | 'plans' | 'manuscript' | 'settings';

const ITEMS: { id: SidebarView; label: string }[] = [
  { id: 'project', label: 'Project' },
  { id: 'graph', label: 'Graph' },
  { id: 'papers', label: 'Papers' },
  { id: 'assets', label: 'Assets' },
  { id: 'definitions', label: 'Definitions' },
  { id: 'library', label: 'Library' },
  { id: 'ideas', label: 'Ideas' },
  { id: 'plans', label: 'Plans' },
  { id: 'manuscript', label: 'Manuscript' },
];

interface Props {
  active: SidebarView;
  onChange: (view: SidebarView) => void;
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

export function Sidebar({ active, onChange }: Props) {
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
      <div style={{ padding: '8px 12px 12px', fontWeight: 700, fontSize: 11, opacity: 0.5, letterSpacing: 1, textTransform: 'uppercase' }}>
        Research
      </div>
      {ITEMS.map((item) => (
        <button key={item.id} onClick={() => onChange(item.id)} style={itemStyle(active === item.id)}>
          {item.label}
        </button>
      ))}
      <div style={{ marginTop: 'auto', borderTop: '1px solid var(--vscode-panel-border)', paddingTop: 4 }}>
        <button onClick={() => onChange('settings')} style={itemStyle(active === 'settings')}>⚙ Settings</button>
      </div>
    </nav>
  );
}
