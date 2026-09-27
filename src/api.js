'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');
const { ApiError, sendJSON, readRawBody, readJsonBody } = require('./http-utils');

const UPLOADS_DIR = storage.UPLOADS_DIR;

// ============================================================
//  SSE (Server-Sent Events) — живые обновления и присутствие
// ============================================================

// SSE-шина и голосовой сервер живут в отдельных модулях
const {
  sseClients, sseSend, broadcast, broadcastToChat, sendToCid, clientByCid, kickSseUser, onlineUserIds,
} = require('./events');
const { voiceRoomView, voiceParticipantsTotal, kickRoom } = require('./voice-server');

function initPresence() {
  setInterval(() => {
    for (const c of sseClients) {
      try {
        c.res.write(': ping\n\n');
      } catch (_) {
        sseClients.delete(c);
      }
    }
  }, 25000).unref();
}

// ============================================================
//  Хелперы
// ============================================================

function getToken(req, url) {
  const h = req.headers['authorization'];
  if (h && typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  const q = url.searchParams.get('token');
  return q || null;
}

function getAuthUser(req, url) {
  return storage.getSessionUser(getToken(req, url));
}

function requireAuth(req, url) {
  const user = getAuthUser(req, url);
  if (!user) throw new ApiError(401, 'Требуется авторизация');
  if (user.banned) throw new ApiError(403, 'Аккаунт заблокирован администратором');
  return user;
}

function requireAdmin(req, url) {
  const me = requireAuth(req, url);
  if (!me.isAdmin) throw new ApiError(403, 'Доступ только для администраторов');
  return me;
}

function getChatOr404(id) {
  const chat = storage.getChat(String(id || ''));
  if (!chat) throw new ApiError(404, 'Чат не найден');
  return chat;
}

function requireMember(chat, userId) {
  const m = chat.members[userId];
  if (!m) throw new ApiError(403, 'Вы не участник этого чата');
  return m;
}

function requireCanManage(chat, userId) {
  const m = requireMember(chat, userId);
  if (chat.type === 'dialog') throw new ApiError(403, 'Личный чат нельзя изменить');
  if (m.role !== 'owner' && m.role !== 'admin') {
    throw new ApiError(403, 'Недостаточно прав');
  }
  return m;
}

function assertCanPost(chat, userId) {
  const m = requireMember(chat, userId);
  if (chat.type === 'channel' && m.role !== 'owner' && m.role !== 'admin') {
    throw new ApiError(403, 'В канале могут публиковать только администраторы');
  }
  return m;
}

function chatView(chat, viewerId, online) {
  const memberIds = Object.keys(chat.members);
  let peer = null;
  if (chat.type === 'dialog') {
    const otherId = memberIds.find((id) => id !== viewerId) || viewerId;
    const u = storage.getUser(otherId);
    peer = u ? storage.publicUser(u, { online: online.has(u.id) }) : null;
  }
  return {
    id: chat.id,
    type: chat.type,
    title: chat.type === 'dialog' ? (peer ? peer.nickname : 'Чат') : (chat.type === 'saved' ? 'Избранное' : chat.title),
    description: chat.description,
    privacy: chat.privacy,
    ownerId: chat.ownerId,
    role: chat.members[viewerId] ? chat.members[viewerId].role : null,
    members: chat.members,
    memberCount: memberIds.length,
    onlineCount: memberIds.filter((id) => online.has(id)).length,
    peer,
    avatar: (chat.type === 'group' || chat.type === 'channel') ? (chat.avatar || '') : '',
    voice: chat.type === 'group' ? voiceRoomView(chat) : [],
    createdAt: chat.createdAt,
  };
}

// полное удаление чата: выкинуть из голосовых, удалить файлы, разослать события
function deleteChatFully(chat) {
  for (const r of chat.voiceRooms || []) kickRoom(r.id, chat.id);
  storage.deleteChat(chat.id);
  broadcast({ type: 'chat_deleted', chatId: chat.id });
}

function chatDetail(chat, viewerId, online) {
  const view = chatView(chat, viewerId, online);
  view.memberUsers = Object.keys(chat.members)
    .map((uid) => {
      const u = storage.getUser(uid);
      if (!u) return null;
      return {
        ...storage.publicUser(u, { online: online.has(uid) }),
        role: chat.members[uid].role,
        joinedAt: chat.members[uid].joinedAt,
      };
    })
    .filter(Boolean);
  return view;
}

function chatWithMeta(chat, viewerId, online) {
  const view = chatView(chat, viewerId, online);
  view.lastMessage = storage.lastMessage(chat.id);
  const m = chat.members[viewerId];
  view.unread = m ? storage.unreadCount(chat.id, viewerId, m.lastRead) : 0;
  return view;
}

// ============================================================
//  Роутер
// ============================================================

async function handleApi(req, res, url) {
  try {
    await route(req, res, url);
  } catch (err) {
    if (err instanceof ApiError) {
      sendJSON(res, err.status, { error: err.message, field: err.field });
    } else {
      console.error('[pulse:api]', err);
      sendJSON(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }
}

async function route(req, res, url) {
  const method = (req.method || 'GET').toUpperCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'uploads') return handleUpload(req, res, url, parts);
  if (parts[0] !== 'api') throw new ApiError(404, 'Не найдено');

  const p = parts.slice(1); // после /api

  // ---------- аутентификация ----------

  if (p[0] === 'auth' && p[1] === 'register' && method === 'POST') {
    return handleRegister(req, res);
  }
  if (p[0] === 'auth' && p[1] === 'login' && method === 'POST') {
    return handleLogin(req, res);
  }
  if (p[0] === 'auth' && p[1] === 'logout' && method === 'POST') {
    const token = getToken(req, url);
    storage.deleteSession(token);
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- профиль ----------

  if (p[0] === 'me' && method === 'GET') {
    const me = requireAuth(req, url);
    return sendJSON(res, 200, storage.publicUser(me, { online: true }));
  }
  if (p[0] === 'me' && method === 'PATCH') {
    const me = requireAuth(req, url);
    const body = await readJsonBody(req);
    const patch = {};
    if (body.nickname !== undefined) {
      const nickname = String(body.nickname || '').trim();
      if (!nickname || nickname.length > 48) throw new ApiError(400, 'Никнейм: от 1 до 48 символов', 'nickname');
      patch.nickname = nickname;
    }
    if (body.bio !== undefined) {
      patch.bio = String(body.bio || '').trim().slice(0, 200);
    }
    if (body.avatar !== undefined) {
      const avatar = String(body.avatar || '');
      if (avatar) {
        if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(avatar)) {
          throw new ApiError(400, 'Неподдерживаемый формат изображения', 'avatar');
        }
        if (avatar.length > 320000) {
          throw new ApiError(400, 'Картинка слишком большая — выберите поменьше', 'avatar');
        }
      }
      patch.avatar = avatar;
    }
    const updated = storage.updateUser(me.id, patch);
    broadcast({ type: 'user_updated', userId: me.id });
    return sendJSON(res, 200, storage.publicUser(updated, { online: true }));
  }

  // ---------- поиск пользователей ----------

  if (p[0] === 'users' && method === 'GET') {
    const me = requireAuth(req, url);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase().replace(/^@/, '');
    const online = onlineUserIds();
    let users = storage.allUsers().filter((u) => u.id !== me.id);
    if (q) {
      users = users.filter(
        (u) => u.username.includes(q) || u.nickname.toLowerCase().includes(q)
      );
    }
    users = users.slice(0, 30);
    return sendJSON(res, 200, {
      users: users.map((u) => storage.publicUser(u, { online: online.has(u.id) })),
    });
  }

  // ---------- чаты ----------

  if (p[0] === 'chats' && p.length === 1) {
    const me = requireAuth(req, url);
    if (method === 'GET') {
      ensureSavedChat(me.id);
      const online = onlineUserIds();
      const list = storage
        .allChats()
        .filter((c) => c.members[me.id])
        .map((c) => chatWithMeta(c, me.id, online))
        .sort((a, b) => {
          const sa = a.type === 'saved' ? 1 : 0;
          const sb = b.type === 'saved' ? 1 : 0;
          if (sa !== sb) return sb - sa; // «Избранное» всегда сверху
          const ta = (a.lastMessage && a.lastMessage.createdAt) || a.createdAt;
          const tb = (b.lastMessage && b.lastMessage.createdAt) || b.createdAt;
          return tb - ta;
        });
      return sendJSON(res, 200, { chats: list });
    }
    if (method === 'POST') return handleCreateChat(req, res, me);
    throw new ApiError(405, 'Метод не поддерживается');
  }

  if (p[0] === 'chats' && p.length >= 2) {
    const me = requireAuth(req, url);
    const chat = getChatOr404(p[1]);
    const sub = p[2];

    // GET /api/chats/:id — подробности
    if (!sub && method === 'GET') {
      requireMember(chat, me.id);
      return sendJSON(res, 200, { chat: chatDetail(chat, me.id, onlineUserIds()) });
    }

    // PATCH /api/chats/:id — настройки (владелец/админ)
    if (!sub && method === 'PATCH') {
      requireCanManage(chat, me.id);
      const body = await readJsonBody(req);
      const patch = {};
      if (body.title !== undefined) {
        const title = String(body.title || '').trim();
        if (!title || title.length > 64) throw new ApiError(400, 'Название: от 1 до 64 символов', 'title');
        patch.title = title;
      }
      if (body.description !== undefined) patch.description = String(body.description || '').trim().slice(0, 300);
      if (body.privacy !== undefined) patch.privacy = body.privacy === 'public' ? 'public' : 'private';
      if (body.avatar !== undefined) {
        const avatar = String(body.avatar || '');
        if (avatar) {
          if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(avatar)) {
            throw new ApiError(400, 'Неподдерживаемый формат изображения', 'avatar');
          }
          if (avatar.length > 320000) {
            throw new ApiError(400, 'Картинка слишком большая — выберите поменьше', 'avatar');
          }
        }
        patch.avatar = avatar;
      }
      storage.updateChat(chat, patch);
      broadcast({ type: 'chat_updated', chatId: chat.id });
      return sendJSON(res, 200, { chat: chatDetail(chat, me.id, onlineUserIds()) });
    }

    // DELETE /api/chats/:id
    if (!sub && method === 'DELETE') {
      requireMember(chat, me.id);
      if (chat.type === 'dialog') {
        // любой из двоих может удалить личный чат
      } else if (chat.ownerId !== me.id && !me.isAdmin) {
        throw new ApiError(403, 'Удалить чат может только владелец');
      }
      deleteChatFully(chat);
      return sendJSON(res, 200, { ok: true });
    }

    // POST /api/chats/:id/members — добавить участника
    if (sub === 'members' && p.length === 3 && method === 'POST') {
      requireCanManage(chat, me.id);
      const body = await readJsonBody(req);
      const user = storage.getUser(String(body.userId || ''));
      if (!user) throw new ApiError(404, 'Пользователь не найден');
      if (chat.members[user.id]) throw new ApiError(409, 'Уже участник');
      storage.addMember(chat, user.id, 'member');
      broadcast({ type: 'chat_updated', chatId: chat.id });
      broadcast({ type: 'chat_created', chatId: chat.id }); // чтобы новичок увидел чат
      return sendJSON(res, 200, { chat: chatDetail(chat, me.id, onlineUserIds()) });
    }

    // DELETE /api/chats/:id/members/:uid
    if (sub === 'members' && p.length === 4 && method === 'DELETE') {
      const my = requireCanManage(chat, me.id);
      const targetId = p[3];
      const target = chat.members[targetId];
      if (!target) throw new ApiError(404, 'Участник не найден');
      if (target.role === 'owner') throw new ApiError(403, 'Нельзя удалить владельца');
      if (target.role === 'admin' && my.role !== 'owner') {
        throw new ApiError(403, 'Администратора может удалить только владелец');
      }
      storage.removeMember(chat, targetId);
      broadcast({ type: 'chat_updated', chatId: chat.id });
      return sendJSON(res, 200, { ok: true });
    }

    // POST /api/chats/:id/leave
    if (sub === 'leave' && method === 'POST') {
      requireMember(chat, me.id);
      if (chat.type === 'dialog') throw new ApiError(400, 'Личный чат можно только удалить');
      if (chat.type === 'saved') throw new ApiError(400, '«Избранное» всегда с вами');
      const others = Object.keys(chat.members).filter((id) => id !== me.id);
      storage.removeMember(chat, me.id);
      if (chat.ownerId === me.id) {
        if (others.length === 0) {
          storage.deleteChat(chat.id);
          broadcast({ type: 'chat_deleted', chatId: chat.id });
          return sendJSON(res, 200, { ok: true, deleted: true });
        }
        // передаём владение: сначала админы, потом самый старый участник
        const admins = others.filter((id) => chat.members[id] && chat.members[id].role === 'admin');
        const rest = others.filter((id) => chat.members[id]);
        const heir = admins[0] || rest[0];
        if (heir) storage.setOwner(chat, heir);
      }
      broadcast({ type: 'chat_updated', chatId: chat.id });
      broadcast({ type: 'chat_deleted', chatId: chat.id }); // ушедший должен убрать чат
      return sendJSON(res, 200, { ok: true });
    }

    // POST /api/chats/:id/join
    if (sub === 'join' && method === 'POST') {
      if (chat.type !== 'group' && chat.type !== 'channel') throw new ApiError(400, 'Это не группа и не канал');
      if (chat.privacy !== 'public') throw new ApiError(403, 'Это приватное сообщество — вход только по приглашению');
      if (!chat.members[me.id]) storage.addMember(chat, me.id, 'member');
      broadcast({ type: 'chat_updated', chatId: chat.id });
      return sendJSON(res, 200, { chat: chatDetail(chat, me.id, onlineUserIds()) });
    }

    // POST /api/chats/:id/voice-rooms — создать голосовой канал
    if (sub === 'voice-rooms' && p.length === 3 && method === 'POST') {
      requireCanManage(chat, me.id);
      if (chat.type !== 'group') throw new ApiError(400, 'Голосовые каналы доступны только в группах');
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name || name.length > 32) throw new ApiError(400, 'Название: 1–32 символа', 'name');
      if ((chat.voiceRooms || []).length >= 20) throw new ApiError(400, 'Слишком много голосовых каналов');
      const room = { id: storage.newId('v'), name, createdAt: Date.now() };
      chat.voiceRooms = chat.voiceRooms || [];
      chat.voiceRooms.push(room);
      storage.updateChat(chat, {});
      broadcast({ type: 'chat_updated', chatId: chat.id });
      return sendJSON(res, 201, { room });
    }

    // DELETE /api/chats/:id/voice-rooms/:roomId — удалить голосовой канал
    if (sub === 'voice-rooms' && p.length === 4 && method === 'DELETE') {
      requireCanManage(chat, me.id);
      const roomId = p[3];
      const i = (chat.voiceRooms || []).findIndex((r) => r.id === roomId);
      if (i === -1) throw new ApiError(404, 'Голосовой канал не найден');
      chat.voiceRooms.splice(i, 1);
      storage.updateChat(chat, {});
      kickRoom(roomId, chat.id);
      broadcast({ type: 'chat_updated', chatId: chat.id });
      return sendJSON(res, 200, { ok: true });
    }

    // GET/POST /api/chats/:id/messages
    if (sub === 'messages' && p.length === 3) {
      requireMember(chat, me.id);
      if (method === 'GET') {
        const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '300', 10) || 300, 500);
        const messages = storage.listMessages(chat.id, { after, limit });
        const online = onlineUserIds();
        const users = {};
        for (const uid of Object.keys(chat.members)) {
          const u = storage.getUser(uid);
          if (u) users[u.id] = storage.publicUser(u, { online: online.has(uid) });
        }
        return sendJSON(res, 200, { messages, users });
      }
      if (method === 'POST') {
        assertCanPost(chat, me.id);
        const body = await readJsonBody(req);
        const text = String(body.text || '').trim();
        if (!text) throw new ApiError(400, 'Пустое сообщение');
        if (text.length > 4000) throw new ApiError(400, 'Сообщение слишком длинное (макс. 4000 символов)');
        const msg = storage.addMessage(chat.id, me.id, { type: 'text', text });
        storage.markRead(chat, me.id, msg.id);
        broadcast({ type: 'new_message', chatId: chat.id });
        return sendJSON(res, 201, { message: msg });
      }
      throw new ApiError(405, 'Метод не поддерживается');
    }

    // DELETE /api/chats/:id/messages/:mid — только автор или владелец/админ
    if (sub === 'messages' && p.length === 4 && method === 'DELETE') {
      const my = requireMember(chat, me.id);
      const store = storage.messageStore(chat.id);
      const target = store.items.find((m) => m.id === Number(p[3]));
      if (!target) throw new ApiError(404, 'Сообщение не найдено');
      const isModerator = me.isAdmin || (chat.type !== 'dialog' && (my.role === 'owner' || my.role === 'admin'));
      if (target.senderId !== me.id && !isModerator) {
        throw new ApiError(403, 'Можно удалять только свои сообщения');
      }
      storage.deleteMessage(chat.id, p[3]);
      broadcast({ type: 'message_deleted', chatId: chat.id });
      return sendJSON(res, 200, { ok: true });
    }

    // POST /api/chats/:id/voice — голосовое сообщение (бинарное тело)
    if (sub === 'voice' && method === 'POST') {
      assertCanPost(chat, me.id);
      const duration = Math.max(0, Math.min(600, parseFloat(url.searchParams.get('duration') || '0') || 0));
      const peaks = (url.searchParams.get('peaks') || '')
        .split(',')
        .map((v) => parseInt(v, 10))
        .filter((v) => Number.isFinite(v) && v >= 0 && v <= 100)
        .slice(0, 64);
      const raw = await readRawBody(req, 25 * 1024 * 1024);
      if (!raw.length) throw new ApiError(400, 'Пустая запись');
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const extMap = {
        'audio/webm': 'webm',
        'audio/mp4': 'm4a',
        'audio/mpeg': 'mp3',
        'audio/ogg': 'ogg',
        'audio/aac': 'aac',
        'audio/wav': 'wav',
      };
      const ext = extMap[mime] || 'webm';
      const name = `v_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, name), raw);
      const msg = storage.addMessage(chat.id, me.id, {
        type: 'voice',
        file: '/uploads/' + name,
        mime,
        duration: Math.round(duration * 10) / 10,
        peaks,
      });
      storage.markRead(chat, me.id, msg.id);
      broadcast({ type: 'new_message', chatId: chat.id });
      return sendJSON(res, 201, { message: msg });
    }

    // POST /api/chats/:id/read
    if (sub === 'read' && method === 'POST') {
      requireMember(chat, me.id);
      const body = await readJsonBody(req);
      const messageId = parseInt(body.messageId || '0', 10) || 0;
      if (messageId > 0) {
        storage.markRead(chat, me.id, messageId);
      }
      return sendJSON(res, 200, { ok: true });
    }

    throw new ApiError(404, 'Не найдено');
  }

  // ---------- обзор публичных сообществ ----------

  if (p[0] === 'discover' && method === 'GET') {
    const me = requireAuth(req, url);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const items = storage
      .allChats()
      .filter(
        (c) =>
          (c.type === 'group' || c.type === 'channel') &&
          c.privacy === 'public' &&
          !c.members[me.id]
      )
      .filter(
        (c) =>
          !q ||
          c.title.toLowerCase().includes(q) ||
          (c.description || '').toLowerCase().includes(q)
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
      .map((c) => ({
        id: c.id,
        type: c.type,
        title: c.title,
        description: c.description,
        memberCount: Object.keys(c.members).length,
      }));
    return sendJSON(res, 200, { items });
  }

  // ---------- админ-панель ----------

  if (p[0] === 'admin' && p[1] === 'overview' && method === 'GET') {
    requireAdmin(req, url);
    const users = storage.allUsers();
    let messages = 0;
    for (const c of storage.allChats()) messages += storage.messageStore(c.id).items.length;
    const recent = users
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 6)
      .map((u) => storage.publicUser(u, { email: u.email, online: onlineUserIds().has(u.id) }));
    return sendJSON(res, 200, {
      stats: {
        users: users.length,
        banned: users.filter((u) => u.banned).length,
        admins: users.filter((u) => u.isAdmin).length,
        online: onlineUserIds().size,
        chats: storage.allChats().length,
        messages,
        voice: voiceParticipantsTotal(),
      },
      recent,
    });
  }

  if (p[0] === 'admin' && p[1] === 'users' && method === 'GET') {
    requireAdmin(req, url);
    const online = onlineUserIds();
    const users = storage.allUsers()
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((u) => storage.publicUser(u, { email: u.email, online: online.has(u.id) }));
    return sendJSON(res, 200, { users });
  }

  if (p[0] === 'admin' && p[1] === 'users' && p.length === 4 && method === 'POST') {
    const me = requireAdmin(req, url);
    const action = p[3];
    if (!['ban', 'unban', 'promote', 'demote'].includes(action)) throw new ApiError(404, 'Не найдено');
    const target = storage.getUser(p[2]);
    if (!target) throw new ApiError(404, 'Пользователь не найден');
    if (target.id === me.id) throw new ApiError(400, 'Нельзя менять свой аккаунт');
    if (target.username === 'coffin') throw new ApiError(403, 'Главного администратора (@coffin) нельзя изменить');

    if (action === 'ban') {
      if (target.isAdmin) throw new ApiError(403, 'Администратора нельзя заблокировать');
      storage.updateUser(target.id, { banned: true });
      storage.deleteSessionsForUser(target.id);
      kickSseUser(target.id);
    } else if (action === 'unban') {
      storage.updateUser(target.id, { banned: false });
    } else if (action === 'promote') {
      storage.updateUser(target.id, { isAdmin: true, banned: false });
    } else {
      storage.updateUser(target.id, { isAdmin: false });
    }
    broadcast({ type: 'user_updated', userId: target.id });
    return sendJSON(res, 200, { user: storage.publicUser(target, { email: target.email }) });
  }

  if (p[0] === 'admin' && p[1] === 'chats' && method === 'GET') {
    requireAdmin(req, url);
    const chats = storage.allChats()
      .map((c) => {
        const lm = storage.lastMessage(c.id);
        return {
          id: c.id,
          type: c.type,
          title: c.type === 'dialog'
            ? Object.keys(c.members).map((id) => (storage.getUser(id) || {}).nickname).join(' · ')
            : c.title,
          privacy: c.privacy,
          memberCount: Object.keys(c.members).length,
          messageCount: storage.messageStore(c.id).items.length,
          voiceRooms: (c.voiceRooms || []).length,
          lastActivity: (lm && lm.createdAt) || c.createdAt,
        };
      })
      .sort((a, b) => b.lastActivity - a.lastActivity);
    return sendJSON(res, 200, { chats });
  }

  if (p[0] === 'admin' && p[1] === 'chats' && p.length === 3 && method === 'DELETE') {
    requireAdmin(req, url);
    const chat = getChatOr404(p[2]);
    deleteChatFully(chat);
    return sendJSON(res, 200, { ok: true });
  }

  if (p[0] === 'admin' && p[1] === 'broadcast' && method === 'POST') {
    const me = requireAdmin(req, url);
    const body = await readJsonBody(req);
    const text = String(body.text || '').trim();
    if (!text || text.length > 2000) throw new ApiError(400, 'Текст объявления: 1–2000 символов');
    const news = getNewsChannel();
    const msg = storage.addMessage(news.id, news.ownerId, {
      type: 'text',
      text: '📣 Объявление от @' + me.username + ':\n' + text,
    });
    broadcast({ type: 'new_message', chatId: news.id });
    return sendJSON(res, 201, { message: msg });
  }

  // ---------- SSE ----------

  if (p[0] === 'events' && method === 'GET') {
    return handleEvents(req, res, url);
  }

  throw new ApiError(404, 'Не найдено');
}

// ============================================================
//  Обработчики
// ============================================================

async function handleRegister(req, res) {
  const body = await readJsonBody(req);

  const username = storage.normalizeUsername(body.username);
  const nickname = String(body.nickname || '').trim();
  const email = storage.normalizeEmail(body.email);
  const password = String(body.password || '');

  if (!username) throw new ApiError(400, 'Укажите username', 'username');
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    throw new ApiError(400, 'Username: 3–24 символа, латинские буквы, цифры и _', 'username');
  }
  if (storage.findUserByUsername(username)) {
    throw new ApiError(409, 'Этот username уже занят', 'username');
  }
  if (!nickname || nickname.length > 48) {
    throw new ApiError(400, 'Укажите никнейм (до 48 символов)', 'nickname');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new ApiError(400, 'Укажите корректный email — он обязателен для регистрации', 'email');
  }
  if (storage.findUserByEmail(email)) {
    throw new ApiError(409, 'Этот email уже зарегистрирован', 'email');
  }
  if (password.length < 6) {
    throw new ApiError(400, 'Пароль должен быть не короче 6 символов', 'password');
  }

  const user = storage.createUser({ username, nickname, email, password, isAdmin: username === 'coffin' });

  // автоматически подписываем новостной канал Pulse
  const news = getNewsChannel();
  if (news) storage.addMember(news, user.id, 'member');

  // личный чат «Избранное»
  ensureSavedChat(user.id);

  const token = storage.createSession(user.id);
  broadcast({ type: 'user_updated', userId: user.id });
  return sendJSON(res, 200, { token, user: storage.publicUser(user, { online: true }) });
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const loginRaw = String(body.login || '').trim();
  const password = String(body.password || '');
  if (!loginRaw || !password) throw new ApiError(400, 'Заполните все поля');

  const isEmail = loginRaw.includes('@') && !loginRaw.startsWith('@');
  const user = isEmail
    ? storage.findUserByEmail(loginRaw)
    : storage.findUserByUsername(loginRaw);

  if (!user) throw new ApiError(401, 'Неверный логин или пароль');
  const hash = storage.hashPassword(password, user.salt);
  if (hash !== user.passwordHash) throw new ApiError(401, 'Неверный логин или пароль');
  if (user.banned) throw new ApiError(403, 'Аккаунт заблокирован администратором');

  const token = storage.createSession(user.id);
  return sendJSON(res, 200, { token, user: storage.publicUser(user, { online: true }) });
}

async function handleCreateChat(req, res, me) {
  const body = await readJsonBody(req);
  const type = body.type;

  if (type === 'saved') {
    const chat = ensureSavedChat(me.id);
    return sendJSON(res, 200, { chat: chatWithMeta(chat, me.id, onlineUserIds()), created: false });
  }

  if (type === 'dialog') {
    const peer = storage.getUser(String(body.userId || ''));
    if (!peer) throw new ApiError(404, 'Пользователь не найден');
    if (peer.id === me.id) throw new ApiError(400, 'Нельзя создать чат с самим собой');
    let chat = storage.findDialog(me.id, peer.id);
    let created = false;
    if (!chat) {
      chat = storage.createChat({ type: 'dialog', ownerId: me.id, memberIds: [peer.id] });
      created = true;
    }
    broadcast({ type: 'chat_created', chatId: chat.id });
    return sendJSON(res, 200, { chat: chatWithMeta(chat, me.id, onlineUserIds()), created });
  }

  if (type === 'group' || type === 'channel') {
    const title = String(body.title || '').trim();
    if (!title || title.length > 64) throw new ApiError(400, 'Название: от 1 до 64 символов', 'title');
    const description = String(body.description || '').trim().slice(0, 300);
    const privacy = body.privacy === 'public' ? 'public' : 'private';
    const memberIds = [...new Set((Array.isArray(body.memberIds) ? body.memberIds : []).map(String))]
      .filter((id) => id !== me.id && storage.getUser(id));
    const chat = storage.createChat({ type, title, description, privacy, ownerId: me.id, memberIds });
    broadcast({ type: 'chat_created', chatId: chat.id });
    return sendJSON(res, 201, { chat: chatWithMeta(chat, me.id, onlineUserIds()) });
  }

  throw new ApiError(400, 'Неверный тип чата');
}

function handleEvents(req, res, url) {
  const user = getAuthUser(req, url);
  if (!user) throw new ApiError(401, 'Требуется авторизация');
  if (user.banned) throw new ApiError(403, 'Аккаунт заблокирован администратором');

  const cid = url.searchParams.get('cid') || storage.newId('cid');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'hello', cid })}\n\n`);

  const client = { userId: user.id, cid, res };
  const wasOnline = onlineUserIds().has(user.id);
  sseClients.add(client);
  if (!wasOnline) {
    broadcast({ type: 'presence', userId: user.id, online: true }, user.id);
  }

  req.on('close', () => {
    sseClients.delete(client);
    if (!onlineUserIds().has(user.id)) {
      broadcast({ type: 'presence', userId: user.id, online: false });
    }
  });
}

function handleUpload(req, res, url, parts) {
  const user = getAuthUser(req, url);
  if (!user) throw new ApiError(401, 'Требуется авторизация');

  const name = parts[1] || '';
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new ApiError(404, 'Файл не найден');
  const filePath = path.join(UPLOADS_DIR, name);
  if (!filePath.startsWith(UPLOADS_DIR + path.sep)) throw new ApiError(404, 'Файл не найден');

  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch (_) {
    throw new ApiError(404, 'Файл не найден');
  }

  const ext = path.extname(name).toLowerCase();
  const mimeMap = {
    '.webm': 'audio/webm',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
  };
  res.writeHead(200, {
    'Content-Type': mimeMap[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=86400',
    'Accept-Ranges': 'none',
  });
  fs.createReadStream(filePath).pipe(res);
}

// ============================================================
//  «Избранное» — личный чат-хранилище каждого пользователя
// ============================================================

function ensureSavedChat(userId) {
  let chat = storage.allChats().find((c) => c.type === 'saved' && c.members[userId]);
  if (!chat) {
    chat = storage.createChat({ type: 'saved', title: 'Избранное', ownerId: userId, memberIds: [] });
  }
  return chat;
}

// ============================================================
//  Системный новостной канал (создаётся при первом старте)
// ============================================================

function getNewsChannel() {
  const NEWS_TITLE = 'Pulse · Новости';
  let news = storage.allChats().find((c) => c.title === NEWS_TITLE && c.type === 'channel');
  if (news) return news;

  let bot = storage.findUserByUsername('pulse');
  if (!bot) {
    bot = storage.createUser({
      username: 'pulse',
      nickname: 'Pulse',
      email: 'pulse@system.local',
      password: crypto.randomBytes(24).toString('hex') + crypto.randomBytes(24).toString('hex'),
    });
  }

  news = storage.createChat({
    type: 'channel',
    title: NEWS_TITLE,
    description: 'Официальный канал мессенджера Pulse: новости и подсказки 💜',
    privacy: 'public',
    ownerId: bot.id,
    memberIds: [],
  });

  storage.addMessage(news.id, bot.id, {
    type: 'text',
    text: 'Добро пожаловать в Pulse 💜 Это публичный канал — здесь появляются новости и подсказки о мессенджере.',
  });
  storage.addMessage(news.id, bot.id, {
    type: 'text',
    text: '🎙 Голосовые сообщения: нажми на микрофон в чате, запиши сообщение и отправь — волновая форма нарисуется автоматически.',
  });
  storage.addMessage(news.id, bot.id, {
    type: 'text',
    text: '✏️ Создай свою группу или канал кнопкой слева. Публичные сообщества видны всем в разделе «Обзор» 🧭',
  });

  return news;
}

module.exports = { handleApi, initPresence, broadcast };
