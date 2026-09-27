// Голосовые каналы Pulse: аудио через СЕРВЕР (WebSocket-релей PCM).
// Захват: AudioWorklet -> Int16 PCM 24кГц пакетами ~50мс.
// Воспроизведение: очереди AudioBuffer на каждый участника + джиттер-буфер.

import { getToken } from './api.js';

const SAMPLE_RATE = 24000;
const CHUNK_SAMPLES = 1200;        // 50 мс при 24 кГц
const JITTER_SEC = 0.14;           // буфер воспроизведения
const SPEAK_THRESHOLD = 15;        // RMS-порог «говорит»
const LEVEL_EVERY_MS = 120;

const WORKLET_SRC = `
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.muted = false;
    this.chunk = new Int16Array(${CHUNK_SAMPLES});
    this.fill = 0;
    this.port.onmessage = (e) => { if (e.data.type === 'mute') this.muted = e.data.muted; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        if (this.fill >= this.chunk.length) {
          if (!this.muted) this.port.postMessage(this.chunk, [this.chunk.buffer]);
          this.chunk = new Int16Array(${CHUNK_SAMPLES});
          this.fill = 0;
        }
        const s = Math.max(-1, Math.min(1, ch[i]));
        this.chunk[this.fill++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PCMCapture);
`;

let workletURL = null;
function getWorkletURL() {
  if (!workletURL) {
    workletURL = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
  }
  return workletURL;
}

function rms16(pcm) {
  let sum = 0;
  const step = Math.max(1, Math.floor(pcm.length / 64));
  let n = 0;
  for (let i = 0; i < pcm.length; i += step) {
    const v = pcm[i] / 32768;
    sum += v * v;
    n++;
  }
  return Math.sqrt(sum / Math.max(1, n)) * 100;
}

/**
 * VoiceClient — одно голосовое соединение на вкладку.
 * hooks: onPeersChanged, onLevels(levelsMap), onKicked, onEnded
 */
export class VoiceClient {
  constructor(cid, hooks = {}) {
    this.cid = cid;
    this.hooks = hooks;
    this.roomId = null;
    this.chatId = null;
    this.roomName = '';
    this.muted = false;
    this.listenOnly = false;
    this.localStream = null;
    this.ws = null;
    this.ctx = null;
    this.captureNode = null;
    this.silentGain = null;
    this.playback = new Map(); // cid -> { nextTime }
    this._levels = {};
    this._levelsAt = 0;
    this._leaving = false;
  }

  get active() {
    return !!this.roomId;
  }

  async join(chatId, roomId, roomName) {
    if (this.roomId === roomId) return;
    if (this.roomId) await this.leave();

    if (typeof WebSocket === 'undefined') {
      throw new Error('Ваш браузер не поддерживает WebSocket');
    }

    // микрофон (не обязателен — можно слушать)
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      this.listenOnly = false;
    } catch (_) {
      this.localStream = null;
      this.listenOnly = true;
    }

    // аудиоконтекст на 24 кГц (если браузер позволит)
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      throw new Error('Ваш браузер не поддерживает Web Audio');
    }
    try {
      this.ctx = new Ctx({ sampleRate: SAMPLE_RATE });
    } catch (_) {
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => { /* noop */ });

    // WebSocket-соединение с голосовым сервером
    await new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = proto + '//' + location.host + '/voice' +
        '?token=' + encodeURIComponent(getToken() || '') +
        '&roomId=' + encodeURIComponent(roomId) +
        '&cid=' + encodeURIComponent(this.cid);
      try {
        this.ws = new WebSocket(url);
      } catch (_) {
        reject(new Error('Не удалось открыть голосовое соединение'));
        return;
      }
      this.ws.binaryType = 'arraybuffer';

      const timer = setTimeout(() => {
        reject(new Error('Голосовой сервер не ответил'));
        this._closeWs();
      }, 8000);

      let settled = false;
      this.ws.onmessage = (e) => {
        if (typeof e.data !== 'string') {
          this._onAudio(e.data);
          return;
        }
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        if (msg.type === 'joined' && !settled) {
          settled = true;
          clearTimeout(timer);
          this.roomId = roomId;
          this.chatId = chatId;
          this.roomName = roomName || '';
          resolve();
        }
      };
      this.ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Ошибка голосового соединения'));
        }
      };
      this.ws.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Голосовое соединение закрыто'));
          return;
        }
        // соединение рвалось уже после входа
        if (this.roomId) {
          const kicked = !this._leaving;
          this._cleanupLocal();
          if (kicked && this.hooks.onKicked) this.hooks.onKicked();
          if (this.hooks.onEnded) this.hooks.onEnded();
        }
      };
    });

    this._startCapture();
    if (this.hooks.onPeersChanged) this.hooks.onPeersChanged();
    if (this.listenOnly) {
      // сообщаем серверу, что мы без микрофона (мьют-состояние)
      this._sendCmd({ type: 'mute', muted: true });
      this.muted = true;
    }
    return true;
  }

  async leave() {
    if (!this.roomId && !this.ws) return;
    this._leaving = true;
    this._closeWs();
    this._cleanupLocal();
  }

  async setMuted(muted) {
    this.muted = !!muted;
    if (this.captureNode && this.captureNode.port) {
      try { this.captureNode.port.postMessage({ type: 'mute', muted: this.muted }); } catch (_) { /* noop */ }
    }
    this._sendCmd({ type: 'mute', muted: this.muted });
    if (this.hooks.onPeersChanged) this.hooks.onPeersChanged();
  }

  _sendCmd(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch (_) { /* noop */ }
    }
  }

  // ---------- захват ----------

  async _startCapture() {
    if (!this.localStream || !this.ctx) return;
    try {
      const source = this.ctx.createMediaStreamSource(this.localStream);
      // узел должен быть в графе до destination, иначе не тянется
      this.silentGain = this.ctx.createGain();
      this.silentGain.gain.value = 0;
      this.silentGain.connect(this.ctx.destination);

      if (this.ctx.audioWorklet) {
        await this.ctx.audioWorklet.addModule(getWorkletURL());
        this.captureNode = new AudioWorkletNode(this.ctx, 'pcm-capture', { numberOfOutputs: 1 });
        this.captureNode.port.onmessage = (e) => this._onOutgoingPcm(e.data);
        source.connect(this.captureNode);
        this.captureNode.connect(this.silentGain);
      } else {
        // запасной вариант для старых браузеров
        const proc = this.ctx.createScriptProcessor(4096, 1, 1);
        let buf = new Int16Array(CHUNK_SAMPLES);
        let fill = 0;
        proc.onaudioprocess = (ev) => {
          const ch = ev.inputBuffer.getChannelData(0);
          for (let i = 0; i < ch.length; i++) {
            if (fill >= buf.length) {
              if (!this.muted) this._onOutgoingPcm(buf);
              buf = new Int16Array(CHUNK_SAMPLES);
              fill = 0;
            }
            const s = Math.max(-1, Math.min(1, ch[i]));
            buf[fill++] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
        };
        this.captureNode = proc;
        source.connect(proc);
        proc.connect(this.silentGain);
      }
    } catch (_) {
      this.listenOnly = true;
    }
  }

  _onOutgoingPcm(pcm) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this._emitLevel(this.cid, rms16(pcm));
    try { this.ws.send(pcm.buffer); } catch (_) { /* noop */ }
  }

  // ---------- воспроизведение ----------

  _onAudio(arrayBuf) {
    if (!this.ctx || !this.roomId) return;
    const data = new Uint8Array(arrayBuf);
    if (data.length < 3) return;
    const cidLen = data[0];
    if (data.length < 1 + cidLen + 2) return;
    const cid = String.fromCharCode.apply(null, data.subarray(1, 1 + cidLen));
    if (cid === this.cid) return;
    const pcm = new Int16Array(arrayBuf, 1 + cidLen);

    // уровень речи для индикатора
    this._emitLevel(cid, rms16(pcm));

    // конвертация + ресемплинг под контекст
    const rs = this.ctx.sampleRate / SAMPLE_RATE;
    const outLen = Math.max(1, Math.round(pcm.length * rs));
    const buf = this.ctx.createBuffer(1, outLen, this.ctx.sampleRate);
    const out = buf.getChannelData(0);
    if (Math.abs(rs - 1) < 0.001) {
      for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
    } else {
      for (let i = 0; i < outLen; i++) {
        const pos = i / rs;
        const i0 = Math.floor(pos);
        const i1 = Math.min(pcm.length - 1, i0 + 1);
        const t = pos - i0;
        out[i] = (pcm[i0] / 32768) * (1 - t) + (pcm[i1] / 32768) * t;
      }
    }

    // планирование с джиттер-буфером
    let pb = this.playback.get(cid);
    if (!pb) {
      pb = { nextTime: 0 };
      this.playback.set(cid, pb);
    }
    const now = this.ctx.currentTime;
    if (pb.nextTime < now + JITTER_SEC) pb.nextTime = now + JITTER_SEC;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    try {
      src.start(pb.nextTime);
      pb.nextTime += buf.duration;
    } catch (_) { /* noop */ }
  }

  _emitLevel(cid, level) {
    this._levels[cid] = level > SPEAK_THRESHOLD;
    const now = Date.now();
    if (now - this._levelsAt > LEVEL_EVERY_MS) {
      this._levelsAt = now;
      if (this.hooks.onLevels) this.hooks.onLevels({ ...this._levels });
    }
  }

  // ---------- очистка ----------

  _closeWs() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) { /* noop */ }
      this.ws = null;
    }
  }

  _cleanupLocal() {
    if (this.captureNode) {
      try { this.captureNode.disconnect(); } catch (_) { /* noop */ }
      this.captureNode = null;
    }
    if (this.silentGain) {
      try { this.silentGain.disconnect(); } catch (_) { /* noop */ }
      this.silentGain = null;
    }
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) {
        try { t.stop(); } catch (_) { /* noop */ }
      }
      this.localStream = null;
    }
    if (this.ctx) {
      try { this.ctx.close(); } catch (_) { /* noop */ }
      this.ctx = null;
    }
    this.playback.clear();
    this._levels = {};
    this.roomId = null;
    this.chatId = null;
    this.roomName = '';
    this.muted = false;
    this.listenOnly = false;
    this._leaving = false;
    if (this.hooks.onEnded) this.hooks.onEnded();
  }
}
