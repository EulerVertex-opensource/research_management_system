import React, { useEffect, useState } from 'react';
import type { ExportPreviewView, ExportRequest } from '../../src/models/packages';
import { ItemList, Modal, buttonStyle, inputStyle, labelStyle } from './Modal';

/**
 * Export this project as a research package: name it, choose which approved
 * results to export, and see what goes in (everything they rest on), what
 * blocks it, and the version the changes call for. Each edit asks the
 * extension for a fresh preview.
 */

interface Props {
  preview?: ExportPreviewView;
  busy: boolean;
  onChange: (request: ExportRequest) => void;
  onConfirm: (request: ExportRequest) => void;
  onCancel: () => void;
}

const SLUG = /^[a-z][a-z0-9_]*$/;
const BUMP_LABEL: Record<string, string> = { initial: 'first release', major: 'statements changed or results removed', minor: 'results added', patch: 'proofs or details changed', none: 'unchanged since the last release' };

export function ExportPackageModal({ preview, busy, onChange, onConfirm, onCancel }: Props) {
  const [ready, setReady] = useState(Boolean(preview));
  const [name, setName] = useState(preview?.manifest.name ?? '');
  const [citation, setCitation] = useState(preview?.citation ?? '');
  const [exports, setExports] = useState<string[]>(preview?.exports ?? []);
  const [version, setVersion] = useState('');
  const [locations, setLocations] = useState<Record<string, string>>(preview?.manifest.locations ?? {});

  // The first preview fills the form from the saved manifest; later ones only report on it.
  useEffect(() => {
    if (!preview || ready) return;
    setName(preview.manifest.name ?? '');
    setCitation(preview.citation);
    setExports(preview.exports);
    setLocations(preview.manifest.locations ?? {});
    setReady(true);
  }, [preview, ready]);

  const request: ExportRequest = { name, citation, exports, locations, ...(version.trim() ? { version: version.trim() } : {}) };
  const key = JSON.stringify(request);
  // The request the shown preview answers; the form filled from the first preview needs no new one.
  const [sentKey, setSentKey] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!ready) return;
    if (sentKey === undefined) { setSentKey(key); return; }
    if (sentKey === key) return;
    const timer = setTimeout(() => { setSentKey(key); onChange(request); }, 400);
    return () => clearTimeout(timer);
  }, [key, ready, sentKey]);

  const toggle = (id: string) => setExports((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const fresh = sentKey === key;
  const canConfirm = Boolean(preview?.ok) && ready && fresh && !busy;
  const changes = preview?.changes;
  const changeItems = changes ? [
    ...changes.added.map((id) => `added ${id}`), ...changes.removed.map((id) => `removed ${id}`),
    ...changes.statement.map((id) => `statement changed: ${id}`), ...changes.proof.map((id) => `proof changed: ${id}`),
    ...changes.exportsAdded.map((id) => `newly exported: ${id}`), ...changes.exportsRemoved.map((id) => `no longer exported: ${id}`),
  ] : [];

  return (
    <Modal
      title="Export this project as a research package"
      subtitle="Another project imports it into its library and uses the results as known. Only approved results go in; ideas, plans, and the manuscript stay here."
      width={620}
      onClose={onCancel}
      footer={(
        <>
          {busy && <span style={{ fontSize: 12, opacity: 0.6, marginRight: 'auto', alignSelf: 'center' }}>Checking…</span>}
          <button onClick={onCancel} style={buttonStyle('secondary')}>Cancel</button>
          <button onClick={() => canConfirm && onConfirm(request)} disabled={!canConfirm} style={buttonStyle('primary', canConfirm)}>
            Export {preview?.version ?? ''}…
          </button>
        </>
      )}
    >
      {!ready ? <p style={{ fontSize: 12, opacity: 0.6, marginBottom: 12 }}>Reading the project…</p> : (
        <>
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Package name</label>
            <input value={name} onChange={(event) => setName(event.target.value.trim())} placeholder="heat_kernel_bounds"
              style={{ ...inputStyle, borderColor: name && !SLUG.test(name) ? 'var(--vscode-inputValidation-errorBorder)' : undefined }} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>
              Cite this work as <span style={{ opacity: 0.6 }}>(its own BibTeX entry, kept apart from the paper&apos;s bibliography; importers cite it for the results proved here{preview?.citationSaved ? '' : '; saved when you export'})</span>
            </label>
            <textarea value={citation} onChange={(event) => setCitation(event.target.value)} rows={7} spellCheck={false}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 12 }} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Results to export <span style={{ opacity: 0.6 }}>(everything they depend on goes in too)</span></label>
            <div style={{ border: '1px solid var(--vscode-panel-border)', borderRadius: 4, maxHeight: 180, overflow: 'auto', padding: '4px 8px' }}>
              {preview?.candidates.length ? preview.candidates.map((item) => (
                <label key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '3px 0', cursor: 'pointer' }}>
                  <input type="checkbox" checked={exports.includes(item.id)} onChange={() => toggle(item.id)} />
                  <span style={{ flex: 1 }}>{item.title} <code style={{ opacity: 0.6 }}>{item.id}</code></span>
                  {item.required && <span style={{ fontSize: 10, opacity: 0.7 }}>GOAL</span>}
                  {!item.approved && <span style={{ fontSize: 10, color: 'var(--vscode-editorWarning-foreground)' }}>NOT APPROVED</span>}
                </label>
              )) : <div style={{ fontSize: 12, opacity: 0.6, padding: 4 }}>No results in this project yet.</div>}
            </div>
          </div>

          {exports.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Where each is in your paper <span style={{ opacity: 0.6 }}>(optional, e.g. Theorem 1.2; importers cite it there)</span></label>
              {exports.map((id) => (
                <div key={id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <code style={{ fontSize: 12, minWidth: 140, opacity: 0.8 }}>{id}</code>
                  <input value={locations[id] ?? ''} onChange={(event) => setLocations((current) => ({ ...current, [id]: event.target.value }))} placeholder="Theorem 1.2" style={{ ...inputStyle, padding: '3px 8px', fontSize: 12 }} />
                </div>
              ))}
            </div>
          )}

          {preview && (
            <>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 14 }}>
                <div style={{ width: 140 }}>
                  <label style={labelStyle}>Version</label>
                  <input value={version} onChange={(event) => setVersion(event.target.value.trim())} placeholder={preview.version} style={inputStyle} />
                </div>
                <p style={{ fontSize: 12, opacity: 0.8, paddingBottom: 6 }}>
                  {preview.previous ? `${preview.previous} → ${preview.version}: ` : ''}{BUMP_LABEL[preview.bump]}
                  {preview.unchanged ? '. Exporting writes the same version again.' : '.'}
                </p>
              </div>
              <ItemList title="Blocked" items={preview.blockers} tone="error" />
              <ItemList title="Changes since the last release" items={changeItems} />
              <ItemList title={`Included (${preview.closure.length})`} items={preview.closure.map((node) => <>{node.title} <code style={{ opacity: 0.6 }}>{node.id}</code>{node.origin === 'library' ? <span style={{ opacity: 0.6 }}> (library)</span> : null}</>)} max={8} />
              <ItemList title="Warnings" items={preview.warnings} tone="warning" />
            </>
          )}
        </>
      )}
    </Modal>
  );
}
