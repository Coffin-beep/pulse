'use strict';

const http = require('http');
const { handleApi, initPresence } = require('./src/api');
const { serveStatic } = require('./src/static');
const voiceServer = require('./src/voice-server');

const PORT = parseInt(process.env.PORT || '3000', 10) || 3000;

// '::' — dual-stack: сервер принимает подключения и по IPv6 (::1 — так часто
// резолвится localhost на Windows/macOS), и по IPv4 (127.0.0.1 и внешние
// адреса через IPv4-mapped). Работает на Windows/Linux/macOS.
// Можно переопределить: HOST=0.0.0.0 node server.js
const HOST = process.env.HOST || '::';

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

let listenHost = HOST;
let triedIpv4Fallback = false;

server.on('error', (err) => {
  const code = err && err.code;

  // IPv6 недоступен в системе (редкие контейнеры/окружения) — откат на чистый IPv4
  if (!triedIpv4Fallback && listenHost === '::' &&
      (code === 'EAFNOSUPPORT' || code === 'EPROTONOSUPPORT' || code === 'EINVAL')) {
    triedIpv4Fallback = true;
    listenHost = '0.0.0.0';
    console.warn('[pulse] IPv6 недоступен — слушаю только IPv4 (0.0.0.0)');
    server.listen(PORT, listenHost);
    return;
  }

  console.error('');
  if (code === 'EADDRINUSE') {
    console.error(`  ✖  Порт ${PORT} уже занят.`);
    console.error('     Похоже, Pulse уже запущен в другом окне/терминале.');
    console.error('     Закрой тот процесс или запусти на другом порту:');
    console.error(`       PORT=3001 node server.js            (Linux/macOS)`);
    console.error(`       set PORT=3001 && node server.js     (Windows cmd)`);
    console.error(`       $env:PORT=3001; node server.js       (Windows PowerShell)`);
  } else if (code === 'EACCES') {
    console.error(`  ✖  Нет доступа к порту ${PORT} (занят системой или нужны права).`);
    console.error(`     Запусти на другом порту:  PORT=3001 node server.js`);
  } else {
    console.error(`  ✖  Не удалось запустить сервер: ${err.message || err}`);
  }
  console.error('');
  process.exit(1);
});

server.listen(PORT, listenHost, () => {
  console.log('');
  console.log('  💜  Pulse запущен');
  console.log(`  Открой в браузере:  http://localhost:${PORT}`);
  console.log(`  (localhost: ${listenHost === '::' ? 'и IPv4, и IPv6' : 'только IPv4'})`);
  console.log('');
});

