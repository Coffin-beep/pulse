// Pulse — основной модуль приложения

import { api, connectEvents, getToken, setToken } from './api.js';
import {
  el, clear, debounce, icon, avatar, fmtTime, fmtListTime, fmtDaySep, fmtDuration,
  toast, modal, confirmModal, popover,
} from './ui.js';
import {
  VoiceRecorder, computePeaks, createVoicePlayer, stopAllVoice, recordingSupported,
} from './audio.js';
import { VoiceClient } from './voice.js';

const $app = document.getElementById('app');

const state = {
  user: null,
  chats: [],
  chatFilter: 'all',
  searchQ: '',
  userResults: [],
  currentChatId: null,
  chatDetail: null,
  openSeq: 0,
  messages: [],
  users: {},
  sse: null,
  rec: null,
  recTimer: null,
  cid: null,
  voice: null,
  voiceRoomsLive: new Map(), // roomId -> Map(cid -> { userId, muted })
  callAvatars: {},
};

const refs = {};
let syncTimer = null;
let emojiPop = null;

// ============================================================
//  Загрузка
// ============================================================

window.addEventListener('pulse:logout', () => showAuth(true));

(async function boot() {
  if (getToken()) {
    try {
      state.user = await api.get('/api/me');
      showApp();
      return;
    } catch (_) {
      setToken(null);
    }
  }
  showAuth();
})();

// ============================================================
//  Экран входа / регистрации
// ============================================================

function showAuth(expired) {
  if (state.sse) { state.sse.close(); state.sse = null; }
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  stopAllVoice();
  cancelRecordingSilently();
  closeEmoji();
  if (state.voice && state.voice.active) {
    try { state.voice.leave(); } catch (_) { /* noop */ }
  }
  state.voice = null;
  state.voiceRoomsLive = new Map();
  if (refs.callPanel) { refs.callPanel.remove(); refs.callPanel = null; }
  Object.assign(state, {
    user: null, chats: [], currentChatId: null, chatDetail: null,
    messages: [], users: {}, searchQ: '', userResults: [],
  });
  document.title = 'Pulse — мессенджер';
  clear($app);
  $app.appendChild(buildAuthScreen(expired));
}

function mkFieldWrap(labelText, inputEl) {
  return el('label', { class: 'field' }, el('span', { class: 'field__label' }, labelText), inputEl);
}

function buildAuthScreen(expired) {
  // --- форма регистрации ---
  const regErr = el('div', { class: 'field-error' });
  const regForm = el('form', {
    class: 'auth-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const f = e.target;
      regErr.textContent = '';
      const btn = f.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const res = await api.post('/api/auth/register', {
          nickname: f.elements.nickname.value,
          username: f.elements.username.value,
          email: f.elements.email.value,
          password: f.elements.password.value,
        });
        setToken(res.token);
        state.user = res.user;
        toast('Добро пожаловать в Pulse, ' + res.user.nickname + '! 💜', 'success');
        showApp();
      } catch (err) {
        setFormError(f, regErr, err);
      } finally {
        btn.disabled = false;
      }
    },
  },
    mkFieldWrap('Никнейм', el('input', { class: 'input', name: 'nickname', placeholder: 'Как тебя называть?', maxlength: '48', autocomplete: 'off' })),
    mkFieldWrap('Username', el('div', { class: 'input-adorn' },
      el('span', { class: 'input-adorn__prefix' }, '@'),
      el('input', { class: 'input input--adorn', name: 'username', placeholder: 'твой уникальный тег', maxlength: '24', autocomplete: 'off', spellcheck: 'false' }),
    )),
    mkFieldWrap('Email — обязателен', el('input', { class: 'input', name: 'email', type: 'email', placeholder: 'you@mail.com', autocomplete: 'email' })),
    mkFieldWrap('Пароль', el('input', { class: 'input', name: 'password', type: 'password', placeholder: 'Минимум 6 символов', autocomplete: 'new-password' })),
    regErr,
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Создать аккаунт'),
  );

  // --- форма входа ---
  const loginErr = el('div', { class: 'field-error' });
  const loginForm = el('form', {
    class: 'auth-form',
    style: 'display:none',
    onsubmit: async (e) => {
      e.preventDefault();
      const f = e.target;
      loginErr.textContent = '';
      const btn = f.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const res = await api.post('/api/auth/login', {
          login: f.elements.login.value,
          password: f.elements.password.value,
        });
        setToken(res.token);
        state.user = res.user;
        showApp();
      } catch (err) {
        setFormError(f, loginErr, err);
      } finally {
        btn.disabled = false;
      }
    },
  },
    mkFieldWrap('Email или @username', el('input', { class: 'input', name: 'login', placeholder: 'you@mail.com или @username', autocomplete: 'username' })),
    mkFieldWrap('Пароль', el('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password' })),
    loginErr,
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Войти'),
  );

  regForm.addEventListener('input', (e) => e.target.classList && e.target.classList.remove('input--error'));
  loginForm.addEventListener('input', (e) => e.target.classList && e.target.classList.remove('input--error'));

  // --- вкладки ---
  const regTab = el('button', { class: 'tab tab--active', type: 'button' }, 'Регистрация');
  const loginTab = el('button', { class: 'tab', type: 'button' }, 'Вход');
  function switchTab(toLogin) {
    regTab.classList.toggle('tab--active', !toLogin);
    loginTab.classList.toggle('tab--active', toLogin);
    regForm.style.display = toLogin ? 'none' : '';
    loginForm.style.display = toLogin ? '' : 'none';
  }
  regTab.addEventListener('click', () => switchTab(false));
  loginTab.addEventListener('click', () => switchTab(true));

  return el('div', { class: 'auth' },
    el('div', { class: 'auth__bg' },
      el('span', { class: 'blob blob--1' }),
      el('span', { class: 'blob blob--2' }),
      el('span', { class: 'blob blob--3' }),
    ),
    el('div', { class: 'auth__card' },
      el('div', { class: 'auth__logo' },
        el('div', { class: 'auth__mark' }, icon('logo', 36)),
        el('h1', { class: 'auth__title' }, 'Pulse'),
        el('p', { class: 'auth__sub' }, 'Мессенджер с тёмной стороной 💜'),
      ),
      expired ? el('div', { class: 'auth__note' }, 'Сессия истекла — войдите заново') : null,
      el('div', { class: 'tabs' }, regTab, loginTab),
      regForm,
      loginForm,
    ),
  );
}

function setFormError(form, errEl, err) {
  errEl.textContent = err.message || 'Что-то пошло не так';
  form.querySelectorAll('.input--error').forEach((i) => i.classList.remove('input--error'));
  if (err && err.field) {
    const input = form.querySelector(`[name="${err.field}"]`);
    if (input) input.classList.add('input--error');
  }
}

// ============================================================
//  Главное окно
// ============================================================

function showApp() {
  clear($app);
  state.cid = genCid();
  state.voice = new VoiceClient(state.cid, {
    onPeersChanged: () => renderCallPanel(),
    onLevels: (levels) => {
      for (const [cid, speaking] of Object.entries(levels)) {
        const av = state.callAvatars[cid];
        if (av) av.classList.toggle('is-speaking', !!speaking);
      }
    },
    onKicked: () => {
      toast('Голосовой канал был удалён или вы отключены');
      renderVoiceSection();
      renderCallPanel();
    },
    onEnded: () => {
      renderVoiceSection();
      renderCallPanel();
    },
  });
  buildLayout();
  state.sse = connectEvents(onServerEvent, state.cid);
  loadChats();
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(syncTick, 5000);
  document.addEventListener('visibilitychange', onVisibility);
}

function buildLayout() {
  refs.root = el('div', { class: 'app' });
  refs.sidebar = el('aside', { class: 'sidebar' });

  refs.avatarBtn = el('button', { class: 'head-avatar', title: 'Профиль' });
  refs.avatarBtn.addEventListener('click', () => openProfileMenu(refs.avatarBtn));

  refs.sidebar.append(
    el('div', { class: 'sidebar__head' },
      el('div', { class: 'brand' }, el('span', { class: 'brand__mark' }, icon('logo', 22)), 'Pulse'),
      el('div', { class: 'sidebar__actions' },
        state.user.isAdmin
          ? el('button', { class: 'icon-btn icon-btn--admin', title: 'Админ-панель', onclick: openAdminPanel }, icon('shield', 19))
          : null,
        el('button', { class: 'icon-btn', title: 'Обзор сообществ', onclick: openDiscover }, icon('compass', 19)),
        el('button', { class: 'icon-btn', title: 'Создать чат, группу или канал', onclick: (e) => openNewChatMenu(e.currentTarget) }, icon('edit', 19)),
        refs.avatarBtn,
      ),
    ),
    el('div', { class: 'search' },
      el('span', { class: 'search__icon' }, icon('search', 16)),
      refs.searchInput = el('input', { class: 'search__input', type: 'text', placeholder: 'Поиск · @username', autocomplete: 'off' }),
      refs.searchClear = el('button', { class: 'search__clear icon-btn', title: 'Очистить' }, icon('x', 13)),
    ),
    refs.chips = el('div', { class: 'chips' }),
    refs.chatList = el('div', { class: 'chat-list' }),
  );

  refs.searchInput.addEventListener('input', onSearchInput);
  refs.searchClear.addEventListener('click', clearSearch);
  refs.searchClear.style.display = 'none';

  for (const [id, label] of [['all', 'Все'], ['dialog', 'Личные'], ['group', 'Группы'], ['channel', 'Каналы']]) {
    refs.chips.append(el('button', {
      class: 'chip' + (state.chatFilter === id ? ' chip--active' : ''),
      onclick: () => setFilter(id),
    }, label));
  }

  refs.main = el('main', { class: 'chat-area' });
  renderEmptyMain();

  refs.root.append(refs.sidebar, refs.main);
  $app.append(refs.root);
  updateUserHead();
}

function updateUserHead() {
  if (!refs.avatarBtn || !state.user) return;
  clear(refs.avatarBtn);
  refs.avatarBtn.appendChild(avatar({ id: state.user.id, name: state.user.nickname }, { size: 36, dot: false }));
}

function setFilter(id) {
  state.chatFilter = id;
  [...refs.chips.children].forEach((c, i) => {
    c.classList.toggle('chip--active', ['all', 'dialog', 'group', 'channel'][i] === id);
  });
  renderChatList();
}

function clearSearch() {
  refs.searchInput.value = '';
  state.searchQ = '';
  state.userResults = [];
  refs.searchClear.style.display = 'none';
  renderChatList();
  refs.searchInput.focus();
}

const onSearchInput = debounce(async () => {
  state.searchQ = refs.searchInput.value;
  refs.searchClear.style.display = state.searchQ ? '' : 'none';
  renderChatList();
  const q = state.searchQ.trim();
  if (q) {
    try {
      const res = await api.get('/api/users?q=' + encodeURIComponent(q));
      state.userResults = res.users;
    } catch (_) {
      state.userResults = [];
    }
  } else {
    state.userResults = [];
  }
  if (state.searchQ === refs.searchInput.value) renderChatList();
}, 180);

// ============================================================
//  Список чатов
// ============================================================

async function loadChats() {
  if (!state.user) return;
  let res;
  try {
    res = await api.get('/api/chats');
  } catch (_) {
    return;
  }
  state.chats = res.chats || [];
  for (const c of state.chats) {
    if (c.peer) state.users[c.peer.id] = c.peer;
  }
  renderChatList();
  updateChatHeadSoft();
  updateTitleUnread();
}

function renderChatList() {
  if (!refs.chatList) return;
  clear(refs.chatList);
  const q = state.searchQ.trim().toLowerCase();

  let chats = state.chats;
  if (state.chatFilter !== 'all') chats = chats.filter((c) => c.type === state.chatFilter);
  if (q) {
    chats = chats.filter((c) =>
      c.title.toLowerCase().includes(q) ||
      (c.peer && (c.peer.username.includes(q.replace('@', '')) && q.replace('@', '').length > 0)) ||
      (c.lastMessage && c.lastMessage.type === 'text' && c.lastMessage.text.toLowerCase().includes(q)));
  }

  if (!q && !chats.length) {
    refs.chatList.append(el('div', { class: 'chat-list__empty' },
      'Здесь пока пусто.\u00A0Найдите человека,\u00A0создайте группу или канал ✏️'));
    return;
  }

  for (const chat of chats) refs.chatList.append(chatListItem(chat));

  if (q) {
    if (state.userResults.length) {
      refs.chatList.append(el('div', { class: 'chat-list__section' }, 'Люди'));
      for (const u of state.userResults) {
        refs.chatList.append(userRow(u, {
          action: 'Написать',
          onAction: async (usr) => {
            try {
              const r = await api.post('/api/chats', { type: 'dialog', userId: usr.id });
              await loadChats();
              openChat(r.chat.id);
            } catch (err) { toast(err.message, 'error'); }
          },
        }));
      }
    } else if (!chats.length) {
      refs.chatList.append(el('div', { class: 'chat-list__empty' }, 'Никого не нашли 🤷'));
    }
  }
}

function chatListItem(chat) {
  const lm = chat.lastMessage;
  let previewParts;
  if (lm && lm.type === 'voice') {
    previewParts = [icon('mic', 13), ' Голосовое · ' + fmtDuration(lm.duration)];
  } else if (lm) {
    previewParts = (chat.type !== 'channel' && lm.senderId === state.user.id ? 'Вы: ' : '') + lm.text;
  } else {
    previewParts = 'Нет сообщений';
  }

  const avEntity = chat.type === 'dialog'
    ? { id: chat.peer ? chat.peer.id : chat.id, name: chat.peer ? chat.peer.nickname : chat.title, online: chat.peer && chat.peer.online }
    : { id: chat.id, name: chat.title, type: chat.type };

  return el('div', {
    class: 'chat-item' +
      (chat.id === state.currentChatId ? ' chat-item--active' : '') +
      (chat.unread > 0 ? ' chat-item--unread' : ''),
    onclick: () => openChat(chat.id),
  },
    avatar(avEntity, { size: 48, typeIcon: true }),
    el('div', { class: 'chat-item__body' },
      el('div', { class: 'chat-item__top' },
        el('span', { class: 'chat-item__name' }, chat.title),
        el('span', { class: 'chat-item__time' }, fmtListTime(lm && lm.createdAt)),
      ),
      el('div', { class: 'chat-item__bottom' },
        el('span', { class: 'chat-item__preview' }, previewParts),
        chat.unread > 0 ? el('span', { class: 'chat-item__badge' }, chat.unread > 99 ? '99+' : String(chat.unread)) : null,
      ),
    ),
  );
}

function userRow(u, opts = {}) {
  const row = el('div', { class: 'user-row' + (opts.selected ? ' user-row--selected' : '') },
    avatar({ id: u.id, name: u.nickname, online: u.online }, { size: opts.avatarSize || 40 }),
    el('div', { class: 'user-row__info' },
      el('span', { class: 'user-row__name' },
        u.nickname,
        u.isAdmin ? el('span', { class: 'shield-ic', title: 'Администратор' }, icon('shield', 12)) : null),
      el('span', { class: 'user-row__sub' }, '@' + u.username + (u.online ? ' · онлайн' : '')),
    ),
  );
  if (opts.action) {
    row.appendChild(el('button', {
      class: 'btn btn--sm ' + (opts.actionClass || 'btn--ghost'),
      type: 'button',
      onclick: (e) => { e.stopPropagation(); opts.onAction && opts.onAction(u, row); },
    }, opts.action));
  }
  if (opts.onRowClick) row.addEventListener('click', () => opts.onRowClick(u, row));
  return row;
}

// ============================================================
//  Открытие чата и рендер переписки
// ============================================================

function currentChatView() {
  return state.chats.find((c) => c.id === state.currentChatId) || state.chatDetail || null;
}

async function openChat(id) {
  const seq = ++state.openSeq;
  state.currentChatId = id;
  state.chatDetail = null;
  cancelRecordingSilently();
  stopAllVoice();
  closeEmoji();
  renderChatList();
  refs.root.classList.add('app--chat-open');

  let detail, msgRes;
  try {
    [detail, msgRes] = await Promise.all([
      api.get('/api/chats/' + id),
      api.get('/api/chats/' + id + '/messages'),
    ]);
  } catch (err) {
    if (seq !== state.openSeq) return;
    toast(err.message || 'Не удалось открыть чат', 'error');
    closeChat();
    return;
  }
  if (seq !== state.openSeq) return;

  state.chatDetail = detail.chat;
  Object.assign(state.users, msgRes.users || {});
  state.messages = msgRes.messages || [];
  // сеем живое состояние голосовых комнат из серверных данных
  for (const r of detail.chat.voice || []) {
    state.voiceRoomsLive.set(r.id, new Map(r.participants.map((p) => [p.cid, p])));
  }
  renderChatArea();
  markRead(true);
}

function closeChat() {
  state.currentChatId = null;
  state.chatDetail = null;
  state.messages = [];
  state.openSeq++;
  cancelRecordingSilently();
  closeEmoji();
  if (refs.root) refs.root.classList.remove('app--chat-open');
  renderEmptyMain();
  renderChatList();
}

function renderEmptyMain() {
  if (!refs.main) return;
  clear(refs.main);
  refs.main.classList.remove('chat-area--open');
  refs.messagesEl = null;
  refs.composer = null;
  refs.recBar = null;
  refs.textarea = null;
  refs.voiceSection = null;
  refs.main.append(el('div', { class: 'empty' },
    el('div', { class: 'empty__mark' }, icon('logo', 64)),
    el('h2', { class: 'empty__title' }, 'Добро пожаловать в Pulse'),
    el('p', { class: 'empty__sub' }, 'Выберите чат слева или начните что-то новое'),
    el('div', { class: 'empty__actions' },
      el('button', { class: 'btn btn--primary', onclick: () => openUserPickerDialog() }, icon('user', 16), ' Личный чат'),
      el('button', { class: 'btn btn--ghost', onclick: () => openCreateChatModal('group') }, icon('users', 16), ' Группа'),
      el('button', { class: 'btn btn--ghost', onclick: () => openCreateChatModal('channel') }, icon('megaphone', 16), ' Канал'),
    ),
  ));
}

function canPost(chat) {
  if (!chat || !chat.role) return false;
  if (chat.type === 'channel') return chat.role === 'owner' || chat.role === 'admin';
  return true;
}

function chatSubtitle(chat) {
  if (chat.type === 'dialog') {
    return chat.peer ? (chat.peer.online ? 'в сети' : 'был(а) недавно') : '';
  }
  const base = chat.memberCount + ' ' + (chat.type === 'channel'
    ? plural(chat.memberCount, ['подписчик', 'подписчика', 'подписчиков'])
    : plural(chat.memberCount, ['участник', 'участника', 'участников']));
  return chat.onlineCount > 1 ? base + ' · ' + chat.onlineCount + ' онлайн' : base;
}

function renderChatArea() {
  const chat = state.chatDetail || currentChatView();
  if (!chat || !refs.main) { renderEmptyMain(); return; }
  clear(refs.main);
  refs.main.classList.add('chat-area--open');

  const entity = chat.type === 'dialog' && chat.peer
    ? { id: chat.peer.id, name: chat.peer.nickname, online: chat.peer.online }
    : { id: chat.id, name: chat.title, type: chat.type };

  refs.chatHeadSub = el('div', { class: 'chat-head__sub' }, chatSubtitle(chat));
  refs.main.append(el('header', { class: 'chat-head' },
    el('button', { class: 'icon-btn chat-head__back', title: 'Назад', onclick: closeChat }, icon('back', 20)),
    avatar(entity, { size: 42, typeIcon: true }),
    el('div', { class: 'chat-head__info' },
      el('div', { class: 'chat-head__title' }, chat.title),
      refs.chatHeadSub,
    ),
    el('div', { class: 'chat-head__actions' },
      el('button', { class: 'icon-btn', title: 'Информация о чате', onclick: openChatInfo }, icon('info', 19)),
    ),
  ));

  refs.messagesEl = el('div', { class: 'messages' });
  if (chat.type !== 'dialog') {
    refs.voiceSection = el('div', { class: 'voice-section' });
    refs.main.append(refs.voiceSection);
    renderVoiceSection();
  } else {
    refs.voiceSection = null;
  }
  refs.main.append(refs.messagesEl);
  renderComposer(chat);
  renderMessages();
  renderCallPanel();
}

function updateChatHeadSoft() {
  const chat = currentChatView();
  if (chat && refs.chatHeadSub && refs.main && refs.main.classList.contains('chat-area--open')) {
    refs.chatHeadSub.textContent = chatSubtitle(chat);
  }
}

// ============================================================
//  Сообщения
// ============================================================

function renderMessages(keepScroll) {
  if (!refs.messagesEl) return;
  const savedScroll = refs.messagesEl.scrollTop;
  const savedHeight = refs.messagesEl.scrollHeight;

  clear(refs.messagesEl);
  const chat = state.chatDetail || currentChatView();
  let prev = null;
  for (const m of state.messages) {
    appendMessageNode(m, prev, chat);
    prev = m;
  }

  if (keepScroll) {
    refs.messagesEl.scrollTop = savedScroll + (refs.messagesEl.scrollHeight - savedHeight);
  } else {
    scrollBottom();
  }
}

function appendMessages(newMsgs) {
  const chat = state.chatDetail || currentChatView();
  if (!chat || !refs.messagesEl) return;
  const fresh = newMsgs.filter((m) => !state.messages.some((x) => x.id === m.id));
  if (!fresh.length) return;
  const nearBottom = isNearBottom();
  let prev = state.messages.length ? state.messages[state.messages.length - 1] : null;
  for (const m of fresh) {
    appendMessageNode(m, prev, chat);
    prev = m;
  }
  state.messages.push(...fresh);
  if (nearBottom || fresh.some((m) => m.senderId === state.user.id)) {
    scrollBottom();
  }
}

function daySeparator(ts) {
  return el('div', { class: 'day-sep' }, el('span', { class: 'day-sep__label' }, fmtDaySep(ts)));
}

function appendMessageNode(m, prev, chat) {
  const mine = m.senderId === state.user.id;
  const showDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
  if (showDay) refs.messagesEl.append(daySeparator(m.createdAt));

  const newRun = !prev || prev.senderId !== m.senderId || showDay || m.createdAt - prev.createdAt > 5 * 60 * 1000;
  const sender = state.users[m.senderId] || (mine ? state.user : { id: m.senderId, nickname: '…' });
  const showSenderInfo = !mine && chat.type !== 'dialog' && newRun;

  refs.messagesEl.append(el('div', {
    class: 'msg' + (mine ? ' msg--mine' : '') + (newRun ? ' msg--first' : ''),
    dataset: { id: String(m.id) },
  },
    !mine && chat.type !== 'dialog'
      ? avatar({ id: m.senderId, name: sender.nickname }, { size: 30, cls: 'msg__avatar', dot: false })
      : null,
    el('div', { class: 'msg__main' },
      showSenderInfo ? el('div', { class: 'msg__sender' }, sender.nickname) : null,
      buildBubble(m, mine, chat),
    ),
  ));
}

function buildBubble(m, mine, chat) {
  const content = m.type === 'voice'
    ? createVoicePlayer(m, { mine })
    : el('div', { class: 'bubble__text' }, m.text);

  const meta = el('span', { class: 'bubble__meta' },
    fmtTime(m.createdAt),
    mine ? readCheck(m, chat) : null,
  );

  const bubble = el('div', { class: 'bubble bubble--' + m.type + (mine ? ' bubble--mine' : '') },
    content,
    meta,
  );

  const canDelete = mine || (chat && (chat.role === 'owner' || chat.role === 'admin'));
  if (canDelete) {
    bubble.appendChild(el('button', {
      class: 'bubble__del',
      title: 'Удалить сообщение',
      onclick: () => deleteMessage(m),
    }, icon('trash', 13)));
  }
  return bubble;
}

function readCheck(m, chat) {
  const members = (chat && chat.members) || {};
  const others = Object.keys(members).filter((id) => id !== state.user.id);
  if (!others.length) return icon('check', 13, 'meta-check');
  const readByAll = others.every((id) => (members[id] && members[id].lastRead || 0) >= m.id);
  return icon(readByAll ? 'checks' : 'check', 14, 'meta-check');
}

async function deleteMessage(m) {
  const ok = await confirmModal({
    title: 'Удалить сообщение?',
    text: 'Сообщение будет удалено у всех участников чата.',
    confirmLabel: 'Удалить',
  });
  if (!ok) return;
  try {
    await api.del(`/api/chats/${state.currentChatId}/messages/${m.id}`);
    removeMessageNode(m.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function removeMessageNode(id) {
  const i = state.messages.findIndex((m) => m.id === id);
  if (i !== -1) state.messages.splice(i, 1);
  const node = refs.messagesEl && refs.messagesEl.querySelector(`.msg[data-id="${id}"]`);
  if (node) node.remove();
  loadChats();
}

function scrollBottom() {
  if (refs.messagesEl) refs.messagesEl.scrollTop = refs.messagesEl.scrollHeight;
}

function isNearBottom() {
  if (!refs.messagesEl) return true;
  return refs.messagesEl.scrollHeight - refs.messagesEl.scrollTop - refs.messagesEl.clientHeight < 180;
}

async function fetchNewMessages() {
  const chatId = state.currentChatId;
  if (!chatId) return;
  const after = state.messages.length ? state.messages[state.messages.length - 1].id : 0;
  try {
    const res = await api.get(`/api/chats/${chatId}/messages?after=${after}`);
    if (state.currentChatId !== chatId) return;
    Object.assign(state.users, res.users || {});
    if (res.messages.length) {
      appendMessages(res.messages);
    }
    markRead();
  } catch (_) { /* noop */ }
}

function markRead(force) {
  const chatId = state.currentChatId;
  if (!chatId || !state.messages.length) return;
  if (!force && document.hidden) return;
  const chat = currentChatView();
  if (!force && chat && !chat.unread) return;
  const lastId = state.messages[state.messages.length - 1].id;
  api.post(`/api/chats/${chatId}/read`, { messageId: lastId }).then(() => {
    const c = state.chats.find((x) => x.id === chatId);
    if (c && c.unread) {
      c.unread = 0;
      renderChatList();
      updateTitleUnread();
    }
  }).catch(() => { /* noop */ });
}

function updateTitleUnread() {
  const n = state.chats.reduce((s, c) => s + (c.unread || 0), 0);
  document.title = n > 0 ? `(${n}) Pulse — мессенджер` : 'Pulse — мессенджер';
}

// ============================================================
//  Композер: текст, эмодзи, голосовые
// ============================================================

function renderComposer(chat) {
  const old = refs.main.querySelector('.composer-wrap');
  if (old) old.remove();

  const wrap = el('div', { class: 'composer-wrap' });

  if (!canPost(chat)) {
    wrap.append(el('div', { class: 'composer-note' },
      el('span', { class: 'composer-note__icon' }, icon('megaphone', 16)),
      chat.type === 'channel' ? 'Только администраторы могут публиковать сообщения' : 'Вы не можете писать в этот чат',
    ));
    refs.composer = null;
    refs.textarea = null;
    refs.main.append(wrap);
    return;
  }

  refs.textarea = el('textarea', { class: 'composer__input', rows: '1', placeholder: 'Написать сообщение…' });
  refs.textarea.addEventListener('input', () => { autoGrow(refs.textarea); updateSendButtons(); });
  refs.textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  });

  refs.sendBtn = el('button', { class: 'composer__btn composer__btn--send', title: 'Отправить' }, icon('send', 18));
  refs.sendBtn.addEventListener('click', sendText);
  refs.micBtn = el('button', { class: 'composer__btn composer__btn--mic', title: 'Записать голосовое сообщение' }, icon('mic', 19));
  refs.micBtn.addEventListener('click', startRecording);
  const emojiBtn = el('button', { class: 'composer__btn composer__btn--emoji', title: 'Эмодзи' }, icon('smile', 20));
  emojiBtn.addEventListener('click', (e) => toggleEmoji(e.currentTarget));

  refs.composer = el('div', { class: 'composer' },
    emojiBtn,
    refs.textarea,
    refs.sendBtn,
    refs.micBtn,
  );
  wrap.append(refs.composer);
  refs.main.append(wrap);
  updateSendButtons();
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
}

function updateSendButtons() {
  if (!refs.textarea || !refs.sendBtn || !refs.micBtn) return;
  const has = refs.textarea.value.trim().length > 0;
  refs.sendBtn.classList.toggle('hidden', !has);
  refs.micBtn.classList.toggle('hidden', has);
}

async function sendText() {
  const chatId = state.currentChatId;
  const text = refs.textarea ? refs.textarea.value.trim() : '';
  if (!text || !chatId) return;
  refs.textarea.value = '';
  autoGrow(refs.textarea);
  updateSendButtons();
  try {
    const res = await api.post(`/api/chats/${chatId}/messages`, { type: 'text', text });
    if (state.currentChatId === chatId) appendMessages([res.message]);
  } catch (err) {
    toast(err.message, 'error');
    refs.textarea.value = text;
    autoGrow(refs.textarea);
    updateSendButtons();
  }
}

// --- эмодзи ---

const EMOJIS = [
  '😀', '😅', '😂', '🥰', '😍', '😉', '😎', '🤔', '😴', '🤗', '😭', '😡',
  '👍', '👎', '👏', '🙏', '💪', '🔥', '💜', '✨', '🎉', '❤️', '💔', '🌟',
  '🎧', '🎵', '🎮', '☕', '🍕', '🚀', '🌙', '☀️',
];

function toggleEmoji(anchor) {
  if (emojiPop) { closeEmoji(); return; }
  const grid = el('div', { class: 'emoji-grid' });
  for (const em of EMOJIS) {
    grid.append(el('button', { class: 'emoji-cell', type: 'button' }, em));
  }
  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.emoji-cell');
    if (cell) insertEmoji(cell.textContent);
  });
  emojiPop = popover(anchor, grid, { align: 'left', cls: 'popover--emoji', onClosed: () => { emojiPop = null; } });
}

function closeEmoji() {
  if (emojiPop) { emojiPop.close(); emojiPop = null; }
}

function insertEmoji(em) {
  const ta = refs.textarea;
  if (!ta) return;
  const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const e2 = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
  ta.setRangeText(em, s, e2, 'end');
  ta.focus();
  autoGrow(ta);
  updateSendButtons();
}

// --- запись голосовых ---

function startRecording() {
  if (state.rec) return;
  if (!recordingSupported()) {
    toast('Ваш браузер не поддерживает запись звука', 'error');
    return;
  }
  closeEmoji();
  const rec = new VoiceRecorder();
  rec.start().then(() => {
    if (!refs.composer) { rec.cancel(); return; }
    state.rec = rec;
    showRecordingUI();
  }).catch(() => {
    toast('Нет доступа к микрофону. Разрешите доступ в браузере и попробуйте снова', 'error');
  });
}

function showRecordingUI() {
  if (!refs.recBar) {
    const timeEl = el('span', { class: 'rec__time' }, '0:00');
    const bars = el('div', { class: 'rec__bars' });
    for (let i = 0; i < 18; i++) {
      const b = el('span', { class: 'rec__bar' });
      b.style.animationDelay = (i * 0.08) + 's';
      b.style.animationDuration = (0.65 + (i % 5) * 0.14) + 's';
      bars.appendChild(b);
    }
    refs.recBar = el('div', { class: 'rec-bar' },
      el('button', { class: 'rec__cancel icon-btn', title: 'Отменить запись' }, icon('trash', 18)),
      el('div', { class: 'rec__indicator' },
        el('span', { class: 'rec__dot' }),
        timeEl,
        bars,
      ),
      el('button', { class: 'rec__send', title: 'Отправить голосовое' }, icon('send', 18)),
    );
    refs.recBar.querySelector('.rec__cancel').addEventListener('click', () => finishRecording(false));
    refs.recBar.querySelector('.rec__send').addEventListener('click', () => finishRecording(true));
    refs.recTimeEl = timeEl;
  }
  refs.composer.style.display = 'none';
  refs.composer.parentNode.insertBefore(refs.recBar, refs.composer);
  state.recTimer = setInterval(() => {
    if (!state.rec || !refs.recTimeEl) return;
    refs.recTimeEl.textContent = fmtDuration(state.rec.duration);
    if (state.rec.duration >= 300) finishRecording(true); // максимум 5 минут
  }, 200);
}

async function finishRecording(send) {
  const rec = state.rec;
  if (!rec) return;
  state.rec = null;
  clearInterval(state.recTimer);
  state.recTimer = null;
  if (refs.recBar && refs.recBar.parentNode) refs.recBar.remove();
  if (refs.composer) refs.composer.style.display = '';

  if (!send) {
    rec.cancel();
    return;
  }

  const duration = rec.duration;
  if (duration < 0.7) {
    rec.cancel();
    toast('Слишком короткая запись', 'error');
    return;
  }

  try {
    const blob = await rec.stop();
    if (blob.size < 800) {
      toast('Не удалось записать звук', 'error');
      return;
    }
    const peaks = await computePeaks(blob);
    const chatId = state.currentChatId;
    const res = await api.postVoice(`/api/chats/${chatId}/voice`, blob, {
      duration: String(Math.round(duration * 10) / 10),
      peaks: peaks ? peaks.join(',') : '',
    });
    if (state.currentChatId === chatId) appendMessages([res.message]);
  } catch (err) {
    toast(err.message || 'Ошибка при отправке голосового сообщения', 'error');
  }
}

function cancelRecordingSilently() {
  if (state.rec) finishRecording(false);
}

// ============================================================
//  Живые обновления (SSE) + синхронизация
// ============================================================

function onServerEvent(e) {
  switch (e.type) {
    case 'new_message':
      if (e.chatId === state.currentChatId) fetchNewMessages();
      scheduleChatsRefresh();
      break;
    case 'chat_created':
    case 'chat_updated':
    case 'user_updated':
    case 'presence':
      scheduleChatsRefresh();
      if (e.chatId && e.chatId === state.currentChatId) refreshCurrentChat();
      break;
    case 'chat_deleted':
      if (e.chatId === state.currentChatId) {
        closeChat();
        toast('Чат больше не существует');
      }
      scheduleChatsRefresh();
      break;
    case 'message_deleted':
      if (e.chatId === state.currentChatId) refreshCurrentChat();
      scheduleChatsRefresh();
      break;
    case 'voice_state':
      applyVoiceState(e);
      if (state.voice) state.voice.handleVoiceState(e);
      break;
    case 'voice_signal':
      if (state.voice) state.voice.handleSignal(e);
      break;
    default:
      break;
  }
}

const scheduleChatsRefresh = debounce(() => loadChats(), 250);

async function refreshCurrentChat() {
  const id = state.currentChatId;
  if (!id) return;
  try {
    const [msgRes, detRes] = await Promise.all([
      api.get('/api/chats/' + id + '/messages'),
      api.get('/api/chats/' + id),
    ]);
    if (state.currentChatId !== id) return;
    Object.assign(state.users, msgRes.users || {});
    state.messages = msgRes.messages || [];
    if (state.chatDetail) {
      state.chatDetail = detRes.chat;
      if (refs.voiceSection) renderVoiceSection();
    }
    renderMessages(true);
  } catch (err) {
    if (err.status === 403 || err.status === 404) closeChat();
  }
}

function syncTick() {
  if (!state.user || document.hidden) return;
  loadChats();
  if (state.currentChatId) fetchNewMessages();
}

function onVisibility() {
  if (!document.hidden && state.user) {
    syncTick();
    markRead();
  }
}

// ============================================================
//  Меню, модалки: создание чатов, обзор, профиль
// ============================================================

function openNewChatMenu(anchor) {
  const pop = popover(anchor, el('div', { class: 'menu' },
    el('button', { class: 'menu__item' }, icon('user', 16), 'Личный чат'),
    el('button', { class: 'menu__item' }, icon('users', 16), 'Новая группа'),
    el('button', { class: 'menu__item' }, icon('megaphone', 16), 'Новый канал'),
  ), { align: 'right' });

  const [b1, b2, b3] = pop.root.querySelectorAll('.menu__item');
  b1.addEventListener('click', () => { pop.close(); openUserPickerDialog(); });
  b2.addEventListener('click', () => { pop.close(); openCreateChatModal('group'); });
  b3.addEventListener('click', () => { pop.close(); openCreateChatModal('channel'); });
}

function openProfileMenu(anchor) {
  const pop = popover(anchor, el('div', { class: 'menu' },
    el('div', { class: 'menu__head' },
      avatar({ id: state.user.id, name: state.user.nickname }, { size: 42, dot: false }),
      el('div', { class: 'menu__head-info' },
        el('span', { class: 'menu__head-name' }, state.user.nickname,
          state.user.isAdmin ? el('span', { class: 'shield-ic', title: 'Администратор' }, icon('shield', 13)) : null),
        el('span', { class: 'menu__head-sub' }, '@' + state.user.username + (state.user.isAdmin ? ' · админ' : '')),
      ),
    ),
    el('button', { class: 'menu__item' }, icon('user', 16), 'Мой профиль'),
    el('button', { class: 'menu__item menu__item--danger' }, icon('logout', 16), 'Выйти'),
  ), { align: 'right' });

  const [profileBtn, logoutBtn] = pop.root.querySelectorAll('.menu__item');
  profileBtn.addEventListener('click', () => { pop.close(); openProfileModal(); });
  logoutBtn.addEventListener('click', () => { pop.close(); doLogout(); });
}

async function doLogout() {
  try { await api.post('/api/auth/logout'); } catch (_) { /* noop */ }
  setToken(null);
  showAuth();
}

// --- выбор пользователя (новый личный чат) ---

function openUserPickerDialog() {
  const list = el('div', { class: 'picker-list' });
  const input = el('input', { class: 'input', placeholder: 'Поиск по имени или @username', autocomplete: 'off' });
  const m = modal({ title: 'Новый личный чат', content: el('div', {}, input, list) });

  const search = debounce(async () => {
    const q = input.value.trim();
    try {
      const res = await api.get('/api/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
      clear(list);
      if (!res.users.length) list.append(el('div', { class: 'picker-empty' }, 'Никого не нашли 🤷'));
      for (const u of res.users) {
        list.append(userRow(u, {
          action: 'Написать',
          onAction: async (usr) => {
            try {
              const r = await api.post('/api/chats', { type: 'dialog', userId: usr.id });
              m.close();
              await loadChats();
              openChat(r.chat.id);
            } catch (err) { toast(err.message, 'error'); }
          },
        }));
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }, 200);

  input.addEventListener('input', search);
  search();
  setTimeout(() => input.focus(), 50);
}

// --- мультивыбор пользователей (участники группы/канала) ---

function openUserPickerMulti(onPick, excludeIds = []) {
  const list = el('div', { class: 'picker-list' });
  const input = el('input', { class: 'input', placeholder: 'Поиск людей', autocomplete: 'off' });
  const picked = [];
  modal({ title: 'Добавить участников', content: el('div', {}, input, list) });

  const search = debounce(async () => {
    const q = input.value.trim();
    try {
      const res = await api.get('/api/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
      clear(list);
      const users = res.users.filter((u) => !excludeIds.includes(u.id));
      if (!users.length) list.append(el('div', { class: 'picker-empty' }, 'Никого не нашли 🤷'));
      for (const u of users) {
        const isPicked = picked.includes(u.id);
        list.append(userRow(u, {
          selected: isPicked,
          action: isPicked ? '✓' : 'Добавить',
          actionClass: isPicked ? 'btn--primary' : 'btn--ghost',
          onAction: (usr) => {
            if (picked.includes(usr.id)) {
              const i = picked.indexOf(usr.id);
              picked.splice(i, 1);
            } else {
              picked.push(usr.id);
              onPick(usr);
            }
            search();
          },
        }));
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }, 200);

  input.addEventListener('input', search);
  search();
  setTimeout(() => input.focus(), 50);
}

// --- создание группы / канала ---

function segmented(items, active, onChange) {
  const wrap = el('div', { class: 'segmented' });
  const btns = new Map();
  for (const it of items) {
    const b = el('button', { class: 'segmented__btn' + (it.id === active ? ' segmented__btn--active' : ''), type: 'button' },
      icon(it.ic, 15), it.label);
    b.addEventListener('click', () => {
      for (const [id, btn] of btns) btn.classList.toggle('segmented__btn--active', id === it.id);
      onChange(it.id);
    });
    btns.set(it.id, b);
    wrap.appendChild(b);
  }
  return wrap;
}

function openCreateChatModal(initialType = 'group') {
  let type = initialType;
  let privacy = 'private';
  const selected = new Map();

  const titleInput = el('input', { class: 'input', placeholder: initialType === 'channel' ? 'Название канала' : 'Название группы', maxlength: '64', autocomplete: 'off' });
  const descInput = el('textarea', { class: 'input input--area', placeholder: 'Описание (необязательно)', maxlength: '300' });

  const typeSeg = segmented([
    { id: 'group', label: 'Группа', ic: 'users' },
    { id: 'channel', label: 'Канал', ic: 'megaphone' },
  ], initialType, (id) => {
    type = id;
    titleInput.placeholder = id === 'channel' ? 'Название канала' : 'Название группы';
  });

  const privacySeg = segmented([
    { id: 'private', label: 'Частное', ic: 'lock' },
    { id: 'public', label: 'Публичное', ic: 'globe' },
  ], 'private', (id) => { privacy = id; });

  const errEl = el('div', { class: 'field-error' });
  const chipsWrap = el('div', { class: 'member-chips' });
  const membersBtn = el('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, icon('plus', 14), ' Добавить участников');

  const m = modal({
    title: 'Создать',
    content: el('div', { class: 'form' },
      typeSeg,
      mkFieldWrap('Название', titleInput),
      mkFieldWrap('Описание', descInput),
      el('div', { class: 'form__row-label' }, 'Приватность'),
      privacySeg,
      el('div', { class: 'form__hint' }, 'Публичные сообщества видны всем в разделе «Обзор» — туда можно вступить или подписаться.'),
      membersBtn,
      chipsWrap,
      errEl,
    ),
  });

  membersBtn.addEventListener('click', () => {
    openUserPickerMulti((u) => {
      selected.set(u.id, u);
      renderChips();
    }, [state.user.id, ...[...selected.keys()]]);
  });

  function renderChips() {
    clear(chipsWrap);
    for (const u of selected.values()) {
      chipsWrap.append(el('span', { class: 'member-chip' },
        avatar({ id: u.id, name: u.nickname }, { size: 22, dot: false }),
        u.nickname,
        el('button', {
          class: 'member-chip__x', title: 'Убрать',
          onclick: () => { selected.delete(u.id); renderChips(); },
        }, icon('x', 11)),
      ));
    }
  }

  const submit = el('button', { class: 'btn btn--primary btn--block' }, 'Создать');
  submit.addEventListener('click', async () => {
    errEl.textContent = '';
    const title = titleInput.value.trim();
    if (!title) { errEl.textContent = 'Укажите название'; return; }
    submit.disabled = true;
    try {
      const res = await api.post('/api/chats', {
        type,
        title,
        description: descInput.value.trim(),
        privacy,
        memberIds: [...selected.keys()],
      });
      m.close();
      await loadChats();
      openChat(res.chat.id);
      toast((type === 'channel' ? 'Канал' : 'Группа') + ' «' + title + '» создан(а) 💜', 'success');
    } catch (err) {
      errEl.textContent = err.message;
      submit.disabled = false;
    }
  });
  m.body.appendChild(submit);
  setTimeout(() => titleInput.focus(), 50);
}

// --- обзор публичных сообществ ---

function openDiscover() {
  const input = el('input', { class: 'input', placeholder: 'Поиск групп и каналов', autocomplete: 'off' });
  const list = el('div', { class: 'picker-list' });
  const m = modal({ title: 'Обзор сообществ', wide: true, content: el('div', {}, input, list) });

  const search = debounce(async () => {
    const q = input.value.trim();
    try {
      const res = await api.get('/api/discover' + (q ? '?q=' + encodeURIComponent(q) : ''));
      clear(list);
      if (!res.items.length) {
        list.append(el('div', { class: 'picker-empty' }, q ? 'Ничего не нашлось 🔍' : 'Пока нет публичных сообществ — создайте первое!'));
      }
      for (const c of res.items) {
        list.append(el('div', { class: 'community-row' },
          avatar({ id: c.id, name: c.title }, { size: 46, typeIcon: true }),
          el('div', { class: 'community-row__info' },
            el('span', { class: 'community-row__name' }, c.title),
            el('span', { class: 'community-row__sub' },
              (c.type === 'channel' ? 'канал' : 'группа') + ' · ' +
              c.memberCount + ' ' + plural(c.memberCount, ['участник', 'участника', 'участников'])),
            c.description ? el('span', { class: 'community-row__desc' }, c.description) : null,
          ),
          el('button', {
            class: 'btn btn--sm ' + (c.type === 'channel' ? 'btn--primary' : 'btn--ghost'),
            onclick: async () => {
              try {
                await api.post(`/api/chats/${c.id}/join`);
                toast(c.type === 'channel' ? 'Вы подписались на канал 💜' : 'Вы вступили в группу 💜', 'success');
                m.close();
                await loadChats();
                openChat(c.id);
              } catch (err) { toast(err.message, 'error'); }
            },
          }, c.type === 'channel' ? 'Подписаться' : 'Вступить'),
        ));
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }, 200);

  input.addEventListener('input', search);
  search();

  m.body.appendChild(el('div', { class: 'discover-actions' },
    el('button', { class: 'btn btn--ghost', onclick: () => { m.close(); openCreateChatModal('group'); } }, icon('users', 16), ' Создать группу'),
    el('button', { class: 'btn btn--ghost', onclick: () => { m.close(); openCreateChatModal('channel'); } }, icon('megaphone', 16), ' Создать канал'),
  ));
  setTimeout(() => input.focus(), 50);
}

// --- информация о чате ---

function chatTypeLabel(chat) {
  if (chat.type === 'dialog') return chat.peer ? '@' + chat.peer.username : 'Личный чат';
  const kind = chat.type === 'channel' ? 'Канал' : 'Группа';
  const priv = chat.privacy === 'public' ? 'публичное' : 'приватное';
  return kind + ' · ' + priv + ' сообщество';
}

function openChatInfo() {
  const chat = state.chatDetail || currentChatView();
  if (!chat) return;
  const m = modal({ title: 'Информация' });
  const body = m.body;
  const isDialog = chat.type === 'dialog';
  const canManage = !isDialog && (chat.role === 'owner' || chat.role === 'admin');

  body.append(el('div', { class: 'chatinfo__head' },
    avatar(
      isDialog && chat.peer
        ? { id: chat.peer.id, name: chat.peer.nickname, online: chat.peer.online }
        : { id: chat.id, name: chat.title, type: chat.type },
      { size: 72, typeIcon: true }
    ),
    el('div', {},
      el('div', { class: 'chatinfo__title' }, chat.title),
      el('div', { class: 'chatinfo__sub' }, chatTypeLabel(chat)),
    ),
  ));

  if (chat.description) {
    body.append(el('p', { class: 'chatinfo__desc' }, chat.description));
  }

  if (!isDialog) {
    const membersBlock = el('div', { class: 'chatinfo__members' });
    body.append(membersBlock);
    renderMembers();

    function memberUsers() {
      return (chat.memberUsers || []).slice().sort((a, b) => {
        const rank = { owner: 0, admin: 1, member: 2 };
        return ((rank[a.role] ?? 3) - (rank[b.role] ?? 3)) || a.nickname.localeCompare(b.nickname);
      });
    }

    function renderMembers() {
      clear(membersBlock);
      const users = memberUsers();
      membersBlock.append(el('div', { class: 'chatinfo__section-title' },
        users.length + ' ' + plural(users.length, ['участник', 'участника', 'участников'])));
      if (canManage) {
        membersBlock.append(el('button', { class: 'btn btn--ghost btn--sm chatinfo__add', onclick: addMemberFlow },
          icon('plus', 14), ' Добавить участника'));
      }
      for (const u of users) {
        const removable = canManage && u.role !== 'owner' && (u.role !== 'admin' || chat.role === 'owner') && u.id !== state.user.id;
        membersBlock.append(el('div', { class: 'user-row' },
          avatar({ id: u.id, name: u.nickname, online: u.online }, { size: 38 }),
          el('div', { class: 'user-row__info' },
            el('span', { class: 'user-row__name' }, u.nickname + (u.id === state.user.id ? ' (вы)' : '')),
            el('span', { class: 'user-row__sub' }, '@' + u.username + (u.online ? ' · онлайн' : '')),
          ),
          u.role !== 'member' ? el('span', { class: 'role-badge role-badge--' + u.role },
            u.role === 'owner' ? 'владелец' : 'админ') : null,
          removable ? el('button', {
            class: 'icon-btn icon-btn--danger',
            title: 'Удалить из чата',
            onclick: () => removeMemberFlow(u),
          }, icon('x', 14)) : null,
        ));
      }
    }

    async function addMemberFlow() {
      openUserPickerMulti(async (u) => {
        try {
          const res = await api.post(`/api/chats/${chat.id}/members`, { userId: u.id });
          state.chatDetail = res.chat;
          Object.assign(chat, res.chat);
          toast(u.nickname + ' добавлен(а) 💜', 'success');
          renderMembers();
          loadChats();
        } catch (err) {
          toast(err.message, 'error');
        }
      }, Object.keys(chat.members));
    }

    async function removeMemberFlow(u) {
      const ok = await confirmModal({
        title: 'Удалить участника?',
        text: u.nickname + ' потеряет доступ к этому чату.',
        confirmLabel: 'Удалить',
      });
      if (!ok) return;
      try {
        await api.del(`/api/chats/${chat.id}/members/${u.id}`);
        delete chat.members[u.id];
        chat.memberUsers = (chat.memberUsers || []).filter((x) => x.id !== u.id);
        renderMembers();
        loadChats();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  }

  const actions = el('div', { class: 'modal__actions' });
  if (!isDialog) {
    actions.append(el('button', { class: 'btn btn--ghost', onclick: leaveChatFlow }, icon('logout', 15), ' Покинуть'));
  }
  if (isDialog || chat.role === 'owner') {
    actions.append(el('button', { class: 'btn btn--danger', onclick: deleteChatFlow }, icon('trash', 15), ' Удалить чат'));
  }
  if (actions.children.length) body.append(actions);

  async function leaveChatFlow() {
    const ok = await confirmModal({
      title: 'Покинуть чат?',
      text: 'Если сообщество публичное, вы сможете вернуться в любой момент.',
      confirmLabel: 'Покинуть',
    });
    if (!ok) return;
    try {
      m.close();
      await api.post(`/api/chats/${chat.id}/leave`);
      closeChat();
      await loadChats();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deleteChatFlow() {
    const ok = await confirmModal({
      title: 'Удалить чат?',
      text: 'Чат и вся история сообщений будут удалены для всех участников.',
      confirmLabel: 'Удалить',
    });
    if (!ok) return;
    try {
      m.close();
      await api.del('/api/chats/' + chat.id);
      closeChat();
      await loadChats();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
}

// --- профиль ---

function openProfileModal() {
  const m = modal({ title: 'Мой профиль' });
  const u = state.user;
  const nickInput = el('input', { class: 'input', value: u.nickname, maxlength: '48', autocomplete: 'off' });
  const bioInput = el('textarea', { class: 'input input--area', maxlength: '200', placeholder: 'Пара слов о себе' });
  bioInput.value = u.bio || '';
  const errEl = el('div', { class: 'field-error' });
  const saveBtn = el('button', { class: 'btn btn--primary' }, 'Сохранить');

  m.body.append(
    el('div', { class: 'chatinfo__head' },
      avatar({ id: u.id, name: u.nickname }, { size: 72, dot: false }),
      el('div', {},
        el('div', { class: 'chatinfo__title' }, u.nickname),
        el('div', { class: 'chatinfo__sub' }, '@' + u.username),
        el('div', { class: 'chatinfo__sub' }, u.email),
      ),
    ),
    mkFieldWrap('Никнейм', nickInput),
    mkFieldWrap('О себе', bioInput),
    errEl,
    el('div', { class: 'modal__actions' },
      el('button', { class: 'btn btn--ghost', onclick: doLogout }, icon('logout', 15), ' Выйти'),
      saveBtn,
    ),
  );

  saveBtn.addEventListener('click', async () => {
    errEl.textContent = '';
    try {
      const res = await api.patch('/api/me', { nickname: nickInput.value.trim(), bio: bioInput.value });
      state.user = res;
      updateUserHead();
      toast('Профиль обновлён 💜', 'success');
      m.close();
      loadChats();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

// ============================================================
//  Голосовые каналы (Discord-style)
// ============================================================

function canManageVoice(chat) {
  return !!chat && chat.type !== 'dialog' && (chat.role === 'owner' || chat.role === 'admin');
}

function voiceUserName(userId) {
  if (state.user && userId === state.user.id) return state.user.nickname;
  if (state.users[userId]) return state.users[userId].nickname;
  if (state.chatDetail && state.chatDetail.memberUsers) {
    const mu = state.chatDetail.memberUsers.find((u) => u.id === userId);
    if (mu) return mu.nickname;
  }
  const fromChats = state.chats.find((c) => c.peer && c.peer.id === userId);
  if (fromChats) return fromChats.peer.nickname;
  return '…';
}

function applyVoiceState(e) {
  const roomId = e.roomId;
  let m = state.voiceRoomsLive.get(roomId);
  if (e.action === 'join') {
    if (!m) {
      m = new Map();
      state.voiceRoomsLive.set(roomId, m);
    }
    m.set(e.connId, { cid: e.connId, userId: e.userId, muted: !!e.muted });
  } else if (e.action === 'leave' || e.action === 'kick') {
    if (m) {
      m.delete(e.connId);
      if (!m.size) state.voiceRoomsLive.delete(roomId);
    }
  } else if (e.action === 'state') {
    if (m && m.has(e.connId)) m.get(e.connId).muted = !!e.muted;
  }
  if (state.chatDetail && e.chatId === state.chatDetail.id && refs.voiceSection) renderVoiceSection();
  if (state.voice && e.roomId === state.voice.roomId) renderCallPanel();
}

function renderVoiceSection() {
  if (!refs.voiceSection) return;
  const chat = state.chatDetail;
  clear(refs.voiceSection);
  if (!chat || chat.type === 'dialog') return;

  const rooms = (chat.voice || []).map((r) => ({
    ...r,
    participants: [...(state.voiceRoomsLive.get(r.id) || new Map()).values()],
  }));
  const manage = canManageVoice(chat);
  if (!rooms.length && !manage) return;

  refs.voiceSection.append(el('div', { class: 'voice-head' },
    icon('speaker', 14),
    el('span', null, 'Голосовые каналы'),
    rooms.length ? el('span', { class: 'voice-head__count' }, String(rooms.length)) : null,
    manage ? el('button', {
      class: 'voice-head__add', title: 'Создать голосовой канал',
      onclick: addVoiceRoomFlow,
    }, icon('plus', 13)) : null,
  ));

  const list = el('div', { class: 'voice-rooms' });
  for (const room of rooms) {
    const active = state.voice && state.voice.roomId === room.id;
    list.append(el('div', {
      class: 'voice-room' + (active ? ' voice-room--active' : ''),
      onclick: () => toggleVoiceRoom(room),
    },
      el('span', { class: 'voice-room__icon' }, icon('volume', 15)),
      el('span', { class: 'voice-room__name' }, room.name),
      el('span', { class: 'voice-room__parts' },
        room.participants.map((p) => el('span', {
          class: 'voice-part' + (p.muted ? ' voice-part--muted' : ''),
          title: voiceUserName(p.userId) + (p.muted ? ' · микрофон выключен' : ' · говорит'),
        }, avatar({ id: p.userId, name: voiceUserName(p.userId) }, { size: 22, dot: false }),
          p.muted ? el('span', { class: 'voice-part__mute' }, icon('micOff', 9)) : null)),
        room.participants.length === 0 && active ? el('span', { class: 'voice-part__solo' }, 'вы') : null,
      ),
      manage ? el('button', {
        class: 'voice-room__del', title: 'Удалить канал',
        onclick: (e) => { e.stopPropagation(); deleteVoiceRoomFlow(room); },
      }, icon('x', 12)) : null,
    ));
  }
  refs.voiceSection.append(list);
}

async function toggleVoiceRoom(room) {
  const v = state.voice;
  if (!v) return;
  if (v.roomId === room.id) {
    try { await v.leave(); } catch (_) { /* noop */ }
    return; // перерисуемся по событиям onEnded
  }
  try {
    await v.join(state.chatDetail.id, room.id, room.name);
    if (v.listenOnly) toast('Микрофон недоступен — вы вошли в режиме слушателя 🎧');
    renderVoiceSection();
    renderCallPanel();
  } catch (err) {
    toast(err.message || 'Не удалось подключиться к голосовому каналу', 'error');
  }
}

function addVoiceRoomFlow() {
  const input = el('input', { class: 'input', placeholder: 'Например: «Общий войс»', maxlength: '32', autocomplete: 'off' });
  const errEl = el('div', { class: 'field-error' });
  const btn = el('button', { class: 'btn btn--primary btn--block' }, 'Создать канал');
  const m = modal({
    title: 'Новый голосовой канал',
    content: el('div', { class: 'form' },
      mkFieldWrap('Название', input),
      el('div', { class: 'form__hint' }, 'Участники смогут заходить в канал и говорить друг с другом в реальном времени — как в Discord.'),
      errEl,
      btn,
    ),
  });
  async function submit() {
    const name = input.value.trim();
    if (!name) { errEl.textContent = 'Укажите название'; return; }
    btn.disabled = true;
    try {
      await api.post(`/api/chats/${state.chatDetail.id}/voice-rooms`, { name });
      const res = await api.get('/api/chats/' + state.chatDetail.id);
      state.chatDetail = res.chat;
      renderVoiceSection();
      m.close();
      toast('Голосовой канал «' + name + '» создан 🔊', 'success');
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false;
    }
  }
  btn.addEventListener('click', submit);
  setTimeout(() => input.focus(), 50);
}

async function deleteVoiceRoomFlow(room) {
  const ok = await confirmModal({
    title: 'Удалить голосовой канал?',
    text: '«' + room.name + '» исчезнет, а все участники будут отключены.',
    confirmLabel: 'Удалить',
  });
  if (!ok) return;
  try {
    await api.del(`/api/chats/${state.chatDetail.id}/voice-rooms/${room.id}`);
    if (state.voice && state.voice.roomId === room.id) {
      try { await state.voice.leave(); } catch (_) { /* noop */ }
    }
    const res = await api.get('/api/chats/' + state.chatDetail.id);
    state.chatDetail = res.chat;
    renderVoiceSection();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderCallPanel() {
  if (refs.callPanel) {
    refs.callPanel.remove();
    refs.callPanel = null;
  }
  state.callAvatars = {};
  const v = state.voice;
  if (!v || !v.active || !refs.root) return;

  const parts = [...(state.voiceRoomsLive.get(v.roomId) || new Map()).values()];
  if (!parts.some((p) => p.cid === v.cid)) {
    parts.push({ cid: v.cid, userId: state.user.id, muted: v.muted });
  }

  const users = el('div', { class: 'call-panel__users' });
  for (const p of parts) {
    const wrap = el('div', {
      class: 'call-avatar' + (p.muted ? ' call-avatar--muted' : ''),
      title: voiceUserName(p.userId),
    },
      avatar({ id: p.userId, name: voiceUserName(p.userId) }, { size: 38, dot: false }),
      p.muted ? el('span', { class: 'call-avatar__mute' }, icon('micOff', 11)) : null,
    );
    state.callAvatars[p.cid] = wrap;
    users.append(wrap);
  }

  const micBtn = el('button', {
    class: 'call-ctrl' + (v.muted && !v.listenOnly ? ' call-ctrl--active' : ''),
    title: v.listenOnly ? 'Микрофон недоступен' : (v.muted ? 'Включить микрофон' : 'Выключить микрофон'),
    onclick: async () => {
      if (v.listenOnly) { toast('Микрофон недоступен — режим слушателя', 'error'); return; }
      await v.setMuted(!v.muted);
      renderCallPanel();
    },
  }, icon(v.muted || v.listenOnly ? 'micOff' : 'mic', 18));

  refs.callPanel = el('div', { class: 'call-panel' },
    el('div', { class: 'call-panel__head' },
      icon('volume', 15),
      el('span', { class: 'call-panel__name' }, v.roomName || 'Голосовой канал'),
      el('span', { class: 'call-panel__count' },
        parts.length + ' ' + plural(parts.length, ['на связи', 'на связи', 'на связи'])),
    ),
    users,
    el('div', { class: 'call-panel__ctrls' },
      micBtn,
      el('button', {
        class: 'call-ctrl call-ctrl--danger', title: 'Покинуть канал',
        onclick: async () => { try { await v.leave(); } catch (_) { /* noop */ } },
      }, icon('x', 18)),
    ),
  );
  refs.root.append(refs.callPanel);
}

// ============================================================
//  Админ-панель
// ============================================================

function openAdminPanel() {
  const m = modal({ title: 'Админ-панель Pulse', wide: true });
  m.root.classList.add('overlay--admin');

  const tabsBar = el('div', { class: 'tabs tabs--admin' });
  const content = el('div', { class: 'admin__content' });
  m.body.append(tabsBar, content);

  const TABS = [
    ['overview', 'Обзор'],
    ['users', 'Пользователи'],
    ['chats', 'Чаты'],
    ['broadcast', 'Объявление'],
  ];
  const btns = {};
  const loaders = {};

  function switchTab(id) {
    for (const [tid, b] of Object.entries(btns)) b.classList.toggle('tab--active', tid === id);
    clear(content);
    loaders[id]();
  }
  for (const [id, label] of TABS) {
    btns[id] = el('button', { class: 'tab', type: 'button', onclick: () => switchTab(id) }, label);
    tabsBar.append(btns[id]);
  }

  loaders.overview = async () => {
    content.append(el('div', { class: 'picker-empty' }, 'Загрузка…'));
    try {
      const d = await api.get('/api/admin/overview');
      clear(content);
      const s = d.stats;
      content.append(el('div', { class: 'stat-grid' },
        statCard('user', s.users, 'Пользователей'),
        statCard('logo', s.online, 'В сети'),
        statCard('users', s.chats, 'Чатов'),
        statCard('send', s.messages, 'Сообщений'),
        statCard('volume', s.voice, 'В голосовых'),
        statCard('shield', s.admins, 'Админов'),
      ));
      content.append(el('div', { class: 'chatinfo__section-title', style: 'padding-left:2px' }, 'Новые пользователи'));
      const list = el('div', { class: 'admin-list' });
      for (const u of d.recent) {
        list.append(el('div', { class: 'admin-row' },
          avatar({ id: u.id, name: u.nickname, online: u.online }, { size: 36 }),
          el('div', { class: 'admin-row__info' },
            el('span', { class: 'admin-row__name' },
              u.nickname,
              u.isAdmin ? el('span', { class: 'badge badge--admin' }, 'админ') : null,
              u.banned ? el('span', { class: 'badge badge--banned' }, 'бан') : null),
            el('span', { class: 'admin-row__sub' }, '@' + u.username + ' · ' + u.email),
          ),
        ));
      }
      content.append(list);
    } catch (err) {
      clear(content);
      content.append(el('div', { class: 'picker-empty' }, err.message));
    }
  };

  loaders.users = async () => {
    content.append(el('div', { class: 'picker-empty' }, 'Загрузка…'));
    try {
      const d = await api.get('/api/admin/users');
      clear(content);
      const list = el('div', { class: 'admin-list' });
      for (const u of d.users) list.append(adminUserRow(u, () => switchTab('users')));
      content.append(list);
    } catch (err) {
      clear(content);
      content.append(el('div', { class: 'picker-empty' }, err.message));
    }
  };

  loaders.chats = async () => {
    content.append(el('div', { class: 'picker-empty' }, 'Загрузка…'));
    try {
      const d = await api.get('/api/admin/chats');
      clear(content);
      if (!d.chats.length) {
        content.append(el('div', { class: 'picker-empty' }, 'Чатов пока нет'));
        return;
      }
      const list = el('div', { class: 'admin-list' });
      for (const c of d.chats) {
        list.append(el('div', { class: 'admin-row' },
          avatar({ id: c.id, name: c.title || 'Чат', type: c.type }, { size: 40, typeIcon: true }),
          el('div', { class: 'admin-row__info' },
            el('span', { class: 'admin-row__name' }, c.title || 'Чат',
              el('span', { class: 'badge badge--type' },
                c.type === 'dialog' ? 'личный' : c.type === 'channel' ? 'канал' : 'группа')),
            el('span', { class: 'admin-row__sub' },
              c.memberCount + ' ' + plural(c.memberCount, ['участник', 'участника', 'участников']) +
              ' · ' + c.messageCount + ' ' + plural(c.messageCount, ['сообщение', 'сообщения', 'сообщений']) +
              (c.voiceRooms ? ' · 🔊 ' + c.voiceRooms : '') +
              ' · ' + fmtListTime(c.lastActivity)),
          ),
          el('button', {
            class: 'btn btn--sm btn--danger',
            onclick: async () => {
              const ok = await confirmModal({
                title: 'Удалить чат?',
                text: '«' + (c.title || 'Чат') + '» будет удалён вместе с историей.',
                confirmLabel: 'Удалить',
              });
              if (!ok) return;
              try {
                await api.del('/api/admin/chats/' + c.id);
                switchTab('chats');
                loadChats();
              } catch (err) { toast(err.message, 'error'); }
            },
          }, 'Удалить'),
        ));
      }
      content.append(list);
    } catch (err) {
      clear(content);
      content.append(el('div', { class: 'picker-empty' }, err.message));
    }
  };

  loaders.broadcast = () => {
    const ta = el('textarea', {
      class: 'input input--area',
      placeholder: 'Текст объявления — он появится в канале «Pulse · Новости» у всех пользователей',
      maxlength: '2000',
    });
    const btn = el('button', { class: 'btn btn--primary' }, icon('megaphone', 16), 'Отправить объявление');
    btn.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text) { toast('Введите текст объявления', 'error'); return; }
      btn.disabled = true;
      try {
        await api.post('/api/admin/broadcast', { text });
        ta.value = '';
        toast('Объявление отправлено 📣', 'success');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
    content.append(
      el('p', { class: 'modal__text' }, 'Объявление публикуется от имени Pulse в официальном канале новостей и мгновенно доставляется всем пользователям.'),
      ta,
      el('div', { class: 'modal__actions' }, btn),
    );
  };

  switchTab('overview');
}

function statCard(ic, value, label) {
  return el('div', { class: 'stat-card' },
    el('span', { class: 'stat-card__icon' }, icon(ic, 18)),
    el('span', { class: 'stat-card__value' }, String(value)),
    el('span', { class: 'stat-card__label' }, label),
  );
}

function adminUserRow(u, refresh) {
  const isMe = u.id === state.user.id;
  const isCoffin = u.username === 'coffin';
  const actions = el('div', { class: 'admin__actions' });

  if (!isMe && !isCoffin) {
    if (u.banned) {
      actions.append(el('button', {
        class: 'btn btn--sm btn--ghost',
        onclick: async () => { try { await api.post(`/api/admin/users/${u.id}/unban`); refresh(); } catch (err) { toast(err.message, 'error'); } },
      }, 'Разбанить'));
    } else if (!u.isAdmin) {
      actions.append(el('button', {
        class: 'btn btn--sm btn--danger',
        onclick: async () => {
          const ok = await confirmModal({
            title: 'Заблокировать пользователя?',
            text: u.nickname + ' потеряет доступ к мессенджеру.',
            confirmLabel: 'Заблокировать',
          });
          if (!ok) return;
          try { await api.post(`/api/admin/users/${u.id}/ban`); refresh(); } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Бан'));
    }
    if (!u.isAdmin) {
      actions.append(el('button', {
        class: 'btn btn--sm btn--ghost',
        onclick: async () => { try { await api.post(`/api/admin/users/${u.id}/promote`); refresh(); } catch (err) { toast(err.message, 'error'); } },
      }, 'Выдать админа'));
    } else {
      actions.append(el('button', {
        class: 'btn btn--sm btn--ghost',
        onclick: async () => { try { await api.post(`/api/admin/users/${u.id}/demote`); refresh(); } catch (err) { toast(err.message, 'error'); } },
      }, 'Снять админа'));
    }
  }

  return el('div', { class: 'admin-row' },
    avatar({ id: u.id, name: u.nickname, online: u.online }, { size: 40 }),
    el('div', { class: 'admin-row__info' },
      el('span', { class: 'admin-row__name' },
        u.nickname + (isMe ? ' (вы)' : ''),
        u.isAdmin ? el('span', { class: 'badge badge--admin' }, isCoffin ? 'главный админ' : 'админ') : null,
        u.banned ? el('span', { class: 'badge badge--banned' }, 'заблокирован') : null,
        u.online ? el('span', { class: 'badge badge--online' }, 'онлайн') : null),
      el('span', { class: 'admin-row__sub' }, '@' + u.username + ' · ' + u.email),
    ),
    actions,
  );
}

// ============================================================
//  Утилиты
// ============================================================

function plural(n, forms) {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (d > 1 && d < 5) return forms[1];
  if (d === 1) return forms[0];
  return forms[2];
}

function genCid() {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch (_) { /* noop */ }
  return 'cid-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

