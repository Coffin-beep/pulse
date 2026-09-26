'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(MESSAGES_DIR, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJSON(file, data, pretty) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : 0));
  fs.renameSync(tmp, file);
}

ensureDirs();

// ---- in-memory state (загружается один раз при старте) ----

const db = {
  users: readJSON(USERS_FILE, { items: {} }),
  chats: readJSON(CHATS_FILE, { items: {} }),
  sessions: readJSON(SESSIONS_FILE, { items: {} }),
};

const messageCache = new Map(); // chatId -> { seq, items }

function saveUsers() { writeJSON(USERS_FILE, db.users, true); }
function saveChats() { writeJSON(CHATS_FILE, db.chats, true); }
function saveSessions() { writeJSON(SESSIONS_FILE, db.sessions, true); }

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('hex');
}

// ---- users ----

function normalizeUsername(username) {
  return String(username || '').trim().replace(/^@+/, '').toLowerCase();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function allUsers() {
  return Object.values(db.users.items);
}

function getUser(id) {
  return db.users.items[id] || null;
}

function findUserByEmail(email) {
  const norm = normalizeEmail(email);
  return allUsers().find((u) => u.email === norm) || null;
}

function findUserByUsername(username) {
  const norm = normalizeUsername(username);
  return allUsers().find((u) => u.username === norm) || null;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function createUser({ username, nickname, email, password }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: newId('u'),
    username: normalizeUsername(username),
    nickname: String(nickname || '').trim(),
    email: normalizeEmail(email),
    salt,
    passwordHash: hashPassword(password, salt),
    bio: '',
    createdAt: Date.now(),
  };
  db.users.items[user.id] = user;
  saveUsers();
  return user;
}

function updateUser(id, patch) {
  const user = db.users.items[id];
  if (!user) return null;
  Object.assign(user, patch);
  saveUsers();
  return user;
}

function publicUser(user, extra) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    bio: user.bio || '',
    createdAt: user.createdAt,
    ...(extra || {}),
  };
}

// ---- sessions ----

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions.items[token] = { userId, createdAt: Date.now() };
  saveSessions();
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const s = db.sessions.items[token];
  if (!s) return null;
  return db.users.items[s.userId] || null;
}

function deleteSession(token) {
  if (token && db.sessions.items[token]) {
    delete db.sessions.items[token];
    saveSessions();
  }
}

// ---- chats ----

function allChats() {
  return Object.values(db.chats.items);
}

function getChat(id) {
  return db.chats.items[id] || null;
}

function dialogKey(a, b) {
  return [a, b].sort().join('~');
}

function findDialog(a, b) {
  const key = dialogKey(a, b);
  return allChats().find((c) => c.type === 'dialog' && c.dialogKey === key) || null;
}

function createChat({ type, title = '', description = '', privacy = 'private', ownerId, memberIds = [] }) {
  const chat = {
    id: newId('c'),
    type, // 'dialog' | 'group' | 'channel'
    title: String(title || '').trim(),
    description: String(description || '').trim(),
    privacy: type === 'dialog' ? 'private' : (privacy === 'public' ? 'public' : 'private'),
    ownerId,
    members: {},
    createdAt: Date.now(),
  };

  const ids = [ownerId, ...memberIds.filter(Boolean)];
  for (const uid of new Set(ids)) {
    chat.members[uid] = {
      role: uid === ownerId ? 'owner' : 'member',
      joinedAt: Date.now(),
      lastRead: 0,
    };
  }

  if (type === 'dialog') {
    const list = Object.keys(chat.members).sort();
    chat.dialogKey = dialogKey(list[0], list[1] || list[0]);
  }

  db.chats.items[chat.id] = chat;
  saveChats();
  return chat;
}

function updateChat(chat, patch) {
  Object.assign(chat, patch);
  saveChats();
}

function deleteChat(chatId) {
  delete db.chats.items[chatId];
  messageCache.delete(chatId);
  try { fs.unlinkSync(path.join(MESSAGES_DIR, chatId + '.json')); } catch (_) { /* noop */ }
  saveChats();
}

function addMember(chat, userId, role = 'member') {
  if (!chat.members[userId]) {
    chat.members[userId] = { role, joinedAt: Date.now(), lastRead: 0 };
    saveChats();
  }
}

function removeMember(chat, userId) {
  if (chat.members[userId]) {
    delete chat.members[userId];
    saveChats();
  }
}

function setOwner(chat, userId) {
  chat.ownerId = userId;
  if (chat.members[userId]) chat.members[userId].role = 'owner';
  saveChats();
}

function markRead(chat, userId, messageId) {
  const m = chat.members[userId];
  if (m && messageId > (m.lastRead || 0)) {
    m.lastRead = messageId;
    saveChats();
  }
}

// ---- messages ----

function messageStore(chatId) {
  if (messageCache.has(chatId)) return messageCache.get(chatId);
  const file = path.join(MESSAGES_DIR, chatId + '.json');
  const store = readJSON(file, { seq: 0, items: [] });
  if (!Array.isArray(store.items)) store.items = [];
  messageCache.set(chatId, store);
  return store;
}

function saveMessages(chatId) {
  const store = messageStore(chatId);
  writeJSON(path.join(MESSAGES_DIR, chatId + '.json'), store);
}

function addMessage(chatId, senderId, payload) {
  const store = messageStore(chatId);
  store.seq = (store.seq || 0) + 1;
  const msg = {
    id: store.seq,
    chatId,
    senderId,
    createdAt: Date.now(),
    ...payload,
  };
  store.items.push(msg);
  saveMessages(chatId);
  return msg;
}

function listMessages(chatId, { after = 0, limit = 300 } = {}) {
  const store = messageStore(chatId);
  let items = store.items;
  if (after > 0) items = items.filter((m) => m.id > after);
  if (items.length > limit) items = items.slice(items.length - limit);
  return items;
}

function lastMessage(chatId) {
  const store = messageStore(chatId);
  return store.items.length ? store.items[store.items.length - 1] : null;
}

function unreadCount(chatId, userId, lastRead) {
  const store = messageStore(chatId);
  let n = 0;
  for (const m of store.items) {
    if (m.id > (lastRead || 0) && m.senderId !== userId) n++;
  }
  return n;
}

function deleteMessage(chatId, messageId) {
  const store = messageStore(chatId);
  const i = store.items.findIndex((m) => m.id === Number(messageId));
  if (i === -1) return false;
  store.items.splice(i, 1);
  saveMessages(chatId);
  return true;
}

module.exports = {
  DATA_DIR,
  UPLOADS_DIR,
  MESSAGES_DIR,
  db,
  newId,
  normalizeUsername,
  normalizeEmail,
  allUsers,
  getUser,
  findUserByEmail,
  findUserByUsername,
  hashPassword,
  createUser,
  updateUser,
  publicUser,
  createSession,
  getSessionUser,
  deleteSession,
  allChats,
  getChat,
  findDialog,
  createChat,
  updateChat,
  deleteChat,
  addMember,
  removeMember,
  setOwner,
  markRead,
  messageStore,
  addMessage,
  listMessages,
  lastMessage,
  unreadCount,
  deleteMessage,
};
