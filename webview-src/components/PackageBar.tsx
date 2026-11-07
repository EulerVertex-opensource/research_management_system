import React from 'react';
import type { PackagesPayload } from '../../src/models/packages';
import { smallButtonStyle } from './Modal';
import { CITED_COLOR } from '../graph/colors';

/**
 * The Library's research packages: import one, export this project as one,
 * and for each imported package its version, whether it is accepted, and its
 * actions. Sits above the Library list.
 */

interface Props {
  data?: PackagesPayload;
  onImport: () => void;
  onExport: () => void;
  onAccept: (alias: string) => void;
  onUpdate: (alias: string) => void;
  onRemove: (alias: string) => void;
}

export function PackageBar({ data, onImport, onExport, onAccept, onUpdate, onRemove }: Props) {
  const installed = data?.installed ?? [];
  return (
    <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--vscode-panel-border)', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5, marginRight: 'auto' }}>Packages</span>
        <button onClick={onImport} style={smallButtonStyle} title="Bring the approved results of another project into this library, with their citations">Import…</button>
        <button
          onClick={onExport}
          style={smallButtonStyle}
          title={`Package this project's approved results so another project can import them${data?.released ? ` (last release ${data.released})` : ''}`}
        >
          Export{data?.released ? ` (v${data.released})` : ''}…
        </button>
      </div>
      {installed.map((item) => (
        <div key={item.alias} style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
            <span title={`Imported from ${item.source}`} style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.alias}</span>
            <span style={{ opacity: 0.7, whiteSpace: 'nowrap' }}>{item.package} {item.version}</span>
            <span
              title={item.accepted ? 'You accepted this package; its results are used as known.' : `${item.pending} of ${item.results} results wait for you to accept the package.`}
              style={{ fontSize: 10, fontWeight: 600, padding: '0 6px', borderRadius: 8, whiteSpace: 'nowrap', color: item.accepted ? CITED_COLOR : 'var(--vscode-descriptionForeground)', border: `1px ${item.accepted ? 'solid' : 'dashed'} ${item.accepted ? CITED_COLOR : 'var(--vscode-descriptionForeground)'}` }}
            >
              {item.accepted ? '✓ ACCEPTED' : `${item.pending} TO REVIEW`}
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              {!item.accepted && !item.problems.length && <button onClick={() => onAccept(item.alias)} style={{ ...smallButtonStyle, background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)' }}>Accept</button>}
              <button onClick={() => onUpdate(item.alias)} style={smallButtonStyle} title="Bring a newer version and see what changed">Update…</button>
              <button onClick={() => onRemove(item.alias)} style={smallButtonStyle} title="Remove the package and the citations only it used">Remove</button>
            </span>
          </div>
          {item.problems.map((problem) => (
            <div key={problem} style={{ color: 'var(--vscode-errorForeground)', fontSize: 11 }}>{problem}</div>
          ))}
        </div>
      ))}
    </div>
  );
}
