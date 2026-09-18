import { describe, expect, test } from 'vitest';
import { RecentSources } from '../src/client/recent-sources';

function store() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
test('normalizes arXiv links and IDs, retaining distinct explicit versions and recency', () => {
  const storage = store(),
    recent = new RecentSources('web', () => storage);
  recent.add('arxiv', 'https://arxiv.org/pdf/1706.03762v6.pdf?download=1');
  recent.add('arxiv', '1706.03762v7');
  recent.add('arxiv', 'https://arxiv.org/abs/1706.03762');
  recent.add('arxiv', 'arXiv:1706.03762v6', 'Updated name');
  recent.add('arxiv', 'hep-th/9901001v2');
  expect(recent.list('arxiv').map((e) => e.value)).toEqual([
    'hep-th/9901001v2',
    '1706.03762v6',
    '1706.03762',
    '1706.03762v7',
  ]);
  expect(recent.list('arxiv')[1].name).toBe('Updated name');
  expect(new RecentSources('web', () => storage).list('arxiv')).toEqual(recent.list('arxiv'));
  expect(new RecentSources('local', () => storage).list('arxiv')).toEqual([]);
});
test('limits each category to twenty and deduplicates actual paths without changing them', () => {
  const recent = new RecentSources('local', () => store());
  for (let i = 0; i < 25; i++) {
    recent.add('arxiv', `2401.${String(i).padStart(5, '0')}`);
    recent.add('git', `/papers/${i}.pdf`);
  }
  expect(recent.list('arxiv')).toHaveLength(20);
  expect(recent.list('git')).toHaveLength(20);
  expect(recent.list('git').at(-1)!.value).toBe('/papers/5.pdf');
  recent.add('git', '/papers/10.pdf');
  expect(recent.list('git')[0].value).toBe('/papers/10.pdf');
  expect(recent.list('git')).toHaveLength(20);
  for (const path of [
    'C:\\Papers\\Draft.pdf',
    '\\\\server\\share\\paper.pdf',
    '/papers/ space .pdf',
  ]) {
    recent.add('git', path);
    expect(recent.list('git')[0].value).toBe(path);
  }
});
test('deletion and category clearing preserve other categories, editions and unrelated storage', () => {
  const storage = store(),
    recent = new RecentSources('local', () => storage);
  storage.setItem('unrelated', 'keep');
  new RecentSources('web', () => storage).add('arxiv', '1706.03762v1');
  recent.add('arxiv', '1706.03762v6');
  recent.add('arxiv', '1706.03762v7');
  recent.add('git', '/papers/draft.pdf');
  recent.remove('arxiv', '1706.03762v6');
  expect(recent.list('arxiv').map((e) => e.value)).toEqual(['1706.03762v7']);
  recent.clear('arxiv');
  const restored = new RecentSources('local', () => storage);
  expect(restored.list('arxiv')).toEqual([]);
  expect(restored.list('git')).toEqual([{ value: '/papers/draft.pdf' }]);
  expect(storage.getItem('unrelated')).toBe('keep');
  expect(new RecentSources('web', () => storage).list('arxiv')).toHaveLength(1);
  expect(JSON.parse(storage.getItem(recent.key)!)).toEqual({
    arxiv: [],
    git: [{ value: '/papers/draft.pdf' }],
  });
});
describe('safe in-memory fallback', () => {
  test.each(['not json', 'null', '{"arxiv":{}}', '{"arxiv":[{"value":"bad"}],"git":[]}'])(
    'handles corrupt data: %s',
    (raw) => {
      const storage = store();
      storage.setItem('pdf-dd:recent-sources:v1:web', raw);
      const recent = new RecentSources('web', () => storage);
      recent.add('arxiv', '1706.03762v6');
      expect(recent.list('arxiv')).toEqual([{ value: '1706.03762v6' }]);
      recent.clear('arxiv');
      expect(recent.list('arxiv')).toEqual([]);
      expect(storage.getItem(recent.key)).toBe(raw);
    },
  );
  test('handles blocked access and reads, and quota errors after a successful read', () => {
    for (const storage of [
      () => {
        throw new Error('SecurityError');
      },
      () => ({
        getItem: () => {
          throw new Error('Read failed');
        },
        setItem: () => {},
      }),
      () => ({
        getItem: () => JSON.stringify({ arxiv: [{ value: '1706.03762v1' }], git: [] }),
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      }),
    ]) {
      const recent = new RecentSources('web', storage);
      recent.add('arxiv', '1706.03762v6');
      expect(recent.list('arxiv')[0].value).toBe('1706.03762v6');
      recent.remove('arxiv', '1706.03762v6');
      expect(recent.list('arxiv').some((e) => e.value === '1706.03762v6')).toBe(false);
    }
  });
});
test('rejects invalid metadata without persisting it and returns detached list values', () => {
  const storage = store(),
    recent = new RecentSources('local', () => storage);
  recent.add('arxiv', 'https://evil.example/paper');
  recent.add('git', '~/draft.pdf');
  recent.add('git', 'relative.pdf');
  expect(storage.values.size).toBe(0);
  recent.add('git', '/paper.pdf');
  recent.list('git')[0].value = 'changed';
  expect(recent.list('git')[0].value).toBe('/paper.pdf');
});
