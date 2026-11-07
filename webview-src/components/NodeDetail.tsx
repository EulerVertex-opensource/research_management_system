import React, { useState, useEffect, useRef, useCallback } from 'react';
import { NodeFrontmatter, NodeType, NodeSource, LayoutMode, ResearchNode, PaperEntry, ResearchStatus, IdeaKind, DefinitionKind, RemarkView } from '../../src/models/types';
import { ASSET_TYPE_LIST, DEFINITION_KIND_LIST, IDEA_KIND_LIST, SOURCE_KIND_LIST, statusesFor } from '../../src/domain/nodeKinds';
import { hasSectionContent } from '../../src/domain/sections';
import { reverseRelations } from '../../src/domain/relations';
import { isCited, sourceKind } from '../../src/domain/schema';
import { MarkdownEditor } from './MarkdownEditor';
import { PaperIdInput } from './PaperIdInput';
import { NodeTagInput } from './NodeTagInput';

const ASSET_TYPES: readonly NodeType[] = ASSET_TYPE_LIST;

interface Props {
  id: string;
  frontmatter: NodeFrontmatter;
  body: string;
  /** Remarks on this result (annotations; not part of the node). */
  remarks?: RemarkView[];
  layoutMode: LayoutMode;
  splitRatio: number;
  metadataHeight: number;
  allNodes: ResearchNode[];
  definitionPath: string;
  allPapers: PaperEntry[];
  sourcePdfDirectory: string;
  onLayoutChange: (mode: LayoutMode) => void;
  onSplitRatioChange: (ratio: number) => void;
  onMetadataHeightChange: (height: number) => void;
  onSave: (id: string, frontmatter: NodeFrontmatter, body: string) => void;
  onOpenInEditor: () => void;
  onOpenPdf: (slug: string) => void;
  onNavigateNode: (node: ResearchNode) => void;
  onOpenNodeLink: (href: string) => boolean;
  /** Open a project file (a remark) in the editor. */
  onOpenFile?: (filePath: string) => void;
  /** The researcher approves a remark's text for the paper. */
  onApproveRemark?: (remarkId: string) => void;
  onCheckRemark?: (remarkId: string) => void;
  /** Open a remark in the Remarks view, or start a new one on this result. */
  onOpenRemark?: (remarkId: string) => void;
  onAddRemark?: () => void;
}

export function NodeDetail({
  id,
  frontmatter: initialFm,
  body: initialBody,
  remarks = [],
  layoutMode,
  splitRatio,
  metadataHeight,
  allNodes,
  definitionPath,
  allPapers,
  sourcePdfDirectory,
  onLayoutChange,
  onSplitRatioChange,
  onMetadataHeightChange,
  onSave,
  onOpenInEditor,
  onOpenPdf,
  onNavigateNode,
  onOpenNodeLink,
  onOpenFile,
  onApproveRemark,
  onCheckRemark,
  onOpenRemark,
  onAddRemark,
}: Props) {
  const isDefinition = initialFm.type === 'definition';
  // Project and library nodes alike, so a project result can pick a library dependency.
  const definitions = allNodes.filter((node) => node.filePath.startsWith(`${definitionPath}/`) || (node.origin === 'library' && node.type === 'definition'));
  const assets = allNodes.filter((node) => ASSET_TYPES.includes(node.type) && !node.filePath.startsWith(`${definitionPath}/`));
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
  const isPlan = fm.type === 'plan';
  const isProofFile = isIdea || isPlan;
  const ideas = allNodes.filter((node) => node.type === 'idea');
  const reverse = reverseRelations(allNodes).get(id);
  const usedIn = [...(reverse?.usedIn ?? []), ...(reverse?.usedBy ?? [])].map((ref) => allNodes.find((node) => node.id === ref)).filter((node): node is ResearchNode => Boolean(node));
  // A status that needs a section is offered only once the section has content.
  const statusBlocked = (status: string) => (status === 'failed' && !hasSectionContent(body, 'Failure')) || (status === 'succeeded' && !hasSectionContent(body, 'Outcome'));
  const isPaperSource = isCited(fm.source);

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
            {isProofFile || isDefinition ? (
              <div style={{ ...inp, opacity: 0.55, cursor: 'default' }}>{fm.type}</div>
            ) : (
              <select value={fm.type} onChange={(e) => update('type', e.target.value as NodeType)} style={inp}>
                {ASSET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
          </div>
          <div style={{ flex: 1 }}>
            <label style={lbl}>Status</label>
            <select value={fm.status ?? ''} onChange={(e) => update('status', e.target.value as ResearchStatus)} style={inp}>
              {statusesFor(fm.type).map((s) => <option key={s} value={s} disabled={s !== fm.status && statusBlocked(s)}>{s}</option>)}
            </select>
          </div>
          {isDefinition && <div style={{ flex: 1 }}>
            <label style={lbl}>Kind</label>
            <select value={fm.definition_kind ?? 'definition'} onChange={(e) => update('definition_kind', e.target.value as DefinitionKind)} style={inp}>
              {DEFINITION_KIND_LIST.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </select>
          </div>}
          {isIdea && <div style={{ flex: 1 }}>
            <label style={lbl}>Kind</label>
            <select value={fm.idea_kind ?? 'approach'} onChange={(e) => update('idea_kind', e.target.value as IdeaKind)} style={inp}>
              {IDEA_KIND_LIST.map((kind) => <option key={kind} value={kind}>{kind.replace('_', ' ')}</option>)}
            </select>
          </div>}
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
        {!isProofFile && (
          <>
            {/* Source kind + location row */}
            <div style={{ marginBottom: 4 }}>
              <label style={lbl}>Source</label>
              <div style={{ display: 'flex', gap: 5 }}>
                <select
                  value={sourceKind(fm.source) ?? 'paper'}
                  onChange={(e) => {
                    updateSource('kind', e.target.value);
                    if (!isCited({ kind: e.target.value })) updateSource('paper_id', '');
                  }}
                  style={{ ...inp, width: 'auto', flex: '0 0 110px' }}
                >
                  {SOURCE_KIND_LIST.map((k) => <option key={k} value={k}>{k}</option>)}
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
                nodes={isDefinition ? definitions : assets}
                excludeId={id}
                onNavigateNode={onNavigateNode}
              />
            </div>

            {!isDefinition && (
              <div style={{ marginBottom: 8 }}>
                <label style={lbl}>Uses definitions</label>
                <NodeTagInput values={fm.uses_definitions} onChange={(v) => update('uses_definitions', v)} nodes={definitions} onNavigateNode={onNavigateNode} />
              </div>
            )}

            {/* Used in: derived from other nodes' depends_on and uses_definitions, never stored */}
            <div>
              <label style={lbl}>Used in (derived)</label>
              <div style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {usedIn.length ? usedIn.map((node) => (
                  <button key={node.id} type="button" onClick={() => onNavigateNode(node)} title={node.id}
                    style={{ padding: '1px 7px', fontSize: 11, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', border: 'none', borderRadius: 9, cursor: 'pointer' }}>
                    {node.title}
                  </button>
                )) : <span style={{ opacity: 0.5 }}>Nothing depends on this yet.</span>}
              </div>
            </div>
          </>
        )}

        {/* Derived from other nodes' forward fields; nothing here is stored in this file. */}
        {!isDefinition && !isPlan && (
          <DerivedList label={isIdea ? 'Plans it inspired' : 'Plans'} ids={isIdea ? reverse?.inspired ?? [] : reverse?.plans ?? []} allNodes={allNodes} onNavigateNode={onNavigateNode} lbl={lbl} />
        )}
        {!isDefinition && !isIdea && !isPlan && <>
          <DerivedList label="Ideas" ids={reverse?.ideas ?? []} allNodes={allNodes} onNavigateNode={onNavigateNode} lbl={lbl} />
          {(reverse?.refutedBy.length ?? 0) > 0 && <DerivedList label="Refuted by" ids={reverse!.refutedBy} allNodes={allNodes} onNavigateNode={onNavigateNode} lbl={lbl} />}
        </>}

        {isIdea && <div>
          <label style={lbl}>Related assets (optional)</label>
          <NodeTagInput values={fm.related_assets} onChange={(v) => update('related_assets', v)} nodes={assets} onNavigateNode={onNavigateNode} />
        </div>}

        {fm.type === 'example' && <div style={{ marginTop: 8 }}>
          <label style={lbl}>Refutes asset (counterexample only)</label>
          <select value={fm.refutes ?? ''} onChange={(e) => update('refutes', e.target.value || undefined)} style={inp}>
            <option value="">Not a counterexample</option>
            {assets.filter((asset) => asset.id !== id).map((asset) => <option key={asset.id} value={asset.id}>{asset.title}</option>)}
          </select>
        </div>}

        {isPlan && (
          <div>
            <label style={lbl}>Target asset</label>
            <select value={fm.target_asset ?? ''} onChange={(e) => update('target_asset', e.target.value)} style={inp}>
              <option value="">Choose an asset</option>
              {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.title}</option>)}
            </select>
            {fm.target_asset && <button type="button" onClick={() => { const asset = assets.find((n) => n.id === fm.target_asset); if (asset) onNavigateNode(asset); }}>Open target asset</button>}
            <label style={lbl}>Inspired by ideas (optional)</label>
            <NodeTagInput values={fm.inspired_by ?? []} onChange={(v) => update('inspired_by', v)} nodes={ideas} onNavigateNode={onNavigateNode} />
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>Add a Failure section with the obstruction before choosing failed. After putting a successful proof in the asset, add an Outcome section saying where it lives, then choose succeeded.</div>
          </div>
        )}

        {/* Remarks: annotations stored in their own files, written from the teaching chat or by the loop; not part of this node. */}
        {remarks.length > 0 && <div style={{ marginTop: 10 }}>
          <label style={lbl}>Remarks ({remarks.length})</label>
          {remarks.map((remark) => (
            <div key={remark.id} style={{ borderLeft: '2px solid var(--vscode-textBlockQuote-border, #888)', padding: '4px 8px', margin: '4px 0', fontSize: 12 }}>
              <div style={{ fontWeight: 600 }}>
                <a href="#" title="Open in Remarks" onClick={(event) => { event.preventDefault(); onOpenRemark?.(remark.id); }}>{remark.title}</a>{remark.anchor ? <span style={{ fontWeight: 400, opacity: 0.7 }}> · {remark.anchor}</span> : null}
              </div>
              <div style={{ fontSize: 11, opacity: 0.7 }}>
                {remark.origin === 'researcher' ? "The researcher's" : `${remark.from === 'loop' ? "The loop's" : "An agent's"} (${remark.checked ? 'checked by you' : 'not checked'})`}
                {remark.origin === 'agent' && !remark.checked && <>{' · '}<a href="#" title="You read it and agree with it as worded now" onClick={(event) => { event.preventDefault(); onCheckRemark?.(remark.id); }}>mark as checked</a></>}
                {remark.stale ? ' · written for an earlier version' : ''}
                {' · '}<a href={remark.file} onClick={(event) => { event.preventDefault(); onOpenFile?.(remark.file); }}>file</a>
                {' · '}{remark.approved
                  ? <span title="You approved this text; the paper may present it as a remark.">approved for the paper</span>
                  : <a href="#" title="Agree that this text, as written, may appear in the paper as a remark. An edit needs a new approval." onClick={(event) => { event.preventDefault(); onApproveRemark?.(remark.id); }}>approve for the paper</a>}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{remark.body}</div>
            </div>
          ))}
        </div>}
        {!isProofFile && !isIdea && onAddRemark && <div style={{ marginTop: remarks.length ? 2 : 10, fontSize: 12 }}>
          <a href="#" title="Write a remark on this result: an explanation, not part of it" onClick={(event) => { event.preventDefault(); onAddRemark(); }}>+ Add a remark</a>
        </div>}
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
          onOpenNodeLink={onOpenNodeLink}
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

/** Nodes that point at this one, with their status; derived on every refresh and never written to the file. */
function DerivedList({ label, ids, allNodes, onNavigateNode, lbl }: { label: string; ids: string[]; allNodes: ResearchNode[]; onNavigateNode: (node: ResearchNode) => void; lbl: React.CSSProperties }) {
  const nodes = ids.map((ref) => allNodes.find((node) => node.id === ref)).filter((node): node is ResearchNode => Boolean(node));
  return (
    <div style={{ marginTop: 8 }}>
      <label style={lbl}>{label} (derived)</label>
      <div style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {nodes.length ? nodes.map((node) => (
          <button key={node.id} type="button" onClick={() => onNavigateNode(node)} title={node.outdated ? 'The target proof changed after this plan succeeded' : node.id}
            style={{ padding: '1px 7px', fontSize: 11, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', border: 'none', borderRadius: 9, cursor: 'pointer' }}>
            {node.title}{node.status ? ` · ${node.status}` : ''}{node.outdated ? ' · outdated' : ''}
          </button>
        )) : <span style={{ opacity: 0.5 }}>None.</span>}
      </div>
    </div>
  );
}
