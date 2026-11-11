import React from 'react';
import type { GraphAction, GraphPayload, RouteView, TeamClaimView } from '../../src/models/graph';
import { buttonStyle, when } from './AttentionList';
import { boxStyle } from './ResultCard';
import { RouteRow, isOpen, sharedLemmas } from './RoutesView';
import { COLOR, tint } from './colors';

/**
 * Team: who works on what in a shared project. One card per collaborator: the main results they own,
 * what their loop holds now (its claims), and the routes they created; then the open routes nobody
 * holds. Claims are soft locks shared through git, so this shows what this machine last fetched.
 */

interface Props {
  payload: GraphPayload | null;
  onAction: (action: GraphAction) => void;
  onShowInResults: (id: string) => void;
  onOpenSettings: () => void;
}

const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: COLOR.muted, marginBottom: 4 };
const short = (who: string) => who.split('@')[0];

interface Member { id: string; you: boolean; owns: string[]; claims: TeamClaimView[]; routes: RouteView[]; lastSeen?: string }

/** Everyone the project knows of: claim holders, route creators, owners, and whoever left records. */
export function teamMembers(payload: GraphPayload): Member[] {
  const team = payload.team;
  const routes = payload.routes ?? [];
  const ids = new Set<string>([
    ...(team?.me ? [team.me] : []), ...(team?.claims ?? []).map((claim) => claim.by), ...(team?.owners ?? []).map((item) => item.owner),
    ...routes.map((route) => route.createdBy).filter((who): who is string => Boolean(who)), ...Object.keys(team?.lastSeen ?? {}),
  ]);
  return [...ids].map((id) => ({
    id, you: id === team?.me,
    owns: (team?.owners ?? []).filter((item) => item.owner === id).map((item) => item.id),
    claims: (team?.claims ?? []).filter((claim) => claim.by === id),
    routes: routes.filter((route) => route.createdBy === id),
    lastSeen: team?.lastSeen[id],
  })).sort((a, b) => Number(b.you) - Number(a.you) || b.claims.length - a.claims.length || a.id.localeCompare(b.id));
}

function ClaimLine({ claim, payload, onAction, onShowInResults }: { claim: TeamClaimView; payload: GraphPayload; onAction: Props['onAction']; onShowInResults: Props['onShowInResults'] }) {
  const title = (id: string) => payload.nodes.find((node) => node.id === id)?.title ?? id;
  const route = claim.key.startsWith('plan:') ? (payload.routes ?? []).find((item) => item.planId === claim.key.slice(5)) : undefined;
  const target = route?.target ?? (claim.key.startsWith('plan:') ? undefined : claim.key);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12.5 }}>
      <span style={{ width: 7, height: 7, borderRadius: 4, background: COLOR.active, flexShrink: 0, alignSelf: 'center' }} />
      {route
        ? <span>the route <b>{route.title}</b> to <a href="#" style={{ color: COLOR.link }} onClick={(event) => { event.preventDefault(); onShowInResults(route.target); }}>{title(route.target)}</a></span>
        : target ? <a href="#" style={{ color: COLOR.link }} onClick={(event) => { event.preventDefault(); onShowInResults(target); }}>{title(target)}</a> : <span>{claim.key}</span>}
      <span style={{ color: COLOR.muted, fontSize: 11.5 }}>since {when(claim.since) || claim.since.slice(0, 16)} · held until {claim.until.slice(0, 16).replace('T', ' ')}</span>
      {claim.mine && <button style={{ ...buttonStyle('secondary'), padding: '0 8px', marginLeft: 'auto' }} title="Let collaborators' loops take it; your loop claims it again if it works on it" onClick={() => onAction({ action: 'claims', op: 'release', key: claim.key })}>Release</button>}
    </div>
  );
}

function MemberCard({ member, payload, onAction, onShowInResults }: { member: Member } & Omit<Props, 'onOpenSettings'> & { payload: GraphPayload }) {
  const title = (id: string) => payload.nodes.find((node) => node.id === id)?.title ?? id;
  const open = member.routes.filter(isOpen);
  const closed = member.routes.filter((route) => !isOpen(route));
  const shared = sharedLemmas((payload.routes ?? []).filter(isOpen));
  const loopOn = payload.loop?.status === 'running' || payload.loop?.status === 'paused';
  const color = member.claims.length ? COLOR.active : COLOR.muted;
  return (
    <article style={{ ...boxStyle(tint(color, 50)), background: tint(color, member.claims.length ? 7 : 3), padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{short(member.id)}</span>
        {member.you && <span style={{ fontSize: 11, fontWeight: 600, color: '#fff', background: COLOR.active, borderRadius: 8, padding: '0 7px' }}>you</span>}
        <span style={{ fontSize: 11.5, color: COLOR.muted }}>{member.id}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: COLOR.muted }}>{member.claims.length ? `working on ${member.claims.length}` : 'not working on anything now'}{member.lastSeen ? ` · last active ${when(member.lastSeen) || member.lastSeen.slice(0, 10)}` : ''}</span>
      </header>
      {member.owns.length > 0 && (
        <section>
          <div style={label}>Owns · commits routes into</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {member.owns.map((id) => <button key={id} onClick={() => onShowInResults(id)} style={{ fontSize: 12, padding: '1px 9px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${COLOR.waiting}`, background: tint(COLOR.waiting, 10), color: 'var(--vscode-foreground)' }}>★ {title(id)}</button>)}
          </div>
        </section>
      )}
      {member.claims.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={label}>Working on now</div>
          {member.claims.map((claim) => <ClaimLine key={claim.key} claim={claim} payload={payload} onAction={onAction} onShowInResults={onShowInResults} />)}
        </section>
      )}
      {open.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={label}>Routes {member.you ? 'you' : 'they'} created · {open.length} open</div>
          {open.map((route) => (
            <RouteRow key={route.planId} route={route} payload={payload} shared={shared} onSelect={onShowInResults}
              actions={loopOn && !member.you ? <button style={{ ...buttonStyle('secondary'), padding: '0 8px' }} title="A route of yours with the same lemmas; copies an instruction and opens the agent chat"
                onClick={() => onAction({ action: 'agent', prompt: `Run a copy of ${short(member.id)}'s route "${route.title}" to ${title(route.target)}: run research-loop route copy ${route.planId}, then continue the loop.` })}>Run a copy ↗</button> : undefined} />
          ))}
        </section>
      )}
      {closed.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: COLOR.muted }}>{closed.length} route{closed.length === 1 ? '' : 's'} no longer open ({closed.filter((route) => route.state === 'won').length} proved a result)</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {closed.map((route) => <RouteRow key={route.planId} route={route} payload={payload} shared={new Set()} onSelect={onShowInResults} />)}
          </div>
        </details>
      )}
    </article>
  );
}

export function TeamPage({ payload, onAction, onShowInResults, onOpenSettings }: Props) {
  if (!payload) return <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>Loading…</div>;
  const team = payload.team;
  const members = teamMembers(payload);
  const unheld = (payload.routes ?? []).filter((route) => (route.state === 'live' || route.state === 'reduced') && !route.claimedBy);
  const legacy = (payload.routes ?? []).filter((route) => !route.createdBy && isOpen(route));
  const title = (id: string) => payload.nodes.find((node) => node.id === id)?.title ?? id;
  return (
    <div style={{ height: '100%', overflow: 'auto', background: COLOR.canvas }}>
      <div style={{ padding: '8px 14px', borderBottom: `1px solid ${COLOR.border}`, background: COLOR.card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Team · {members.length}</h2>
        <span style={{ fontSize: 12, color: COLOR.muted }}>
          {team ? <>Claims shared {team.shareClaims === 'auto' ? 'at once' : 'with each publish'}{team.fetchedAt ? ` · collaborators' fetched ${when(team.fetchedAt) || team.fetchedAt.slice(0, 16)}` : ' · not fetched yet'}</> : 'No identity yet: start the loop to claim work.'}
          {' · '}<a href="#" style={{ color: COLOR.link }} onClick={(event) => { event.preventDefault(); onOpenSettings(); }}>Settings</a>
        </span>
        <button style={{ ...buttonStyle('secondary'), marginLeft: 'auto' }} title="Fetch what collaborators' loops hold now (the claims branch)" onClick={() => onAction({ action: 'claims', op: 'refresh' })}>Fetch now</button>
      </div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 960 }}>
        {members.length <= 1 && (
          <div style={{ fontSize: 12.5, color: COLOR.muted, lineHeight: 1.6 }}>
            Only you so far. When collaborators run their own loops on this project (through git sync), each appears here with what their loop works on. Loops claim the route or result they work on and pass over what another holds; to work on someone's route, run a copy of it.
          </div>
        )}
        {members.map((member) => <MemberCard key={member.id} member={member} payload={payload} onAction={onAction} onShowInResults={onShowInResults} />)}
        {unheld.length > 0 && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={label}>Open routes nobody is working on · {unheld.length}</div>
            {unheld.map((route) => (
              <div key={route.planId} style={{ fontSize: 12.5, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span><b>{route.title}</b> to <a href="#" style={{ color: COLOR.link }} onClick={(event) => { event.preventDefault(); onShowInResults(route.target); }}>{title(route.target)}</a></span>
                <span style={{ color: COLOR.muted, fontSize: 11.5 }}>{route.createdBy ? `by ${short(route.createdBy)}` : 'from before routes had creators'}{route.left !== null ? ` · ${route.left === 0 ? 'complete' : `${route.left} step${route.left === 1 ? '' : 's'} left`}` : ''}</span>
              </div>
            ))}
          </section>
        )}
        {legacy.length > 0 && <div style={{ fontSize: 11.5, color: COLOR.muted }}>{legacy.length} open route(s) were written before routes had creators; every loop may work on them.</div>}
      </div>
    </div>
  );
}
