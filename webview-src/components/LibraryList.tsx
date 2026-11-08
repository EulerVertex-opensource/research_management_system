import React, { useEffect, useRef, useState } from 'react';
import type { ResearchNode } from '../../src/models/types';
import type { CollectionView, InstalledPackageView, PackagesPayload } from '../../src/models/packages';
import { CITED_SOURCE_KINDS } from '../../src/domain/nodeKinds';
import { CITED_COLOR, COLOR, tint } from '../graph/colors';
import { buttonStyle } from '../graph/AttentionList';
import { NodeListItem, kindLabelStyle, researchCardStyle } from './NodeList';
import { useTechnical } from '../technical';

/**
 * The Library as one list of folds: each collection (an imported package, or
 * results extracted from a paper or notes) with its state and actions, opening
 * onto its results; click one to show it in the panel next to the list. Drawn
 * in the style of the other Research lists (NodeList's cards), not the tinted
 * boxes of the Work pages. Packages were approved
 * upstream and are accepted as a whole; extracted results are checked against
 * their source one at a time.
 */

interface Props {
  nodes: ResearchNode[];
  data?: PackagesPayload;
  selectedId: string | null;
  onSelect: (node: ResearchNode) => void;
  onImport: () => void;
  onExport: () => void;
  onAccept: (alias: string) => void;
  onUpdate: (alias: string) => void;
  onRemove: (alias: string) => void;
  onCheck: (collection: string) => void;
  onOpenPaper: (paperId: string) => void;
  onRemoveCollection: (name: string) => void;
}

type StatusFilter = 'all' | 'draft' | 'approved';
const KIND_LABEL: Record<CollectionView['kind'], string> = { paper: 'Paper', note: 'Notes', thesis: 'Thesis', other: 'Known results' };
const ellipsis: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
const groupLabel: React.CSSProperties = { fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5, margin: '4px 2px 0' };
/** Import and export share the row; written out in full, they wrap rather than shrink in a narrow column. */
const wide: React.CSSProperties = { flex: '1 1 140px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '4px 10px' };
const control: React.CSSProperties = { padding: '4px 8px', fontSize: 12, borderRadius: 4, background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)' };

/** The outlined state badge of the Research lists: solid once done, dashed while it waits. */
function Badge({ tone, children, title }: { tone: 'done' | 'waiting' | 'problem'; children: React.ReactNode; title?: string }) {
  const color = tone === 'done' ? CITED_COLOR : tone === 'problem' ? COLOR.error : 'var(--vscode-descriptionForeground)';
  return (
    <span title={title} style={{ fontSize: 10, fontWeight: 600, padding: '0 6px', borderRadius: 8, color, border: `1px ${tone === 'waiting' ? 'dashed' : 'solid'} ${color}`, background: tone === 'done' ? tint(CITED_COLOR, 10) : 'transparent', whiteSpace: 'nowrap', flexShrink: 0 }}>
      {children}
    </span>
  );
}

/** Whether a fold waits for the researcher: a package to accept, results to check, or a problem. */
const needsYou = (item: InstalledPackageView | CollectionView) => item.problems.length > 0 || ('accepted' in item ? !item.accepted : item.drafts.length > 0);

const byOrder = (a: ResearchNode, b: ResearchNode) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.title.localeCompare(b.title);

export function LibraryList(props: Props) {
  const { nodes, data, selectedId } = props;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  // Like the Results list, a fold that needs the researcher starts open and a finished one folded; a click flips that.
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const refs = useRef(new Map<string, HTMLElement>());

  const library = nodes.filter((node) => node.origin === 'library');
  const selectedCollection = library.find((node) => node.id === selectedId)?.collection;
  // A result chosen elsewhere (a link, the next one to check) opens its fold and scrolls into view.
  useEffect(() => {
    if (!selectedId || !selectedCollection) return;
    setRevealed((current) => current.has(selectedCollection) ? current : new Set([...current, selectedCollection]));
    const timer = setTimeout(() => refs.current.get(selectedId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
    return () => clearTimeout(timer);
  }, [selectedId, selectedCollection]);

  const query = search.trim().toLowerCase();
  const filtering = Boolean(query) || status !== 'all';
  const matches = (node: ResearchNode) => (status === 'all' || node.status === status)
    && (!query || [node.title, node.id, ...node.tags].some((text) => text.toLowerCase().includes(query)));
  const members = (name: string) => library.filter((node) => node.collection === name && matches(node)).sort(byOrder);
  const isOpen = (name: string, attention: boolean) => filtering || revealed.has(name) || attention !== flipped.has(name);
  const toggle = (name: string, attention: boolean) => {
    const open = !isOpen(name, attention);
    setRevealed((current) => { const next = new Set(current); next.delete(name); return next; });
    setFlipped((current) => { const next = new Set(current); if (open !== attention) next.add(name); else next.delete(name); return next; });
  };

  const packages = data?.installed ?? [];
  const known = new Set([...packages.map((item) => item.alias), ...(data?.collections ?? []).map((item) => item.name)]);
  // Collections the overview has not described yet (still loading) show by name.
  const collections: CollectionView[] = [
    ...(data?.collections ?? []),
    ...[...new Set(library.map((node) => node.collection ?? ''))].filter((name) => name && !known.has(name)).sort().map((name) => {
      const inside = library.filter((node) => node.collection === name);
      return { name, kind: 'other' as const, declared: false, results: inside.length, approved: inside.filter((node) => node.status === 'approved').length, drafts: inside.filter((node) => node.status === 'draft').map((node) => node.id), problems: [] };
    }),
  ];
  const shownPackages = packages.filter((item) => !filtering || members(item.alias).length);
  const shownCollections = collections.filter((item) => !filtering || members(item.name).length);
  const row = (node: ResearchNode) => (
    <LibraryRow key={node.id} node={node} selected={node.id === selectedId} onSelect={props.onSelect}
      innerRef={(element) => { if (element) refs.current.set(node.id, element); else refs.current.delete(node.id); }} />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: '8px 12px 0', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={props.onImport} style={{ ...buttonStyle('secondary'), ...wide }} title="Bring the approved results of another project into this library, with their citations">
          Import a package…
        </button>
        <button onClick={props.onExport} style={{ ...buttonStyle('secondary'), ...wide }} title="Package this project's approved results so another project can import them">
          Export this project…
        </button>
      </div>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--vscode-panel-border)', display: 'flex', gap: 8 }}>
        <input placeholder="Search…" value={search} onChange={(event) => setSearch(event.target.value)} style={{ ...control, flex: 1, minWidth: 0 }} />
        <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} style={{ ...control, background: 'var(--vscode-dropdown-background)', color: 'var(--vscode-dropdown-foreground)', border: '1px solid var(--vscode-dropdown-border)' }}>
          <option value="all">All</option>
          <option value="draft">Not checked</option>
          <option value="approved">Checked</option>
        </select>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(!filtering || shownPackages.length > 0) && <div style={groupLabel}>Packages</div>}
        {!filtering && data?.released && <div style={{ fontSize: 11, color: COLOR.muted, marginTop: -4 }}>This project&apos;s latest release: v{data.released}</div>}
        {!filtering && !packages.length && <div style={{ fontSize: 11, color: COLOR.muted }}>No packages imported. A package brings another project&apos;s approved results here as known results.</div>}
        {shownPackages.map((item) => (
          <PackageFold key={item.alias} {...props} item={item} expanded={isOpen(item.alias, needsYou(item))} onToggle={() => toggle(item.alias, needsYou(item))}>
            {members(item.alias).map(row)}
          </PackageFold>
        ))}

        {(!filtering || shownCollections.length > 0) && <div style={groupLabel}>From papers &amp; notes</div>}
        {!filtering && !collections.length && <div style={{ fontSize: 11, color: COLOR.muted }}>None yet. Ask the agent to extract the results of a paper or your notes into the library; each one is then checked against its source.</div>}
        {shownCollections.map((item) => (
          <CollectionFold key={item.name} {...props} item={item} expanded={isOpen(item.name, needsYou(item))} onToggle={() => toggle(item.name, needsYou(item))}>
            {members(item.name).map(row)}
          </CollectionFold>
        ))}

        {filtering && !shownPackages.length && !shownCollections.length && <div style={{ padding: '24px 16px', opacity: 0.5, fontSize: 13, textAlign: 'center' }}>No known results match.</div>}
      </div>
    </div>
  );
}

interface FoldProps {
  /** The small uppercase label: Package, Paper, Notes, … */
  kind: string;
  done: boolean;
  badge: React.ReactNode;
  badgeTitle?: string;
  name: string;
  extra?: React.ReactNode;
  subtitle: React.ReactNode;
  problems: string[];
  expanded: boolean;
  onToggle: () => void;
  actions: React.ReactNode;
  children: React.ReactNode;
}

/**
 * A collection: a card like a node's (kind and state, name, one line of
 * detail) that opens onto its results, listed under it along a guide line.
 */
function Fold({ kind, done, badge, badgeTitle, name, extra, subtitle, problems, expanded, onToggle, actions, children }: FoldProps) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
      <div style={{ ...researchCardStyle(), padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button aria-expanded={expanded} onClick={onToggle}
          style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4, padding: 0, border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 0 }}>
            <span style={kindLabelStyle}>{kind}</span>
            <Badge tone={problems.length ? 'problem' : done ? 'done' : 'waiting'} title={badgeTitle}>{problems.length ? `⚠ ${problems.length} PROBLEM${problems.length === 1 ? '' : 'S'}` : badge}</Badge>
            <span aria-hidden="true" style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 11, flexShrink: 0 }}>{expanded ? '▾' : '▸'}</span>
          </span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', width: '100%', minWidth: 0 }}>
            <span style={{ ...ellipsis, fontSize: 13, fontWeight: 500 }} title={name}>{name}</span>
            {extra}
          </span>
          <span style={{ ...ellipsis, fontSize: 11, opacity: 0.6, width: '100%' }}>{subtitle}</span>
        </button>
        {expanded && (
          <>
            {problems.map((problem) => <div key={problem} style={{ color: COLOR.error, fontSize: 11 }}>{problem}</div>)}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{actions}</div>
          </>
        )}
      </div>
      {expanded && React.Children.count(children) > 0 && (
        <div style={{ marginLeft: 6, paddingLeft: 8, borderLeft: '2px solid var(--vscode-panel-border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {children}
        </div>
      )}
    </section>
  );
}

type FoldOf<T> = Props & { item: T; expanded: boolean; onToggle: () => void; children: React.ReactNode };

function PackageFold({ item, expanded, onToggle, children, onAccept, onUpdate, onRemove }: FoldOf<InstalledPackageView>) {
  const canAccept = !item.accepted && !item.problems.length;
  return (
    <Fold
      kind="Package" done={item.accepted}
      badge={item.accepted ? '✓ ACCEPTED' : `${item.pending} TO REVIEW`}
      badgeTitle={item.accepted ? 'You accepted this package; its results are used as known.' : `${item.pending} of ${item.results} results wait for you to accept the package.`}
      name={item.alias} extra={<span style={{ fontSize: 11, opacity: 0.6, flexShrink: 0 }}>v{item.version}</span>}
      subtitle={<span title={item.source}>{item.package !== item.alias ? `${item.package} · ` : ''}{item.results} result{item.results === 1 ? '' : 's'} · from {item.source}{item.approvedVersion ? ` · v${item.approvedVersion} accepted earlier` : ''}</span>}
      problems={item.problems} expanded={expanded} onToggle={onToggle}
      actions={(
        <>
          {canAccept && <button onClick={() => onAccept(item.alias)} style={buttonStyle('primary')} title="Accept every result of the package as known, once">Accept package</button>}
          <button onClick={() => onUpdate(item.alias)} style={buttonStyle('secondary')} title="Bring a newer version and see what changed">Update…</button>
          <button onClick={() => onRemove(item.alias)} style={{ ...buttonStyle('secondary'), color: COLOR.error }} title="Remove the package and the citations only it used">Remove…</button>
        </>
      )}
    >
      {children}
    </Fold>
  );
}

function CollectionFold({ item, expanded, onToggle, children, onCheck, onOpenPaper, onRemoveCollection }: FoldOf<CollectionView>) {
  const drafts = item.drafts.length;
  const source = item.paperTitle ?? item.title ?? item.paperId;
  return (
    <Fold
      kind={KIND_LABEL[item.kind]} done={!drafts && item.results > 0}
      badge={!item.results ? 'EMPTY' : drafts ? `${drafts} TO CHECK` : '✓ CHECKED'}
      badgeTitle={drafts ? `${drafts} of ${item.results} results are not checked against the source yet.` : 'You checked every result against the source.'}
      name={item.name}
      subtitle={<span title={source}>{item.results} result{item.results === 1 ? '' : 's'}{source ? ` · ${source}` : ''}</span>}
      problems={item.problems} expanded={expanded} onToggle={onToggle}
      actions={(
        <>
          {drafts > 0 && (
            <button onClick={() => onCheck(item.name)} style={buttonStyle('primary')} title="Go through the unchecked results one by one, each beside its place in the source">
              Check {drafts} result{drafts === 1 ? '' : 's'}…
            </button>
          )}
          {item.paperId && item.paperIndexed && <button onClick={() => onOpenPaper(item.paperId!)} style={buttonStyle('secondary')} title={`Open the PDF of ${item.paperId}`}>Open paper</button>}
          <button onClick={() => onRemoveCollection(item.name)} style={{ ...buttonStyle('secondary'), color: COLOR.error }} title="Delete these known results; the paper stays in Papers">Remove…</button>
        </>
      )}
    >
      {children}
    </Fold>
  );
}

/** One known result: the Research list's node card, with where in the source it comes from. */
function LibraryRow({ node, selected, onSelect, innerRef }: { node: ResearchNode; selected: boolean; onSelect: (node: ResearchNode) => void; innerRef: (element: HTMLElement | null) => void }) {
  const technical = useTechnical();
  const source = node.source && CITED_SOURCE_KINDS.has(node.source.kind) && node.source.paper_id ? `${node.source.paper_id}${node.source.location ? `, ${node.source.location}` : ''}` : undefined;
  const meta = [source, technical ? node.id : undefined].filter(Boolean).join(' · ');
  return <NodeListItem node={node} selected={selected} onSelect={onSelect} meta={meta || undefined} innerRef={innerRef} />;
}
