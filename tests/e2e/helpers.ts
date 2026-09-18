import { expect } from '@playwright/test';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

export async function pdf(text: string, pages = 1, rotate = 0, width = 612) {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([width, 792]);
    p.setRotation(degrees(rotate));
    p.drawText(`SECTION ${i + 1}`, { x: 60, y: 720, font, size: 13 });
    p.drawText(text, { x: 60, y: 665, font, size: 12, maxWidth: 480, lineHeight: 18 });
    p.drawText(`Page ${i + 1}`, { x: 60, y: 40, font, size: 10 });
  }
  return Buffer.from(await doc.save());
}
export async function upload(page: import('@playwright/test').Page, left: Buffer, right: Buffer) {
  await page
    .locator('#file-0')
    .setInputFiles({ name: 'original.pdf', mimeType: 'application/pdf', buffer: left });
  await page
    .locator('#file-1')
    .setInputFiles({ name: 'modified.pdf', mimeType: 'application/pdf', buffer: right });
  await page.getByRole('button', { name: 'Make a difference!' }).click();
  await expect(page.locator('#busy')).toBeHidden();
  await expect(page.locator('#result-screen')).toBeVisible();
  await expect(page.locator('#reader-0 .rendered').first()).toBeVisible();
}
