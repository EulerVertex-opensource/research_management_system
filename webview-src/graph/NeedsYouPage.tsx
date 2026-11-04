import React from 'react';
import type { AttentionItem, AttentionPriority, GraphAction, GraphNodeView, GraphPayload } from '../../src/models/graph';
import { isPrerequisiteEdge } from '../../src/models/graph';
import { URGENCY_HINT, URGENCY_LABEL, kindLabel, plural } from '../../src/domain/copy';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { ActionRow, GROUP_COLOR, when } from './AttentionList';
import { waitingItems } from './graphModel';
import { COLOR, nodeStyle, tint } from './colors';
import { useTechnical } from '../technical';

/**
 * Needs you: everything that waits for the researcher, in urgency groups on
 * the left; the chosen item in full on the right, with the result it is about.
 */

interface Props {
  payload: GraphPayload | null;
  selectedKey?: string;
  onSelect: (key: string) => void;
  onAction: (action: GraphAction) => void;
  onNavigate: (id: string) => void;
  onShowInResults: (id: string) => void;
  onOpenPaper: (section?: string) => void;
}

const link: React.CSSProperties = { padding: 0, border: 'none', background: 'transparent', color: COLOR.link, fontSize: 12, cursor: 'pointer' };
const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: COLOR.muted, marginBottom: 3 };

function Row({ item, selected, onSelect }: { item: AttentionItem; selected: boolean; onSelect: () => void }) {
  return (
    <button onClick={onSelect} aria-current={selected || undefined}
      style={{ width: '100%', textAlign: 'left', padding: '7px 10px', borderRadius: 6, border: `1px solid ${selected ? COLOR.active : COLOR.border}`, boxShadow: selected ? `0 0 0 1px ${COLOR.active}` : undefined, cursor: 'pointer', fontSize: 13,
        background: selected ? tint(GROUP_COLOR[item.priority], 10) : COLOR.card, color: 'var(--vscode-foreground)',
        display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.title}</span>
      <span style={{ fontSize: 11, opacity: 0.7 }}>
        {[item.blocks.length ? `Holds up ${plural(item.blocks.length, 'main result')}` : '', when(item.since)].filter(Boolean).join(' · ')}
      </span>
    </button>
  );
}

function Detail({ item, node, payload, onAction, onNavigate, onShowInResults, onOpenPaper }: { item: AttentionItem; node?: GraphNodeView } & Omit<Props, 'selectedKey' | 'onSelect'> & { payload: GraphPayload }) {
  const technical = useTechnical();
  const byId = new Map(payload.nodes.map((entry) => [entry.id, entry]));
  const mains = item.blocks.map((id) => byId.get(id)?.title ?? id);
  const prerequisites = node ? payload.edges.filter((edge) => edge.from === node.id && isPrerequisiteEdge(edge)).map((edge) => byId.get(edge.to)).filter((entry): entry is GraphNodeView => Boolean(entry)) : [];
  return (
    <article style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 820, padding: '14px 16px', borderRadius: 8, border: `1px solid ${tint(GROUP_COLOR[item.priority], 60)}`, background: tint(GROUP_COLOR[item.priority], 7) }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 11, color: COLOR.muted }}>{URGENCY_LABEL[item.priority]}{item.since && when(item.since) ? ` · since ${when(item.since)}` : ''}</div>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.35 }}>{item.title}</h2>
      </header>
      {item.reason && <section><div style={label}>What is going on</div><div className="compact-md"><MarkdownPreview content={item.reason} style={{ fontSize: 13, lineHeight: 1.6 }} /></div></section>}
      {item.why && <section><div style={label}>Why it matters</div><div style={{ fontSize: 13 }}>{item.why}</div></section>}
      {item.ifIgnored && <section><div style={label}>If you do nothing</div><div style={{ fontSize: 13 }}>{item.ifIgnored}</div></section>}
      <div>
        <ActionRow buttons={item.buttons.filter((button) => button.action.action !== 'openNode')} onAction={onAction} onNavigate={onNavigate} />
        <div style={{ display: 'flex', gap: 14, marginTop: 8 }}>
          {item.target && <button style={link} onClick={() => onNavigate(item.target!)}>Open</button>}
          {item.target && <button style={link} onClick={() => onShowInResults(item.target!)}>Show in Results</button>}
          {item.sections.length > 0 && <button style={link} onClick={() => onOpenPaper(item.sections[0])}>Show in the paper</button>}
        </div>
      </div>
      {node && (
        <section style={{ padding: '10px 12px', borderRadius: 6, border: `1px ${nodeStyle(node).dashed ? 'dashed' : 'solid'} ${tint(nodeStyle(node).color, 55)}`, background: tint(nodeStyle(node).color, 8), display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={label}>{kindLabel(node.type)} · {node.progressLabel}</div>
          {technical && <div style={{ fontSize: 11, color: COLOR.muted, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>{node.id} · {node.filePath}</div>}
          {node.statement
            ? <MarkdownPreview content={node.statement} style={{ fontSize: 13, maxHeight: 360, overflow: 'auto' }} />
            : <div style={{ fontSize: 13, color: COLOR.muted }}>No statement written yet.</div>}
          <div style={{ fontSize: 12, color: COLOR.muted, display: 'flex', flexWrap: 'wrap', gap: '2px 16px' }}>
            {prerequisites.length > 0 && <span>Prerequisites: {prerequisites.filter((entry) => entry.progress === 'done').length} of {prerequisites.length} done</span>}
            {node.counts.plans > 0 && <span>Proof attempts: {node.counts.plans}, {node.counts.failedPlans} failed</span>}
          </div>
          {mains.length > 0 && (
            <details style={{ fontSize: 12 }}>
              <summary style={{ cursor: 'pointer', color: COLOR.muted }}>Holds up {mains.length === 1 ? 'one main result' : plural(mains.length, 'main result')}</summary>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{mains.map((name, index) => <li key={`${name}:${index}`}>{name}</li>)}</ul>
            </details>
          )}
        </section>
      )}
    </article>
  );
}

export function NeedsYouPage({ payload, selectedKey, onSelect, onAction, onNavigate, onShowInResults, onOpenPaper }: Props) {
  if (!payload) return <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>Loading…</div>;
  const items = waitingItems(payload);
  if (!items.length) return <div style={{ padding: 24, fontSize: 13, opacity: 0.7 }}>Nothing waits for you right now.</div>;
  const selected = items.find((item) => item.key === selectedKey) ?? items[0];
  const node = selected.target ? payload.nodes.find((entry) => entry.id === selected.target) : undefined;
  const groups = ([0, 1, 2, 3, 4] as AttentionPriority[]).map((priority) => ({ priority, entries: items.filter((item) => item.priority === priority) })).filter((group) => group.entries.length);
  return (
    <div style={{ display: 'flex', height: '100%', background: COLOR.canvas }}>
      <nav aria-label="Waiting for you" style={{ width: 360, flexShrink: 0, borderRight: `1px solid ${COLOR.border}`, background: COLOR.sunken, overflow: 'auto', padding: '12px 10px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 style={{ margin: '0 4px', fontSize: 15, fontWeight: 600 }}>Needs you · {items.length}</h2>
        {groups.map(({ priority, entries }) => (
          <section key={priority} aria-label={URGENCY_LABEL[priority]} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 4px 4px', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: COLOR.muted }} title={URGENCY_HINT[priority]}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: GROUP_COLOR[priority] }} />{URGENCY_LABEL[priority]} · {entries.length}
            </div>
            {entries.map((item) => <Row key={item.key} item={item} selected={item.key === selected.key} onSelect={() => onSelect(item.key)} />)}
          </section>
        ))}
      </nav>
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '16px 20px', boxSizing: 'border-box' }}>
        <Detail key={selected.key} item={selected} node={node} payload={payload} onAction={onAction} onNavigate={onNavigate} onShowInResults={onShowInResults} onOpenPaper={onOpenPaper} />
      </div>
    </div>
  );
}
