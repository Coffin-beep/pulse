'use strict';

// Голосовой сервер Pulse: аудио идёт ЧЕРЕЗ СЕРВЕР (релей), а не P2P.
// Клиенты захватывают микрофон (PCM 16-bit 24 кГц), шлют бинарными WebSocket-фреймами,
// сервер помечает кадр отправителем и раздаёт остальным участникам комнаты.
// Управление состоянием (вход/выход/мьют) дублируется в SSE-шину для интерфейса.

const { URL } = require('url');
const storage = require('./storage');
const { broadcastToChat, sendToCid } = require('./events');
const { acceptUpgrade } = require('./ws');

const SAMPLE_RATE = 24000;

// roomId -> Map(cid -> { ws, userId, chatId, muted })
const voiceRooms = new Map();

function findChatByRoomId(roomId) {
  return storage.allChats().find((c) => (c.voiceRooms || []).some((r) => r.id === roomId)) || null;
}

function voiceRoomView(chat) {
  return (chat.voiceRooms || []).map((r) => {
    const participants = [];
    const m = voiceRooms.get(r.id);
    if (m) {
      for (const [cid, p] of m) participants.push({ cid, userId: p.userId, muted: p.muted });
    }
    return { id: r.id, name: r.name, participants };
  });
}

function voiceParticipantsTotal() {
  let n = 0;
  for (const m of voiceRooms.values()) n += m.size;
  return n;
}

function leaveVoiceCid(cid) {
  for (const [roomId, m] of voiceRooms) {
    const p = m.get(cid);
    if (!p) continue;
    m.delete(cid);
    if (!m.size) voiceRooms.delete(roomId);
    broadcastToChat(p.chatId, {
      type: 'voice_state', chatId: p.chatId, roomId,
      connId: cid, userId: p.userId, action: 'leave',
    });
  }
}

// выкинуть всех из комнаты (удаление комнаты/чата) — с кодом 4000 «вас кикнули»
function kickRoom(roomId, chatId) {
  const m = voiceRooms.get(roomId);
  if (!m) return;
  for (const cid of [...m.keys()]) {
    const p = m.get(cid);
    m.delete(cid);
    if (p) {
      try { p.ws.close(4000); } catch (_) { /* noop */ }
    }
    sendToCid(cid, {
      type: 'voice_state', chatId, roomId, connId: cid,
      userId: p ? p.userId : null, action: 'kick',
    });
  }
  voiceRooms.delete(roomId);
}

function detachCid(cid) {
  // отключить соединение от любой комнаты без рассылки (при переподключении)
  for (const [rid, m] of voiceRooms) {
    const old = m.get(cid);
    if (old) {
      m.delete(cid);
      if (!m.size) voiceRooms.delete(rid);
      try { old.ws.close(4000); } catch (_) { /* noop */ }
    }
  }
}

function init(server) {
  server.on('upgrade', (req, socket) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (_) {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/voice') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token') || '';
    const roomId = url.searchParams.get('roomId') || '';
    const cid = url.searchParams.get('cid') || '';
    const user = storage.getSessionUser(token);

    if (!user || user.banned || !roomId || !cid) {
      try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch (_) { /* noop */ }
      socket.destroy();
      return;
    }
    const chat = findChatByRoomId(roomId);
    if (!chat || !chat.members[user.id]) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch (_) { /* noop */ }
      socket.destroy();
      return;
    }

    const ws = acceptUpgrade(req, socket);
    if (!ws) return;

    detachCid(cid); // этот cid уже где-то сидел — переподключаем

    let m = voiceRooms.get(roomId);
    if (!m) {
      m = new Map();
      voiceRooms.set(roomId, m);
    }
    const peer = { ws, userId: user.id, chatId: chat.id, muted: false };
    m.set(cid, peer);

    // приветствие: список тех, кто уже в комнате
    const peers = [];
    for (const [c, p] of m) {
      if (c !== cid) peers.push({ cid: c, userId: p.userId, muted: p.muted });
    }
    ws.sendText(JSON.stringify({ type: 'joined', roomId, me: cid, peers }));
    broadcastToChat(chat.id, {
      type: 'voice_state', chatId: chat.id, roomId,
      connId: cid, userId: user.id, muted: false, action: 'join',
    });

    ws.onmessage = (opcode, payload) => {
      if (opcode === 0x1) {
        // текстовая команда
        let msg;
        try { msg = JSON.parse(payload.toString('utf8')); } catch (_) { return; }
        if (msg.type === 'mute') {
          peer.muted = !!msg.muted;
          broadcastToChat(chat.id, {
            type: 'voice_state', chatId: chat.id, roomId,
            connId: cid, userId: user.id, muted: peer.muted, action: 'state',
          });
        }
        return;
      }
      if (opcode !== 0x2) return;
      // бинарный аудиокадр: [длина cid (1 байт)][cid utf8][PCM int16] -> остальным
      const room = voiceRooms.get(roomId);
      if (!room || room.get(cid) !== peer) return;
      if (peer.muted) return; // замьюченный ничего не раздаёт
      const cidBuf = Buffer.from(cid, 'utf8');
      const frame = Buffer.concat([Buffer.from([cidBuf.length]), cidBuf, payload]);
      for (const [c, p] of room) {
        if (c === cid) continue;
        try { p.ws.sendBinary(frame); } catch (_) { /* сокет мертв — почистится по close */ }
      }
    };

    ws.onclose = () => {
      const room = voiceRooms.get(roomId);
      if (room && room.get(cid) === peer) {
        room.delete(cid);
        if (!room.size) voiceRooms.delete(roomId);
        broadcastToChat(chat.id, {
          type: 'voice_state', chatId: chat.id, roomId,
          connId: cid, userId: user.id, action: 'leave',
        });
      }
    };
  });
}

module.exports = {
  init, voiceRoomView, voiceParticipantsTotal, kickRoom, leaveVoiceCid, findChatByRoomId, SAMPLE_RATE,
};
