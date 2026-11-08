import React from 'react';
import type { CollectionView, InstalledPackageView, PackagesPayload } from '../../src/models/packages';
import { CITED_COLOR, COLOR } from '../graph/colors';
import { buttonStyle } from '../graph/AttentionList';

/**
 * The top of the Library column: import and export packages, then one card per
 * collection, in two groups. Imported packages were approved upstream and are
 * accepted once, as a whole; collections extracted from papers and notes are
 * checked against their source one result at a time. Clicking a card shows
 * only its results in the list below. The column can be narrow, so labels are
 * written out and actions wrap instead of shrinking.
 */

interface Props {
  data?: PackagesPayload;
  /** The collection the list below is limited to. */
  selected?: string;
  onSelect: (name: string | undefined) => void;
  onImport: () => void;
  onExport: () => void;
  onAccept: (alias: string) => void;
  onUpdate: (alias: string) => void;
  onRemove: (alias: string) => void;
  onCheck: (collection: string) => void;
  onOpenPaper: (paperId: string) => void;
  onRemoveCollection: (name: string) => void;
}

/** What a card gets: the bar's actions, whether it is the chosen one, and how to choose it. */
type CardProps = Omit<Props, 'selected' | 'onSelect'> & { selected: boolean; onSelect: (name: string) => void };

const wide: React.CSSProperties = { flex: '1 1 140px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '4px 10px' };
const groupLabel: React.CSSProperties = { fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 };
const KIND_LABEL: Record<CollectionView['kind'], string> = { paper: 'paper', note: 'notes', thesis: 'thesis', other: 'known results' };

export function LibraryBar(props: Props) {
  const { data, selected, onSelect, onImport, onExport } = props;
  const installed = data?.installed ?? [];
  const collections = data?.collections ?? [];
  const toggle = (name: string) => onSelect(selected === name ? undefined : name);
  return (
    <div style={{ padding: '8px 12px 10px', borderBottom: `1px solid ${COLOR.border}`, display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0, maxHeight: '55%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={onImport} style={{ ...buttonStyle('secondary'), ...wide }} title="Bring the approved results of another project into this library, with their citations">
          Import a package…
        </button>
        <button onClick={onExport} style={{ ...buttonStyle('secondary'), ...wide }} title="Package this project's approved results so another project can import them">
          Export this project…
        </button>
      </div>
      {data?.released && <div style={{ fontSize: 11, color: COLOR.muted, marginTop: -2 }}>This project&apos;s latest release: v{data.released}</div>}

      <div style={groupLabel}>Packages</div>
      {!installed.length && (
        <div style={{ fontSize: 11, color: COLOR.muted }}>No packages imported. A package brings another project&apos;s approved results here as known results.</div>
      )}
      {installed.map((item) => (
        <PackageCard {...props} key={item.alias} item={item} selected={selected === item.alias} onSelect={toggle} />
      ))}

      <div style={groupLabel}>From papers &amp; notes</div>
      {!collections.length && (
        <div style={{ fontSize: 11, color: COLOR.muted }}>None yet. Ask the agent to extract the results of a paper or your notes into the library; each one is then checked against its source.</div>
      )}
      {collections.map((item) => (
        <CollectionCard {...props} key={item.name} item={item} selected={selected === item.name} onSelect={toggle} />
      ))}
    </div>
  );
}

/** A clickable card; buttons inside it act without toggling the filter. */
function Card({ name, selected, onSelect, children }: { name: string; selected: boolean; onSelect: (name: string) => void; children: React.ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      title={selected ? 'Showing only these results; click to show the whole library' : 'Show only these results in the list'}
      onClick={() => onSelect(name)}
      onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) { event.preventDefault(); onSelect(name); } }}
      style={{
        border: `1px solid ${selected ? 'var(--vscode-focusBorder)' : COLOR.border}`, boxShadow: selected ? '0 0 0 1px var(--vscode-focusBorder)' : undefined,
        borderRadius: 6, background: COLOR.card, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, cursor: 'pointer', flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

function Badge({ done, title, children }: { done: boolean; title: string; children: React.ReactNode }) {
  const color = done ? CITED_COLOR : COLOR.waiting;
  return (
    <span title={title} style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, padding: '0 6px', borderRadius: 8, whiteSpace: 'nowrap', color, border: `1px ${done ? 'solid' : 'dashed'} ${color}` }}>
      {children}
    </span>
  );
}

const stop = (action: () => void) => (event: React.MouseEvent) => { event.stopPropagation(); action(); };
const nameStyle: React.CSSProperties = { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const mutedLine: React.CSSProperties = { color: COLOR.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const actions: React.CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 };

function PackageCard({ item, selected, onSelect, onAccept, onUpdate, onRemove }: CardProps & { item: InstalledPackageView }) {
  const accepted = item.accepted;
  const canAccept = !accepted && !item.problems.length;
  return (
    <Card name={item.alias} selected={selected} onSelect={onSelect}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span style={nameStyle} title={`Library folder and ID prefix: lib_${item.alias}_…`}>{item.alias}</span>
        {item.package !== item.alias && <span style={{ color: COLOR.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.package}</span>}
        <span style={{ color: COLOR.muted, whiteSpace: 'nowrap' }}>v{item.version}</span>
        <Badge done={accepted} title={accepted ? 'You accepted this package; its results are used as known.' : `${item.pending} of ${item.results} results wait for you to accept the package.`}>
          {accepted ? '✓ ACCEPTED' : `${item.pending} TO REVIEW`}
        </Badge>
      </div>
      <div style={mutedLine} title={item.source}>
        {item.results} result{item.results === 1 ? '' : 's'} · from {item.source}
        {item.approvedVersion ? ` · v${item.approvedVersion} accepted earlier` : ''}
      </div>
      {item.problems.map((problem) => <div key={problem} style={{ color: COLOR.error, fontSize: 11 }}>{problem}</div>)}
      <div style={actions}>
        {canAccept && <button onClick={stop(() => onAccept(item.alias))} style={buttonStyle('primary')} title="Accept every result of the package as known, once">Accept package</button>}
        <button onClick={stop(() => onUpdate(item.alias))} style={buttonStyle('secondary')} title="Bring a newer version and see what changed">Update…</button>
        <button onClick={stop(() => onRemove(item.alias))} style={{ ...buttonStyle('secondary'), color: COLOR.error }} title="Remove the package and the citations only it used">Remove…</button>
      </div>
    </Card>
  );
}

function CollectionCard({ item, selected, onSelect, onCheck, onOpenPaper, onRemoveCollection }: CardProps & { item: CollectionView }) {
  const drafts = item.drafts.length;
  const source = item.paperTitle ?? item.title ?? item.paperId;
  return (
    <Card name={item.name} selected={selected} onSelect={onSelect}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span style={nameStyle} title={`Library folder: ${item.name}`}>{item.name}</span>
        <span style={{ color: COLOR.muted, whiteSpace: 'nowrap' }} title={item.declared ? 'From collection.md' : 'collection.md does not say; inferred from the results'}>{KIND_LABEL[item.kind]}</span>
        {item.results > 0 && (
          <Badge done={!drafts} title={drafts ? `${drafts} of ${item.results} results are not checked against the source yet.` : 'You checked every result against the source.'}>
            {drafts ? `${drafts} TO CHECK` : '✓ CHECKED'}
          </Badge>
        )}
      </div>
      <div style={mutedLine} title={source}>
        {item.results} result{item.results === 1 ? '' : 's'}{item.results ? ` (${item.approved} checked)` : ''}{source ? ` · ${source}` : ''}
      </div>
      {item.problems.map((problem) => <div key={problem} style={{ color: COLOR.error, fontSize: 11 }}>{problem}</div>)}
      <div style={actions}>
        {drafts > 0 && (
          <button onClick={stop(() => onCheck(item.name))} style={buttonStyle('primary')} title="Go through the unchecked results one by one, each beside its place in the source">
            Check {drafts} result{drafts === 1 ? '' : 's'}…
          </button>
        )}
        {item.paperId && item.paperIndexed && (
          <button onClick={stop(() => onOpenPaper(item.paperId!))} style={buttonStyle('secondary')} title={`Open the PDF of ${item.paperId}`}>Open paper</button>
        )}
        <button onClick={stop(() => onRemoveCollection(item.name))} style={{ ...buttonStyle('secondary'), color: COLOR.error }} title="Delete these known results; the paper stays in Papers">Remove…</button>
      </div>
    </Card>
  );
}
