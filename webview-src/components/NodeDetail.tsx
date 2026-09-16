import React, { useState, useEffect, useRef, useCallback } from 'react';
import { NodeFrontmatter, NodeType, NodeStatus, NodeSource, LayoutMode, ResearchNode, PaperEntry } from '../../src/models/types';
import { MarkdownEditor } from './MarkdownEditor';
import { PaperIdInput } from './PaperIdInput';
import { NodeTagInput } from './NodeTagInput';

const ASSET_TYPES: NodeType[] = [
  'theorem', 'lemma', 'proposition', 'definition',
  'example', 'construction', 'remark',
];
const STATUS_OPTIONS: NodeStatus[] = ['draft', 'approved', 'deprecated', 'archived'];
const SOURCE_KINDS: NodeSource['kind'][] = ['paper', 'self_proved'];

interface Props {
  id: string;
  frontmatter: NodeFrontmatter;
  body: string;
  layoutMode: LayoutMode;
  splitRatio: number;
  metadataHeight: number;
  allNodes: ResearchNode[];
  allPapers: PaperEntry[];
  sourcePdfDirectory: string;
  onLayoutChange: (mode: LayoutMode) => void;
  onSplitRatioChange: (ratio: number) => void;
  onMetadataHeightChange: (height: number) => void;
  onSave: (id: string, frontmatter: NodeFrontmatter, body: string) => void;
  onOpenInEditor: () => void;
  onOpenPdf: (slug: string) => void;
}

export function NodeDetail({
  id,
  frontmatter: initialFm,
  body: initialBody,
  layoutMode,
  splitRatio,
  metadataHeight,
  allNodes,
  allPapers,
  sourcePdfDirectory,
  onLayoutChange,
  onSplitRatioChange,
  onMetadataHeightChange,
  onSave,
  onOpenInEditor,
  onOpenPdf,
}: Props) {
  const [fm, setFm] = useState<NodeFrontmatter>(initialFm);
  const [body, setBody] = useState(initialBody);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Refs so the debounce timer always reads the latest values without stale closures
  const fmRef = useRef(fm);
  fmRef.current = fm;
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up timers on unmount
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
  }, []);

  // Full reset when a different node is selected (component remounts via key, but keep as safety net)
  useEffect(() => {
    setFm(initialFm);
    setBody(initialBody);
    setDirty(false);
    setSaveStatus('idle');
  }, [id]);

  // Always sync display when external changes arrive (file watcher → props update).
  // This overwrites any unsaved local edits — the file is the source of truth.
  const fmStr = JSON.stringify(initialFm);
  useEffect(() => {
    setFm(initialFm);
    setBody(initialBody);
    setDirty(false);
    setSaveStatus('idle');
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fmStr, initialBody]);

  // Debounced auto-save: fires 1.5 s after the last edit
  useEffect(() => {
    if (!dirty) return;
    setSaveStatus('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      onSave(id, fmRef.current, bodyRef.current);
      setDirty(false);
      setSaveStatus('saved');
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 1500);
    }, 1500);
  // fm and body in deps resets the timer on every edit (debounce)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, fm, body]);

  const update = <K extends keyof NodeFrontmatter>(key: K, value: NodeFrontmatter[K]) => {
    setFm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const updateSource = (field: keyof NodeSource, value: string) => {
    setFm((prev) => ({
      ...prev,
      source: { ...(prev.source ?? { kind: 'paper' }), [field]: value } as NodeSource,
    }));
    setDirty(true);
  };

  const metadataHeightRef = useRef(metadataHeight);
  metadataHeightRef.current = metadataHeight;
  const metadataDivRef = useRef<HTMLDivElement>(null);

  const startMetadataDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = metadataDivRef.current?.offsetHeight ?? metadataHeightRef.current;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
    const onMove = (me: MouseEvent) => {
      onMetadataHeightChange(Math.max(80, Math.min(600, startHeight + me.clientY - startY)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onMetadataHeightChange]);

  const isIdea = fm.type === 'idea';
  const isPaperSource = fm.source?.kind === 'paper';

  const inp: React.CSSProperties = {
    padding: '3px 7px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: 3,
    fontSize: 12,
    width: '100%',
  };

  const lbl: React.CSSProperties = {
    fontSize: 10,
    opacity: 0.55,
    display: 'block',
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ── Metadata ── */}
      <div
        ref={metadataDivRef}
        style={{ height: metadataHeight, flexShrink: 0, padding: '10px 14px', overflowY: 'auto' }}
      >
        {/* Title */}
        <div style={{ marginBottom: 8 }}>
          <label style={lbl}>Title</label>
          <input value={fm.title} onChange={(e) => update('title', e.target.value)} style={inp} />
        </div>

        {/* Type + Status */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={lbl}>Type</label>
            {isIdea ? (
              <div style={{ ...inp, opacity: 0.55, cursor: 'default' }}>idea</div>
            ) : (
              <select value={fm.type} onChange={(e) => update('type', e.target.value as NodeType)} style={inp}>
                {ASSET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
          </div>
          <div style={{ flex: 1 }}>
            <label style={lbl}>Status</label>
            <select value={fm.status} onChange={(e) => update('status', e.target.value as NodeStatus)} style={inp}>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* Tags */}
        <div style={{ marginBottom: 8 }}>
          <label style={lbl}>Tags (comma-separated)</label>
          <input
            value={fm.tags.join(', ')}
            onChange={(e) => update('tags', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
            placeholder="e.g. arithmetic-geometry, finite-fields"
            style={inp}
          />
        </div>

        {/* Asset fields */}
        {!isIdea && (
          <>
            {/* Source kind + location row */}
            <div style={{ marginBottom: 4 }}>
              <label style={lbl}>Source</label>
              <div style={{ display: 'flex', gap: 5 }}>
                <select
                  value={fm.source?.kind ?? 'paper'}
                  onChange={(e) => {
                    updateSource('kind', e.target.value);
                    if (e.target.value !== 'paper') updateSource('paper_id', '');
                  }}
                  style={{ ...inp, width: 'auto', flex: '0 0 110px' }}
                >
                  {SOURCE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                <input
                  value={fm.source?.location ?? ''}
                  onChange={(e) => updateSource('location', e.target.value)}
                  placeholder="Thm 3.1"
                  style={{ ...inp, flex: 1 }}
                />
              </div>
            </div>

            {/* Paper ID — only shown when source kind is paper */}
            {isPaperSource && (
              <div style={{ marginBottom: 8 }}>
                <PaperIdInput
                  value={fm.source?.paper_id ?? ''}
                  onChange={(v) => { updateSource('paper_id', v); setDirty(true); }}
                  papers={allPapers}
                  onOpenPdf={onOpenPdf}
                  sourcePdfDirectory={sourcePdfDirectory}
                  inputStyle={inp}
                />
              </div>
            )}

            {/* Depends on */}
            <div style={{ marginBottom: 8 }}>
              <label style={lbl}>Depends on</label>
              <NodeTagInput
                values={fm.depends_on}
                onChange={(v) => update('depends_on', v)}
                nodes={allNodes}
                excludeId={id}
              />
            </div>

            {/* Used in */}
            <div>
              <label style={lbl}>Used in</label>
              <NodeTagInput
                values={fm.used_in}
                onChange={(v) => update('used_in', v)}
                nodes={allNodes}
                excludeId={id}
              />
            </div>
          </>
        )}

        {/* Idea: related assets */}
        {isIdea && (
          <div>
            <label style={lbl}>Related assets</label>
            <NodeTagInput
              values={fm.related_assets}
              onChange={(v) => update('related_assets', v)}
              nodes={allNodes}
              excludeId={id}
            />
          </div>
        )}
      </div>

      {/* ── Horizontal splitter ── */}
      <div
        onMouseDown={startMetadataDrag}
        style={{ height: 5, flexShrink: 0, cursor: 'ns-resize', background: 'transparent', borderBottom: '1px solid var(--vscode-panel-border)', transition: 'background 0.1s' }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--vscode-focusBorder)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      />

      {/* ── Action bar ── */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderBottom: '1px solid var(--vscode-panel-border)' }}>
        <span style={{ fontSize: 11, flex: 1, opacity: 0.6 }}>
          {saveStatus === 'saving' ? 'Auto-saving…'
            : saveStatus === 'saved' ? 'Saved ✓'
            : dirty ? 'Unsaved changes'
            : ''}
        </span>
        <button
          onClick={onOpenInEditor}
          style={{ padding: '3px 10px', fontSize: 11, background: 'transparent', color: 'var(--vscode-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: 3, cursor: 'pointer' }}
        >
          Open in Editor
        </button>
        <button
          onClick={() => {
            if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
            onSave(id, fm, body);
            setDirty(false);
            setSaveStatus('saved');
            if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
            statusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 1500);
          }}
          disabled={!dirty}
          style={{
            padding: '3px 12px', fontSize: 12,
            background: dirty ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)',
            color: dirty ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)',
            border: 'none', borderRadius: 3,
            cursor: dirty ? 'pointer' : 'default',
            opacity: dirty ? 1 : 0.5,
          }}
        >
          Save
        </button>
      </div>

      {/* ── Markdown editor ── */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <MarkdownEditor
          value={body}
          onChange={(v) => { setBody(v); setDirty(true); }}
          layoutMode={layoutMode}
          splitRatio={splitRatio}
          onLayoutChange={onLayoutChange}
          onSplitRatioChange={onSplitRatioChange}
        />
      </div>
    </div>
  );
}
