import React, { useState } from 'react';
import type { GraphAction, GraphPayload } from '../../src/models/graph';
import { AttentionList, HistoryList } from './AttentionList';
import { ProgressView } from './ProgressView';
import { CoverageMatrix } from './CoverageMatrix';
import { ImpactView } from './ImpactView';
import { StatusCard } from './StatusCard';
import { DEFAULT_OPTIONS, ViewOptions } from './graphModel';
import { COLOR, SECTION_STATE_COLOR, SECTION_STATE_LABEL } from './colors';

export type GraphSubview = 'overview' | 'coverage' | 'impact';

interface Props {
  payload: GraphPayload | null;
  onAction: (action: GraphAction) => void;
  onNavigate: (id: string) => void;
  onOpenSettings?: () => void;
}

const SUBVIEWS: { id: GraphSubview; label: string; hint: string }[] = [
  { id: 'overview', label: 'Research', hint: 'What the main results rest on, and what needs you' },
  { id: 'coverage', label: 'Paper coverage', hint: 'Which results each section of the paper presents, and whether it is up to date' },
  { id: 'impact', label: 'What depends on this?', hint: 'What a change to one result touches, in the research and in the paper' },
];

/**
 * The Overview tab: the loop's status on top, then the research graph next to
 * the Needs you list and the timeline. Paper coverage and change impact are
 * secondary views of the same payload.
 */
export function GraphTab({ payload, onAction, onNavigate, onOpenSettings }: Props) {
  const [subview, setSubview] = useState<GraphSubview>('overview');
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [options, setOptions] = useState<ViewOptions>(DEFAULT_OPTIONS);
  const [highlightSection, setHighlightSection] = useState<string | undefined>();

  if (!payload) return <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>Loading the research overview…</div>;

  /** "Show on graph": the graph view, with the result's card open. */
  const show = (id: string) => { setSelectedId(id); setOptions((current) => ({ ...current, display: 'graph' })); setSubview('overview'); };
  const showImpact = (id: string) => { setSelectedId(id); setSubview('impact'); };
  const showSection = (id: string) => { setHighlightSection(id); setSubview('coverage'); };
  const paper = payload.manuscriptState;

  return (
    <div style={{ height: '100%', overflow: 'auto', boxSizing: 'border-box', padding: '12px 14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ flexShrink: 0 }}><StatusCard payload={payload} onAction={onAction} onNavigate={onNavigate} onShow={show} /></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', flexShrink: 0 }}>
        <div style={{ display: 'flex', border: `1px solid ${COLOR.border}`, borderRadius: 4, overflow: 'hidden' }} role="tablist">
          {SUBVIEWS.map((item) => (
            <button key={item.id} role="tab" aria-selected={subview === item.id} title={item.hint} onClick={() => setSubview(item.id)}
              style={{ padding: '4px 12px', fontSize: 12, border: 'none', cursor: 'pointer',
                background: subview === item.id ? 'var(--vscode-button-background)' : 'transparent',
                color: subview === item.id ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)' }}>
              {item.label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 12 }}>
          <span style={{ color: COLOR.muted }}>Paper:</span>{' '}
          <span style={{ color: SECTION_STATE_COLOR[paper ?? ''] ?? COLOR.muted }}>{paper ? SECTION_STATE_LABEL[paper] ?? paper : 'no outline yet'}</span>
        </span>
        {!payload.projectApproved && <span style={{ fontSize: 12, color: COLOR.waiting }}>Goals not accepted yet</span>}
        {payload.autoMode && (
          <button onClick={onOpenSettings} title="Auto mode is on: some results are accepted without asking you. Open Settings."
            style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, padding: '1px 6px', borderRadius: 3, cursor: 'pointer', border: `1px solid ${COLOR.waiting}`, color: COLOR.waiting, background: 'transparent' }}>AUTO MODE</button>
        )}
      </div>
      {subview === 'overview' && (
        // Fills the rest of the panel: the results on the left reach the bottom, and the right column scrolls inside its own boxes.
        // One line on purpose: a wrapping row sizes itself to its tallest content, which would defeat the inner scrolling.
        <div style={{ flex: '1 1 0', minHeight: 560, display: 'flex', gap: 14, alignItems: 'stretch' }}>
          <section aria-label="Research graph" style={{ flex: '1 1 0', minWidth: 0, border: `1px solid ${COLOR.border}`, borderRadius: 8, overflow: 'hidden' }}>
            <ProgressView payload={payload} options={options} onOptions={setOptions} selectedId={selectedId} onSelect={setSelectedId}
              onImpact={showImpact} onNavigate={onNavigate} onAction={onAction} />
          </section>
          <aside style={{ flex: '0 1 360px', minWidth: 260, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <section aria-label="Needs you" style={{ flex: '1 1 0', minHeight: 180, display: 'flex', flexDirection: 'column', border: `1px solid ${COLOR.border}`, borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '9px 12px 8px', borderBottom: `1px solid ${COLOR.border}`, flexShrink: 0 }}>
                <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  Needs you {payload.attention.length > 0 && <span style={{ fontSize: 11, padding: '0 7px', borderRadius: 9, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)' }}>{payload.attention.length}</span>}
                </h3>
                <div style={{ fontSize: 11, color: COLOR.muted, marginTop: 3 }}>Your decisions are recorded here directly. Buttons marked ↗ copy an instruction and open the agent chat.</div>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px' }}>
                <AttentionList items={payload.attention} onAction={onAction} onShow={show} onSection={showSection} onNavigate={onNavigate} />
              </div>
            </section>
            <section aria-label="What happened" style={{ flex: '0 1 auto', maxHeight: '38%', minHeight: 90, display: 'flex', flexDirection: 'column', border: `1px solid ${COLOR.border}`, borderRadius: 8, overflow: 'hidden' }}>
              <h3 style={{ margin: 0, padding: '9px 12px 8px', fontSize: 13, fontWeight: 600, borderBottom: `1px solid ${COLOR.border}`, flexShrink: 0 }}>What happened</h3>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px' }}>
                <HistoryList entries={payload.history} onShow={show} />
              </div>
            </section>
          </aside>
        </div>
      )}
      {subview === 'coverage' && <div style={{ minHeight: 400 }}><CoverageMatrix payload={payload} highlightSection={highlightSection} onFocus={showImpact} onAction={onAction} /></div>}
      {subview === 'impact' && <div style={{ flex: '1 1 0', minHeight: 520, border: `1px solid ${COLOR.border}`, borderRadius: 8, overflow: 'hidden' }}><ImpactView payload={payload} selectedId={selectedId} onSelect={setSelectedId} onNavigate={onNavigate} onAction={onAction} /></div>}
    </div>
  );
}
