import React, { useState } from 'react';
import type { GraphAction, GraphPayload } from '../../src/models/graph';
import { AttentionList } from './AttentionList';
import { ProgressView } from './ProgressView';
import { CoverageMatrix } from './CoverageMatrix';
import { ImpactView } from './ImpactView';
import { DEFAULT_OPTIONS, ViewOptions } from './graphModel';
import { COLOR, SECTION_STATE_COLOR } from './colors';

export type GraphSubview = 'attention' | 'progress' | 'coverage' | 'impact';

interface Props {
  payload: GraphPayload | null;
  onAction: (action: GraphAction) => void;
  onNavigate: (id: string) => void;
}

const SUBVIEWS: { id: GraphSubview; label: string; hint: string }[] = [
  { id: 'attention', label: 'Attention', hint: 'What needs your decision, most urgent first' },
  { id: 'progress', label: 'Progress', hint: 'Dependency graph of the required results' },
  { id: 'coverage', label: 'Coverage', hint: 'Which results each manuscript section presents, and whether it is current' },
  { id: 'impact', label: 'Impact', hint: 'What a change to one node touches' },
];

/** The Graph tab: one derived graph, four views. Graph explains, the queue acts, the matrix shows coverage. */
export function GraphTab({ payload, onAction, onNavigate }: Props) {
  const [subview, setSubview] = useState<GraphSubview>('attention');
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [options, setOptions] = useState<ViewOptions>(DEFAULT_OPTIONS);
  const [highlightSection, setHighlightSection] = useState<string | undefined>();

  if (!payload) return <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>Loading the research graph…</div>;

  const showImpact = (id: string) => { setSelectedId(id); setSubview('impact'); };
  const showSection = (id: string) => { setHighlightSection(id); setSubview('coverage'); };
  const urgent = payload.attention.filter((item) => item.priority <= 1).length;
  const research = payload.loop ? `${payload.loop.status === 'running' ? payload.loop.stage : payload.loop.status}${payload.loop.assetId ? ` · ${payload.loop.assetId}` : ''}` : 'loop not started';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '8px 12px', borderBottom: `1px solid ${COLOR.border}`, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', border: `1px solid ${COLOR.border}`, borderRadius: 4, overflow: 'hidden' }} role="tablist">
          {SUBVIEWS.map((item) => (
            <button key={item.id} role="tab" aria-selected={subview === item.id} title={item.hint} onClick={() => setSubview(item.id)}
              style={{ padding: '4px 12px', fontSize: 12, border: 'none', cursor: 'pointer',
                background: subview === item.id ? 'var(--vscode-button-background)' : 'transparent',
                color: subview === item.id ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)' }}>
              {item.label}{item.id === 'attention' && payload.attention.length ? ` (${payload.attention.length})` : ''}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 12 }}><span style={{ color: COLOR.muted }}>Research:</span> {research}{payload.projectApproved ? '' : ' · project.md not approved'}</span>
        <span style={{ fontSize: 12 }}>
          <span style={{ color: COLOR.muted }}>Manuscript:</span>{' '}
          <span style={{ color: SECTION_STATE_COLOR[payload.manuscriptState ?? ''] ?? COLOR.muted }}>{payload.manuscriptState ?? 'no outline'}</span>
          {payload.projectRevision ? <span style={{ color: COLOR.muted }}> · project rev {payload.projectRevision}</span> : null}
        </span>
        {urgent > 0 && subview !== 'attention' && (
          <a href="#" onClick={(event) => { event.preventDefault(); setSubview('attention'); }} style={{ fontSize: 12, color: COLOR.error, marginLeft: 'auto' }}>{urgent} urgent item{urgent > 1 ? 's' : ''}</a>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {subview === 'attention' && <AttentionList items={payload.attention} onAction={onAction} onFocus={showImpact} onSection={showSection} />}
        {subview === 'progress' && (
          <ProgressView payload={payload} options={options} onOptions={setOptions} selectedId={selectedId} onSelect={setSelectedId}
            onImpact={showImpact} onNavigate={onNavigate} onAction={onAction} />
        )}
        {subview === 'coverage' && <CoverageMatrix payload={payload} highlightSection={highlightSection} onFocus={showImpact} onAction={onAction} />}
        {subview === 'impact' && <ImpactView payload={payload} selectedId={selectedId} onSelect={setSelectedId} onNavigate={onNavigate} onAction={onAction} />}
      </div>
    </div>
  );
}
