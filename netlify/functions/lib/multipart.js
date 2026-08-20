// netlify/functions/lib/multipart.js
//
// Thin wrapper around busboy that turns a raw multipart/form-data Buffer
// into plain `fields` (string values) and `files` (buffered file parts).
//
// Requires: npm install busboy

const Busboy = require('busboy');
const { Readable } = require('stream');

const MAX_FILE_BYTES = 5.5 * 1024 * 1024; // keep in step with submit.js body cap

/**
 * @param {Buffer} rawBody
 * @param {string} contentType - must include the multipart boundary
 * @returns {Promise<{ fields: Object<string,string>, files: Object<string,{filename:string, contentType:string, buffer:Buffer}> }>}
 */
function parseMultipart(rawBody, contentType) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: { fileSize: MAX_FILE_BYTES },
    });

    const fields = {};
    const files = {};
    let fileSizeExceeded = false;

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (name, stream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];

      stream.on('data', (chunk) => chunks.push(chunk));

      stream.on('limit', () => {
        fileSizeExceeded = true;
      });

      stream.on('end', () => {
        if (!filename) return; // empty file input, nothing selected
        files[name] = {
          filename,
          contentType: mimeType || 'application/octet-stream',
          buffer: Buffer.concat(chunks),
        };
      });
    });

    busboy.on('error', reject);

    busboy.on('finish', () => {
      if (fileSizeExceeded) {
        reject(new Error('One or more uploaded files exceeded the size limit.'));
        return;
      }
      resolve({ fields, files });
    });

    Readable.from(rawBody).pipe(busboy);
  });
}

module.exports = { parseMultipart };
