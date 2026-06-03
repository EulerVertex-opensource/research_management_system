import React, { useRef, useState } from 'react';
import { AddPaperModal } from './AddPaperModal';

interface PendingPaper {
  fileName: string;
  file: File;
}

interface Props {
  onAddPaper: (slug: string, fileName: string, fileData: string, bibEntry: string, description: string) => void;
}

export function PapersView({ onAddPaper }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingPaper | null>(null);
  const [reading, setReading] = useState(false);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPending({ fileName: file.name, file });
    e.target.value = '';
  };

  const handleConfirm = (slug: string, bibEntry: string, description: string) => {
    if (!pending) return;
    setReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
      onAddPaper(slug, pending.fileName, base64, bibEntry, description);
      setPending(null);
      setReading(false);
    };
    reader.onerror = () => setReading(false);
    reader.readAsDataURL(pending.file);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <div style={{ padding: 24 }}>
        <h2 style={{ fontSize: 15, marginBottom: 16 }}>Papers</h2>

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
          style={{
            padding: '8px 18px',
            background: 'var(--vscode-button-background)',
            color: 'var(--vscode-button-foreground)',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 13,
            marginBottom: 24,
            opacity: reading ? 0.5 : 1,
          }}
        >
          {reading ? 'Reading…' : 'Add PDF…'}
        </button>

        <p style={{ fontSize: 12, opacity: 0.5, marginBottom: 20 }}>
          Copies the PDF to <code>raw_papers/</code>, adds a BibTeX entry to{' '}
          <code>manuscript/reference.bib</code>, and appends an entry to <code>papers.md</code>.
        </p>

        <p style={{ fontSize: 13, opacity: 0.7 }}>
          You can also edit <code>papers.md</code> and <code>manuscript/reference.bib</code> directly.
          Reference papers in asset nodes via their <code>paper_id</code> (slug).
        </p>
      </div>

      {pending && !reading && (
        <AddPaperModal
          fileName={pending.fileName}
          onConfirm={handleConfirm}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
