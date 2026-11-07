import React, { useEffect, useState } from 'react';
import { RemarkView, ResearchNode } from '../../src/models/types';
import { MarkdownPreview } from './MarkdownPreview';
import { remarkBadges } from './RemarkList';
import { buttonStyle } from '../graph/AttentionList';
import { COLOR } from '../graph/colors';

const field: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
  border: '1px solid var(--vscode-input-border)', borderRadius: 4, fontSize: 13, fontFamily: 'inherit',
};
const label: React.CSSProperties = { display: 'block', fontSize: 11, opacity: 0.7, margin: '10px 0 4px' };

const NOTE = 'A remark explains a result for people (intuition, why a step is needed, a picture to keep in mind). It is not part of the result: nothing depends on it, no check covers it, and the loop never reads it. A claim belongs in an idea or a result instead.';

interface DetailProps {
  remark: RemarkView;
  target?: ResearchNode;
  onOpenTarget: (node: ResearchNode) => void;
  onOpenFile: (file: string) => void;
  onApprove: (id: string) => void;
  onCheck: (id: string) => void;
  onSave: (id: string, changes: { title: string; body: string; anchor: string }) => void;
  onArchive: (id: string, archived: boolean) => void;
}

/** One remark: what result it is on, its text, and what the researcher can do with it. */
export function RemarkDetail({ remark, target, onOpenTarget, onOpenFile, onApprove, onCheck, onSave, onArchive }: DetailProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: remark.title, body: remark.body, anchor: remark.anchor ?? '' });
  useEffect(() => { setEditing(false); setDraft({ title: remark.title, body: remark.body, anchor: remark.anchor ?? '' }); }, [remark.id, remark.title, remark.body, remark.anchor]);
  const archived = remark.status === 'archived';

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Remark</span>
        {remarkBadges(remark)}
      </div>
      {editing ? (
        <div>
          <label style={label}>Title</label>
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} style={field} />
          <label style={label}>Where in the result (optional, e.g. "step 3")</label>
          <input value={draft.anchor} onChange={(event) => setDraft({ ...draft, anchor: event.target.value })} style={field} />
          <label style={label}>Remark (Markdown; $…$ for math)</label>
          <textarea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} rows={12} style={{ ...field, resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button style={buttonStyle('primary')} disabled={!draft.body.trim()} onClick={() => onSave(remark.id, draft)}>Save</button>
            <button style={buttonStyle('secondary')} onClick={() => { setEditing(false); setDraft({ title: remark.title, body: remark.body, anchor: remark.anchor ?? '' }); }}>Cancel</button>
          </div>
          {remark.approved && <div style={{ fontSize: 11, color: COLOR.waiting, marginTop: 6 }}>Saving changes the approved text, so it needs your approval for the paper again.</div>}
        </div>
      ) : (
        <>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{remark.title}</h2>
          <div style={{ fontSize: 12, color: COLOR.muted }}>
            On {target
              ? <a href="#" onClick={(event) => { event.preventDefault(); onOpenTarget(target); }}>{target.title || target.id}</a>
              : <span>{remark.targetTitle ?? remark.target} (not found)</span>}
            {remark.anchor ? ` · ${remark.anchor}` : ''} · {remark.at.slice(0, 10)}
          </div>
          {!remark.checked && !archived && <div style={{ fontSize: 12, color: COLOR.waiting }}>Written by {remark.from === 'loop' ? 'the loop' : 'an agent'}; nobody has checked it. Read it, then mark it as checked, edit it, or archive it.</div>}
          {remark.stale && !archived && <div style={{ fontSize: 12, color: COLOR.waiting }}>The result changed after this remark was written; check that it still fits, then edit it (saving marks it current).</div>}
          <div style={{ border: `1px solid ${COLOR.border}`, borderRadius: 6, padding: '8px 12px', background: COLOR.card }}>
            <MarkdownPreview content={remark.body} style={{ fontSize: 13 }} />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {!archived && !remark.checked && (
              <button style={buttonStyle('primary')} title="You read this agent's remark and agree with it as worded now. If it is edited later, it needs checking again." onClick={() => onCheck(remark.id)}>Mark as checked</button>
            )}
            {!archived && <button style={buttonStyle('secondary')} onClick={() => setEditing(true)}>Edit</button>}
            {!archived && !remark.approved && (
              <button style={buttonStyle('primary')} title="Agree that this text, as written, may appear in the paper as a remark. An edit needs a new approval." onClick={() => onApprove(remark.id)}>Approve for the paper</button>
            )}
            <button style={buttonStyle('secondary')} title={archived ? 'Show it again under its result' : 'Hide it; the file and its history stay'} onClick={() => onArchive(remark.id, !archived)}>{archived ? 'Restore' : 'Archive'}</button>
            <button style={buttonStyle('secondary')} onClick={() => onOpenFile(remark.file)}>Open file</button>
          </div>
        </>
      )}
      <div style={{ fontSize: 11, color: COLOR.muted, marginTop: 'auto' }}>{NOTE}</div>
    </div>
  );
}

interface CreateProps {
  targets: ResearchNode[];
  initialTarget?: string;
  onCreate: (input: { target: string; title: string; body: string; anchor?: string }) => void;
  onCancel: () => void;
}

/** A remark the researcher writes in the dashboard: theirs, saved at once. */
export function RemarkCreate({ targets, initialTarget, onCreate, onCancel }: CreateProps) {
  const [draft, setDraft] = useState({ target: initialTarget ?? '', title: '', body: '', anchor: '' });
  const ready = Boolean(draft.target && draft.title.trim() && draft.body.trim());
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px' }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>New remark</h2>
      <label style={label}>On which result</label>
      <select value={draft.target} onChange={(event) => setDraft({ ...draft, target: event.target.value })} style={field}>
        <option value="">Choose a result or definition</option>
        {targets.map((node) => <option key={node.id} value={node.id}>{node.title || node.id}</option>)}
      </select>
      <label style={label}>Title</label>
      <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="e.g. Why the constant must be uniform" style={field} />
      <label style={label}>Where in the result (optional, e.g. "step 3")</label>
      <input value={draft.anchor} onChange={(event) => setDraft({ ...draft, anchor: event.target.value })} style={field} />
      <label style={label}>Remark (Markdown; $…$ for math)</label>
      <textarea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} rows={12} style={{ ...field, resize: 'vertical' }} />
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button style={buttonStyle('primary')} disabled={!ready} onClick={() => onCreate({ target: draft.target, title: draft.title, body: draft.body, ...(draft.anchor.trim() ? { anchor: draft.anchor } : {}) })}>Save remark</button>
        <button style={buttonStyle('secondary')} onClick={onCancel}>Cancel</button>
      </div>
      <div style={{ fontSize: 11, color: COLOR.muted, marginTop: 12 }}>{NOTE}</div>
    </div>
  );
}
