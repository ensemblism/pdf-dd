import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import type { ExportInput, Rect } from './model';

export async function exportComparison(
  input: ExportInput,
  progress: (n: number) => void = () => {},
) {
  const { files, pages, comparison, geometry } = input;
  const sources = await Promise.all(files.map((file) => PDFDocument.load(file)));
  const out = await PDFDocument.create();
  out.setTitle('PDF comparison');
  out.setProducer('PDF Diff Discerner');
  const font = await out.embedFont(StandardFonts.Helvetica);
  const pad = 20,
    header = 36,
    gap = 16;
  for (let row = 0; row < comparison.pagePairs.length; row++) {
    const pair = comparison.pagePairs[row];
    const meta = pair.map((p, s) => (p === null ? null : pages[s][p]));
    const widths = meta.map((p, s) => p?.width ?? meta[1 - s]?.width ?? 612);
    const h = Math.max(...meta.map((p) => p?.height ?? 0));
    const sheet = out.addPage([widths[0] + widths[1] + gap + pad * 2, h + header + pad]);
    sheet.drawText('Original  - red: removed     Modified  - green: added     Blue: moved', {
      x: pad,
      y: h + pad + 18,
      size: 9,
      font,
      color: rgb(0.25, 0.3, 0.3),
    });
    if (input.incomplete || comparison.coarse)
      sheet.drawText(
        input.incomplete
          ? 'Text comparison is incomplete; some text or highlights could not be recovered.'
          : 'Some changes are shown as whole text blocks because detailed comparison timed out.',
        {
          x: pad,
          y: h + pad + 5,
          size: 8,
          font,
          color: rgb(0.65, 0.25, 0.15),
        },
      );
    for (const side of [0, 1] as const) {
      const p = pair[side],
        x = pad + (side ? widths[0] + gap : 0),
        y = pad;
      if (p === null) {
        sheet.drawText(side ? 'Page removed' : 'Page added', {
          x: x + 16,
          y: y + h / 2,
          size: 12,
          font,
          color: rgb(0.5, 0.5, 0.5),
        });
        continue;
      }
      const page = pages[side][p],
        source = sources[side].getPage(p);
      // A genuinely blank PDF page has no content stream to embed.
      if (source.node.Contents()) {
        const [left, bottom, right, top] = page.view;
        const embedded = await out.embedPage(source, { left, bottom, right, top });
        const rotation = ((page.rotation % 360) + 360) % 360;
        const dx = rotation === 180 || rotation === 270 ? page.width : 0;
        const dy = rotation === 90 || rotation === 180 ? page.height : 0;
        sheet.drawPage(embedded, { x: x + dx, y: y + dy, rotate: degrees(-rotation) });
      }
      sheet.drawText(`${side ? 'Modified' : 'Original'} - page ${p + 1}`, {
        x,
        y: 7,
        size: 8,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });
      for (const change of comparison.changes) {
        const rects = (side ? geometry.right : geometry.left)[change.id] ?? [];
        const color =
          change.kind === 'moved'
            ? rgb(0.2, 0.47, 0.78)
            : side
              ? rgb(0.08, 0.6, 0.43)
              : rgb(0.84, 0.23, 0.23);
        let labelDrawn = false;
        for (const rect of rects.filter((r: Rect) => r.page === p)) {
          sheet.drawRectangle({
            x: x + rect.x,
            y: y + page.height - rect.y - rect.height,
            width: rect.width,
            height: rect.height,
            color,
            opacity: change.kind === 'moved' ? 0.23 : 0.31,
          });
          if (change.kind === 'moved' && !labelDrawn) {
            sheet.drawText(`M${change.id}`, {
              x: x + Math.max(0, rect.x - 22),
              y: y + page.height - rect.y - 6,
              size: 6,
              font,
              color,
            });
            labelDrawn = true;
          }
        }
      }
    }
    progress(Math.round(((row + 1) / comparison.pagePairs.length) * 100));
  }
  return out.save();
}
