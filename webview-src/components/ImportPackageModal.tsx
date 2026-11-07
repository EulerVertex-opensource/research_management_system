import React, { useEffect, useState } from 'react';
import type { ImportPreviewView } from '../../src/models/packages';
import { ItemList, Modal, buttonStyle, inputStyle, labelStyle, smallButtonStyle } from './Modal';

/**
 * Import a research package, or update an imported one: choose where it comes
 * from (a .rpkg.json file or a project folder), see exactly what would be
 * written, then confirm. The extension builds every preview; nothing is
 * written before the confirm button.
 */

interface Props {
  /** The alias of the package being updated; absent for a new import. */
  update?: string;
  preview?: ImportPreviewView;
  busy: boolean;
  onPick: (kind: 'file' | 'folder') => void;
  onAlias: (alias: string) => void;
  onConfirm: (preview: ImportPreviewView) => void;
  onCancel: () => void;
}

const ALIAS = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const BUMP_LABEL: Record<string, string> = { major: 'statements changed', minor: 'results added', patch: 'proofs or details changed', none: 'no change', initial: 'first version' };

export function ImportPackageModal({ update, preview, busy, onPick, onAlias, onConfirm, onCancel }: Props) {
  const [alias, setAlias] = useState(preview?.alias ?? '');
  useEffect(() => { if (preview) setAlias(preview.alias); }, [preview?.source, preview?.alias]);
  const aliasValid = ALIAS.test(alias) && alias.length <= 24;
  const aliasChanged = Boolean(preview && alias !== preview.alias);
  const diff = preview?.diff;

  const results = diff
    ? [
      ...diff.added.map((id) => <>added <code>{id}</code></>),
      ...diff.removed.map((id) => <>removed <code>{id}</code></>),
      ...diff.statement.map((id) => <>statement changed: <code>{id}</code> (results here that use it are checked again)</>),
      ...diff.proof.map((id) => <>proof changed: <code>{id}</code></>),
    ]
    : (preview?.nodes ?? []).map((node) => <><code>{node.id}</code> {node.title} <span style={{ opacity: 0.6 }}>({node.kind})</span></>);
  const bib = (preview?.bibChanges ?? []).filter((item) => !item.unchanged).map((item) => item.action === 'renamed'
    ? <><code>{item.key}</code> → <code>{item.as}</code> (the key is taken by another work here)</>
    : item.action === 'reused'
      ? <><code>{item.key}</code>{item.as !== item.key ? <> → <code>{item.as}</code></> : null} (already in the bibliography)</>
      : <><code>{item.key}</code> added</>);

  const canConfirm = Boolean(preview?.ok) && !busy && !aliasChanged && (Boolean(update) || aliasValid);
  return (
    <Modal
      title={update ? `Update ${update}` : 'Import a research package'}
      subtitle={preview ? `${preview.name} ${preview.version} · from ${preview.source}` : 'Approved results of another project, with their citations, become known results in this library.'}
      onClose={onCancel}
      footer={(
        <>
          <button onClick={onCancel} style={buttonStyle('secondary')}>Cancel</button>
          <button onClick={() => preview && canConfirm && onConfirm(preview)} disabled={!canConfirm} style={buttonStyle('primary', canConfirm)}>
            {update ? 'Update' : 'Import'}
          </button>
        </>
      )}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, opacity: 0.8 }}>{preview ? 'Another source:' : 'From:'}</span>
        <button onClick={() => onPick('file')} disabled={busy} style={smallButtonStyle}>A package file (.rpkg.json)…</button>
        <button onClick={() => onPick('folder')} disabled={busy} style={smallButtonStyle}>A project folder…</button>
        {busy && <span style={{ fontSize: 12, opacity: 0.6 }}>Reading…</span>}
      </div>

      {preview && !update && (
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>
            Alias <span style={{ opacity: 0.6 }}>(the library folder, and the prefix of every imported ID: lib_{alias || '…'}_…)</span>
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={alias}
              onChange={(event) => setAlias(event.target.value.trim())}
              onKeyDown={(event) => { if (event.key === 'Enter' && aliasValid && aliasChanged) onAlias(alias); }}
              style={{ ...inputStyle, borderColor: alias && !aliasValid ? 'var(--vscode-inputValidation-errorBorder)' : undefined }}
            />
            {aliasChanged && <button onClick={() => onAlias(alias)} disabled={!aliasValid || busy} style={buttonStyle('secondary', aliasValid && !busy)}>Check</button>}
          </div>
          {alias && !aliasValid && <p style={{ fontSize: 11, color: 'var(--vscode-inputValidation-errorForeground)', marginTop: 3 }}>Lowercase letters and digits, words joined by single underscores, at most 24 characters.</p>}
        </div>
      )}

      {diff && (
        <p style={{ fontSize: 12, marginBottom: 12 }}>
          {diff.from} → {diff.to}: <strong>{diff.bump}</strong> ({BUMP_LABEL[diff.bump]}).
        </p>
      )}
      {preview && (
        <>
          <ItemList title="Conflicts (fix these first)" items={preview.conflicts} tone="error" />
          <ItemList title={diff ? 'Changes' : `Results and definitions (${preview.nodes.length})`} items={results} />
          <ItemList title="Bibliography" items={bib} />
          <ItemList title="Warnings" items={preview.warnings} tone="warning" />
          {preview.ok && (
            <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
              {update
                ? 'Unchanged results stay accepted; changed ones wait for you to accept the package again.'
                : 'The files are read-only copies pinned by a lockfile. After importing, accept the package once to use its results as known.'}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
