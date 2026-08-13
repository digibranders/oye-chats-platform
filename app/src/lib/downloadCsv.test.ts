/**
 * The CSV download path.
 *
 * Each of these pins a detail that fails *silently* when it is missing — no
 * exception, no console error, just a file that opens wrong (or not at all) on
 * someone else's machine. That is exactly the class of bug worth a test:
 * nobody notices it in review, and nobody notices it in Chrome.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadCsv } from './downloadCsv';

/** Capture what `downloadCsv` hands to the browser, without a real download. */
function captureDownload(): {
  blobParts: () => unknown[];
  blobType: () => string;
  anchor: () => HTMLAnchorElement;
  wasInDocumentAtClick: () => boolean;
} {
  const created: { parts: unknown[]; type: string }[] = [];
  const OriginalBlob = globalThis.Blob;
  vi.stubGlobal(
    'Blob',
    class extends OriginalBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        created.push({ parts: [...parts], type: options?.type ?? '' });
      }
    },
  );
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:stub'),
    revokeObjectURL: vi.fn(),
  });

  let anchor!: HTMLAnchorElement;
  let inDocumentAtClick = false;
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const element = realCreate(tag);
    if (tag === 'a') {
      anchor = element as HTMLAnchorElement;
      // Firefox ignores a click on a detached anchor, so what matters is
      // whether the element is in the document at the moment click() fires.
      vi.spyOn(anchor, 'click').mockImplementation(() => {
        inDocumentAtClick = document.body.contains(anchor);
      });
    }
    return element;
  });

  return {
    blobParts: () => created[0]?.parts ?? [],
    blobType: () => created[0]?.type ?? '',
    anchor: () => anchor,
    wasInDocumentAtClick: () => inDocumentAtClick,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('downloadCsv', () => {
  it('leads the file with a UTF-8 BOM', () => {
    /* The regression this exists for: without the BOM, Excel decodes the file
       in the system codepage and every Devanagari / Tamil / accented character
       renders as garbage. Nothing throws — the file just opens wrong. */
    const captured = captureDownload();

    downloadCsv('Name\n"प्रिया"', 'leads.csv');

    expect(captured.blobParts()[0]).toBe('﻿');
    expect(captured.blobParts()[1]).toBe('Name\n"प्रिया"');
  });

  it('declares utf-8 in the MIME type', () => {
    const captured = captureDownload();

    downloadCsv('a,b', 'x.csv');

    expect(captured.blobType()).toBe('text/csv;charset=utf-8;');
  });

  it('attaches the anchor to the document before clicking it', () => {
    /* Firefox ignores a programmatic click on a detached element, so a
       download that works in Chrome does nothing there. */
    const captured = captureDownload();

    downloadCsv('a,b', 'x.csv');

    expect(captured.wasInDocumentAtClick()).toBe(true);
  });

  it('cleans up the anchor and the object URL', () => {
    const captured = captureDownload();

    downloadCsv('a,b', 'x.csv');

    expect(document.body.contains(captured.anchor())).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:stub');
  });

  it('uses the filename it was given', () => {
    const captured = captureDownload();

    downloadCsv('a,b', 'selected-leads-3.csv');

    expect(captured.anchor().download).toBe('selected-leads-3.csv');
  });
});
