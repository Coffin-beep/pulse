// API-клиент Pulse: fetch-обёртки + SSE

const TOKEN_KEY = 'pulse_token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (_) { /* noop */ }
}

export class ApiError extends Error {
  constructor(status, payload) {
    super((payload && payload.error) || 'Что-то пошло не так');
    this.status = status;
    this.field = (payload && payload.field) || null;
  }
}

async function request(method, path, body, opts = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  let payload;
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      payload = body;
      if (opts.contentType) headers['Content-Type'] = opts.contentType;
    } else {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
  }

  let res;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch (_) {
    throw new ApiError(0, { error: 'Нет соединения с сервером' });
  }

  let data = null;
  try { data = await res.json(); } catch (_) { /* пустой ответ */ }

  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith('/api/auth/')) {
      setToken(null);
      window.dispatchEvent(new CustomEvent('pulse:logout'));
    }
    throw new ApiError(res.status, data || {});
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body === undefined ? {} : body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
  postVoice: (path, blob, params) => {
    const qs = new URLSearchParams(params).toString();
    return request('POST', path + (qs ? '?' + qs : ''), blob, { contentType: blob.type || 'audio/webm' });
  },
};

// URL для медиафайлов (голосовые) с токеном
export function fileUrl(file) {
  if (!file) return '';
  const token = getToken();
  return file + (file.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token || '');
}

// Живые обновления через Server-Sent Events
export function connectEvents(onEvent) {
  let closed = false;
  let es = null;

  function connect() {
    if (closed) return;
    const token = getToken();
    if (!token) return;
    es = new EventSource('/api/events?token=' + encodeURIComponent(token));
    es.onmessage = (e) => {
      try { onEvent(JSON.parse(e.data)); } catch (_) { /* noop */ }
    };
    // EventSource переподключается сам; вручную — не надо
  }

  connect();

  return {
    close() {
      closed = true;
      if (es) es.close();
    },
    reconnect() {
      if (es) es.close();
      connect();
    },
  };
}
