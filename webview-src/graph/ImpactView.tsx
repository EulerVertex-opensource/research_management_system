import React, { useMemo } from 'react';
import type { GraphAction, GraphNodeView, GraphPayload } from '../../src/models/graph';
import { impactOf } from './graphModel';
import { GraphCanvas } from './GraphCanvas';
import { COLOR, SECTION_STATE_COLOR, SECTION_STATE_LABEL, nodeColor, tint } from './colors';
import { inputStyle } from './ProgressView';

interface Props {
  payload: GraphPayload;
  selectedId?: string;
  onSelect: (id: string) => void;
  onNavigate: (id: string) => void;
  onAction: (action: GraphAction) => void;
}

function NodeLink({ node, onSelect }: { node: GraphNodeView; onSelect: (id: string) => void }) {
  return (
    <li style={{ listStyle: 'none' }}>
      <button onClick={() => onSelect(node.id)} title={node.id}
        style={{ width: '100%', textAlign: 'left', padding: '5px 9px', borderRadius: 6, border: `1px solid ${tint(nodeColor(node), 55)}`, background: tint(nodeColor(node), 7), color: 'var(--vscode-foreground)', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
        <span style={{ fontWeight: 600 }}>{node.title}</span>
        <span style={{ color: COLOR.muted, marginLeft: 'auto', whiteSpace: 'nowrap' }}>{node.progressLabel}</span>
      </button>
    </li>
  );
}

/** What a change to one node would touch: dependants in the research and the passages of the manuscript that present them. */
export function ImpactView({ payload, selectedId, onSelect, onNavigate, onAction }: Props) {
  const impact = useMemo(() => (selectedId ? impactOf(payload, selectedId) : undefined), [payload, selectedId]);
  const highlight = useMemo(() => (selectedId ? new Set([selectedId, ...(impact?.downstream.map((node) => node.id) ?? [])]) : undefined), [selectedId, impact]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 12px', borderBottom: `1px solid ${COLOR.border}` }}>
        <span style={{ fontSize: 12 }}>If this changes:</span>
        <input list="graph-node-ids" placeholder="Pick a result or definition" aria-label="Result or definition" defaultValue={selectedId} key={selectedId}
          onChange={(event) => { if (payload.nodes.some((node) => node.id === event.target.value)) onSelect(event.target.value); }} style={{ ...inputStyle, width: 240 }} />
        <datalist id="graph-node-ids">{payload.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</datalist>
      </div>
      {!impact?.node ? (
        <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>Pick a result here, or use “What depends on this?” on the graph.</div>
      ) : (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <GraphCanvas nodes={impact.graph.nodes} edges={impact.graph.edges} required={payload.required} selectedId={selectedId} highlight={highlight}
              onSelect={onSelect} />
          </div>
          <div style={{ width: 320, flexShrink: 0, borderLeft: `1px solid ${COLOR.border}`, padding: 12, overflow: 'auto', fontSize: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{impact.node.title}</div>
            <div style={{ color: COLOR.muted, marginBottom: 10 }}>{impact.node.id}</div>
            <b>Rests on</b>
            {impact.upstream.length ? <ul style={{ padding: 0, margin: '4px 0 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>{impact.upstream.map((node) => <NodeLink key={node.id} node={node} onSelect={onSelect} />)}</ul> : <div style={{ color: COLOR.muted, margin: '4px 0 10px' }}>nothing</div>}
            <b>Results that rest on it</b> <span style={{ color: COLOR.muted }}>(would need your review again)</span>
            {impact.downstream.length ? <ul style={{ padding: 0, margin: '4px 0 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>{impact.downstream.map((node) => <NodeLink key={node.id} node={node} onSelect={onSelect} />)}</ul> : <div style={{ color: COLOR.muted, margin: '4px 0 10px' }}>nothing rests on it</div>}
            <b>Passages in the paper</b>
            {impact.sections.length ? (
              <ul style={{ paddingLeft: 16, margin: '4px 0 10px' }}>
                {impact.sections.map(({ section, via, blocks }) => (
                  <li key={section.id} style={{ marginBottom: 6 }}>
                    <a href="#" onClick={(event) => { event.preventDefault(); onAction({ action: 'openTex', section: section.id }); }} style={{ color: SECTION_STATE_COLOR[section.state] }}>{section.title}</a>
                    <span style={{ color: COLOR.muted }}> ({SECTION_STATE_LABEL[section.state] ?? section.state}) via {via.join(', ') || blocks.flatMap((block) => block.via).join(', ')}</span>
                    {blocks.length > 0 && (
                      <ul style={{ paddingLeft: 14 }}>
                        {blocks.map((block) => (
                          <li key={block.id}>
                            <a href="#" onClick={(event) => { event.preventDefault(); onAction({ action: 'openTex', section: section.id, line: block.lines?.[0] }); }} style={{ color: SECTION_STATE_COLOR[block.state] }}>{block.id}</a>
                            <span style={{ color: COLOR.muted }}>{block.lines ? ` lines ${block.lines[0]}-${block.lines[1]}` : ''} · {block.via.join(', ')}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            ) : <div style={{ color: COLOR.muted, margin: '4px 0 10px' }}>no section presents it or what rests on it</div>}
            {impact.unaffected.length > 0 && <><b>Unaffected</b><div style={{ color: COLOR.muted, marginTop: 4 }}>{impact.unaffected.map((section) => section.title).join(', ')}</div></>}
          </div>
        </div>
      )}
    </div>
  );
}
