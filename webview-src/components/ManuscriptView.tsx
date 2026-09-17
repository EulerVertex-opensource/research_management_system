import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { ManuscriptStatus } from '../../src/models/types';

declare global {
  interface Window {
    __RESEARCH_ASSISTANT_PDF_WORKER__: string;
  }
}

GlobalWorkerOptions.workerSrc = window.__RESEARCH_ASSISTANT_PDF_WORKER__;

interface ManuscriptViewProps {
  status: ManuscriptStatus | null;
  onBuild(): void;
  onReload(): void;
  onOpenExternal(): void;
  onSetAutoBuild(enabled: boolean): void;
  onApplySettings(): void;
  onInstallLatexWorkshop(): void;
}

interface PdfPageProps {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  pageRef(node: HTMLDivElement | null): void;
}

function PdfPage({ document, pageNumber, scale, pageRef }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy['render']> | undefined;
    void document.getPage(pageNumber).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = page.getViewport({ scale });
      const pixelRatio = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is unavailable.');
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      return renderTask.promise;
    }).catch((reason: unknown) => {
      if (!cancelled && (reason as { name?: string }).name !== 'RenderingCancelledException') {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, pageNumber, scale]);

  return (
    <div
      ref={pageRef}
      data-page-number={pageNumber}
      style={{ margin: '18px auto', width: 'fit-content', minHeight: 80, position: 'relative' }}
    >
      <canvas ref={canvasRef} style={{ display: 'block', background: 'white', boxShadow: '0 2px 12px rgba(0,0,0,0.35)' }} />
      {error && <div style={{ color: 'var(--vscode-errorForeground)', padding: 12 }}>Page {pageNumber}: {error}</div>}
    </div>
  );
}

function PdfViewer({ uri }: { uri: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.2);
  const [fitWidth, setFitWidth] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pageElements = useRef(new Map<number, HTMLDivElement>());
  const documentRef = useRef<PDFDocumentProxy | null>(null);

  useEffect(() => {
    let disposed = false;
    let loaded = false;
    const task = getDocument({ url: uri });
    setLoadError(null);
    void task.promise.then((nextDocument) => {
      if (disposed) {
        void nextDocument.destroy();
        return;
      }
      loaded = true;
      const previous = documentRef.current;
      documentRef.current = nextDocument;
      setDocument(nextDocument);
      if (previous) void previous.destroy();
      setCurrentPage((page) => Math.min(page, nextDocument.numPages));
    }).catch((reason: unknown) => {
      if (!disposed) setLoadError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      disposed = true;
      if (!loaded) void task.destroy();
    };
  }, [uri]);

  useEffect(() => () => {
    if (documentRef.current) void documentRef.current.destroy();
  }, []);

  useEffect(() => {
    if (!document || !fitWidth || !viewportRef.current) return;
    const viewportElement = viewportRef.current;
    const updateScale = async () => {
      const firstPage = await document.getPage(1);
      const unscaled = firstPage.getViewport({ scale: 1 });
      setScale(Math.max(0.25, (viewportElement.clientWidth - 48) / unscaled.width));
    };
    void updateScale();
    const observer = new ResizeObserver(() => void updateScale());
    observer.observe(viewportElement);
    return () => observer.disconnect();
  }, [document, fitWidth]);

  useEffect(() => {
    const root = viewportRef.current;
    if (!root) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const page = Number((visible?.target as HTMLElement | undefined)?.dataset.pageNumber);
      if (page) setCurrentPage(page);
    }, { root, threshold: [0.2, 0.5, 0.8] });
    for (const element of pageElements.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [document, scale]);

  const pageNumbers = useMemo(
    () => document ? Array.from({ length: document.numPages }, (_, index) => index + 1) : [],
    [document]
  );

  const moveToPage = (page: number) => {
    if (!document) return;
    const next = Math.max(1, Math.min(document.numPages, page));
    setCurrentPage(next);
    pageElements.current.get(next)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const changeZoom = (factor: number) => {
    setFitWidth(false);
    setScale((value) => Math.max(0.25, Math.min(4, value * factor)));
  };

  return (
    <div style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={viewerToolbarStyle}>
        <button style={secondaryButtonStyle} onClick={() => changeZoom(0.85)} title="Zoom out">−</button>
        <button style={secondaryButtonStyle} onClick={() => changeZoom(1.15)} title="Zoom in">+</button>
        <button style={secondaryButtonStyle} onClick={() => setFitWidth(true)}>Fit width</button>
        <span style={{ opacity: 0.75 }}>{Math.round(scale * 100)}%</span>
        <span style={{ flex: 1 }} />
        <button style={secondaryButtonStyle} onClick={() => moveToPage(currentPage - 1)} disabled={currentPage <= 1}>‹</button>
        <label>
          Page{' '}
          <input
            value={currentPage}
            type="number"
            min={1}
            max={document?.numPages ?? 1}
            onChange={(event) => moveToPage(Number(event.target.value))}
            style={{ width: 54, padding: '3px 5px', color: 'var(--vscode-input-foreground)', background: 'var(--vscode-input-background)', border: '1px solid var(--vscode-input-border)' }}
          />
          {' '}of {document?.numPages ?? '…'}
        </label>
        <button style={secondaryButtonStyle} onClick={() => moveToPage(currentPage + 1)} disabled={!document || currentPage >= document.numPages}>›</button>
      </div>
      {loadError && document && (
        <div style={{ padding: '6px 10px', color: 'var(--vscode-errorForeground)', borderBottom: '1px solid var(--vscode-panel-border)', fontSize: 12 }}>
          Unable to load the latest PDF; showing the last valid preview. {loadError}
        </div>
      )}
      <div ref={viewportRef} style={{ minHeight: 0, flex: 1, overflow: 'auto', background: 'var(--vscode-sideBar-background)' }}>
        {!document ? (
          <div style={{ padding: 24, color: loadError ? 'var(--vscode-errorForeground)' : undefined, opacity: loadError ? 1 : 0.65 }}>
            {loadError ? `Unable to render PDF: ${loadError}` : 'Loading PDF…'}
          </div>
        ) : pageNumbers.map((pageNumber) => (
          <PdfPage
            key={`${pageNumber}-${scale}`}
            document={document}
            pageNumber={pageNumber}
            scale={scale}
            pageRef={(node) => {
              if (node) pageElements.current.set(pageNumber, node);
              else pageElements.current.delete(pageNumber);
            }}
          />
        ))}
      </div>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  padding: '6px 12px',
  border: 'none',
  borderRadius: 3,
  cursor: 'pointer',
  color: 'var(--vscode-button-foreground)',
  background: 'var(--vscode-button-background)',
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '4px 9px',
  border: '1px solid var(--vscode-button-border, var(--vscode-panel-border))',
  borderRadius: 3,
  cursor: 'pointer',
  color: 'var(--vscode-button-secondaryForeground)',
  background: 'var(--vscode-button-secondaryBackground)',
};

const viewerToolbarStyle: React.CSSProperties = {
  minHeight: 38,
  padding: '5px 10px',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  borderBottom: '1px solid var(--vscode-panel-border)',
  fontSize: 12,
};

export function ManuscriptView(props: ManuscriptViewProps) {
  const { status } = props;
  const conflict = Boolean(status?.configurationConflicts.length);
  const compiling = status?.phase === 'compiling';

  return (
    <div style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 9, borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0 }}>
        <strong style={{ fontSize: 13 }}>Manuscript</strong>
        <code style={{ opacity: 0.7, fontSize: 11 }}>{status?.mainTex ?? 'main.tex'}</code>
        <span style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }} title="This workspace setting is shared through Git">
          <input
            type="checkbox"
            checked={status?.autoBuild ?? false}
            disabled={!status?.latexWorkshopInstalled}
            onChange={(event) => props.onSetAutoBuild(event.target.checked)}
          />
          Build on save
        </label>
        <button
          style={secondaryButtonStyle}
          onClick={props.onReload}
          title="Load the latest compiled PDF from the local LaTeX output directory"
        >
          View compiled PDF
        </button>
        <button style={secondaryButtonStyle} onClick={props.onOpenExternal} disabled={!status?.pdfUri}>Open externally</button>
        <button
          style={primaryButtonStyle}
          onClick={props.onBuild}
          disabled={compiling || !status?.latexWorkshopInstalled || conflict}
        >
          {compiling ? 'Compiling…' : 'Compile Manuscript'}
        </button>
      </div>

      {!status ? (
        <div style={{ padding: 24, opacity: 0.65 }}>Loading manuscript status…</div>
      ) : (
        <>
          {!status.latexWorkshopInstalled && (
            <div style={{ padding: '9px 12px', borderBottom: '1px solid var(--vscode-panel-border)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span><strong>Local compiler unavailable.</strong> Install LaTeX Workshop and a TeX distribution containing <code>latexmk</code>.</span>
              <button style={primaryButtonStyle} onClick={props.onInstallLatexWorkshop}>Install LaTeX Workshop</button>
            </div>
          )}
          {conflict && (
            <div style={{ padding: '9px 12px', borderBottom: '1px solid var(--vscode-panel-border)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span>
                <strong>Build settings conflict:</strong>{' '}
                {status.configurationConflicts.map((key) => <code key={key} style={{ marginRight: 6 }}>{key}</code>)}
              </span>
              <button style={primaryButtonStyle} onClick={props.onApplySettings}>Use Research Assistant build setup</button>
            </div>
          )}
          {status.message && status.latexWorkshopInstalled && (
            <div style={{ padding: '7px 12px', color: status.phase === 'failed' ? 'var(--vscode-errorForeground)' : 'inherit', borderBottom: '1px solid var(--vscode-panel-border)', fontSize: 12 }}>
              {status.message}
            </div>
          )}
          {status.pdfUri ? (
            <PdfViewer uri={status.pdfUri} />
          ) : (
            <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
              <div>
                <h2 style={{ fontSize: 15, marginBottom: 8 }}>No local PDF yet</h2>
                <p style={{ opacity: 0.65 }}>Compile <code>{status.mainTex}</code> to create <code>{status.outputPdf}</code>.</p>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
