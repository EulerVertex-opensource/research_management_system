import type { BibAction, Bump, PackageDiff, PackageManifest, VersionChanges } from '../domain/packages';

/** What the dashboard shows about research packages. Plain data: sent to the webview as is. */

export interface InstalledPackageView {
  alias: string;
  package: string;
  version: string;
  results: number;
  /** Results its approval does not (or no longer) cover. */
  pending: number;
  accepted: boolean;
  /** The version the researcher last accepted, when it differs from the installed one. */
  approvedVersion?: string;
  source: string;
  problems: string[];
}

export interface PackagesPayload {
  library: string;
  manifest?: PackageManifest;
  installed: InstalledPackageView[];
  /** The latest release of this project's own package. */
  released?: string;
}

/** What the researcher sets in the export dialog; absent fields keep the saved manifest. */
export interface ExportRequest {
  name?: string;
  /** This work's BibTeX entry; saved to research/package/citation.bib on export. */
  citation?: string;
  exports?: string[];
  version?: string;
  locations?: Record<string, string>;
}

export interface ExportCandidate { id: string; title: string; approved: boolean; required: boolean }

export interface ExportPreviewView {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  manifest: Partial<PackageManifest>;
  exports: string[];
  closure: Array<{ id: string; kind: 'asset' | 'definition'; title: string; origin: 'project' | 'library' }>;
  version: string;
  previous?: string;
  bump: Bump;
  changes: VersionChanges;
  unchanged: boolean;
  /** Project results the researcher can choose to export. */
  candidates: ExportCandidate[];
  /** The citation the preview used: the one being edited, else the saved one, else a template to fill in. */
  citation: string;
  /** Whether research/package/citation.bib exists. */
  citationSaved: boolean;
}

/** This project's own citation, for the Settings page. */
export interface CitationView {
  path: string;
  /** The saved text, or a template when nothing is saved yet. */
  text: string;
  saved: boolean;
  key?: string;
  problems: string[];
  warnings: string[];
}

export interface ImportPreviewView {
  ok: boolean;
  /** The path the preview was built from, sent back to import it. */
  source: string;
  /** Set when updating an installed package. */
  update?: string;
  name: string;
  version: string;
  alias: string;
  nodes: Array<{ id: string; upstream: string; kind: 'asset' | 'definition'; title: string }>;
  bibChanges: Array<{ key: string; as: string; action: BibAction; unchanged?: boolean }>;
  conflicts: string[];
  warnings: string[];
  diff?: PackageDiff;
}

export type PackageModal = { kind: 'import' } | { kind: 'export' } | { kind: 'update'; alias: string };
