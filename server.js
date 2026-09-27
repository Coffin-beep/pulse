'use strict';

const http = require('http');
const { handleApi, initPresence } = require('./src/api');
const { serveStatic } = require('./src/static');
const voiceServer = require('./src/voice-server');

const PORT = parseInt(process.env.PORT || '3000', 10) || 3000;
const HOST = '0.0.0.0';

const server = http.createServer(async (req, res) => {
  try {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (_) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const isUpload = url.pathname.startsWith('/uploads/');

    if (isApi || isUpload) {
      await handleApi(req, res, url);
      return;
    }

    serveStatic(req, res, url);
  } catch (err) {
    console.error('[pulse] error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Внутренняя ошибка сервера' }));
    } else {
      try { res.end(); } catch (_) { /* noop */ }
    }
  }
});

initPresence();
voiceServer.init(server);

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  💜  Pulse запущен');
  console.log(`  Открой в браузере:  http://localhost:${PORT}`);
  console.log('');
});
