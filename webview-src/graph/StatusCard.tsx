import React from 'react';
import type { GraphAction, GraphPayload } from '../../src/models/graph';
import { ActionRow, buttonStyle, when } from './AttentionList';
import { COLOR, PROGRESS_STYLE, TONE_COLOR, nodeStyle, tint } from './colors';

interface Props {
  payload: GraphPayload;
  onAction: (action: GraphAction) => void;
  onNavigate: (id: string) => void;
  onShow: (id: string) => void;
}

/**
 * The top of the Overview: whose turn it is, what holds the research up, and
 * what happens if nobody acts. One card per situation (see computeLoopHealth).
 */
export function StatusCard({ payload, onAction, onNavigate, onShow }: Props) {
  const health = payload.health;
  const color = TONE_COLOR[health.tone];
  const byId = new Map(payload.nodes.map((node) => [node.id, node]));
  return (
    <section aria-label="Loop status" style={{ border: `1px solid ${tint(color, 60)}`, background: tint(color, health.tone === 'neutral' ? 4 : 9), borderRadius: 8, padding: '14px 16px', display: 'flex', flexWrap: 'wrap', gap: '12px 24px' }}>
      <div style={{ flex: '999 1 480px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color }}>{health.eyebrow}</div>
        <h2 style={{ margin: 0, fontSize: 17, lineHeight: 1.3, fontWeight: 600 }}>{health.headline}</h2>
        {health.body && <p style={{ margin: 0, fontSize: 13, opacity: 0.9, maxWidth: 820, whiteSpace: 'pre-wrap' }}>{health.body}</p>}
        {health.chain.length > 1 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ color: COLOR.muted }}>Holding up:</span>
            {health.chain.map((id, index) => {
              const node = byId.get(id);
              const style = node ? nodeStyle(node) : PROGRESS_STYLE.waiting;
              return (
                <React.Fragment key={id}>
                  {index > 0 && <span aria-hidden="true" style={{ color: COLOR.muted }}>→</span>}
                  <button onClick={() => onShow(id)} title="Show on graph"
                    style={{ padding: '1px 8px', borderRadius: 4, fontSize: 12, cursor: 'pointer', color: 'var(--vscode-foreground)', background: tint(style.color, 14), border: `1px ${style.dashed ? 'dashed' : 'solid'} ${style.color}` }}>
                    {node?.title ?? id}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        )}
        {health.blockers.length > 0 && (
          <ol style={{ margin: '2px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {health.blockers.map((blocker, index) => (
              <li key={`${blocker.title}:${index}`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px', padding: '7px 10px', borderRadius: 6, border: `1px solid ${tint(color, 45)}`, background: tint(color, 6) }}>
                <span style={{ width: 22, height: 22, borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, background: tint(color, 35), flexShrink: 0 }}>{index + 1}</span>
                <span style={{ flex: '999 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontWeight: 600 }}>{blocker.title}</span>
                  <span style={{ fontSize: 12, color: COLOR.muted }}>{blocker.detail}</span>
                </span>
                <ActionRow buttons={blocker.buttons} onAction={onAction} onNavigate={onNavigate}
                  extra={blocker.target && <button style={buttonStyle('secondary')} onClick={() => onShow(blocker.target!)}>Show on graph</button>} />
              </li>
            ))}
          </ol>
        )}
        <div style={{ fontSize: 12.5 }}><span style={{ color, fontWeight: 600 }}>If you do nothing: </span>{health.ifIgnored}</div>
      </div>
      {health.buttons.length > 0 && (
        <div style={{ flex: '0 1 280px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ActionRow buttons={health.buttons} onAction={onAction} onNavigate={onNavigate} large />
        </div>
      )}
      {(health.last || health.agentAt) && (
        <div style={{ flex: '1 1 100%', borderTop: `1px solid ${tint(color, 40)}`, paddingTop: 8, fontSize: 12, color: COLOR.muted, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
          {health.last && <span style={{ flex: '999 1 320px', minWidth: 0 }}>Last step{when(health.last.at) ? ` · ${when(health.last.at)}` : ''} — <span style={{ color: 'var(--vscode-foreground)' }}>{health.last.text}</span></span>}
          {health.agentAt && when(health.agentAt) && <span title="The agent's last tool call, command, or turn end">Agent last active · {when(health.agentAt)}</span>}
        </div>
      )}
    </section>
  );
}
