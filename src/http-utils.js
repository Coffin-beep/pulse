'use strict';

class ApiError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.field = field || null;
  }
}

function sendJSON(res, status, data) {
  if (res.headersSent) {
    try { res.end(); } catch (_) { /* noop */ }
    return;
  }
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readRawBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new ApiError(413, 'Файл слишком большой'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      reject(new ApiError(400, 'Ошибка приёма данных'));
    });
  });
}

async function readJsonBody(req, limit = 256 * 1024) {
  const buf = await readRawBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    throw new ApiError(400, 'Некорректный JSON');
  }
}

module.exports = { ApiError, sendJSON, readRawBody, readJsonBody };
