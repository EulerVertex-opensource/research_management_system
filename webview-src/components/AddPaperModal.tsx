import React, { useState } from 'react';

export function slugFromFilename(name: string): string {
  return name
    .replace(/\.pdf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function defaultBib(slug: string): string {
  return `@article{${slug},\n  author  = {},\n  title   = {},\n  journal = {},\n  year    = {}\n}`;
}

// Extract the key from a BibTeX entry string
function extractBibKey(bib: string): string {
  const m = bib.match(/@\w+\{([^,\s]+),/);
  return m ? m[1] : '';
}

// Replace only the key part of a BibTeX entry.
// Uses [^,]* (zero-or-more) so it also matches @article{, left by an empty slug.
function replaceBibKey(bib: string, newKey: string): string {
  return bib.replace(/(@\w+\{)[^,]*,/, `$1${newKey},`);
}

interface Props {
  fileName: string;
  onConfirm: (slug: string, bibEntry: string, description: string, sourceUrl: string) => void;
  onCancel: () => void;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  background: 'var(--vscode-input-background)',
  color: 'var(--vscode-input-foreground)',
  border: '1px solid var(--vscode-input-border)',
  borderRadius: 4,
  fontSize: 13,
  fontFamily: 'var(--vscode-font-family)',
};

export function AddPaperModal({ fileName, onConfirm, onCancel }: Props) {
  const initialSlug = slugFromFilename(fileName);
  const [slug, setSlug] = useState(initialSlug);
  const [bibEntry, setBibEntry] = useState(() => defaultBib(initialSlug));
  const [description, setDescription] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');

  // Slug field changed → update the bib key to match
  const handleSlugChange = (newSlug: string) => {
    setSlug(newSlug);
    setBibEntry((prev) => replaceBibKey(prev, newSlug));
  };

  // BibTeX textarea changed → if the key changed, sync slug to match
  const handleBibChange = (newBib: string) => {
    setBibEntry(newBib);
    const newKey = extractBibKey(newBib);
    if (newKey && newKey !== slug) {
      setSlug(newKey);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = slug.trim();
    if (trimmed) onConfirm(trimmed, bibEntry.trim(), description.trim(), sourceUrl.trim());
  };

  const slugValid = /^[a-z0-9_]+$/.test(slug.trim());

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        style={{
          background: 'var(--vscode-editor-background)',
          border: '1px solid var(--vscode-panel-border)',
          borderRadius: 8,
          padding: 24,
          width: 480,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          position: 'relative',
        }}
      >
        {/* Close button */}
        <button
          onClick={onCancel}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 10,
            right: 12,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            color: 'var(--vscode-foreground)',
            opacity: 0.6,
            padding: '2px 4px',
          }}
        >
          ✕
        </button>

        <h3 style={{ marginBottom: 4, fontSize: 15 }}>Add Paper</h3>
        <p style={{ fontSize: 12, opacity: 0.6, marginBottom: 18 }}>{fileName}</p>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, marginBottom: 4, opacity: 0.8 }}>
              Slug <span style={{ opacity: 0.5 }}>(= BibTeX key — lowercase, underscores only)</span>
            </label>
            <input
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              autoFocus
              style={{
                ...inputStyle,
                borderColor: slug.trim() && !slugValid ? 'var(--vscode-inputValidation-errorBorder)' : undefined,
              }}
            />
            {slug.trim() && !slugValid && (
              <p style={{ fontSize: 11, color: 'var(--vscode-inputValidation-errorForeground)', marginTop: 3 }}>
                Use only lowercase letters, digits, and underscores.
              </p>
            )}
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, marginBottom: 4, opacity: 0.8 }}>
              BibTeX entry <span style={{ opacity: 0.5 }}>(editing the key updates the slug above)</span>
            </label>
            <textarea
              value={bibEntry}
              onChange={(e) => handleBibChange(e.target.value)}
              rows={6}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 12 }}
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, marginBottom: 4, opacity: 0.8 }}>
              Stable source URL <span style={{ opacity: 0.5 }}>(DOI, arXiv, or publisher; shared in Git)</span>
            </label>
            <input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://arxiv.org/abs/..."
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 12, marginBottom: 4, opacity: 0.8 }}>
              Short description <span style={{ opacity: 0.5 }}>(optional)</span>
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Proves the main density theorem we use in §3"
              style={inputStyle}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onCancel}
              style={{
                padding: '6px 14px',
                background: 'var(--vscode-button-secondaryBackground)',
                color: 'var(--vscode-button-secondaryForeground)',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!slug.trim() || !slugValid}
              style={{
                padding: '6px 14px',
                background: 'var(--vscode-button-background)',
                color: 'var(--vscode-button-foreground)',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 13,
                opacity: slug.trim() && slugValid ? 1 : 0.5,
              }}
            >
              Add Paper
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
