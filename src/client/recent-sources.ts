import { parseArxivInput } from '../shared/arxiv';

export type RecentKind = 'arxiv' | 'git';
export interface RecentSource {
  value: string;
  name?: string;
}
type Store = Pick<Storage, 'getItem' | 'setItem'>;
const LIMIT = 20;

function entry(kind: RecentKind, value: string, name?: string): RecentSource {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.includes('\0'))
    throw new Error('Invalid recent source');
  if (kind === 'arxiv') {
    const { id, version } = parseArxivInput(value);
    value = id + (version === undefined ? '' : `v${version}`);
  } else if (!/^(\/|[a-z]:[\\/]|\\\\)/i.test(value)) {
    throw new Error('Expected an absolute PDF path');
  }
  return {
    value,
    ...(typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, 300) } : {}),
  };
}

/** Small, origin-local metadata only. Storage errors never prevent using a PDF source. */
export class RecentSources {
  readonly key: string;
  private storage?: Store;
  private data: Record<RecentKind, RecentSource[]> = { arxiv: [], git: [] };
  constructor(edition: 'web' | 'local', storage: () => Store = () => localStorage) {
    this.key = `pdf-dd:recent-sources:v1:${edition}`;
    try {
      this.storage = storage();
      const raw = this.storage.getItem(this.key);
      if (raw === null) return;
      const parsed = JSON.parse(raw);
      const data = { arxiv: [], git: [] } as Record<RecentKind, RecentSource[]>;
      for (const kind of ['arxiv', 'git'] as const) {
        if (!Array.isArray(parsed[kind])) throw new Error('Invalid recent sources');
        for (const item of parsed[kind]) {
          const source = entry(kind, item.value, item.name);
          if (!data[kind].some((e) => e.value === source.value) && data[kind].length < LIMIT)
            data[kind].push(source);
        }
      }
      this.data = data;
    } catch {
      this.storage = undefined; // Keep an in-memory list if storage is blocked or corrupt.
    }
  }
  list(kind: RecentKind): RecentSource[] {
    return this.data[kind].map((source) => ({ ...source }));
  }
  add(kind: RecentKind, value: string, name?: string) {
    try {
      const source = entry(kind, value, name);
      this.data[kind] = [source, ...this.data[kind].filter((e) => e.value !== source.value)].slice(
        0,
        LIMIT,
      );
      this.save();
    } catch {
      /* Invalid metadata must not interrupt a successful load. */
    }
  }
  remove(kind: RecentKind, value: string) {
    this.data[kind] = this.data[kind].filter((e) => e.value !== value);
    this.save();
  }
  clear(kind: RecentKind) {
    this.data[kind] = [];
    this.save();
  }
  private save() {
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.data));
    } catch {
      this.storage = undefined;
    }
  }
}
