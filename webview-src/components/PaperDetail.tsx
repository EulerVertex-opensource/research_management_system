import React, { useState, useEffect, useRef } from 'react';
import { PaperEntry } from '../../src/models/types';
import { MarkdownPreview } from './MarkdownPreview';

type ViewMode = 'editor' | 'preview';

function parseDescription(mdSection: string): string {
  const match = mdSection.match(/^- Description:\s*(.+)$/m);
  return match ? match[1].trim() : '';
}

function parseSourceUrl(mdSection: string): string {
  const match = mdSection.match(/^- Source URL:\s*(.+)$/m);
  return match ? match[1].trim() : '';
}

function buildMdSection(
  existing: string,
  slug: string,
  sourceUrl: string,
  description: string,
  sourcePdfDirectory: string
): string {
  const lines = [`- Local file: \`${sourcePdfDirectory}/${slug}.pdf\``];
  if (sourceUrl.trim()) {
    lines.push(`- Source URL: ${sourceUrl.trim()}`);
  }
  if (description.trim()) {
    lines.push(`- Description: ${description.trim()}`);
  }
  const preserved = existing
    .split('\n')
    .filter((line) => line.trim())
    .filter((line) => !/^- (?:Local )?File:/i.test(line))
    .filter((line) => !/^- Source URL:/i.test(line))
    .filter((line) => !/^- Description:/i.test(line));
  return [...lines, ...preserved].join('\n') + '\n';
}

function extractBibKey(bib: string): string {
  const m = bib.match(/@\w+\{([^,\s]+),/);
  return m ? m[1] : '';
}

interface Props {
  paper: PaperEntry;
  onSave: (originalSlug: string, newSlug: string, mdSection: string, bibEntry: string) => void;
  onOpenPdf: (slug: string) => void;
  sourcePdfDirectory: string;
  onOpenNodeLink?: (href: string) => boolean;
}

export function PaperDetail({ paper, onSave, onOpenPdf, sourcePdfDirectory, onOpenNodeLink }: Props) {
  const [localSlug, setLocalSlug] = useState(paper.slug);
  const [sourceUrl, setSourceUrl] = useState(() => parseSourceUrl(paper.mdSection));
  const [description, setDescription] = useState(() => parseDescription(paper.mdSection));
  const [bibEntry, setBibEntry] = useState(paper.bibEntry);
  const [mode, setMode] = useState<ViewMode>('editor');
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const localSlugRef = useRef(localSlug);
  localSlugRef.current = localSlug;
  const descriptionRef = useRef(description);
  descriptionRef.current = description;
  const sourceUrlRef = useRef(sourceUrl);
  sourceUrlRef.current = sourceUrl;
  const bibEntryRef = useRef(bibEntry);
  bibEntryRef.current = bibEntry;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
  }, []);

  // Full reset when a different paper is selected (component remounts via key)
  useEffect(() => {
    setLocalSlug(paper.slug);
    setSourceUrl(parseSourceUrl(paper.mdSection));
    setDescription(parseDescription(paper.mdSection));
    setBibEntry(paper.bibEntry);
    setDirty(false);
    setSaveStatus('idle');
  }, [paper.slug]);

  // Always sync display when external changes arrive — the file is the source of truth.
  useEffect(() => {
    setLocalSlug(paper.slug);
    setSourceUrl(parseSourceUrl(paper.mdSection));
    setDescription(parseDescription(paper.mdSection));
    setBibEntry(paper.bibEntry);
    setDirty(false);
    setSaveStatus('idle');
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.mdSection, paper.bibEntry]);

  // Debounced auto-save: fires 1.5 s after the last edit
  useEffect(() => {
    if (!dirty) return;
    setSaveStatus('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      onSave(
        paper.slug,
        localSlugRef.current,
        buildMdSection(paper.mdSection, localSlugRef.current, sourceUrlRef.current, descriptionRef.current, sourcePdfDirectory),
        bibEntryRef.current,
      );
      setDirty(false);
      setSaveStatus('saved');
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 1500);
    }, 1500);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, localSlug, sourceUrl, description, bibEntry]);

  // When the BibTeX textarea changes, sync slug from the entry key
  const handleBibChange = (newBib: string) => {
    setBibEntry(newBib);
    setDirty(true);
    const newKey = extractBibKey(newBib);
    if (newKey && newKey !== localSlug) {
      setLocalSlug(newKey);
    }
  };

  const handleSave = () => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    onSave(paper.slug, localSlug, buildMdSection(paper.mdSection, localSlug, sourceUrl, description, sourcePdfDirectory), bibEntry);
    setDirty(false);
    setSaveStatus('saved');
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 1500);
  };

  const slugChanged = localSlug !== paper.slug;

  const inp: React.CSSProperties = {
    width: '100%',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: 3,
    fontSize: 13,
    padding: '6px 10px',
    outline: 'none',
    fontFamily: 'var(--vscode-font-family)',
    resize: 'none',
  };

  const monoInp: React.CSSProperties = {
    ...inp,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: 12,
  };

  const lbl: React.CSSProperties = {
    fontSize: 10,
    opacity: 0.55,
    display: 'block',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header bar */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 14px',
          borderBottom: '1px solid var(--vscode-panel-border)',
        }}
      >
        <span
          style={{
            fontWeight: 600,
            fontSize: 13,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: slugChanged ? 'var(--vscode-notificationsWarningIcon-foreground)' : undefined,
          }}
          title={slugChanged ? `Will be renamed from "${paper.slug}" to "${localSlug}" on save` : undefined}
        >
          {localSlug}
          {slugChanged && <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.7 }}> (renamed)</span>}
        </span>

        <button
          onClick={() => onOpenPdf(paper.slug)}
          title={`Open ${sourcePdfDirectory}/${paper.slug}.pdf`}
          style={{ padding: '2px 10px', fontSize: 11, border: '1px solid var(--vscode-input-border)', borderRadius: 3, background: 'transparent', color: 'var(--vscode-foreground)', cursor: 'pointer' }}
        >
          Open PDF
        </button>

        <div style={{ display: 'flex', gap: 2 }}>
          {(['editor', 'preview'] as ViewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: '2px 10px',
                fontSize: 11,
                border: '1px solid var(--vscode-input-border)',
                borderRadius: 3,
                background: mode === m ? 'var(--vscode-button-background)' : 'transparent',
                color: mode === m ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)',
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {m}
            </button>
          ))}
        </div>

        <span style={{ fontSize: 11, opacity: 0.6 }}>
          {saveStatus === 'saving' ? 'Auto-saving…'
            : saveStatus === 'saved' ? 'Saved ✓'
            : dirty ? 'Unsaved'
            : ''}
        </span>
        <button
          onClick={handleSave}
          disabled={!dirty}
          style={{
            padding: '3px 12px',
            fontSize: 12,
            background: dirty ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)',
            color: dirty ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)',
            border: 'none',
            borderRadius: 3,
            cursor: dirty ? 'pointer' : 'default',
            opacity: dirty ? 1 : 0.5,
          }}
        >
          Save
        </button>
      </div>

      {/* Content — BibTeX first, then description */}
      <div style={{ flex: 1, overflow: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* BibTeX entry */}
        <div>
          <label style={lbl}>
            BibTeX entry
            {mode === 'editor' && <span style={{ opacity: 0.5, textTransform: 'none', letterSpacing: 0 }}> — editing the key updates the slug above</span>}
          </label>
          {mode === 'editor' ? (
            <textarea
              value={bibEntry}
              onChange={(e) => handleBibChange(e.target.value)}
              rows={8}
              style={monoInp}
            />
          ) : (
            <pre
              style={{
                padding: '8px 10px',
                border: '1px solid var(--vscode-panel-border)',
                borderRadius: 3,
                fontSize: 12,
                lineHeight: 1.6,
                fontFamily: 'var(--vscode-editor-font-family, monospace)',
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                minHeight: 60,
              }}
            >
              {bibEntry || '(no BibTeX entry)'}
            </pre>
          )}
        </div>

        <div>
          <label style={lbl}>Stable source URL</label>
          {mode === 'editor' ? (
            <input
              value={sourceUrl}
              onChange={(e) => { setSourceUrl(e.target.value); setDirty(true); }}
              placeholder="https://arxiv.org/abs/..."
              style={inp}
            />
          ) : sourceUrl ? (
            <a href={sourceUrl} style={{ color: 'var(--vscode-textLink-foreground)' }}>{sourceUrl}</a>
          ) : (
            <p style={{ fontSize: 13, opacity: 0.4 }}>(no shared source URL)</p>
          )}
        </div>

        {/* Description — supports Markdown + math */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <label style={lbl}>Description (Markdown)</label>
          {mode === 'editor' ? (
            <textarea
              value={description}
              onChange={(e) => { setDescription(e.target.value); setDirty(true); }}
              placeholder="Describe what this paper is about, key results, how you use it…"
              style={{ ...inp, flex: 1, minHeight: 120, lineHeight: 1.7 }}
            />
          ) : description ? (
            <MarkdownPreview
              content={description}
              onOpenNodeLink={onOpenNodeLink}
              style={{ padding: '8px 10px', border: '1px solid var(--vscode-panel-border)', borderRadius: 3, flex: 1 }}
            />
          ) : (
            <p style={{ fontSize: 13, opacity: 0.4 }}>(no description)</p>
          )}
        </div>
      </div>
    </div>
  );
}
