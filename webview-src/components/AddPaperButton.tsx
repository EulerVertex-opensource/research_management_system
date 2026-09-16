import React, { useRef, useState } from 'react';
import { AddPaperModal } from './AddPaperModal';

interface Props {
  onAdd: (slug: string, fileName: string, fileData: string, bibEntry: string, description: string, sourceUrl: string) => void;
}

export function AddPaperButton({ onAdd }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ fileName: string; file: File } | null>(null);
  const [reading, setReading] = useState(false);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPending({ fileName: file.name, file });
    e.target.value = '';
  };

  const handleConfirm = (slug: string, bibEntry: string, description: string, sourceUrl: string) => {
    if (!pending) return;
    setReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
      onAdd(slug, pending.fileName, base64, bibEntry, description, sourceUrl);
      setPending(null);
      setReading(false);
    };
    reader.onerror = () => setReading(false);
    reader.readAsDataURL(pending.file);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf"
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={reading}
        title={reading ? 'Reading file…' : 'Add PDF'}
        style={{
          padding: '1px 8px',
          fontSize: 12,
          background: 'var(--vscode-button-background)',
          color: 'var(--vscode-button-foreground)',
          border: 'none',
          borderRadius: 3,
          cursor: reading ? 'default' : 'pointer',
          opacity: reading ? 0.5 : 1,
        }}
      >
        {reading ? '…' : '+ PDF'}
      </button>
      {pending && !reading && (
        <AddPaperModal
          fileName={pending.fileName}
          onConfirm={handleConfirm}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
