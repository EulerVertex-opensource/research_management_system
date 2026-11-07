import React from 'react';

/** A dialog over the dashboard: title, scrolling body, and a footer of actions. */

export const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  background: 'var(--vscode-input-background)',
  color: 'var(--vscode-input-foreground)',
  border: '1px solid var(--vscode-input-border)',
  borderRadius: 4,
  fontSize: 13,
  fontFamily: 'var(--vscode-font-family)',
};

export const labelStyle: React.CSSProperties = { display: 'block', fontSize: 12, marginBottom: 4, opacity: 0.8 };

export function buttonStyle(kind: 'primary' | 'secondary', enabled = true): React.CSSProperties {
  return {
    padding: '6px 14px',
    background: kind === 'primary' ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)',
    color: kind === 'primary' ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: 4,
    cursor: enabled ? 'pointer' : 'default',
    fontSize: 13,
    opacity: enabled ? 1 : 0.5,
    whiteSpace: 'nowrap',
  };
}

export const smallButtonStyle: React.CSSProperties = {
  padding: '2px 8px', fontSize: 12, background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)', border: 'none', borderRadius: 3, cursor: 'pointer', whiteSpace: 'nowrap',
};

interface Props {
  title: string;
  subtitle?: string;
  width?: number;
  onClose: () => void;
  footer: React.ReactNode;
  children: React.ReactNode;
}

export function Modal({ title, subtitle, width = 560, onClose, footer, children }: Props) {
  return (
    <div
      onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
    >
      <div
        role="dialog"
        aria-label={title}
        style={{
          background: 'var(--vscode-editor-background)', border: '1px solid var(--vscode-panel-border)', borderRadius: 8,
          width: `min(${width}px, calc(100vw - 32px))`, maxHeight: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)', position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{ position: 'absolute', top: 10, right: 12, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1, color: 'var(--vscode-foreground)', opacity: 0.6, padding: '2px 4px' }}
        >
          ✕
        </button>
        <div style={{ padding: '20px 24px 12px' }}>
          <h3 style={{ fontSize: 15, marginBottom: subtitle ? 4 : 0 }}>{title}</h3>
          {subtitle && <p style={{ fontSize: 12, opacity: 0.6, wordBreak: 'break-all' }}>{subtitle}</p>}
        </div>
        <div style={{ padding: '0 24px', overflow: 'auto', flex: 1 }}>{children}</div>
        <div style={{ padding: '14px 24px 20px', display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--vscode-panel-border)', marginTop: 12 }}>{footer}</div>
      </div>
    </div>
  );
}

/** A titled list inside a dialog; nothing when empty. Long lists show the first `max` items. */
export function ItemList({ title, items, tone, max = 12 }: { title: string; items: React.ReactNode[]; tone?: 'error' | 'warning'; max?: number }) {
  if (!items.length) return null;
  const color = tone === 'error' ? 'var(--vscode-errorForeground)' : tone === 'warning' ? 'var(--vscode-editorWarning-foreground)' : undefined;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ ...labelStyle, color, opacity: color ? 1 : 0.8 }}>{title}</div>
      <ul style={{ paddingLeft: 18, fontSize: 12, lineHeight: 1.6, color }}>
        {items.slice(0, max).map((item, index) => <li key={index}>{item}</li>)}
        {items.length > max && <li style={{ opacity: 0.7 }}>and {items.length - max} more</li>}
      </ul>
    </div>
  );
}
