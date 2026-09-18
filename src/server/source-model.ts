export interface Revision {
  id: string;
  label: string;
  date: string;
  detail: string;
}
export interface SourceHistory {
  token: string;
  kind: 'arxiv' | 'git';
  arxivId?: string;
  title: string;
  subtitle: string;
  revisions: Revision[]; // Newest first; current working file first for Git.
  original: string;
  modified: string;
  path?: string;
  truncated?: boolean;
}
