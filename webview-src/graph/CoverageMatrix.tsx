import React from 'react';
import type { GraphAction, GraphPayload } from '../../src/models/graph';
import { COLOR, SECTION_STATE_COLOR } from './colors';
import { buttonStyle } from './AttentionList';

interface Props {
  payload: GraphPayload;
  highlightSection?: string;
  onFocus: (id: string) => void;
  onAction: (action: GraphAction) => void;
}

const CELL_LABEL: Record<string, string> = { current: 'current', stale: 'stale', invalid: 'invalid', planned: 'planned', dependency: 'via dep.' };
const cellStyle: React.CSSProperties = { padding: '4px 8px', borderBottom: `1px solid ${COLOR.border}`, fontSize: 12, whiteSpace: 'nowrap' };

/** Which results each section presents, and whether that presentation is still current. */
export function CoverageMatrix({ payload, highlightSection, onFocus, onAction }: Props) {
  if (!payload.sections.length) {
    return <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>No manuscript outline yet. Plan the paper with the plan-manuscript skill; the coverage of each required result then appears here.</div>;
  }
  return (
    <div style={{ overflow: 'auto', height: '100%', padding: 12, boxSizing: 'border-box' }}>
      <table style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...cellStyle, textAlign: 'left', position: 'sticky', left: 0, background: 'var(--vscode-editor-background)' }}>Result</th>
            {payload.sections.map((section) => (
              <th key={section.id} style={{ ...cellStyle, textAlign: 'left', verticalAlign: 'bottom', background: section.id === highlightSection ? 'var(--vscode-list-hoverBackground)' : undefined }}>
                <div>{section.title}</div>
                <div style={{ fontWeight: 400, color: SECTION_STATE_COLOR[section.state] }} title={section.reasons.join('\n')}>
                  {section.state}{section.lockedRevision ? ` · rev ${section.lockedRevision}` : ''}
                </div>
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  {section.texExists && <button style={{ ...buttonStyle('secondary'), padding: '1px 6px', fontSize: 11 }} onClick={() => onAction({ action: 'openTex', section: section.id })}>TeX</button>}
                  {section.texExists && section.state !== 'current' && <button style={{ ...buttonStyle('secondary'), padding: '1px 6px', fontSize: 11 }} onClick={() => onAction({ action: 'lock', section: section.id })} title="Record that the reviewed TeX matches the current research">Lock</button>}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {payload.coverage.map((row) => (
            <tr key={row.id}>
              <td style={{ ...cellStyle, position: 'sticky', left: 0, background: 'var(--vscode-editor-background)', outline: row.uncovered ? `1px solid ${COLOR.link}` : undefined }}>
                <a href="#" onClick={(event) => { event.preventDefault(); onFocus(row.id); }} style={{ color: 'var(--vscode-foreground)', fontWeight: row.required ? 700 : 400 }}>{row.id}{row.required ? ' ★' : ''}</a>
                {row.uncovered && <span style={{ color: COLOR.link, marginLeft: 6 }}>uncovered</span>}
              </td>
              {payload.sections.map((section) => {
                const cell = row.cells[section.id];
                if (!cell) return <td key={section.id} style={cellStyle} />;
                const block = section.blocks.find((item) => cell.blocks.includes(item.id) && item.lines);
                return (
                  <td key={section.id} style={{ ...cellStyle, cursor: section.texExists ? 'pointer' : undefined }}
                    title={`${CELL_LABEL[cell.state]}${cell.uses.length ? `\npresents: ${cell.uses.join(', ')}` : ''}${cell.blocks.length ? `\nblocks: ${cell.blocks.join(', ')}` : ''}`}
                    onClick={() => section.texExists && onAction({ action: 'openTex', section: section.id, line: block?.lines?.[0] })}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: SECTION_STATE_COLOR[cell.state], marginRight: 6 }} />
                    <span style={{ color: cell.state === 'dependency' || cell.state === 'planned' ? COLOR.muted : undefined }}>{CELL_LABEL[cell.state]}</span>
                    {cell.uses.length > 0 && cell.uses.length < 3 && <span style={{ color: COLOR.muted }}> · {cell.uses.join('+')}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: COLOR.muted, marginTop: 10 }}>
        planned: in a brief, section not locked yet · via dep.: needed by a presented result · click a cell to open the TeX at its block.
      </div>
    </div>
  );
}
