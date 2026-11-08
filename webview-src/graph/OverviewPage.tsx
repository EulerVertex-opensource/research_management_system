import React, { useEffect, useRef, useState } from 'react';
import type { AttentionItem, GraphAction, GraphNodeView, GraphPayload, LoopHealth } from '../../src/models/graph';
import { capitalize, plural, stageText } from '../../src/domain/copy';
import { ActionRow, GROUP_COLOR, HistoryList, when } from './AttentionList';
import { blockingStates, waitingItems } from './graphModel';
import { COLOR, SECTION_STATE_COLOR, SECTION_STATE_LABEL, TONE_COLOR, tint } from './colors';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { AgentConstellation } from '../components/AgentConstellation';
import { useTechnical } from '../technical';

/**
 * The Overview: four short blocks that say what is happening and whether the
 * researcher is needed. Everything else is one click away: the full list on
 * Needs you, the structure on Results, the timeline on Activity.
 */

interface Props {
  payload: GraphPayload | null;
  onAction: (action: GraphAction) => void;
  /** A node's own page in the dashboard. */
  onNavigate: (id: string) => void;
  onShowInResults: (id: string) => void;
  /** The Needs you page, with one item selected. */
  onOpenNeeds: (key?: string) => void;
  onOpenActivity: () => void;
  onOpenPaper: (section?: string) => void;
  onOpenSettings?: () => void;
}

const LEAD_REASON_LINES = 4;
const MORE_ITEMS = 2;
const MAX_MAINS = 5;

/** The short state label over the "Now" block. */
function nowLabel(health: LoopHealth): string {
  switch (health.key) {
    case 'working': case 'set_aside': return 'The agent is working';
    case 'needs_you': return health.signature.startsWith('question:') ? 'The agent is asking you' : 'The agent is working';
    case 'goals': return 'Your turn';
    case 'stopped': return 'Stopped · waiting for you';
    case 'stalled': case 'agent_idle': return 'No agent is working';
    case 'paused': return 'Paused';
    case 'done': return 'All done';
    default: return 'Not running';
  }
}

/** While the agent works, the block says what on; otherwise it carries the loop's own headline. */
function agentDoing(payload: GraphPayload): string | undefined {
  const { health, loop } = payload;
  if (health.key === 'working') return health.headline;
  const working = health.key === 'set_aside' || (health.key === 'needs_you' && !health.signature.startsWith('question:'));
  if (!working || !loop?.stage) return undefined;
  const title = loop.assetId ? payload.nodes.find((node) => node.id === loop.assetId)?.title ?? loop.assetId : undefined;
  return `${capitalize(stageText(loop.stage, title))}.`;
}

const sameAction = (a: GraphAction, b: GraphAction) => JSON.stringify(a) === JSON.stringify(b);

/** A titled card: the widget background, or a wash of `tone` with a border to match (the old status card). */
function Block({ title, aside, children, tone, wash = 9 }: { title: string; aside?: React.ReactNode; children: React.ReactNode; tone?: string; wash?: number }) {
  return (
    <section aria-label={title} style={{ border: `1px solid ${tone ? tint(tone, 60) : COLOR.border}`, background: tone ? tint(tone, wash) : COLOR.card, borderRadius: 8, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: tone ?? COLOR.muted }}>{title}</h3>
        {aside && <span style={{ marginLeft: 'auto', fontSize: 12 }}>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

const link: React.CSSProperties = { padding: 0, border: 'none', background: 'transparent', color: COLOR.link, fontSize: 12, cursor: 'pointer' };

function Now({ payload, onAction, onNavigate, onOpenSettings }: Pick<Props, 'onAction' | 'onNavigate' | 'onOpenSettings'> & { payload: GraphPayload }) {
  const { health } = payload;
  const doing = agentDoing(payload);
  const color = doing ? COLOR.active : TONE_COLOR[health.tone];
  // A button the Needs you list already carries (an answer, an approval) stays there only.
  const buttons = health.buttons.filter((button) => button.action.action !== 'openNode'
    && !payload.attention.some((item) => item.buttons.some((other) => sameAction(other.action, button.action))));
  const waiting = waitingItems(payload).length;
  const technical = useTechnical();
  return (
    <Block title="Now" tone={color} wash={health.tone === 'neutral' && !doing ? 4 : 9}
      aside={health.agentAt && when(health.agentAt) ? <span style={{ color: COLOR.muted }} title={health.last?.text}>Agent last active {when(health.agentAt)}</span> : undefined}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <AgentConstellation active={Boolean(doing)} color={color} size={30} style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: COLOR.muted }}>{nowLabel(health)}</div>
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.35 }}>{doing ?? health.headline}</div>
          <div style={{ fontSize: 13, opacity: 0.9, whiteSpace: 'pre-wrap' }}>
            {doing
              ? waiting ? 'It keeps working on its own. When you have a moment, look at what waits for you below.' : 'Nothing needs you right now. You will see it here, and in the status bar, when something does.'
              : health.body}
          </div>
        </div>
      </div>
      {buttons.length > 0 && <div><ActionRow buttons={buttons} onAction={onAction} onNavigate={onNavigate} /></div>}
      {technical && (health.last || payload.loop) && (
        <div style={{ fontSize: 11, color: COLOR.muted, fontFamily: 'var(--vscode-editor-font-family, monospace)', whiteSpace: 'pre-wrap' }}>
          {payload.loop ? `loop ${payload.loop.status} · stage ${payload.loop.stage}${payload.loop.assetId ? ` · ${payload.loop.assetId}` : ''} · ${health.key}` : ''}
          {health.last ? `\nLast step${when(health.last.at) ? ` (${when(health.last.at)})` : ''}: ${health.last.text}` : ''}
        </div>
      )}
      {((payload.autoMode && !payload.autonomy?.active) || !payload.projectApproved) && (
        <div style={{ fontSize: 12, color: COLOR.muted, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {!payload.projectApproved && <span style={{ color: COLOR.waiting }}>The goals in project.md are not accepted yet.</span>}
          {payload.autoMode && !payload.autonomy?.active && <span>Routine work is approved without asking you. <button style={link} onClick={onOpenSettings}>Settings</button></span>}
        </div>
      )}
    </Block>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Autonomous mode: while the agent works alone, its budget; once it hands the
 * loop back, what it did, so the researcher can pick up from there.
 */
function Autonomy({ payload, onShowInResults, onOpenActivity }: Pick<Props, 'onShowInResults' | 'onOpenActivity'> & { payload: GraphPayload }) {
  const run = payload.autonomy;
  if (!run || (!run.active && !run.handedOverAt)) return null;
  const titleOf = (id: string) => payload.nodes.find((node) => node.id === id)?.title ?? id;
  const names = (ids: string[]) => ids.map((id, index) => (
    <React.Fragment key={id}>{index > 0 && ', '}<button style={{ ...link, fontSize: 13 }} onClick={() => onShowInResults(id)}>{titleOf(id)}</button></React.Fragment>
  ));
  const tone = run.active ? COLOR.active : COLOR.waiting;
  const share = run.budget ? Math.min(1, run.spent / run.budget) : 0;
  const row = (label: string, content: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', gap: 12, fontSize: 13, alignItems: 'baseline' }}>
      <span style={{ color: COLOR.muted, fontSize: 12 }}>{label}</span>
      <div style={{ minWidth: 0 }}>{content}</div>
    </div>
  );
  const spending = run.spending.slice(0, 5).map((item) => `${titleOf(item.id)} (${item.attempts})`).join(', ');
  return (
    <Block title={run.active ? 'Autonomous run' : 'Autonomous run · handed back to you'} tone={tone} wash={run.active ? 5 : 9}
      aside={<span style={{ color: COLOR.muted }}>{run.active ? `since ${clock(run.startedAt)}` : `${clock(run.startedAt)} – ${clock(run.handedOverAt!)}`}</span>}>
      <div style={{ fontSize: 13 }}>
        {run.active
          ? 'The agent works on its own and asks you nothing. It hands the loop back when the budget or the time limit runs out, or when nothing is left that it can do alone.'
          : <>It stopped because {run.reason ?? 'its run ended'}. Here is what it did; what waits for your review is below. Resuming starts a new run with a fresh budget.</>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, flexWrap: 'wrap' }}>
        <span aria-hidden="true" style={{ flex: '0 0 160px', height: 6, borderRadius: 3, background: tint(COLOR.muted, 25), overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${Math.round(share * 100)}%`, background: tone }} />
        </span>
        <span>{run.spent} of {plural(run.budget, 'attempt')} spent</span>
        {run.deadline && run.active && <span style={{ color: COLOR.muted }}>· hands back by {clock(run.deadline)} at the latest</span>}
        <span style={{ color: COLOR.muted }}>· {run.revisions} of {plural(run.revisionLimit, 'goal reassessment')}</span>
      </div>
      {run.proved.length > 0 && row('Proved', names(run.proved))}
      {run.setAside.length > 0 && row('Set aside by the agent', (
        <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {run.setAside.map((item) => <li key={item.id}>{names([item.id])}{item.note ? <span style={{ color: COLOR.muted }}> — {item.note}</span> : null}</li>)}
        </ul>
      ))}
      {run.addedGoals.length > 0 && row('Goals it added', <>{names(run.addedGoals)}<div style={{ fontSize: 12, color: COLOR.muted }}>Your own goals are all still there. Keep or drop either kind in project.md.</div></>)}
      {run.agentChecked && row('Approved on the agent\'s check alone', (
        <>
          <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {run.agentChecked.definitions.length > 0 && <li>Definitions: {names(run.agentChecked.definitions)}</li>}
            {run.agentChecked.citations.length > 0 && <li>Checked against their source: {names(run.agentChecked.citations)}</li>}
            {(run.agentChecked.proofs ?? []).length > 0 && <li>Proofs checked as written: {names(run.agentChecked.proofs)}</li>}
            {run.agentChecked.rechecked.length > 0 && <li>Proofs re-checked after a change: {names(run.agentChecked.rechecked)}</li>}
          </ul>
          <div style={{ fontSize: 12, color: COLOR.muted }}>No person has read these yet; an independent agent checked each one.</div>
        </>
      ))}
      {spending && row('Where the attempts went', spending)}
      {run.decided > 0 && row('Questions it decided', <>{plural(run.decided, 'question')}, each kept as an idea with the default it chose. <button style={link} onClick={onOpenActivity}>Activity →</button></>)}
    </Block>
  );
}

/** "Holds up the main result" / "Holds up 3 main results", with the names on hover. */
function holdsUp(item: AttentionItem, byId: Map<string, GraphNodeView>): React.ReactNode {
  if (!item.blocks.length) return null;
  const names = item.blocks.map((id) => byId.get(id)?.title ?? id);
  return <span title={names.join('\n')}>Holds up {item.blocks.length === 1 ? names[0] : plural(item.blocks.length, 'main result')}</span>;
}

function LeadItem({ item, byId, onAction, onNavigate, onShowInResults, onOpenPaper }: { item: AttentionItem; byId: Map<string, GraphNodeView> } & Pick<Props, 'onAction' | 'onNavigate' | 'onShowInResults' | 'onOpenPaper'>) {
  const [full, setFull] = useState(false);
  const node = item.target ? byId.get(item.target) : undefined;
  const failed = item.category === 'parked' ? node?.counts.failedPlans ?? 0 : 0;
  // Rendered math and wrapping decide where the text overflows: measure it, starting from a guess by length.
  const reasonRef = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(item.reason.split('\n').length > LEAD_REASON_LINES || item.reason.length > 400);
  useEffect(() => { const box = reasonRef.current; if (box && !full) setLong(box.scrollHeight > box.clientHeight + 2); }, [item.reason, full]);
  const facts = [holdsUp(item, byId), failed > 0 ? <span>{plural(failed, 'proof attempt')} failed</span> : null].filter(Boolean);
  return (
    <article style={{ border: `1px solid ${tint(GROUP_COLOR[item.priority], 45)}`, background: tint(GROUP_COLOR[item.priority], 6), borderRadius: 6, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{item.title}</div>
      {item.reason && (
        <div ref={reasonRef} className="compact-md" style={full ? undefined : { maxHeight: `${LEAD_REASON_LINES * 1.5}em`, overflow: 'hidden', fontSize: 13, lineHeight: 1.5 }}>
          <MarkdownPreview content={item.reason} style={{ fontSize: 13, lineHeight: 1.5 }} />
        </div>
      )}
      {(long || full) && <div><button style={link} onClick={() => setFull(!full)}>{full ? 'Show less' : 'Show more'}</button></div>}
      {!item.reason && item.why && <div style={{ fontSize: 13 }}>{item.why}</div>}
      {facts.length > 0 && (
        <div style={{ fontSize: 12, color: COLOR.muted, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {facts.map((fact, index) => <React.Fragment key={index}>{index > 0 && <span aria-hidden="true">·</span>}{fact}</React.Fragment>)}
        </div>
      )}
      <div style={{ marginTop: 2 }}>
        <ActionRow buttons={item.buttons.filter((button) => button.action.action !== 'openNode')} onAction={onAction} onNavigate={onNavigate} extra={<span style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
          {item.target && <button style={link} onClick={() => onNavigate(item.target!)}>Open</button>}
          {item.target && <button style={link} onClick={() => onShowInResults(item.target!)}>Show in Results</button>}
          {!item.target && item.sections.length > 0 && <button style={link} onClick={() => onOpenPaper(item.sections[0])}>Show in the paper</button>}
        </span>} />
      </div>
    </article>
  );
}

function Decisions({ payload, onAction, onNavigate, onShowInResults, onOpenNeeds, onOpenPaper }: Pick<Props, 'onAction' | 'onNavigate' | 'onShowInResults' | 'onOpenNeeds' | 'onOpenPaper'> & { payload: GraphPayload }) {
  const items = waitingItems(payload);
  const byId = new Map(payload.nodes.map((node) => [node.id, node]));
  const [lead, ...rest] = items;
  return (
    <Block title={items.length ? `Waiting for you · ${items.length}` : 'Waiting for you'}
      aside={items.length > 1 ? <button style={link} onClick={() => onOpenNeeds()}>See all {items.length} →</button> : undefined}>
      {!lead ? (
        <div style={{ fontSize: 13, color: COLOR.muted }}>Nothing waits for you.</div>
      ) : <>
        <LeadItem item={lead} byId={byId} onAction={onAction} onNavigate={onNavigate} onShowInResults={onShowInResults} onOpenPaper={onOpenPaper} />
        {rest.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rest.slice(0, MORE_ITEMS).map((item) => (
              <li key={item.key}>
                <button onClick={() => onOpenNeeds(item.key)}
                  style={{ width: '100%', display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 12px', borderRadius: 6, border: `1px solid ${COLOR.border}`, background: COLOR.card, color: 'var(--vscode-foreground)', cursor: 'pointer', textAlign: 'left', fontSize: 13 }}>
                  <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, alignSelf: 'center', background: GROUP_COLOR[item.priority] }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                  <span style={{ fontSize: 12, color: COLOR.muted, whiteSpace: 'nowrap' }}>{holdsUp(item, byId)}</span>
                  <span aria-hidden="true" style={{ color: COLOR.muted }}>→</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {rest.length > MORE_ITEMS && <div style={{ fontSize: 12, color: COLOR.muted }}>and {plural(rest.length - MORE_ITEMS, 'more item')} on Needs you.</div>}
      </>}
    </Block>
  );
}

function Progress({ payload, onAction, onShowInResults, onOpenPaper }: Pick<Props, 'onAction' | 'onShowInResults' | 'onOpenPaper'> & { payload: GraphPayload }) {
  const blocking = blockingStates(payload);
  const mains = payload.required.map((id) => payload.nodes.find((node) => node.id === id)).filter((node): node is GraphNodeView => Boolean(node));
  const rank = (node: GraphNodeView) => (node.progress === 'done' ? 3 : blocking.get(node.id) === 'stuck' ? 0 : blocking.get(node.id) === 'needs_you' ? 1 : 2);
  const shown = [...mains].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_MAINS);
  const done = mains.filter((node) => node.progress === 'done').length;
  const paper = payload.manuscriptState;
  return (
    <Block title="Progress" aside={mains.length ? <span style={{ color: COLOR.muted }}>{done} of {plural(mains.length, 'main result')} done</span> : undefined}>
      {!mains.length && <div style={{ fontSize: 13, color: COLOR.muted }}>No main results yet. They come from the goals in project.md.</div>}
      {shown.map((node) => {
        const tone = node.progress === 'done' ? COLOR.approved : blocking.get(node.id) === 'stuck' ? COLOR.error : blocking.get(node.id) === 'needs_you' ? COLOR.waiting : COLOR.active;
        const note = node.progress === 'done' ? 'done' : blocking.get(node.id) === 'stuck' ? 'held up' : blocking.get(node.id) === 'needs_you' ? 'waits for you' : 'in progress';
        const share = node.closure && node.closure.total ? node.closure.done / node.closure.total : node.progress === 'done' ? 1 : 0;
        return (
          <button key={node.id} onClick={() => onShowInResults(node.id)} title={`${node.title}: show in Results`}
            style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 140px 150px', gap: 12, alignItems: 'center', padding: '6px 10px', borderRadius: 6, border: `1px ${node.progress === 'done' ? 'solid' : 'dashed'} ${tint(tone, 50)}`, background: tint(tone, node.progress === 'done' ? 8 : 5), color: 'var(--vscode-foreground)', cursor: 'pointer', textAlign: 'left', fontSize: 13 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {node.title}
              {node.agentGoal && <span title="The agent added this goal while working on its own; yours are kept." style={{ marginLeft: 8, fontSize: 11, color: COLOR.muted, border: `1px solid ${COLOR.border}`, borderRadius: 3, padding: '0 4px' }}>added by the agent</span>}
            </span>
            <span aria-hidden="true" style={{ height: 6, borderRadius: 3, background: tint(COLOR.muted, 25), overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: `${Math.round(share * 100)}%`, background: tone }} />
            </span>
            <span style={{ fontSize: 12, color: node.progress === 'done' ? COLOR.muted : tone, whiteSpace: 'nowrap' }}>
              {node.closure ? `${node.closure.done}/${node.closure.total} · ` : ''}{note}
            </span>
          </button>
        );
      })}
      {mains.length > shown.length && <div style={{ fontSize: 12, color: COLOR.muted }}>and {plural(mains.length - shown.length, 'more main result')} in Results.</div>}
      <div style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'baseline', borderTop: `1px solid ${COLOR.border}`, paddingTop: 8 }}>
        <span style={{ color: COLOR.muted }}>The paper:</span>
        <span style={{ color: SECTION_STATE_COLOR[paper ?? ''] ?? COLOR.muted }}>{paper ? SECTION_STATE_LABEL[paper] ?? paper : 'no outline yet'}</span>
        {payload.sections.length > 0 && <button style={{ ...link, marginLeft: 'auto' }} onClick={() => onOpenPaper()}>Which results it covers →</button>}
      </div>
      {payload.study && payload.study.total > 0 && (
        <div style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ color: COLOR.muted }}>What you know:</span>
          <span style={{ color: payload.study.behind ? COLOR.waiting : COLOR.muted }}>
            {payload.study.behind ? `${plural(payload.study.behind, 'verified result')} new to you or changed since you studied ${payload.study.behind === 1 ? 'it' : 'them'}` : `you have studied all ${plural(payload.study.total, 'verified result')}`}
          </span>
          {payload.study.behind > 0 && <button style={{ ...link, marginLeft: 'auto' }} title="Copies a teaching prompt and opens the agent chat: start a new chat beside the loop and paste it" onClick={() => onAction({ action: 'teach' })}>Study them in a new chat ↗</button>}
        </div>
      )}
    </Block>
  );
}

/** The Overview tab. */
export function OverviewPage({ payload, onAction, onNavigate, onShowInResults, onOpenNeeds, onOpenActivity, onOpenPaper, onOpenSettings }: Props) {
  if (!payload) return <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>Loading the research overview…</div>;
  return (
    <div style={{ height: '100%', overflow: 'auto', boxSizing: 'border-box', padding: '16px 18px 24px', background: COLOR.canvas }}>
      <div style={{ maxWidth: 920, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Now payload={payload} onAction={onAction} onNavigate={onNavigate} onOpenSettings={onOpenSettings} />
        <Autonomy payload={payload} onShowInResults={onShowInResults} onOpenActivity={onOpenActivity} />
        <Decisions payload={payload} onAction={onAction} onNavigate={onNavigate} onShowInResults={onShowInResults} onOpenNeeds={onOpenNeeds} onOpenPaper={onOpenPaper} />
        <Progress payload={payload} onAction={onAction} onShowInResults={onShowInResults} onOpenPaper={onOpenPaper} />
        <Block title="Recently" aside={payload.history.length > 3 ? <button style={link} onClick={onOpenActivity}>All activity →</button> : undefined}>
          <HistoryList entries={payload.history.slice(0, 3)} onShow={onShowInResults} />
        </Block>
      </div>
    </div>
  );
}
