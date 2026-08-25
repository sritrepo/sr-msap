// netlify/functions/lib/file-validator.js
//
// Manatal's attachment `file` field must be a URL (confirmed via their
// docs: developers.manatal.com/reference/candidates_attachments_create —
// `file` is documented as "Url leading to the attachment file", not a
// binary upload). Their general upload constraints (developers.manatal.com
// /reference/uploading-a-file) cap size at 5MB and only guarantee ingestion
// of PDF/DOC/DOCX/RTF.
//
// This validates every attachment against those constraints and converts
// images (JPEG/PNG — the realistic case for gov ID photos and screenshots)
// to a single-page PDF ONLY when needed. Already-compliant files (PDF,
// DOC, DOCX, RTF) pass through untouched — no wasted conversion work.
//
// Requires: npm install pdf-lib

const { PDFDocument } = require('pdf-lib');

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB, per Manatal's docs

const ACCEPTED_CONTENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/rtf',
  'text/rtf',
];

const IMAGE_EMBED_METHOD = {
  'image/jpeg': 'embedJpg',
  'image/jpg': 'embedJpg',
  'image/png': 'embedPng',
};

class FileValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FileValidationError';
    this.code = code; // 'TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'CONVERSION_FAILED'
  }
}

/**
 * @param {{filename: string, contentType: string, buffer: Buffer}} file
 *   - matches the shape returned by lib/multipart.js
 * @returns {Promise<{filename: string, contentType: string, buffer: Buffer, converted: boolean}>}
 */
async function validateAndNormalizeFile(file) {
  const { filename, contentType, buffer } = file;

  if (buffer.length > MAX_SIZE_BYTES) {
    throw new FileValidationError(
      `"${filename}" is ${(buffer.length / 1024 / 1024).toFixed(1)}MB, over Manatal's 5MB limit.`,
      'TOO_LARGE'
    );
  }

  if (ACCEPTED_CONTENT_TYPES.includes(contentType)) {
    return { filename, contentType, buffer, converted: false };
  }

  const embedMethod = IMAGE_EMBED_METHOD[contentType];
  if (embedMethod) {
    try {
      const pdfDoc = await PDFDocument.create();
      // pdf-lib reads `buffer.buffer` directly, which breaks on a Node
      // Buffer's byteOffset (a real bug caught during testing) — copy
      // into a clean Uint8Array first.
      const cleanBytes = new Uint8Array(buffer);
      const image = await pdfDoc[embedMethod](cleanBytes);
      const page = pdfDoc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      const pdfBytes = await pdfDoc.save();

      return {
        filename: filename.replace(/\.[^.]+$/, '') + '.pdf',
        contentType: 'application/pdf',
        buffer: Buffer.from(pdfBytes),
        converted: true,
      };
    } catch (err) {
      throw new FileValidationError(
        `Couldn't process "${filename}" — the image may be corrupted.`,
        'CONVERSION_FAILED'
      );
    }
  }

  throw new FileValidationError(
    `"${filename}" is a ${contentType || 'unrecognized'} file, which isn't supported.`,
    'UNSUPPORTED_TYPE'
  );
}

module.exports = { validateAndNormalizeFile, FileValidationError };
