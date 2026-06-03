import React, { useState, useRef, useEffect } from 'react';
import { ResearchNode } from '../../src/models/types';
import { PROMPT_TEMPLATES } from '../../src/prompts/templates';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  nodes: ResearchNode[];
  onSendAI: (requestId: string, prompt: string, contextNodeIds: string[], template?: string) => void;
  streamingId: string | null;
  streamingText: string;
}

export function AIChat({ nodes, onSendAI, streamingId, streamingText }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // When streaming finishes, add the assistant message
  useEffect(() => {
    if (pendingId && streamingId === null && streamingText) {
      setMessages((prev) => [...prev, { role: 'assistant', content: streamingText }]);
      setPendingId(null);
    }
  }, [streamingId, pendingId, streamingText]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  const handleSend = () => {
    const template = PROMPT_TEMPLATES[selectedTemplate];
    const fullPrompt = template ? template.template + input : input;
    if (!fullPrompt.trim()) return;

    const requestId = `req_${Date.now()}`;
    setMessages((prev) => [...prev, { role: 'user', content: input || template?.label || '' }]);
    setPendingId(requestId);
    onSendAI(requestId, fullPrompt, Array.from(selectedNodes), selectedTemplate || undefined);
    setInput('');
  };

  const toggleNode = (id: string) => {
    setSelectedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isStreaming = pendingId !== null;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Context node picker */}
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--vscode-panel-border)',
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>CONTEXT NODES</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 80, overflowY: 'auto' }}>
          {nodes.map((n) => (
            <button
              key={n.id}
              onClick={() => toggleNode(n.id)}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                borderRadius: 12,
                border: '1px solid var(--vscode-input-border)',
                background: selectedNodes.has(n.id)
                  ? 'var(--vscode-button-background)'
                  : 'var(--vscode-input-background)',
                color: selectedNodes.has(n.id)
                  ? 'var(--vscode-button-foreground)'
                  : 'var(--vscode-foreground)',
                cursor: 'pointer',
              }}
            >
              {n.title.length > 30 ? n.title.substring(0, 28) + '…' : n.title}
            </button>
          ))}
          {nodes.length === 0 && (
            <span style={{ fontSize: 12, opacity: 0.5 }}>No nodes available</span>
          )}
        </div>
      </div>

      {/* Chat history */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
        {messages.length === 0 && (
          <div style={{ opacity: 0.4, fontSize: 13, textAlign: 'center', marginTop: 32 }}>
            Ask the AI assistant about your research.<br />Select context nodes above to include them.
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              marginBottom: 12,
              padding: '10px 12px',
              borderRadius: 6,
              background:
                msg.role === 'user'
                  ? 'var(--vscode-input-background)'
                  : 'var(--vscode-editor-inactiveSelectionBackground)',
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 4, textTransform: 'uppercase' }}>
              {msg.role}
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0 }}>
              {msg.content}
            </pre>
          </div>
        ))}
        {isStreaming && streamingText && (
          <div
            style={{
              marginBottom: 12,
              padding: '10px 12px',
              borderRadius: 6,
              background: 'var(--vscode-editor-inactiveSelectionBackground)',
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 4, textTransform: 'uppercase' }}>
              assistant
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0 }}>
              {streamingText}
              <span style={{ opacity: 0.5 }}>▍</span>
            </pre>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div
        style={{
          borderTop: '1px solid var(--vscode-panel-border)',
          padding: '8px 12px',
          flexShrink: 0,
        }}
      >
        <select
          value={selectedTemplate}
          onChange={(e) => setSelectedTemplate(e.target.value)}
          style={{
            width: '100%',
            marginBottom: 6,
            padding: '4px 8px',
            background: 'var(--vscode-dropdown-background)',
            color: 'var(--vscode-dropdown-foreground)',
            border: '1px solid var(--vscode-dropdown-border)',
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          <option value="">— Select a template (optional) —</option>
          {Object.entries(PROMPT_TEMPLATES).map(([key, { label }]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <div style={{ display: 'flex', gap: 6 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSend();
            }}
            placeholder="Type your message… (Ctrl+Enter to send)"
            rows={3}
            disabled={isStreaming}
            style={{
              flex: 1,
              padding: '6px 10px',
              background: 'var(--vscode-input-background)',
              color: 'var(--vscode-input-foreground)',
              border: '1px solid var(--vscode-input-border)',
              borderRadius: 4,
              fontSize: 12,
              resize: 'none',
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || (!input.trim() && !selectedTemplate)}
            style={{
              padding: '6px 14px',
              background: 'var(--vscode-button-background)',
              color: 'var(--vscode-button-foreground)',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 13,
              alignSelf: 'flex-end',
              opacity: isStreaming || (!input.trim() && !selectedTemplate) ? 0.5 : 1,
            }}
          >
            {isStreaming ? '…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
