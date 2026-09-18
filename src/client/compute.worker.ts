import { compare } from './core';
import type { ExportInput, Page } from './model';

self.onmessage = async ({
  data,
}: {
  data:
    | { id: number; type: 'compare'; pages: [Page[], Page[]] }
    | { id: number; type: 'export'; input: ExportInput };
}) => {
  try {
    if (data.type === 'compare') self.postMessage({ id: data.id, result: compare(...data.pages) });
    else {
      const { exportComparison } = await import('./export');
      const bytes = await exportComparison(data.input, (progress) =>
        self.postMessage({ id: data.id, progress }),
      );
      self.postMessage({ id: data.id, result: bytes }, { transfer: [bytes.buffer as ArrayBuffer] });
    }
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
