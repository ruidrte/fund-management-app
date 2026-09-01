/**
 * PDF text extraction.
 *
 * What this does and does not do, stated up front because the difference
 * determines how much anyone should trust what comes out of it:
 *
 *   Reliable    getting the text off the page, in reading order, with the page
 *               each line came from.
 *   Not reliable  deciding what that text *means*. A capital account statement
 *               from one GP and the same statement from another share no layout,
 *               no labels and no ordering.
 *
 * So this module returns text and nothing else. Meaning is inferred downstream
 * by the extractors, at confidences that say it was inferred, and confirmed by a
 * person before anything is committed. A scanned PDF with no text layer returns
 * nothing and says so — it is not silently treated as an empty document.
 *
 * pdf.js is loaded on demand. It is by far the largest dependency here and most
 * sessions never open a PDF.
 */

export interface PdfText {
  /** The whole document, pages joined with form feeds. */
  text: string;
  /** One entry per page, so a locator can name the page a figure came from. */
  pages: string[];
  pageCount: number;
  /**
   * True when the document yielded no meaningful text. Almost always a scan,
   * which needs OCR rather than a parser.
   */
  needsOcr: boolean;
}

/**
 * Raised when the PDF worker cannot be loaded, which is a property of how the
 * application was built rather than of the document.
 */
export class PdfWorkerUnavailable extends Error {
  constructor() {
    super(
      'PDF reading is not available in this build — it needs the pdf.js worker, '
      + 'which a single-file review build cannot load. Spreadsheets and manual entry '
      + 'work normally; run the app with `npm run dev` to read PDFs.',
    );
    this.name = 'PdfWorkerUnavailable';
  }
}

/** Below this many characters per page, treat the document as an image. */
const TEXT_PER_PAGE_FLOOR = 40;

export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  const pdfjs = await import('pdfjs-dist');

  // The worker is a separate file that pdf.js fetches at run time. It resolves
  // in a normal build; in a single-file review build there is nothing to fetch,
  // so the failure is caught below and reported as a limitation of that build
  // rather than as a corrupt document.
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
  } catch {
    throw new PdfWorkerUnavailable();
  }

  // These documents are not trusted input, and nothing in a statement needs to
  // load a font from elsewhere, render an embedded form, or reach the network.
  // pdf.js 6 disables `eval` by default, so there is no longer a flag for it.
  const task = pdfjs.getDocument({
    data: bytes,
    disableAutoFetch: true,
    disableStream: true,
    disableFontFace: true,
    enableXfa: false,
  });
  let document;
  try {
    document = await task.promise;
  } catch (cause) {
    // A missing worker and a malformed file fail the same way here, so the
    // message has to distinguish them or the user chases the wrong problem.
    if (String(cause).includes('worker') || String(cause).includes('Worker')) {
      throw new PdfWorkerUnavailable();
    }
    throw cause;
  }

  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(layoutTextItems(content.items as TextItemLike[]));
    page.cleanup();
  }

  const pageCount = document.numPages;
  // Tears down the worker as well as the document; leaving it running leaks a
  // thread per file opened.
  await task.destroy();

  const text = pages.join('\n\f\n');
  const density = pageCount > 0 ? text.length / pageCount : 0;

  return {
    text,
    pages,
    pageCount,
    needsOcr: density < TEXT_PER_PAGE_FLOOR,
  };
}

interface TextItemLike {
  str: string;
  transform?: number[];
  hasEOL?: boolean;
}

/**
 * Reassembles text items into lines.
 *
 * pdf.js emits positioned fragments, not lines. Concatenating them in order
 * turns a two-column statement into interleaved nonsense, and — worse for this
 * application — glues a label to the number in the next column so neither can
 * be read. Grouping by vertical position and then sorting by horizontal
 * position recovers the line, and the wide gap between a label and its amount
 * is preserved as whitespace, which is what the NAV pack reader keys off.
 */
function layoutTextItems(items: TextItemLike[]): string {
  const lines = new Map<number, Array<{ x: number; text: string }>>();

  for (const item of items) {
    if (!item.str) continue;
    const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
    const x = transform[4];
    const y = transform[5];

    // Round the baseline so fragments a fraction of a point apart — which is
    // normal within one line — group together.
    const key = Math.round(y * 2) / 2;
    const line = lines.get(key) ?? [];
    line.push({ x, text: item.str });
    lines.set(key, line);
  }

  return [...lines.entries()]
    // Descending y: PDF coordinates start at the bottom of the page.
    .sort((a, b) => b[0] - a[0])
    .map(([, fragments]) => {
      const sorted = fragments.sort((a, b) => a.x - b.x);
      let out = '';
      let previousEnd = 0;

      for (const fragment of sorted) {
        // A gap wide enough to be a column boundary becomes double space, which
        // is what separates a label from its amount downstream.
        const gap = fragment.x - previousEnd;
        if (out !== '') out += gap > 20 ? '  ' : gap > 2 ? ' ' : '';
        out += fragment.text;
        previousEnd = fragment.x + fragment.text.length * 5;
      }

      return out.trimEnd();
    })
    .filter((line) => line.trim() !== '')
    .join('\n');
}
