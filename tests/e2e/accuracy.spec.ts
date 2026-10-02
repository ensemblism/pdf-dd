import { test, expect } from '@playwright/test';
import { PDFDocument, PDFDict, PDFName, StandardFonts, degrees } from 'pdf-lib';
import { startStaticSite } from '../static-server';
import { upload, pdf } from './helpers';

let site: Awaited<ReturnType<typeof startStaticSite>>;
test.beforeAll(async () => {
  site = await startStaticSite();
});
test.afterAll(async () => {
  await site.close();
});

async function singleLine(text: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText(text, { x: 60, y: 700, size: 14, font });
  return Buffer.from(await doc.save());
}

test('real PDF superscripts remain visible as differences', async ({ page }) => {
  await page.goto(site.url);
  await upload(page, await singleLine('x² = 4'), await singleLine('x2 = 4'));
  await expect(page.locator('.change-card')).toHaveCount(1);
  await expect(page.locator('.change-card p.removed')).toContainText('²');
  await expect(page.locator('.change-card p.added')).toContainText('2');
  await page.locator('.change-card').click();
  await expect(page.locator('#reader-0 .mark.selected')).toBeVisible();
  await expect(page.locator('#reader-1 .mark.selected')).toBeVisible();
});
test('warns when a visible glyph has an unusable Unicode mapping', async ({ page }) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('E', { x: 60, y: 700, size: 14, font });
  await font.embed();
  const mapping = doc.context.stream(
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /BrokenMap def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <45> <000F> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end',
  );
  doc.context.lookup(font.ref, PDFDict).set(PDFName.of('ToUnicode'), doc.context.register(mapping));
  await page.goto(site.url);
  await upload(page, Buffer.from(await doc.save()), await singleLine('E'));
  await expect(page.locator('#notice')).toBeVisible();
  await expect(page.locator('#notice')).toContainText('unusable text mappings');
  await expect(page.locator('#notice')).toContainText('Original 1');
});
test('rotating a real PDF preserves its reading order', async ({ page }) => {
  const original = await pdf('The same body text remains unchanged.');
  const rotated = await PDFDocument.load(original);
  rotated.getPage(0).setRotation(degrees(90));
  await page.goto(site.url);
  await upload(page, original, Buffer.from(await rotated.save()));
  await expect(page.locator('.change-card')).toHaveCount(0);
  await expect(page.locator('.empty-changes')).toContainText('No text differences');
});
test('narrow PDF columns remain equal after rewrapping and shifting baselines', async ({
  page,
}) => {
  const paragraphs = [
    'The left column describes a stable scientific method with detailed explanations of its assumptions and results. Each sentence belongs to this column and continues in reading order through several lines of the same unchanged paragraph.',
    'The right column discusses separate experiments with several observations and conclusions about their performance. These words stay together within this column while the page uses a narrow gutter between the two independent paragraphs.',
  ];
  async function columns(revised: boolean) {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.TimesRoman);
    const sheet = doc.addPage([612, 792]);
    for (let side = 0; side < 2; side++) {
      const width = revised && !side ? 210 : 218;
      const lines: string[][] = [[]];
      for (const word of paragraphs[side].split(' ')) {
        const line = lines.at(-1)!;
        if (line.length && font.widthOfTextAtSize([...line, word].join(' '), 10) > width)
          lines.push([word]);
        else line.push(word);
      }
      for (const [i, line] of lines.entries()) {
        let x = side ? 307 : 72;
        const gap =
          i < lines.length - 1
            ? (width - line.reduce((sum, w) => sum + font.widthOfTextAtSize(w, 10), 0)) /
              (line.length - 1)
            : 3;
        for (const word of line) {
          sheet.drawText(word, { x, y: 700 - i * 12 + (revised && side ? 2 : 0), font, size: 10 });
          x += font.widthOfTextAtSize(word, 10) + gap;
        }
      }
    }
    return Buffer.from(await doc.save());
  }
  await page.goto(site.url);
  await upload(page, await columns(false), await columns(true));
  await expect(page.locator('.change-card')).toHaveCount(0);
  await expect(page.locator('.empty-changes')).toContainText('No text differences');
});

test('word highlights use PDF glyph widths at fit and zoom and export successfully', async ({
  page,
}) => {
  const old = 'The result is useful.';
  await page.goto(site.url);
  await upload(page, await singleLine(old), await singleLine('The result is helpful.'));
  await expect(page.locator('.change-card')).toHaveCount(1);
  await page.locator('.change-card').click();
  await expect(page.locator('.change-card p.removed')).toHaveText('useful');
  await expect(page.locator('.change-card p.added')).toHaveText('helpful');
  const mark = page.locator('#reader-0 .mark.selected');
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  const expectedX = 60 + font.widthOfTextAtSize('The result is ', 14);
  const expectedWidth = font.widthOfTextAtSize('useful', 14);
  for (const zoom of [null, '125']) {
    if (zoom) {
      await page.locator('#zoom-0').fill(zoom);
      await expect(page.locator('#zoom-label-0')).toHaveText('125%');
      await expect
        .poll(() =>
          page
            .locator('#reader-0 .paper')
            .first()
            .evaluate((p) => p.getBoundingClientRect().width),
        )
        .toBeCloseTo(612 * 1.25, 0);
    }
    await expect(mark).toBeVisible();
    const box = await mark.evaluate((element) => {
      const paper = element.closest('.paper')!.getBoundingClientRect();
      const rect = element.getBoundingClientRect(),
        scale = paper.width / 612;
      return { x: (rect.left - paper.left) / scale, width: rect.width / scale };
    });
    expect(box.x).toBeCloseTo(expectedX, 0);
    expect(box.width).toBeCloseTo(expectedWidth, 0);
  }
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const exported = await download;
  const stream = await exported.createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  expect((await PDFDocument.load(Buffer.concat(chunks))).getPageCount()).toBe(1);
  await exported.saveAs('tmp/test-results/accuracy-comparison.pdf');
  await page.screenshot({ path: 'tmp/test-results/accuracy-highlights.png' });
  await expect(page.locator('#notice')).toBeHidden();
});

async function positionedDigit(offset: number, size: number) {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    sheet = doc.addPage([612, 792]);
  sheet.drawText('x', { x: 60, y: 700, size: 14, font });
  sheet.drawText('2', { x: 67, y: 700 + offset, size, font });
  sheet.drawText(' = 4', { x: 73, y: 700, size: 14, font });
  return Buffer.from(await doc.save());
}

test('detects a geometrically raised ordinary digit, including its glyph highlight', async ({
  page,
}) => {
  await page.goto(site.url);
  await upload(page, await positionedDigit(7, 9), await positionedDigit(0, 14));
  await expect(page.locator('.change-card')).toHaveCount(1);
  await expect(page.locator('.change-card p.removed')).toContainText('²');
  await expect(page.locator('.change-card p.added')).toContainText('2');
  await page.locator('.change-card').click();
  await expect(page.locator('#reader-0 .mark.selected')).toBeVisible();
  await expect(page.locator('#reader-1 .mark.selected')).toBeVisible();
});
test('a raised ordinary digit equals the corresponding Unicode superscript', async ({ page }) => {
  await page.goto(site.url);
  await upload(page, await positionedDigit(7, 9), await singleLine('x² = 4'));
  await expect(page.locator('.change-card')).toHaveCount(0);
});
test('distinguishes a superscript from a subscript drawn with the same ordinary digit', async ({
  page,
}) => {
  await page.goto(site.url);
  await upload(page, await positionedDigit(7, 9), await positionedDigit(-4, 9));
  await expect(page.locator('.change-card')).toHaveCount(1);
  await expect(page.locator('.change-card p.removed')).toContainText('²');
  await expect(page.locator('.change-card p.added')).toContainText('₂');
});
