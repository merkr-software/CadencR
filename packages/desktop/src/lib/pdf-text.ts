/**
 * Lazy PDF → text extraction for prompt attachments.
 *
 * pdf.js is heavy (~1 MB) and only needed when a PDF is actually
 * attached, so the library and its worker are dynamically imported on
 * first use — they never land in the initial bundle. Extraction runs in
 * pdf.js's web worker, off the main thread.
 */

type PdfjsModule = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

/**
 * Extract the visible text of a PDF, one block per page (pages separated
 * by a blank line). Returns "" for PDFs with no extractable text (e.g.
 * scanned/image-only documents).
 */
export async function extractPdfText(data: ArrayBuffer | Uint8Array): Promise<string> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/[ \t]+/g, " ")
        .trim();
      pages.push(pageText);
    }
    return pages
      .filter((page) => page.length > 0)
      .join("\n\n")
      .trim();
  } finally {
    await doc.destroy();
  }
}
