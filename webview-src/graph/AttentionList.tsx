import React, { useState } from 'react';
import type { AttentionButton, AttentionItem, GraphAction } from '../../src/models/graph';
import { COLOR } from './colors';

interface Props {
  items: AttentionItem[];
  onAction: (action: GraphAction) => void;
  onFocus: (id: string) => void;
  onSection: (id: string) => void;
}

const PRIORITY: Record<number, { label: string; hint: string; color: string }> = {
  0: { label: 'P0', hint: 'Blocking: the loop or the manuscript is wrong or waits on you', color: COLOR.error },
  1: { label: 'P1', hint: 'Reviews that block a required result', color: COLOR.waiting },
  2: { label: 'P2', hint: 'Stuck research, uncovered results, stale sections', color: COLOR.link },
  3: { label: 'P3', hint: 'Off the critical path', color: COLOR.muted },
};

export function buttonStyle(kind: AttentionButton['kind']): React.CSSProperties {
  const primary = kind === 'primary';
  return {
    padding: '3px 10px', fontSize: 12, borderRadius: 3, cursor: 'pointer', border: primary ? 'none' : '1px solid var(--vscode-panel-border)',
    background: primary ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)',
    color: primary ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)',
  };
}

function withText(action: GraphAction, text: string): GraphAction {
  if (action.action === 'answer' || action.action === 'requestChanges') return { ...action, text };
  return action;
}

function Item({ item, onAction, onFocus, onSection }: { item: AttentionItem } & Omit<Props, 'items'>) {
  const [asking, setAsking] = useState<AttentionButton | undefined>();
  const [text, setText] = useState('');
  const priority = PRIORITY[item.priority];
  return (
    <div style={{ borderLeft: `3px solid ${priority.color}`, padding: '8px 12px', marginBottom: 8, background: 'var(--vscode-editorWidget-background, transparent)', borderRadius: 3 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: priority.color }} title={priority.hint}>{priority.label}</span>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{item.title}</span>
        {item.since && <span style={{ fontSize: 11, color: COLOR.muted, marginLeft: 'auto' }}>{new Date(item.since).toLocaleString()}</span>}
      </div>
      {item.reason && <div style={{ fontSize: 12, marginTop: 4, whiteSpace: 'pre-wrap', opacity: 0.9 }}>{item.reason}</div>}
      <div style={{ fontSize: 11, color: COLOR.muted, marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {item.blocks.length > 0 && <span>Blocks: {item.blocks.map((id) => <a key={id} href="#" onClick={(event) => { event.preventDefault(); onFocus(id); }} style={{ color: COLOR.link, marginRight: 6 }}>{id}</a>)}</span>}
        {item.sections.length > 0 && <span>Sections: {item.sections.map((id) => <a key={id} href="#" onClick={(event) => { event.preventDefault(); onSection(id); }} style={{ color: COLOR.link, marginRight: 6 }}>{id}</a>)}</span>}
        {item.target && <a href="#" onClick={(event) => { event.preventDefault(); onFocus(item.target!); }} style={{ color: COLOR.link }}>Show impact</a>}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {item.buttons.map((button) => (
          <button key={button.label} style={buttonStyle(button.kind)} title={button.action.action === 'agent' ? 'Copies an instruction and opens the agent chat; paste it there.' : undefined}
            onClick={() => { if (button.needsText) { setAsking(button); setText(''); } else onAction(button.action); }}>
            {button.action.action === 'agent' ? `${button.label} ↗` : button.label}
          </button>
        ))}
      </div>
      {asking && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
          <input autoFocus value={text} placeholder={asking.needsText} onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && text.trim()) { onAction(withText(asking.action, text)); setAsking(undefined); } if (event.key === 'Escape') setAsking(undefined); }}
            style={{ flex: 1, padding: '3px 6px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))' }} />
          <button style={buttonStyle('primary')} disabled={!text.trim()} onClick={() => { onAction(withText(asking.action, text)); setAsking(undefined); }}>Send</button>
          <button style={buttonStyle('secondary')} onClick={() => setAsking(undefined)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

export function AttentionList({ items, onAction, onFocus, onSection }: Props) {
  if (!items.length) return <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>Nothing needs you right now. The loop and the manuscript are up to date with the research.</div>;
  return (
    <div style={{ padding: 12, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ fontSize: 11, color: COLOR.muted, marginBottom: 10 }}>
        Your decisions are recorded here directly. Buttons marked ↗ copy an instruction for the agent and open its chat.
      </div>
      {items.map((item) => <Item key={item.key} item={item} onAction={onAction} onFocus={onFocus} onSection={onSection} />)}
    </div>
  );
}
