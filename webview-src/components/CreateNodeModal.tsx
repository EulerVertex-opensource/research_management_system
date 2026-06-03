import React, { useState } from 'react';
import { NodeType } from '../../src/models/types';

const ASSET_TYPES: NodeType[] = [
  'theorem', 'lemma', 'proposition', 'definition',
  'example', 'construction', 'remark',
];

interface Props {
  allowedTypes: NodeType[];
  onConfirm: (nodeType: NodeType, title: string) => void;
  onCancel: () => void;
}

export function CreateNodeModal({ allowedTypes, onConfirm, onCancel }: Props) {
  const [nodeType, setNodeType] = useState<NodeType>(allowedTypes[0]);
  const [title, setTitle] = useState('');

  const singleType = allowedTypes.length === 1;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim()) {
      onConfirm(nodeType, title.trim());
    }
  };

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
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          background: 'var(--vscode-editor-background)',
          border: '1px solid var(--vscode-panel-border)',
          borderRadius: 8,
          padding: 24,
          width: 400,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        <h3 style={{ marginBottom: 16, fontSize: 15 }}>
          {singleType ? `Create New ${allowedTypes[0].charAt(0).toUpperCase() + allowedTypes[0].slice(1)}` : 'Create New Node'}
        </h3>
        <form onSubmit={handleSubmit}>
          {!singleType && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 4, opacity: 0.8 }}>Type</label>
              <select
                value={nodeType}
                onChange={(e) => setNodeType(e.target.value as NodeType)}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  background: 'var(--vscode-dropdown-background)',
                  color: 'var(--vscode-dropdown-foreground)',
                  border: '1px solid var(--vscode-dropdown-border)',
                  borderRadius: 4,
                  fontSize: 13,
                }}
              >
                {allowedTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          )}

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 12, marginBottom: 4, opacity: 0.8 }}>Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={singleType ? 'e.g. Use Frobenius cycle to count patterns' : 'e.g. Chebotarev Density Theorem'}
              autoFocus
              style={{
                width: '100%',
                padding: '6px 10px',
                background: 'var(--vscode-input-background)',
                color: 'var(--vscode-input-foreground)',
                border: '1px solid var(--vscode-input-border)',
                borderRadius: 4,
                fontSize: 13,
              }}
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
              disabled={!title.trim()}
              style={{
                padding: '6px 14px',
                background: 'var(--vscode-button-background)',
                color: 'var(--vscode-button-foreground)',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 13,
                opacity: title.trim() ? 1 : 0.5,
              }}
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
