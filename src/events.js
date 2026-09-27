'use strict';

// SSE-шина Pulse: клиенты, рассылки, присутствие.
// Выделена в отдельный модуль, чтобы голосовой сервер мог слать события без циклических импортов.

const sseClients = new Set(); // { userId, cid, res }

function sseSend(client, event) {
  try {
    client.res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch (_) { /* соединение мертво */ }
}

function broadcast(event, exceptUserId) {
  for (const c of sseClients) {
    if (exceptUserId && c.userId === exceptUserId) continue;
    sseSend(c, event);
  }
}

// рассылка только участникам конкретного чата
function broadcastToChat(chatId, event) {
  const storage = require('./storage'); // лениво, чтобы избежать цикла
  const chat = storage.getChat(chatId);
  if (!chat) return;
  for (const c of sseClients) {
    if (chat.members[c.userId]) sseSend(c, event);
  }
}

function sendToCid(cid, event) {
  for (const c of sseClients) {
    if (c.cid === cid) {
      sseSend(c, event);
      return true;
    }
  }
  return false;
}

function clientByCid(cid) {
  for (const c of sseClients) {
    if (c.cid === cid) return c;
  }
  return null;
}

function onlineUserIds() {
  const set = new Set();
  for (const c of sseClients) set.add(c.userId);
  return set;
}

function kickSseUser(userId) {
  for (const c of [...sseClients]) {
    if (c.userId === userId) {
      sseClients.delete(c);
      try { c.res.end(); } catch (_) { /* noop */ }
    }
  }
}

module.exports = {
  sseClients, sseSend, broadcast, broadcastToChat, sendToCid, clientByCid, onlineUserIds, kickSseUser,
};
