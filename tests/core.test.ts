import { describe, it, expect } from 'vitest';
import { compare, blocksOf, pairPages } from '../src/client/core';
import { exportComparison } from '../src/client/export';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { resolve } from 'node:path';
import type { Page, TextItem } from '../src/client/model';

function page(lines: string[], overrides: Partial<Page> = {}): Page {
  return {
    width: 612,
    height: 792,
    rotation: 0,
    view: [0, 0, 612, 792],
    items: lines.map((str, i) => ({
      str,
      x: 40,
      y: 50 + i * 30,
      width: str.length * 6,
      height: 12,
    })),
    ...overrides,
  };
}
describe('text comparison', () => {
  it('keeps a tall column heading from bridging body rows in the other column', () => {
    const left = [
      'The normalization method keeps',
      'activation values stable during',
      'training and preserves useful',
      'representations across the layers.',
      'These values remain stable.',
      'Additional experiments confirm',
      'the stability across different',
      'models and training settings.',
    ];
    const right = [
      'Adaptive optimization improves',
      'the training procedure for many',
      'models with different parameters.',
      'The reference gives full details.',
    ];
    const p = page([], {
      items: [
        ...left.map((str, i) => ({
          str,
          x: 72,
          y: 212 + i * 12,
          width: 229,
          height: 10,
          baseline: [72, 219 + i * 12] as [number, number],
        })),
        { str: 'References', x: 311, y: 230, width: 67, height: 14, baseline: [311, 240] },
        ...right.map((str, i) => ({
          str,
          x: 311,
          y: 255 + i * 12,
          width: 229,
          height: 10,
          baseline: [311, 262 + i * 12] as [number, number],
        })),
      ],
    });
    const blocks = blocksOf([p]);
    expect(blocks.some((b) => b.text === 'References')).toBe(true);
    const text = blocks.map((b) => b.text).join(' ');
    expect(text.indexOf('These values remain stable.')).toBeLessThan(text.indexOf('References'));
    expect(text).toContain('activation values stable during training and preserves useful');
  });
  it.each([
    ['t´', 'el´', 'ephones'],
    ['G¨', 'ulc¸', 'ehre'],
  ])('preserves overlapping TeX accents when runs are fragmented: %s', (...strings) => {
    const p = page([], {
      items: strings.map((str, i) => ({
        str,
        x: [40, 45, 52][i],
        y: 50,
        width: [8.5, 10.5, 28][i],
        height: 10,
        baseline: [[40, 45, 52][i], 57] as [number, number],
      })),
    });
    const fragmented = {
      ...p,
      items: p.items.flatMap((item) =>
        Array.from(item.str).map((str, i) => ({
          ...item,
          str,
          x: item.x + (item.width * i) / item.str.length,
          width: item.width / item.str.length,
        })),
      ),
    };
    expect(compare([p], [fragmented]).changes).toEqual([]);
    expect(blocksOf([p])[0].text).toBe(strings.join(''));
  });
  it('preserves dotted author initials when a bibliography changes position', () => {
    const citation = [
      '[1] M. Auli, M. Galley, C. Quirk, and G. Zweig.',
      'Joint language and translation modeling with recurrent neural networks.',
      'In EMNLP, 2013.',
    ];
    const prose =
      'The encoder preserves the full input sequence and produces a useful representation for translation.';
    const changes = compare([page([...citation, prose])], [page([prose, ...citation])]).changes;
    expect(
      changes
        .filter((c) => c.kind !== 'moved')
        .every((c) => !/Auli|Galley|Quirk|Zweig/.test(c.before + c.after)),
    ).toBe(true);
  });
  it('places a raised ordinal with its own row rather than the preceding row', () => {
    const p = page([], {
      items: [
        { str: 'Initial parameter vector', x: 40, y: 206, width: 210, height: 10 },
        { str: '(Initialize 1', x: 150, y: 217, width: 45, height: 10 },
        { str: 'st', x: 195, y: 216, width: 5, height: 7 },
        { str: 'moment vector)', x: 203, y: 217, width: 120, height: 10 },
      ],
    });
    const blocks = blocksOf([p]);
    expect(blocks.some((b) => b.text.includes('1st moment vector'))).toBe(true);
    expect(blocks.some((b) => b.text.includes('vectorst'))).toBe(false);
  });
  it('keeps pseudocode lines stable when a repeated variant is added', () => {
    const make = (lines: string[]) =>
      page(lines, {
        items: lines.map((str, i) => ({ str, x: 40, y: 50 + i * 14, width: 450, height: 12 })),
      });
    const code = [
      'Require: Initial parameter vector',
      'while not converged do',
      'Compute gradients of the objective at the current step',
      'Update first moment estimate',
      'return parameters',
    ];
    const left = [make(code)];
    const right = [
      make(['Algorithm 1: Updated description.', ...code]),
      make([
        'Algorithm 2: A new variant.',
        ...code.slice(0, 3),
        'Update second moment estimate',
        'return parameters',
      ]),
    ];
    const changes = compare(left, right).changes;
    expect(changes.every((c) => c.left.length === 0)).toBe(true);
    expect(changes.some((c) => c.after.includes('second moment'))).toBe(true);
  });
  it('reads a side figure separately from prose wrapping beside it', () => {
    const left = page([
      'The model analyzes its internal representations.',
      'It learns to preserve distances between image patches.',
    ]);
    const right = page([], {
      items: [
        { str: 'The model analyzes its internal', x: 40, y: 50, width: 270, height: 12 },
        { str: 'Input', x: 340, y: 60, width: 30, height: 12 },
        { str: 'Attention', x: 390, y: 60, width: 60, height: 12 },
        { str: 'representations.', x: 40, y: 64, width: 120, height: 12 },
        { str: 'It learns to preserve distances', x: 40, y: 90, width: 270, height: 12 },
        { str: 'between image patches.', x: 40, y: 104, width: 270, height: 12 },
        { str: 'Figure 1: Attention maps.', x: 319, y: 104, width: 140, height: 12 },
      ],
    });
    const changes = compare([left], [right]).changes;
    expect(
      changes.every((c) => !/representations|distances|patches/.test(c.before + c.after)),
    ).toBe(true);
    expect(changes.some((c) => c.after.includes('Attention'))).toBe(true);
  });
  it('continues a sentence onto a new page starting with a year', () => {
    const a = [
      page(['We used the larger dataset from']),
      page(['2014 consisting of many labeled examples.']),
    ];
    const b = [page(['We used the larger dataset from 2014 consisting of many labeled examples.'])];
    expect(compare(a, b).changes).toEqual([]);
  });
  it('retains shared prose when a revised sentence is split into two sentences', () => {
    const left = page([
      'For the larger models, the execution time was one second per step, and the models were trained for many thousands of steps over several days.',
    ]);
    const right = page([
      'The execution time for larger models was one second per step. The models were trained for many thousands of steps (over several days).',
    ]);
    const changes = compare([left], [right]).changes;
    expect(changes.length).toBeGreaterThan(0);
    expect(
      changes.every((c) => !/models were trained|many thousands/.test(c.before + c.after)),
    ).toBe(true);
  });
  it('excludes adjacent whitespace from highlighted source spans', () => {
    const left = page(['The result is useful for everyone.']);
    const right = page(['The result is helpful for everyone.']);
    const result = compare([left], [right]);
    for (const change of result.changes)
      for (const [refs, source] of [
        [change.left, left],
        [change.right, right],
      ] as const) {
        const text = refs
          .map((ref) => source.items[ref.item].str.slice(ref.start, ref.end))
          .join('');
        expect(text).toBe(text.trim());
      }
    const addition = compare(
      [page(['effect of intervention'])],
      [page(['effect of an intervention'])],
    ).changes[0];
    expect(addition.right).toEqual([{ page: 0, item: 0, start: 10, end: 12 }]);
  });
  it('does not flag identical PDFs or line wrapping', () => {
    expect(compare([page(['A small example'])], [page(['A small example'])]).changes).toEqual([]);
    const a = page(['A paragraph that wraps across lines.']);
    const b = page(['A paragraph that', 'wraps across lines.']);
    b.items[1].y = 64;
    expect(compare([a], [b]).changes).toEqual([]);
  });
  it('keeps numbered footnotes out of rewrapped cross-page sentences but compares their text', () => {
    const make = (tail: string, continuation: string) => [
      page([], {
        items: [
          {
            str: `The model lacks inductive biases ${tail}`,
            x: 40,
            y: 680,
            width: 400,
            height: 12,
          },
          { str: '1', x: 40, y: 712, width: 3, height: 6 },
          { str: 'Reliable', x: 44, y: 714, width: 35, height: 9 },
          { str: 'code is available.', x: 91, y: 714, width: 130, height: 9 },
        ],
      }),
      page([continuation]),
    ];
    const left = make('inherent to CNNs, such as translation', 'equivariance and locality.');
    const right = make('inherent to CNNs, such as', 'translation equivariance and locality.');
    expect(compare(left, right).changes).toEqual([]);
    right[0].items[3].str = 'code is provided.';
    const changed = compare(left, right).changes;
    expect(changed.length).toBeGreaterThan(0);
    expect(
      changed.every((c) => [...c.left, ...c.right].every((r) => r.page === 0 && r.item === 3)),
    ).toBe(true);
  });
  it('locates a suffix addition at its original character offset', () => {
    const result = compare([page(['A variable'])], [page(['A variables'])]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      kind: 'added',
      after: 's',
      right: [{ page: 0, item: 0, start: 10, end: 11 }],
    });
  });
  it('rejoins a small footnote continued on the next page without a repeated marker', () => {
    const sheet = (body: string, note: string, numbered: boolean) =>
      page([], {
        items: [
          { str: body, x: 40, y: 120, width: 280, height: 12 },
          ...(numbered ? [{ str: '1', x: 40, y: 712, width: 3, height: 6 }] : []),
          { str: note, x: numbered ? 44 : 40, y: 714, width: 340, height: 9 },
        ],
      });
    const old = [
      sheet(
        'First body paragraph remains.',
        'The scientific note continues with more context and ends.',
        true,
      ),
      sheet('Second body paragraph remains.', '', false),
    ];
    const revised = [
      sheet('First body paragraph remains.', 'The scientific note con-', true),
      sheet('Second body paragraph remains.', 'tinues with more context and ends.', false),
    ];
    expect(compare(old, revised).changes).toMatchObject([{ before: '', after: '-' }]);
    expect(compare(old, revised).changes).toHaveLength(1);
  });
  it('keeps a deep subscript from merging adjacent body rows', () => {
    const runs = page([], {
      items: [
        { str: 'First x', x: 40, y: 50, width: 42, height: 10 },
        { str: '2', x: 82, y: 57, width: 4, height: 7 },
        { str: ' remains.', x: 86, y: 50, width: 60, height: 10 },
        { str: 'Second line is unchanged.', x: 40, y: 61, width: 220, height: 10 },
      ],
    });
    expect(
      compare([page(['First x2 remains.', 'Second line is unchanged.'])], [runs]).changes,
    ).toEqual([]);
  });
  it('compares inserted figures separately from continued narrative', () => {
    const beginning = page(['A long sentence ends at']);
    const left = [beginning, page(['the continuation and it ends.'])];
    const right = [
      beginning,
      page([], {
        items: [
          { str: 'Training', x: 40, y: 150, width: 60, height: 9 },
          { str: '0.1', x: 120, y: 150, width: 24, height: 9 },
          { str: 'Figure 1: A newly added learning curve.', x: 40, y: 300, width: 430, height: 12 },
          { str: 'the continuation and it ends.', x: 40, y: 340, width: 220, height: 12 },
        ],
      }),
    ];
    const changes = compare(left, right).changes;
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.kind === 'added' && c.right.every((r) => r.item !== 3))).toBe(
      true,
    );
    expect(changes.some((c) => c.after.includes('learning curve'))).toBe(true);
    expect(changes.some((c) => c.after.includes('0.1'))).toBe(true);
  });
  it('still finds a changed value inside a detached table', () => {
    const table = (value: string) =>
      page([], {
        items: [
          { str: 'Table 1: Model accuracy results.', x: 40, y: 130, width: 300, height: 12 },
          { str: 'Accuracy', x: 40, y: 150, width: 60, height: 12 },
          { str: value, x: 160, y: 150, width: 20, height: 12 },
        ],
      });
    expect(compare([table('95')], [table('98')]).changes).toMatchObject([
      { before: '95', after: '98', left: [{ item: 2 }], right: [{ item: 2 }] },
    ]);
  });
  it('pairs a revised paragraph across an unchanged anchor without hiding negation', () => {
    const before = 'During training we did not use any dropout on the shared encoder.';
    const after = 'During training we did use any dropout on the shared encoder.';
    const anchor = 'An independent paragraph remains unchanged for all experiments.';
    expect(compare([page([before, anchor])], [page([anchor, after])]).changes).toMatchObject([
      { before: 'not', after: '' },
    ]);
    expect(compare([page([before, anchor])], [page([anchor, after])]).changes).toHaveLength(1);
  });
  it('aligns a compound with its expanded phrase while retaining real wording edits', () => {
    const changes = compare(
      [page(['An encoder-decoder configuration.'])],
      [page(['An encoder and a decoder.'])],
    ).changes;
    expect(changes.every((c) => !/encoder|decoder/.test(c.before + c.after))).toBe(true);
    expect(changes.some((c) => c.before.includes('configuration'))).toBe(true);
    expect(changes.some((c) => c.after === 'and a')).toBe(true);
  });
  it('preserves a shared stem when a phrase becomes a prefixed word', () => {
    const changes = compare(
      [page(['The deterministic parameterization trick.'])],
      [page(['The reparameterization trick.'])],
    ).changes;
    expect(changes.every((c) => !/parameterization/.test(c.before + c.after))).toBe(true);
    expect(changes.some((c) => c.before === 'deterministic')).toBe(true);
    expect(changes.some((c) => c.after === 're')).toBe(true);
  });
  it.each([
    ['useful', 'helpful'],
    ['95', '98'],
    ['x²', 'x2'],
  ])('keeps weakly related tokens readable: %s / %s', (before, after) => {
    expect(compare([page([before])], [page([after])]).changes).toMatchObject([
      { kind: 'replaced', before, after },
    ]);
  });
  it('handles CJK replacements and punctuation', () => {
    const result = compare([page(['模型是可靠的。'])], [page(['模型是准确的！'])]);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.some((c) => c.before.includes('可靠') && c.after.includes('准确'))).toBe(
      true,
    );
    expect(result.changes.some((c) => c.before.includes('。') && c.after.includes('！'))).toBe(
      true,
    );
  });
  it('finds an unchanged paragraph moved across pages', () => {
    const a = 'This long paragraph uniquely describes the first experiment.';
    const b = 'Another paragraph provides a completely different discussion.';
    const c = 'The conclusion contains enough unique words to be an anchor.';
    const result = compare([page([a, b]), page([c])], [page([b]), page([c, a])]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      kind: 'moved',
      before: a,
      left: [{ page: 0 }],
      right: [{ page: 1 }],
    });
  });
  it('does not identify ambiguous duplicate paragraphs as moves', () => {
    const a = 'A repeated paragraph appears multiple times in this document.';
    const b = 'A second paragraph provides unique content for stable anchors.';
    const result = compare([page([a, a, b])], [page([b, a, a])]);
    expect(result.changes.some((c) => c.kind === 'moved' && c.before === a)).toBe(false);
  });
  it('ignores repagination and aligns inserted pages', () => {
    const a = 'First independent paragraph with sufficient descriptive text.';
    const b = 'Second independent paragraph with some other descriptive text.';
    expect(compare([page([a, b])], [page([a]), page([b])]).changes).toHaveLength(0);
    const result = compare(
      [page([a]), page([b])],
      [page(['A newly inserted standalone page.']), page([a]), page([b])],
    );
    expect(result.pagePairs).toEqual([
      [null, 0],
      [0, 1],
      [1, 2],
    ]);
    expect(result.changes.every((c) => c.kind === 'added')).toBe(true);
  });
  it('reads each column vertically instead of interleaving columns', () => {
    const items: TextItem[] = [];
    for (let i = 0; i < 4; i++)
      for (const x of [40, 330])
        items.push({
          str: `${x === 40 ? 'Left' : 'Right'} ${i}`,
          x,
          y: 100 + i * 14,
          width: 150,
          height: 12,
        });
    const blocks = blocksOf([page([], { items })]);
    expect(blocks.map((b) => b.text).join(' ')).toBe(
      'Left 0 Left 1 Left 2 Left 3 Right 0 Right 1 Right 2 Right 3',
    );
  });
  it('reads narrow column gutters before joining body lines', () => {
    const items: TextItem[] = [];
    for (let i = 0; i < 4; i++)
      for (const x of [72, 307])
        items.push({
          str: `${x === 72 ? 'Left' : 'Right'} ${i}`,
          x,
          y: 100 + i * 14,
          width: 218,
          height: 11,
        });
    expect(
      blocksOf([page([], { items })])
        .map((b) => b.text)
        .join(' '),
    ).toBe('Left 0 Left 1 Left 2 Left 3 Right 0 Right 1 Right 2 Right 3');
  });
  it('keeps a vertical arXiv stamp out of the body reading order', () => {
    const p = page(['First body line', 'Second body line', 'Third body line']);
    p.items[1].y = 64;
    p.items[2].y = 78;
    p.items.push({ str: 'arXiv:1234v1', x: 20, y: 60, width: 20, height: 300 });
    expect(blocksOf([p]).map((b) => b.text)).toEqual([
      'First body line Second body line Third body line',
      'arXiv:1234v1',
    ]);
  });
  it('localizes a line-end hyphen without inserting a false word space', () => {
    const wrapped = page(['A Rad-', 'ford model']);
    wrapped.items[1].y = 64;
    const changes = compare([page(['A Radford model'])], [wrapped]).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'added',
      before: '',
      after: '-',
      right: [{ item: 0, start: 5, end: 6 }],
    });
    expect(
      compare(
        [page(['A state-of-the-art model'])],
        [
          page(['A state-of-the-', 'art model'], {
            items: [
              { str: 'A state-of-the-', x: 40, y: 50, width: 100, height: 12 },
              { str: 'art model', x: 40, y: 64, width: 60, height: 12 },
            ],
          }),
        ],
      ).changes,
    ).toEqual([]);
  });
  it('joins mixed-font runs which bridge two earlier fragments', () => {
    expect(
      blocksOf([
        page([], {
          items: [
            { str: 'A', x: 40, y: 50, width: 6, height: 12 },
            { str: 'B', x: 80, y: 50, width: 6, height: 12 },
            { str: ' word ', x: 46, y: 50.1, width: 34, height: 12 },
          ],
        }),
      ]).map((b) => b.text),
    ).toEqual(['A word B']);
  });
  it('keeps an inline superscript in its word while retaining its meaning', () => {
    const inline = page([], {
      items: [
        { str: 'x', x: 40, y: 50, width: 7, height: 12 },
        { str: '²', x: 47, y: 46, width: 4, height: 7 },
        { str: ' = value', x: 51, y: 50, width: 60, height: 12 },
      ],
    });
    expect(compare([page(['x² = value'])], [inline]).changes).toEqual([]);
    expect(compare([page(['x2 = value'])], [inline]).changes).not.toEqual([]);
  });
  it('does not infer prose columns from plot labels on a single-column page', () => {
    const items: TextItem[] = [
      { str: 'Full-width narrative.', x: 40, y: 50, width: 480, height: 12 },
    ];
    for (let i = 0; i < 4; i++)
      for (const x of [40, 330])
        items.push({
          str: `${x === 40 ? 'L' : 'R'}${i}`,
          x,
          y: 100 + i * 14,
          width: 30,
          height: 12,
        });
    expect(
      blocksOf([page([], { items })])
        .map((b) => b.text)
        .join(' '),
    ).toBe('Full-width narrative. L0 R0 L1 R1 L2 R2 L3 R3');
  });
  it('anchors unchanged sentences inside paragraphs with revised surrounding text', () => {
    const stable = 'The architecture stays exactly the same.';
    const changes = compare(
      [page([`Old opening. ${stable} Old ending.`])],
      [page([`New opening. ${stable} New ending.`])],
    ).changes;
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => !/architecture|exactly/.test(c.before + c.after))).toBe(true);
  });
  it('keeps a lower-case continuation across pages in one sentence', () => {
    const blocks = blocksOf([
      page(['An incomplete sentence extends']),
      page(['across pages without edits.']),
    ]);
    expect(blocks.map((b) => b.text)).toEqual([
      'An incomplete sentence extends across pages without edits.',
    ]);
    expect(blocks[0].refs.some((ref) => ref?.page === 1)).toBe(true);
  });
  it('separates hyphen movement from an adjacent real wording change', () => {
    const changes = compare(
      [page(['It needs gradi-ents and requires little memory.'])],
      [page(['It needs gra-dients with little memory.'])],
    ).changes;
    expect(changes.some((c) => c.before === '-' && !c.after)).toBe(true);
    expect(changes.some((c) => c.after === '-' && !c.before)).toBe(true);
    expect(changes.some((c) => c.before === 'and requires' && c.after === 'with')).toBe(true);
    expect(changes.every((c) => !/gradi|ents/.test(c.before + c.after))).toBe(true);
  });
  it('preserves the stem when a word gains a hyphen and loses a suffix', () => {
    const changes = compare([page(['attended'])], [page(['at-tend'])]).changes;
    expect(changes).toMatchObject([
      { kind: 'added', before: '', after: '-', right: [{ start: 2, end: 3 }] },
      { kind: 'removed', before: 'ed', after: '', left: [{ start: 6, end: 8 }] },
    ]);
    expect(changes).toHaveLength(2);
  });
  it('keeps prose aligned when author-year citations move to the sentence end', () => {
    const changes = compare(
      [
        page([
          'Tasks include parsing (Reader et al., 2018) and answering (Writer et al., 2019), where models produce token-level output.',
        ]),
      ],
      [
        page([
          'Tasks include parsing and answering, where models produce token level output (Reader et al., 2018; Writer et al., 2019).',
        ]),
      ],
    ).changes;
    expect(changes.length).toBeGreaterThan(0);
    expect(
      changes.every((c) => !/models|produce|output|token|level/.test(c.before + c.after)),
    ).toBe(true);
    const suffix = compare(
      [page(['A model (Reader et al., 2018).'])],
      [page(['A model (Reader et al., 2018a).'])],
    ).changes;
    expect(suffix).toMatchObject([{ kind: 'added', after: 'a' }]);
    expect(suffix).toHaveLength(1);
  });
  it('keeps running headers and page numbers from interrupting a continued word', () => {
    const sheet = (header: string, body: string, number: string) =>
      page([], {
        items: [
          { str: header, x: 40, y: 20, width: 120, height: 12 },
          { str: body, x: 40, y: 100, width: 220, height: 12 },
          { str: number, x: 300, y: 755, width: 6, height: 12 },
        ],
      });
    const changes = compare(
      [
        sheet('Draft version', 'This model re-', '1'),
        sheet('Draft version', 'quires modest memory.', '2'),
      ],
      [
        sheet('Final version', 'This model requires modest memory.', '1'),
        sheet('Final version', '', '2'),
      ],
    ).changes;
    expect(changes.some((c) => c.before === '-')).toBe(true);
    expect(changes.some((c) => /Draft/.test(c.before) && /Final/.test(c.after))).toBe(true);
    expect(changes.every((c) => !/model|quires|memory/.test(c.before + c.after))).toBe(true);
  });
  it('lists left-column changes before changes at the top of the right column', () => {
    const items: TextItem[] = [];
    for (let i = 0; i < 4; i++)
      for (const x of [72, 307])
        items.push({
          str: `${x === 72 ? 'Left' : 'Right'} text ${i}.`,
          x,
          y: 100 + i * 14,
          width: 218,
          height: 11,
        });
    const updated = structuredClone(items);
    updated[6].str = 'Left revised 3.';
    updated[1].str = 'Right revised 0.';
    const changes = compare([page([], { items })], [page([], { items: updated })]).changes;
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.left[0].item)).toEqual([6, 1]);
  });
  it('keeps real hyphens and normalizes ligatures without losing source offsets', () => {
    expect(compare([page(['re-sign'])], [page(['resign'])]).changes[0]).toMatchObject({
      kind: 'removed',
      before: '-',
    });
    expect(compare([page(['ﬁnd'])], [page(['find'])]).changes).toHaveLength(0);
  });
  it.each([
    ['x²', 'x2'],
    ['H₂O', 'H2O'],
    ['ℝ', 'R'],
    ['①', '1'],
    ['−1', '-1'],
    ['95%', '98%'],
    ['result is significant', 'result is not significant'],
  ])('preserves meaningful changes from %s to %s', (before, after) => {
    const result = compare([page([before])], [page([after])]);
    expect(result.changes.length).toBeGreaterThan(0);
    for (const change of result.changes)
      for (const [refs, text] of [
        [change.left, before],
        [change.right, after],
      ] as const)
        for (const ref of refs) {
          expect(ref.start).toBeGreaterThanOrEqual(0);
          expect(ref.end).toBeLessThanOrEqual(text.length);
          expect(text.slice(ref.start, ref.end)).not.toBe('');
        }
  });
  it.each([
    ['café', 'cafe\u0301'],
    ['oﬃce', 'office'],
    ['A\u00a0word', 'A word'],
  ])('accepts canonical spelling and typography: %s / %s', (before, after) => {
    expect(compare([page([before])], [page([after])]).changes).toEqual([]);
  });
  it('keeps ligature source offsets when a later character changes', () => {
    const result = compare([page(['ﬁnd'])], [page(['ﬁnds'])]);
    expect(result.changes[0]).toMatchObject({
      kind: 'added',
      after: 's',
      right: [{ start: 3, end: 4 }],
    });
  });
  it('does not anchor reflowed body text to a page number', () => {
    const a = page(['First paragraph.', 'Second paragraph.', '1']);
    const b = [page(['First paragraph.', '1']), page(['Second paragraph.', '2'])];
    const result = compare([a], b);
    expect(result.changes.length).toBeGreaterThan(0); // page numbers remain significant
    expect(result.changes.every((c) => !/paragraph/.test(c.before + c.after))).toBe(true);
    expect(
      result.anchors.every((anchor) =>
        a.items.some((item) => item.y === anchor.left.y && item.str !== '1'),
      ),
    ).toBe(true);
  });
  it('marks an exhausted budget as coarse and keeps the changed text visible', () => {
    const result = compare([page(['Old content'])], [page(['New content'])], 0);
    expect(result.coarse).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ before: 'Old content', after: 'New content' });
  });
  it('does not call an unchanged numeric block a move', () => {
    const doc = [page(['012345678901234567890123456789'])];
    expect(compare(doc, doc).changes).toEqual([]);
    expect(compare(doc, doc, 0).changes).toEqual([]);
  });
  it.each([90, 180, 270])('does not confuse page rotation %s with text edits', (rotation) => {
    const original = page([
      'First line of the same document.',
      'Second line remains unchanged.',
      'Third line is also the same.',
    ]);
    const vertical = rotation % 180 !== 0;
    const rotated = page([], {
      rotation,
      width: vertical ? 792 : 612,
      height: vertical ? 612 : 792,
      items: original.items.map((item) => ({
        ...item,
        x:
          rotation === 90
            ? 792 - item.y - item.height
            : rotation === 180
              ? 612 - item.x - item.width
              : item.y,
        y:
          rotation === 90
            ? item.x
            : rotation === 180
              ? 792 - item.y - item.height
              : 612 - item.x - item.width,
        width: vertical ? item.height : item.width,
        height: vertical ? item.width : item.height,
      })),
    });
    expect(compare([original], [rotated]).changes).toEqual([]);
    rotated.items[1].str = 'Second line has genuinely changed.';
    expect(compare([original], [rotated]).changes.length).toBeGreaterThan(0);
  });
  it('handles empty documents without pretending to produce differences', () => {
    expect(compare([page([])], [page([])]).changes).toEqual([]);
    expect(pairPages(2, 1, [])).toEqual([
      [0, 0],
      [1, null],
    ]);
  });
  it('compares 100 pages with sparse edits without whole-document character matching', () => {
    const a = Array.from({ length: 100 }, (_, i) =>
      page([
        `Section ${i}. This is a unique paragraph describing experiment ${i}.`,
        `Results for ${i}: accuracy is 95 percent.`,
      ]),
    );
    const b = structuredClone(a);
    b[70].items[1].str = 'Results for 70: accuracy is 98 percent.';
    const start = performance.now(),
      result = compare(a, b);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].left[0].page).toBe(70);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});
it('exports original vector pages into a paired comparison with missing sides', async () => {
  const original = await PDFDocument.create(),
    font = await original.embedFont(StandardFonts.Helvetica);
  original.addPage([300, 400]).drawText('Original text', { x: 30, y: 350, font });
  const bytes = await original.save();
  const result = await exportComparison({
    files: [bytes, bytes],
    pages: [
      [page([], { width: 300, height: 400, view: [0, 0, 300, 400] })],
      [page([], { width: 300, height: 400, view: [0, 0, 300, 400] })],
    ],
    comparison: {
      changes: [],
      anchors: [],
      pagePairs: [
        [0, 0],
        [null, 0],
      ],
    },
    geometry: { left: {}, right: {} },
  });
  const pdf = await PDFDocument.load(result);
  expect(pdf.getPageCount()).toBe(2);
  expect(pdf.getPage(0).getSize()).toEqual({ width: 656, height: 456 });
  expect(pdf.getPage(0).node.Resources()?.toString()).toContain('XObject');
});
it.each(['incomplete', 'coarse'] as const)(
  'persists the %s notice in the exported PDF',
  async (status) => {
    const source = await PDFDocument.create();
    source.addPage([300, 400]);
    const bytes = await source.save();
    const result = await exportComparison({
      files: [bytes, bytes],
      pages: [[page([])], [page([])]],
      comparison: { changes: [], anchors: [], pagePairs: [[0, 0]], coarse: status === 'coarse' },
      geometry: { left: {}, right: {} },
      incomplete: status === 'incomplete',
    });
    const task = getDocument({
      data: result,
      standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
    });
    try {
      const doc = await task.promise;
      const text = (await (await doc.getPage(1)).getTextContent()).items
        .filter((item) => 'str' in item)
        .map((item) => item.str)
        .join(' ');
      expect(text).toContain(
        status === 'incomplete' ? 'Text comparison is incomplete' : 'detailed comparison timed out',
      );
    } finally {
      await task.destroy();
    }
  },
);

describe('comparison invariants', () => {
  const original = page([], {
    items: [
      { str: 'Encoder:', x: 40, y: 50, width: 48, height: 10 },
      {
        str: ' A deterministic method uses stable mathematical notation.',
        x: 88,
        y: 50.12,
        width: 400,
        height: 10,
      },
      { str: 'The estimate is x', x: 40, y: 70, width: 96, height: 10 },
      { str: '2', x: 136, y: 68, width: 4, height: 7 },
      { str: ' and the result is unchanged.', x: 140, y: 70, width: 190, height: 10 },
      { str: '[CLS]', x: 40, y: 110, width: 35, height: 10 },
      { str: '[CLS]', x: 40, y: 110, width: 35, height: 10 },
      {
        str: 'A small note remains in its own reading flow.',
        x: 40,
        y: 710,
        width: 270,
        height: 8,
      },
    ],
  });
  it.each([1, 3, 7, 17])('is independent of text-run fragmentation into %i characters', (size) => {
    const fragmented = {
      ...original,
      items: original.items.flatMap((item) =>
        Array.from({ length: Math.ceil(item.str.length / size) }, (_, k) => ({
          ...item,
          str: item.str.slice(k * size, (k + 1) * size),
          x: item.x + (item.width * k * size) / item.str.length,
          width: (item.width * Math.min(size, item.str.length - k * size)) / item.str.length,
        })),
      ),
    };
    expect(compare([original], [fragmented]).changes).toEqual([]);
  });
  it('does not let a partial sentence consume a merged revision', () => {
    const left = [
      page([
        'The method is simple to implement. The method is computationally efficient, requires little memory and handles large problems. The method adapts to the geometry of the objective function.',
        'The hyper-parameters have intuitive interpretations and require little tuning.',
      ]),
    ];
    const right = [
      page([
        'The method is simple to implement, is computationally efficient, requires little memory, adapts to the geometry of the objective function, and handles large problems.',
        'The hyper-parameters have intuitive interpretations and require little tuning.',
      ]),
    ];
    const changes = compare(left, right).changes;
    expect(changes.length).toBeGreaterThan(0);
    expect(
      changes.some((c) => c.left.some((s) => s.item === 1) || c.right.some((s) => s.item === 1)),
    ).toBe(false);
    expect(changes.every((c) => !/computationally|efficient|memory/.test(c.before + c.after))).toBe(
      true,
    );
  });
  it('keeps common citation authors when punctuation changes', () => {
    const changes = compare(
      [page(['Previous work Brown et al. (1992); Ando and Zhang (2005) informs the approach.'])],
      [page(['Previous work (Brown et al., 1992; Ando and Zhang, 2005) informs the approach.'])],
    ).changes;
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => !/Brown|Ando|Zhang|1992|2005/.test(c.before + c.after))).toBe(true);
  });
  it('an unrelated addition does not retokenize unchanged compound words', () => {
    const text = 'Our encoder-decoder implementation computes gradient-based updates reliably.';
    const changes = compare(
      [page([text])],
      [page([text, 'The decoder and encoder are separately documented.'])],
    ).changes;
    expect(changes.every((c) => c.left.length === 0 && c.right.every((s) => s.item === 1))).toBe(
      true,
    );
  });
  it('keeps negations, signs and full numerical values visible', () => {
    const changes = compare(
      [page(['This method does not converge with a stepsize of -95.'])],
      [page(['This method does converge with a stepsize of +98.'])],
    ).changes;
    expect(changes.map((c) => c.before).join(' ')).toContain('not');
    expect(changes.map((c) => c.before).join(' ')).toContain('-');
    expect(changes.map((c) => c.before).join(' ')).toContain('95');
    expect(changes.map((c) => c.after).join(' ')).toContain('+');
    expect(changes.map((c) => c.after).join(' ')).toContain('98');
  });
});

it('preserves an exact phrase moved within a rewritten sentence', () => {
  const changes = compare(
    [
      page([
        'We introduce a method. The method is straightforward to implement and is based on adaptive estimates of lower-order moments. The method is computationally efficient and requires little memory.',
      ]),
    ],
    [
      page([
        'We introduce a method based on adaptive estimates of lower-order moments. The method is straightforward to implement, is computationally efficient and requires little memory.',
      ]),
    ],
  ).changes;
  expect(
    changes.some((c) => c.kind === 'moved' && c.before.includes('straightforward to implement')),
  ).toBe(true);
  expect(
    changes
      .filter((c) => c.kind !== 'moved')
      .every((c) => !/straightforward|implement/.test(c.before + c.after)),
  ).toBe(true);
});

it('keeps raised ordinals stable when the same drawing is fragmented', () => {
  const input = page([], {
    items: [
      { str: 'Initialize 1', x: 40, y: 50, width: 66, height: 10, baseline: [40, 58] },
      { str: 'st ', x: 106, y: 48, width: 9, height: 7, baseline: [106, 53.6] },
      { str: 'moment vector.', x: 115, y: 50, width: 84, height: 10, baseline: [115, 58] },
    ],
  });
  const fragmented = {
    ...input,
    items: input.items.flatMap((item) =>
      Array.from(item.str, (str, i) => ({
        ...item,
        str,
        x: item.x + (item.width * i) / item.str.length,
        width: item.width / item.str.length,
      })),
    ),
  };
  expect(compare([input], [fragmented]).changes).toEqual([]);
});

it('recognizes a unique reordered email address as moved content', () => {
  const changes = compare(
    [page(['lukaszkaiser@google.com', 'other@example.org'])],
    [page(['other@example.org', 'lukaszkaiser@google.com'])],
  ).changes;
  expect(changes.some((c) => c.kind === 'moved')).toBe(true);
  expect(changes.every((c) => c.kind === 'moved')).toBe(true);
});
