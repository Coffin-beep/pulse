// UI-утилиты Pulse: DOM-хелперы, иконки, аватары, модалки, тосты, форматирование

// ---------- DOM ----------

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

// ---------- Иконки (feather-стиль, inline SVG) ----------

const ICONS = {
  logo: '<path d="M3 12h4l2-7 5 14 2-7h5"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><path d="M12 18v4"/>',
  play: '<path d="M7 4.5v15l13-7.5Z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="4" width="4" height="16" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="4" width="4" height="16" rx="1.2" fill="currentColor" stroke="none"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  x: '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checks: '<path d="M17 6 7 17l-4-4"/><path d="m22 10-7.5 7.5L12 15"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  megaphone: '<path d="M4 10v5h3l8 4V6l-8 4H4Z"/><path d="M18 9a4 4 0 0 1 0 6"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01"/><path d="M15 9h.01"/>',
  shield: '<path d="M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10Z"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  headphones: '<path d="M3 14v-3a9 9 0 0 1 18 0v3"/><path d="M3 14h4v7H5a2 2 0 0 1-2-2v-5Z"/><path d="M21 14h-4v7h2a2 2 0 0 0 2-2v-5Z"/>',
  micOff: '<path d="m2 2 20 20"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><path d="M12 19v3"/>',
  speaker: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
};

export function icon(name, size = 20, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

// ---------- Аватары ----------

const GRADS = [
  ['#7c3aed', '#c084fc'],
  ['#8b5cf6', '#6366f1'],
  ['#a855f7', '#ec4899'],
  ['#6d28d9', '#8b5cf6'],
  ['#9333ea', '#6366f1'],
  ['#7e22ce', '#c084fc'],
  ['#5b21b6', '#a78bfa'],
  ['#86198f', '#e879f9'],
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function gradFor(id) {
  return GRADS[hashStr(String(id || 'x')) % GRADS.length];
}

export function initialsOf(name) {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Аватар. entity: {id, name, online, type?}
 */
export function avatar(entity, opts = {}) {
  const size = opts.size || 48;
  const [c1, c2] = gradFor(entity && entity.id);
  const node = el('div', {
    class: 'avatar' + (opts.cls ? ' ' + opts.cls : ''),
    style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px;background:linear-gradient(135deg,${c1},${c2})`,
  }, initialsOf(entity && (entity.name || entity.nickname || entity.title)));

  if (entity && entity.online && opts.dot !== false) {
    node.appendChild(el('span', { class: 'avatar__dot' }));
  }

  if (opts.typeIcon && (entity.type === 'group' || entity.type === 'channel')) {
    node.appendChild(el('span', { class: 'avatar__type' }, icon(entity.type === 'channel' ? 'megaphone' : 'users', 10)));
  }
  return node;
}

// ---------- Время ----------

const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function fmtListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return fmtTime(ts);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'вчера';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function fmtDaySep(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
  const sameYear = d.getFullYear() === now.getFullYear();
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return sameYear ? base : `${base} ${d.getFullYear()}`;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------- Тосты ----------

let toastWrap = null;

export function toast(message, type = 'info') {
  if (!toastWrap) {
    toastWrap = el('div', { class: 'toasts' });
    document.body.appendChild(toastWrap);
  }
  const t = el('div', { class: 'toast toast--' + type }, message);
  toastWrap.appendChild(t);
  setTimeout(() => t.classList.add('toast--out'), 2600);
  setTimeout(() => t.remove(), 3000);
}

// ---------- Модалки ----------

const modalStack = [];

export function modal(opts = {}) {
  const { title = '', content, wide = false, onClose } = opts;

  const body = el('div', { class: 'modal__body' });
  if (content) appendTo(content, body);

  const close = () => {
    root.classList.add('overlay--out');
    setTimeout(() => root.remove(), 160);
    const i = modalStack.indexOf(api2);
    if (i !== -1) modalStack.splice(i, 1);
    if (onClose) onClose();
  };

  const api2 = { close, root: null };

  const head = el('div', { class: 'modal__head' },
    el('h3', { class: 'modal__title' }, title),
    el('button', { class: 'icon-btn modal__x', onclick: close }, icon('x', 18)),
  );

  const root = el('div', {
    class: 'overlay' + (wide ? ' overlay--wide' : ''),
    onclick: (e) => { if (e.target === root) close(); },
  },
    el('div', { class: 'modal' + (wide ? ' modal--wide' : '') }, head, body),
  );

  api2.root = root;
  modalStack.push(api2);
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add('overlay--in'));

  const onKey = (e) => {
    if (e.key === 'Escape' && modalStack[modalStack.length - 1] === api2) {
      close();
    }
  };
  document.addEventListener('keydown', onKey);
  const origClose = close;

  return { close: origClose, body, root };
}

function appendTo(content, target) {
  if (content instanceof Node) target.appendChild(content);
  else if (Array.isArray(content)) content.forEach((c) => appendTo(c, target));
  else if (content) target.appendChild(document.createTextNode(String(content)));
}

export function confirmModal({ title = 'Вы уверены?', text = '', confirmLabel = 'Удалить', danger = true }) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      onClose: () => resolve(false),
      content: el('div', {},
        text ? el('p', { class: 'modal__text' }, text) : null,
        el('div', { class: 'modal__actions' },
          el('button', { class: 'btn btn--ghost', onclick: () => { resolve(false); m.close(); } }, 'Отмена'),
          el('button', {
            class: 'btn ' + (danger ? 'btn--danger' : 'btn--primary'),
            onclick: () => { resolve(true); m.close(); },
          }, confirmLabel),
        ),
      ),
    });
  });
}

// ---------- Поповер ----------

export function popover(anchor, content, opts = {}) {
  const pop = el('div', { class: 'popover' + (opts.cls ? ' ' + opts.cls : '') });
  appendTo(content, pop);
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.visibility = 'hidden';
  pop.style.display = 'block';
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;

  let top = rect.bottom + 8;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 8);
  let left = opts.align === 'left' ? rect.left : rect.right - pw;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));

  pop.style.top = top + 'px';
  pop.style.left = left + 'px';
  pop.style.visibility = '';

  const onDocClick = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) {
      cleanup();
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') cleanup();
  };
  function cleanup() {
    pop.remove();
    document.removeEventListener('mousedown', onDocClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (opts.onClosed) opts.onClosed();
  }
  document.addEventListener('mousedown', onDocClick, true);
  document.addEventListener('keydown', onKey, true);
  return { close: cleanup, root: pop };
}
