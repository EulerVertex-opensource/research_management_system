import React, { useState } from 'react';
import type { AttentionButton, AttentionItem, AttentionPriority, GraphAction, HistoryEntry } from '../../src/models/graph';
import { CHAT_BUTTON_HINT, URGENCY_HINT, URGENCY_LABEL } from '../../src/domain/copy';
import { CITED_COLOR, COLOR, TONE_COLOR } from './colors';

const GROUP_COLOR: Record<AttentionPriority, string> = { 0: COLOR.error, 1: COLOR.waiting, 2: COLOR.link, 3: CITED_COLOR, 4: COLOR.muted };

export function buttonStyle(kind: AttentionButton['kind']): React.CSSProperties {
  const primary = kind === 'primary';
  return {
    padding: '3px 10px', fontSize: 12, borderRadius: 3, cursor: 'pointer', border: primary ? '1px solid transparent' : '1px solid var(--vscode-panel-border)',
    background: primary ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)',
    color: primary ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)',
  };
}

function withText(action: GraphAction, text: string): GraphAction {
  if (action.action === 'answer' || action.action === 'requestChanges') return { ...action, text };
  return action;
}

/** "10:42" today, "Oct 9" otherwise. */
export function when(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** A row of action buttons; a button that needs text opens an input below it. */
export function ActionRow({ buttons, onAction, onNavigate, extra, large }: { buttons: AttentionButton[]; onAction: (action: GraphAction) => void; onNavigate: (id: string) => void; extra?: React.ReactNode; large?: boolean }) {
  // Large rows (the status card) stack their buttons so each label stays on one line.
  const [asking, setAsking] = useState<AttentionButton | undefined>();
  const [text, setText] = useState('');
  const send = () => { if (asking && text.trim()) { onAction(withText(asking.action, text)); setAsking(undefined); } };
  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: large ? 'stretch' : 'center', flexDirection: large ? 'column' : 'row' }}>
        {buttons.map((button) => (
          <button key={button.label} style={{ ...buttonStyle(button.kind), ...(large ? { padding: '5px 12px', fontSize: 13 } : {}) }} title={button.action.action === 'agent' ? CHAT_BUTTON_HINT : undefined}
            onClick={() => {
              if (button.needsText) { setAsking(button); setText(''); }
              else if (button.action.action === 'openNode') onNavigate(button.action.id);
              else onAction(button.action);
            }}>
            {button.action.action === 'agent' ? `${button.label} ↗` : button.label}
          </button>
        ))}
        {extra}
      </div>
      {asking && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
          <input autoFocus value={text} placeholder={asking.needsText} aria-label={asking.needsText} onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') send(); if (event.key === 'Escape') setAsking(undefined); }}
            style={{ flex: 1, padding: '3px 6px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))' }} />
          <button style={buttonStyle('primary')} disabled={!text.trim()} onClick={send}>Send</button>
          <button style={buttonStyle('secondary')} onClick={() => setAsking(undefined)}>Cancel</button>
        </div>
      )}
    </>
  );
}

const linkButton: React.CSSProperties = { padding: '3px 4px', border: 'none', background: 'transparent', color: COLOR.link, fontSize: 12, cursor: 'pointer' };

interface Props {
  items: AttentionItem[];
  onAction: (action: GraphAction) => void;
  /** Point at a node on the graph. */
  onShow: (id: string) => void;
  onSection: (id: string) => void;
  /** Show a node in the dashboard's own detail view (preview and metadata) rather than a text editor. */
  onNavigate: (id: string) => void;
}

function Item({ item, onAction, onShow, onSection, onNavigate }: { item: AttentionItem } & Omit<Props, 'items'>) {
  return (
    <article style={{ border: `1px solid ${COLOR.border}`, padding: '9px 12px', borderRadius: 6, background: 'var(--vscode-editorWidget-background, transparent)', display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{item.title}</span>
        {item.since && <span style={{ fontSize: 11, color: COLOR.muted, whiteSpace: 'nowrap' }}>{when(item.since)}</span>}
      </div>
      {item.reason && <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', color: COLOR.muted }}>{item.reason}</div>}
      {item.why && <div style={{ fontSize: 12 }}><span style={{ color: COLOR.muted }}>Why it matters: </span>{item.why}</div>}
      {item.ifIgnored && <div style={{ fontSize: 12 }}><span style={{ color: COLOR.muted }}>If you do nothing: </span>{item.ifIgnored}</div>}
      <div style={{ marginTop: 3 }}>
        <ActionRow buttons={item.buttons} onAction={onAction} onNavigate={onNavigate} extra={<>
          {item.target && <button style={linkButton} onClick={() => onShow(item.target!)}>Show on graph</button>}
          {!item.target && item.sections.length > 0 && <button style={linkButton} onClick={() => onSection(item.sections[0])}>Show in paper coverage</button>}
        </>} />
      </div>
    </article>
  );
}

/** The Needs you list, in urgency groups. */
export function AttentionList({ items, onAction, onShow, onSection, onNavigate }: Props) {
  if (!items.length) return <div style={{ padding: '8px 0', opacity: 0.7, fontSize: 13 }}>Nothing needs you right now.</div>;
  const groups = ([0, 1, 2, 3, 4] as AttentionPriority[]).map((priority) => ({ priority, entries: items.filter((item) => item.priority === priority) })).filter((group) => group.entries.length);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {groups.map(({ priority, entries }) => (
        <section key={priority} style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label={URGENCY_LABEL[priority]}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: COLOR.muted }} title={URGENCY_HINT[priority]}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: GROUP_COLOR[priority] }} />{URGENCY_LABEL[priority]}
          </div>
          {entries.map((item) => <Item key={item.key} item={item} onAction={onAction} onShow={onShow} onSection={onSection} onNavigate={onNavigate} />)}
        </section>
      ))}
    </div>
  );
}

/** The "What happened" timeline, newest first. */
export function HistoryList({ entries, onShow }: { entries: HistoryEntry[]; onShow: (id: string) => void }) {
  if (!entries.length) return <div style={{ fontSize: 12, color: COLOR.muted }}>Nothing has happened in this run yet.</div>;
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
      {entries.map((entry, index) => (
        <li key={`${entry.at}:${index}`} style={{ display: 'grid', gridTemplateColumns: '64px 8px minmax(0, 1fr)', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
          <span style={{ color: COLOR.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{when(entry.at)}</span>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: entry.tone === 'neutral' ? COLOR.border : TONE_COLOR[entry.tone] }} />
          <span>
            {entry.text}
            {entry.target && <button style={{ ...linkButton, padding: '0 4px', fontSize: 11 }} onClick={() => onShow(entry.target!)}>show</button>}
          </span>
        </li>
      ))}
    </ol>
  );
}
