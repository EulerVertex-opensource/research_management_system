import React, { useState } from 'react';
import type { AttentionButton, AttentionPriority, GraphAction, HistoryEntry } from '../../src/models/graph';
import { CHAT_BUTTON_HINT } from '../../src/domain/copy';
import { CITED_COLOR, COLOR, TONE_COLOR } from './colors';
import { UsageCard, UsageState } from './UsageCard';

export const GROUP_COLOR: Record<AttentionPriority, string> = { 0: COLOR.error, 1: COLOR.waiting, 2: COLOR.link, 3: CITED_COLOR, 4: COLOR.muted };

export function buttonStyle(kind: AttentionButton['kind']): React.CSSProperties {
  const primary = kind === 'primary';
  return {
    padding: '3px 10px', fontSize: 12, borderRadius: 4, cursor: 'pointer', border: primary ? '1px solid transparent' : `1px solid ${COLOR.border}`,
    background: primary ? COLOR.solid : COLOR.card,
    color: primary ? '#ffffff' : 'var(--vscode-foreground)',
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
          <button key={button.label} style={{ ...buttonStyle(button.kind), ...(large ? { padding: '5px 12px', fontSize: 13 } : {}) }} title={button.hint ?? (button.action.action === 'agent' ? CHAT_BUTTON_HINT : undefined)}
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

/** The activity timeline, newest first. */
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

/** The Activity tab: where the tokens went, then what the agent and the researcher did, newest first. */
export function ActivityPage({ entries, onShow, usage, usageSpan, onUsageSpan }: { entries: HistoryEntry[] | undefined; onShow: (id: string) => void; usage?: UsageState; usageSpan?: string; onUsageSpan: (span: string) => void }) {
  return (
    <div style={{ height: '100%', overflow: 'auto', boxSizing: 'border-box', padding: '16px 18px 24px', background: COLOR.canvas }}>
      <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Activity</h2>
        <UsageCard usage={usage} span={usageSpan} onSpan={onUsageSpan} onShow={onShow} />
        <section style={{ border: `1px solid ${COLOR.border}`, borderRadius: 8, background: COLOR.card, padding: '12px 16px' }}>
          {entries ? <HistoryList entries={entries} onShow={onShow} /> : <div style={{ fontSize: 13, opacity: 0.6 }}>Loading…</div>}
        </section>
      </div>
    </div>
  );
}
