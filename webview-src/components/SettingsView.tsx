import React, { useEffect, useRef, useState } from 'react';
import { AUTO_APPROVE_RULES, LOOP_NUMBER_KEYS, RIGOR_KEYS } from '../../src/models/settings';
import type { AutoApproveRule, AutoPullMode, LoopNumberKey, ProviderSetting, RigorPolicy, SettingsErrors, SettingsPatch, SettingsPayload } from '../../src/models/settings';
import { LOOP_FIELD_GROUPS, LOOP_NUMBER_FIELDS, LoopFieldGroup, RIGOR_FIELDS, RIGOR_PRESETS, rigorPreset, validateSettingsPatch } from '../../src/domain/loopSettings';
import { COLOR } from '../graph/colors';

type SectionId = 'agent' | 'loop' | 'sync' | 'budgets';

interface Props {
  settings: SettingsPayload | null;
  /** Outcome of the last save: its request ID and the fields it rejected. */
  result: { requestId: string; errors: SettingsErrors } | null;
  onSave: (requestId: string, patch: SettingsPatch) => void;
  onNavigate: (id: string) => void;
}

/** One entry per auto-approve rule; a Record so a new rule without a checkbox does not compile. */
const RULE_TEXT: Record<AutoApproveRule, { label: string; hint: string; warning?: string }> = {
  proofs: { label: 'Proofs', hint: 'a proof a succeeded plan produced, over approved dependencies' },
  supporting: { label: 'Supporting assets', hint: 'remarks and examples a required result uses' },
  citations: { label: 'Citations & library', hint: 'results citing an indexed paper with a location, and library results' },
  definitions: { label: 'Definitions', hint: 'definitions the results use' },
  counterexamples: { label: 'Counterexamples', hint: 'verified counterexamples', warning: 'Confirming a counterexample deprecates the result it refutes.' },
  specifications: { label: 'Construction specifications', hint: 'the required properties P1…Pn a construction search looks for', warning: 'The loop will search against a specification you have not reviewed.' },
  project: { label: 'Project goals', hint: 'project.md and its required results', warning: 'The loop will pursue goals you have not reviewed.' },
};
const RULES = AUTO_APPROVE_RULES.map((id) => ({ id, ...RULE_TEXT[id] }));
const FIELD_GROUPS = Object.keys(LOOP_FIELD_GROUPS) as LoopFieldGroup[];

// ---------- drafts: what the form holds, as the inputs show it ----------

const num = (value: number | undefined) => value === undefined ? '' : String(value);
const toNumber = (text: string) => text.trim() === '' ? NaN : Number(text);

function agentDraft(s: SettingsPayload) { return { provider: s.agent.provider, useDefaultOnStart: s.agent.useDefaultOnStart }; }
function loopDraft(s: SettingsPayload) {
  return { autoApprove: { ...s.loop.autoApprove }, rigor: { ...s.loop.rigor }, ...Object.fromEntries(LOOP_NUMBER_KEYS.map((key) => [key, num(s.loop[key])])) as Record<LoopNumberKey, string> };
}
function syncDraft(s: SettingsPayload) {
  const sync = s.sync;
  return {
    autoPull: sync.autoPull, autoPullIntervalMinutes: num(sync.autoPullIntervalMinutes), remote: sync.remote, branch: sync.branch ?? '', overleafRemote: sync.overleafRemote ?? '',
    overleafBranch: sync.overleafBranch, strategy: sync.strategy, signCommits: sync.signCommits, identity: sync.identity ?? '', latexCommand: sync.latexCommand ?? '',
  };
}
function budgetDraft(s: SettingsPayload) {
  return Object.fromEntries(Object.keys(s.contextBudgets.defaults).map((stage) => [stage, num(s.contextBudgets.values[stage])]));
}
type Drafts = { agent: ReturnType<typeof agentDraft>; loop: ReturnType<typeof loopDraft>; sync: ReturnType<typeof syncDraft>; budgets: Record<string, string> };
const draftsOf = (s: SettingsPayload): Drafts => ({ agent: agentDraft(s), loop: loopDraft(s), sync: syncDraft(s), budgets: budgetDraft(s) });

/** The patch for one section: only the fields that differ from the saved settings. */
function patchFor(section: SectionId, draft: Drafts, saved: Drafts): SettingsPatch {
  const changed = <T extends Record<string, unknown>>(next: T, old: T) => Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(old[key])));
  if (section === 'agent') return { agent: changed(draft.agent, saved.agent) };
  if (section === 'loop') {
    const { autoApprove, rigor, ...numbers } = changed(draft.loop, saved.loop) as Partial<Drafts['loop']>;
    return { loop: { ...(autoApprove ? { autoApprove } : {}), ...(rigor ? { rigor } : {}), ...Object.fromEntries(Object.entries(numbers).map(([key, value]) => [key, toNumber(value as string)])) } };
  }
  if (section === 'sync') {
    const sync = changed(draft.sync, saved.sync) as Record<string, unknown>;
    if (sync.autoPullIntervalMinutes !== undefined) sync.autoPullIntervalMinutes = toNumber(sync.autoPullIntervalMinutes as string);
    for (const key of ['branch', 'overleafRemote', 'identity', 'latexCommand']) if (sync[key] === '') sync[key] = null;
    return { sync };
  }
  return { contextBudgets: Object.fromEntries(Object.entries(changed(draft.budgets, saved.budgets)).map(([stage, text]) => [stage, (text as string).trim() === '' ? null : toNumber(text as string)])) };
}

// ---------- the view ----------

/** Settings: which agent drives the loop, auto mode and limits, sync, and context budgets. */
export function SettingsView({ settings, result, onSave, onNavigate }: Props) {
  const [drafts, setDrafts] = useState<Drafts | null>(settings ? draftsOf(settings) : null);
  const [errors, setErrors] = useState<Partial<Record<SectionId, SettingsErrors>>>({});
  const [pending, setPending] = useState<{ requestId: string; section: SectionId } | null>(null);
  /** The settings the drafts were last synced with, to tell a section being edited from one left alone. */
  const synced = useRef<Drafts | null>(settings ? draftsOf(settings) : null);
  const saved = settings ? draftsOf(settings) : null;
  const dirty = (section: SectionId) => Boolean(drafts && saved && JSON.stringify(drafts[section]) !== JSON.stringify(saved[section]));

  // New settings from the extension replace every section the researcher is not editing, and the one just saved.
  useEffect(() => {
    if (!settings) return;
    const fresh = draftsOf(settings);
    const justSaved = pending && result?.requestId === pending.requestId ? pending : null;
    const failed = justSaved && Object.keys(result!.errors).length > 0;
    if (justSaved) { setErrors((old) => ({ ...old, [justSaved.section]: failed ? result!.errors : {} })); setPending(null); }
    const previous = synced.current;
    synced.current = fresh;
    setDrafts((old) => {
      if (!old || !previous) return fresh;
      const next = { ...old };
      for (const section of ['agent', 'loop', 'sync', 'budgets'] as SectionId[]) {
        const editing = JSON.stringify(old[section]) !== JSON.stringify(previous[section]);
        if (!editing || (justSaved?.section === section && !failed)) (next as Record<SectionId, unknown>)[section] = fresh[section];
      }
      return next;
    });
  }, [settings, result]);

  if (!settings || !drafts || !saved) return <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>Loading settings…</div>;

  const update = <S extends SectionId>(section: S, patch: Partial<Drafts[S]>) => setDrafts({ ...drafts, [section]: { ...drafts[section], ...patch } });
  const save = (section: SectionId) => {
    const patch = patchFor(section, drafts, saved);
    const local = validateSettingsPatch(patch, Object.keys(settings.contextBudgets.defaults));
    if (Object.keys(local).length) { setErrors({ ...errors, [section]: local }); return; }
    const requestId = `${section}-${Date.now()}`;
    setPending({ requestId, section });
    onSave(requestId, patch);
  };
  const revert = (section: SectionId) => { setDrafts({ ...drafts, [section]: saved[section] }); setErrors({ ...errors, [section]: {} }); };
  const footer = (section: SectionId) => (
    <SectionFooter dirty={dirty(section)} saving={pending?.section === section} general={errors[section]?.['']} onSave={() => save(section)} onRevert={() => revert(section)} />
  );
  const error = (section: SectionId, key: string) => errors[section]?.[key];

  const agent = drafts.agent;
  const loop = drafts.loop;
  const sync = drafts.sync;
  const autoOn = loop.autoApprove.enabled;

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--vscode-panel-border)', fontSize: 13, fontWeight: 600 }}>Settings</div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>

        <Section title="Agent" scope="this machine">
          <Field label="Default agent" hint="The chat the status bar, commands, and dashboard open.">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <select value={agent.provider} onChange={(event) => update('agent', { provider: event.target.value as ProviderSetting })} style={{ ...inputStyle, width: 220 }}>
                <option value="auto">Auto (first installed)</option>
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
              <Installed label="Claude Code" installed={settings.agent.installed.claude} />
              <Installed label="Codex" installed={settings.agent.installed.codex} />
            </div>
          </Field>
          <Check checked={agent.useDefaultOnStart} onChange={(value) => update('agent', { useDefaultOnStart: value })}
            label="Start the loop with the default agent" hint="Skip the “which agent?” picker in Start Research Loop." />
          {footer('agent')}
        </Section>

        <Section title="Research loop" scope="this machine" note={settings.loop.file}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 320px' }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>How careful</div>
                <div style={{ fontSize: 12, color: COLOR.muted }}>Careful checks more before the loop builds on something; Fast moves on and leaves more for you to check later.</div>
              </div>
              <Segmented value={rigorPreset(loop.rigor)}
                options={[['careful', 'Careful'], ['fast', 'Fast'], ...(rigorPreset(loop.rigor) === 'custom' ? [['custom', 'Custom'] as [string, string]] : [])]}
                onChange={(value) => { if (value === 'careful' || value === 'fast') update('loop', { rigor: { ...RIGOR_PRESETS[value] } }); }} />
            </div>
            <div style={{ border: `1px solid ${COLOR.border}`, borderRadius: 4, padding: '8px 12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '10px 16px' }}>
              {RIGOR_KEYS.map((key) => {
                const field = RIGOR_FIELDS[key];
                return (
                  <Field key={key} label={field.label} hint={field.hint}>
                    <select value={loop.rigor[key]} aria-label={field.label} style={inputStyle}
                      onChange={(event) => update('loop', { rigor: { ...loop.rigor, [key]: event.target.value } as RigorPolicy })}>
                      {Object.entries(field.options).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <FieldError text={error('loop', `loop.rigor.${key}`)} />
                  </Field>
                );
              })}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Switch on={autoOn} onChange={(value) => update('loop', { autoApprove: { ...loop.autoApprove, enabled: value } })} label="Auto mode" />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Auto mode</div>
              <div style={{ fontSize: 12, color: COLOR.muted }}>Approve these results without asking you. Questions still come to you.</div>
            </div>
          </div>
          <div style={{ border: `1px solid ${COLOR.border}`, borderRadius: 4, padding: '6px 12px', opacity: autoOn ? 1 : 0.5 }}>
            {RULES.map((rule) => (
              <div key={rule.id} style={{ padding: '4px 0' }}>
                <Check checked={loop.autoApprove[rule.id]} disabled={!autoOn} onChange={(value) => update('loop', { autoApprove: { ...loop.autoApprove, [rule.id]: value } })}
                  label={rule.label} hint={rule.hint} />
                {rule.warning && autoOn && loop.autoApprove[rule.id] && <Warning text={rule.warning} />}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: COLOR.muted, lineHeight: 1.5 }}>
            Auto approvals are recorded as <code>auto</code> in the shared approval records, so collaborators see them.
            A result whose approval was revoked by a change (its dependency changed, say) always comes back to you.
            {!saved.loop.autoApprove.enabled && autoOn && settings.loop.queued > 0 && <> Saving approves the eligible ones of the {settings.loop.queued} request(s) now waiting.</>}
          </div>
          {FIELD_GROUPS.map((group) => (
            <React.Fragment key={group}>
              {LOOP_FIELD_GROUPS[group] && <Divider label={LOOP_FIELD_GROUPS[group]} />}
              {LOOP_NUMBER_KEYS.filter((key) => LOOP_NUMBER_FIELDS[key].group === group).map((key) => {
                const field = LOOP_NUMBER_FIELDS[key];
                return <NumberField key={key} label={field.label} hint={field.hint} unit={field.unit} value={loop[key]} range={field.range}
                  onChange={(value) => update('loop', { [key]: value } as Partial<Drafts['loop']>)} error={error('loop', `loop.${key}`)} />;
              })}
            </React.Fragment>
          ))}
          {settings.loop.problems.map((problem) => <Warning key={problem} text={problem} />)}
          {settings.recentAutoApprovals.length > 0 && (
            <div style={{ fontSize: 12 }}>
              <span style={{ color: COLOR.muted }}>Recent auto approvals: </span>
              {settings.recentAutoApprovals.map((item, index) => (
                <React.Fragment key={`${item.at}-${item.target}`}>
                  {index > 0 && ' · '}
                  <a href="#" title={`${item.kind} · ${item.at}`} onClick={(event) => { event.preventDefault(); onNavigate(item.target); }} style={{ color: COLOR.link }}>{item.target}</a>
                </React.Fragment>
              ))}
            </div>
          )}
          {footer('loop')}
        </Section>

        <Section title="Sync" scope="mixed">
          <Field label="Check the remote for new commits" hint="On startup, when the window regains focus, and on an interval. This machine only.">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Segmented value={sync.autoPull} options={[['pull', 'Pull'], ['notify', 'Notify'], ['off', 'Off']]} onChange={(value) => update('sync', { autoPull: value as AutoPullMode })} />
              <span style={{ fontSize: 12, opacity: sync.autoPull === 'off' ? 0.5 : 1 }}>every{' '}
                <input value={sync.autoPullIntervalMinutes} disabled={sync.autoPull === 'off'} onChange={(event) => update('sync', { autoPullIntervalMinutes: event.target.value })} inputMode="numeric" style={{ ...inputStyle, width: 64 }} /> min
              </span>
            </div>
            <FieldError text={error('sync', 'sync.autoPullIntervalMinutes')} />
          </Field>
          <Divider label="Shared with collaborators (.research-assistant.json)" />
          <Row>
            <TextField label="Remote" value={sync.remote} onChange={(value) => update('sync', { remote: value })} error={error('sync', 'sync.remote')} />
            <TextField label="Branch" value={sync.branch} placeholder="current branch" onChange={(value) => update('sync', { branch: value })} error={error('sync', 'sync.branch')} />
            <Field label="Strategy">
              <Segmented value={sync.strategy} options={[['rebase', 'Rebase'], ['merge', 'Merge']]} onChange={(value) => update('sync', { strategy: value as 'rebase' | 'merge' })} />
            </Field>
          </Row>
          <Row>
            <TextField label="Overleaf remote" value={sync.overleafRemote} placeholder="none" onChange={(value) => update('sync', { overleafRemote: value })} error={error('sync', 'sync.overleafRemote')} />
            <TextField label="Overleaf branch" value={sync.overleafBranch} onChange={(value) => update('sync', { overleafBranch: value })} error={error('sync', 'sync.overleafBranch')} />
          </Row>
          <Row>
            <TextField label="Identity" value={sync.identity} placeholder={settings.sync.defaults.identity ?? 'git user.email'} onChange={(value) => update('sync', { identity: value })} error={error('sync', 'sync.identity')} />
            <Field label="Commits">
              <Check checked={sync.signCommits} onChange={(value) => update('sync', { signCommits: value })} label="Sign commits" />
            </Field>
          </Row>
          <TextField label="LaTeX command" hint="Used by sync prepare --latex." value={sync.latexCommand} placeholder={settings.sync.defaults.latexCommand} onChange={(value) => update('sync', { latexCommand: value })} error={error('sync', 'sync.latexCommand')} mono />
          {footer('sync')}
        </Section>

        <Section title="Context budgets" scope="shared" note="tokens per stage; empty uses the default">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
            {Object.entries(settings.contextBudgets.defaults).map(([stage, fallback]) => {
              const value = drafts.budgets[stage] ?? '';
              return (
                <div key={stage}>
                  <label style={labelStyle}>{stage}</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input value={value} placeholder={String(fallback)} inputMode="numeric" onChange={(event) => update('budgets', { [stage]: event.target.value })}
                      style={{ ...inputStyle, fontWeight: value ? 600 : 400 }} />
                    {value && <button title={`Reset to ${fallback}`} onClick={() => update('budgets', { [stage]: '' })} style={iconButtonStyle}>↺</button>}
                  </div>
                  <FieldError text={error('budgets', `contextBudgets.${stage}`)} />
                </div>
              );
            })}
          </div>
          {footer('budgets')}
        </Section>
      </div>
    </div>
  );
}

// ---------- small pieces ----------

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '5px 8px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
  border: '1px solid var(--vscode-input-border, transparent)', borderRadius: 4, fontSize: 13,
};
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 12, marginBottom: 4, opacity: 0.8 };
const iconButtonStyle: React.CSSProperties = { border: 'none', background: 'transparent', color: 'var(--vscode-foreground)', cursor: 'pointer', fontSize: 13, padding: '0 4px' };
const button = (primary: boolean, enabled: boolean): React.CSSProperties => ({
  padding: '5px 14px', border: 'none', borderRadius: 4, fontSize: 13, cursor: enabled ? 'pointer' : 'default', opacity: enabled ? 1 : 0.5,
  background: primary ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)',
  color: primary ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)',
});

function Section({ title, scope, note, children }: { title: string; scope: 'this machine' | 'shared' | 'mixed'; note?: string; children: React.ReactNode }) {
  const scopeText = scope === 'this machine' ? 'this machine only' : scope === 'shared' ? 'shared with collaborators' : '';
  return (
    <section style={{ border: `1px solid ${COLOR.border}`, borderRadius: 6, background: COLOR.card }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${COLOR.border}` }}>
        <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.6 }}>{title}</span>
        {note && <span style={{ fontSize: 11, color: COLOR.muted }}>{note}</span>}
        {scopeText && <span style={{ marginLeft: 'auto', fontSize: 11, color: COLOR.muted }}>{scopeText}</span>}
      </header>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </section>
  );
}

function SectionFooter({ dirty, saving, general, onSave, onRevert }: { dirty: boolean; saving: boolean; general?: string; onSave: () => void; onRevert: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
      {general && <span style={{ fontSize: 12, color: 'var(--vscode-inputValidation-errorForeground, ' + COLOR.error + ')', marginRight: 'auto' }}>{general}</span>}
      {dirty && !saving && <span style={{ fontSize: 11, color: COLOR.muted }}>Unsaved changes</span>}
      <button disabled={!dirty || saving} onClick={onRevert} style={button(false, dirty && !saving)}>Revert</button>
      <button disabled={!dirty || saving} onClick={onSave} style={button(true, dirty && !saving)}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <label style={labelStyle}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: COLOR.muted, marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

function FieldError({ text }: { text?: string }) {
  return text ? <div style={{ fontSize: 11, marginTop: 3, color: 'var(--vscode-inputValidation-errorForeground, ' + COLOR.error + ')' }}>{text}</div> : null;
}

function TextField({ label, hint, value, placeholder, error, mono, onChange }: { label: string; hint?: string; value: string; placeholder?: string; error?: string; mono?: boolean; onChange: (value: string) => void }) {
  return (
    <Field label={label} hint={hint}>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)}
        style={{ ...inputStyle, ...(mono ? { fontFamily: 'var(--vscode-editor-font-family)', fontSize: 12 } : {}), ...(error ? { borderColor: 'var(--vscode-inputValidation-errorBorder)' } : {}) }} />
      <FieldError text={error} />
    </Field>
  );
}

function NumberField({ label, hint, unit, value, range, error, onChange }: { label: string; hint: string; unit?: string; value: string; range: readonly [number, number]; error?: string; onChange: (value: string) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 12, alignItems: 'start' }}>
      <label style={{ fontSize: 13, paddingTop: 5 }}>{label}</label>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input value={value} inputMode="numeric" onChange={(event) => onChange(event.target.value)}
            style={{ ...inputStyle, width: 80, ...(error ? { borderColor: 'var(--vscode-inputValidation-errorBorder)' } : {}) }} />
          <span style={{ fontSize: 12, color: COLOR.muted }}>{unit ? `${unit} · ` : ''}{range[0]}–{range[1]}</span>
        </div>
        <div style={{ fontSize: 11, color: COLOR.muted, marginTop: 3 }}>{hint}</div>
        <FieldError text={error} />
      </div>
    </div>
  );
}

function Check({ checked, disabled, label, hint, onChange }: { checked: boolean; disabled?: boolean; label: string; hint?: string; onChange: (value: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13, cursor: disabled ? 'default' : 'pointer' }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}{hint && <span style={{ fontSize: 12, color: COLOR.muted }}> — {hint}</span>}</span>
    </label>
  );
}

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (value: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      style={{ width: 40, height: 22, borderRadius: 11, border: `1px solid ${on ? 'transparent' : COLOR.border}`, padding: 2, cursor: 'pointer', flexShrink: 0,
        background: on ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)', display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start' }}>
      <span style={{ width: 16, height: 16, borderRadius: 8, background: on ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)', opacity: on ? 1 : 0.6 }} />
    </button>
  );
}

function Segmented({ value, options, onChange }: { value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return (
    <div style={{ display: 'inline-flex', border: `1px solid ${COLOR.border}`, borderRadius: 4, overflow: 'hidden' }} role="radiogroup">
      {options.map(([id, label]) => (
        <button key={id} role="radio" aria-checked={value === id} onClick={() => onChange(id)}
          style={{ padding: '4px 12px', fontSize: 12, border: 'none', cursor: 'pointer',
            background: value === id ? 'var(--vscode-button-background)' : 'transparent',
            color: value === id ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)' }}>{label}</button>
      ))}
    </div>
  );
}

function Installed({ label, installed }: { label: string; installed: boolean }) {
  return <span style={{ fontSize: 12, color: installed ? COLOR.approved : COLOR.muted }}>{installed ? '✓' : '✗'} {label}{installed ? '' : ' not installed'}</span>;
}

function Warning({ text }: { text: string }) {
  return <div style={{ fontSize: 12, margin: '4px 0 0 22px', padding: '4px 8px', borderLeft: `3px solid ${COLOR.waiting}`, background: 'var(--vscode-inputValidation-warningBackground, transparent)' }}>⚠ {text}</div>;
}

function Divider({ label }: { label: string }) {
  return <div style={{ fontSize: 11, color: COLOR.muted, borderTop: `1px dashed ${COLOR.border}`, paddingTop: 8 }}>{label}</div>;
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{children}</div>;
}
