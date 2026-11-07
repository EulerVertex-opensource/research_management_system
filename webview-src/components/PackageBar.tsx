import React from 'react';
import type { InstalledPackageView, PackagesPayload } from '../../src/models/packages';
import { CITED_COLOR, COLOR } from '../graph/colors';
import { buttonStyle } from '../graph/AttentionList';

/**
 * The Library's research packages: import one, export this project as one,
 * and a card for each imported package with its version, whether it is
 * accepted, and its actions. Sits above the Library list, whose column can be
 * narrow, so labels are written out and actions wrap instead of shrinking.
 */

interface Props {
  data?: PackagesPayload;
  onImport: () => void;
  onExport: () => void;
  onAccept: (alias: string) => void;
  onUpdate: (alias: string) => void;
  onRemove: (alias: string) => void;
}

const wide: React.CSSProperties = { flex: '1 1 140px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '4px 10px' };

export function PackageBar({ data, onImport, onExport, onAccept, onUpdate, onRemove }: Props) {
  const installed = data?.installed ?? [];
  return (
    <div style={{ padding: '8px 12px 10px', borderBottom: `1px solid ${COLOR.border}`, display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
      <div style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Packages</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={onImport} style={{ ...buttonStyle('secondary'), ...wide }} title="Bring the approved results of another project into this library, with their citations">
          Import a package…
        </button>
        <button onClick={onExport} style={{ ...buttonStyle('secondary'), ...wide }} title="Package this project's approved results so another project can import them">
          Export this project…
        </button>
      </div>
      {data?.released && <div style={{ fontSize: 11, color: COLOR.muted, marginTop: -2 }}>This project&apos;s latest release: v{data.released}</div>}
      {!installed.length && (
        <div style={{ fontSize: 11, color: COLOR.muted }}>No packages imported. A package brings another project&apos;s approved results here as known results.</div>
      )}
      {installed.map((item) => (
        <PackageCard key={item.alias} item={item} onAccept={onAccept} onUpdate={onUpdate} onRemove={onRemove} />
      ))}
    </div>
  );
}

function PackageCard({ item, onAccept, onUpdate, onRemove }: { item: InstalledPackageView; onAccept: (alias: string) => void; onUpdate: (alias: string) => void; onRemove: (alias: string) => void }) {
  const accepted = item.accepted;
  const badgeColor = accepted ? CITED_COLOR : COLOR.waiting;
  const canAccept = !accepted && !item.problems.length;
  return (
    <div style={{ border: `1px solid ${COLOR.border}`, borderRadius: 6, background: COLOR.card, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`Library folder and ID prefix: lib_${item.alias}_…`}>{item.alias}</span>
        {item.package !== item.alias && <span style={{ color: COLOR.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.package}</span>}
        <span style={{ color: COLOR.muted, whiteSpace: 'nowrap' }}>v{item.version}</span>
        <span
          title={accepted ? 'You accepted this package; its results are used as known.' : `${item.pending} of ${item.results} results wait for you to accept the package.`}
          style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, padding: '0 6px', borderRadius: 8, whiteSpace: 'nowrap', color: badgeColor, border: `1px ${accepted ? 'solid' : 'dashed'} ${badgeColor}` }}
        >
          {accepted ? '✓ ACCEPTED' : `${item.pending} TO REVIEW`}
        </span>
      </div>
      <div style={{ color: COLOR.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.source}>
        {item.results} result{item.results === 1 ? '' : 's'} · from {item.source}
        {item.approvedVersion ? ` · v${item.approvedVersion} accepted earlier` : ''}
      </div>
      {item.problems.map((problem) => (
        <div key={problem} style={{ color: COLOR.error, fontSize: 11 }}>{problem}</div>
      ))}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
        {canAccept && (
          <button onClick={() => onAccept(item.alias)} style={buttonStyle('primary')} title="Accept every result of the package as known, once">Accept package</button>
        )}
        <button onClick={() => onUpdate(item.alias)} style={buttonStyle('secondary')} title="Bring a newer version and see what changed">Update…</button>
        <button onClick={() => onRemove(item.alias)} style={{ ...buttonStyle('secondary'), color: COLOR.error }} title="Remove the package and the citations only it used">Remove…</button>
      </div>
    </div>
  );
}
