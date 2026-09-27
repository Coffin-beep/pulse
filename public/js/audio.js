// Аудио Pulse: запись голосовых, расчёт волновой формы, плеер

import { el, icon, fmtDuration } from './ui.js';
import { fileUrl } from './api.js';

// ---------- Запись ----------

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) { /* noop */ }
  }
  return null;
}

export function recordingSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
}

export class VoiceRecorder {
  constructor() {
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.startedAt = 0;
    this.mime = pickMime();
  }

  get duration() {
    return Math.max(0, (Date.now() - this.startedAt) / 1000);
  }

  async start() {
    if (!recordingSupported()) throw new Error('Браузер не поддерживает запись звука');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.startedAt = Date.now();
    this.recorder.start(250);
  }

  stop() {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec || rec.state === 'inactive') {
        this.cleanup();
        resolve(new Blob(this.chunks, { type: this.mime || 'audio/webm' }));
        return;
      }
      rec.onstop = () => {
        this.cleanup();
        resolve(new Blob(this.chunks, { type: rec.mimeType || this.mime || 'audio/webm' }));
      };
      try { rec.stop(); } catch (_) {
        this.cleanup();
        resolve(new Blob(this.chunks, { type: this.mime || 'audio/webm' }));
      }
    });
  }

  cancel() {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.onstop = null;
        this.recorder.stop();
      }
    } catch (_) { /* noop */ }
    this.cleanup();
  }

  cleanup() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        try { t.stop(); } catch (_) { /* noop */ }
      }
      this.stream = null;
    }
  }
}

// ---------- Волновая форма ----------

export async function computePeaks(blob, bars = 48) {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData(arrayBuffer);
    const data = audio.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / bars));
    const peaks = [];
    for (let i = 0; i < bars; i++) {
      let max = 0;
      const start = i * step;
      const end = Math.min(start + step, data.length);
      for (let j = start; j < end; j += 8) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    const maxPeak = Math.max(...peaks, 0.001);
    return peaks.map((v) => Math.max(4, Math.round((v / maxPeak) * 100)));
  } catch (_) {
    return null;
  } finally {
    try { ctx.close(); } catch (_) { /* noop */ }
  }
}

export function pseudoPeaks(seed, bars = 48) {
  // детерминированные псевдо-пики, если настоящие не посчитались
  let h = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const out = [];
  for (let i = 0; i < bars; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    out.push(12 + (h % 70));
  }
  return out;
}

// ---------- Плеер ----------

let currentPlaying = null; // { pause: fn }

export function stopAllVoice() {
  if (currentPlaying) {
    try { currentPlaying.pause(); } catch (_) { /* noop */ }
    currentPlaying = null;
  }
}

export function createVoicePlayer(msg, opts = {}) {
  const mine = !!opts.mine;
  const duration = msg.duration || 0;
  const peaks = (msg.peaks && msg.peaks.length ? msg.peaks : pseudoPeaks(msg.file || msg.id));

  const playBtn = el('button', { class: 'voice__btn', type: 'button' }, icon('play', 16));
  const barsWrap = el('div', { class: 'voice__bars' });
  const bars = [];
  for (const p of peaks) {
    const bar = el('span', { class: 'voice__bar' });
    bar.style.height = Math.max(8, Math.min(100, p)) + '%';
    barsWrap.appendChild(bar);
    bars.push(bar);
  }
  const progress = el('div', { class: 'voice__progress' });
  const wave = el('div', { class: 'voice__wave' }, barsWrap, progress);
  const time = el('span', { class: 'voice__time' }, fmtDuration(duration));

  const root = el('div', { class: 'voice' + (mine ? ' voice--mine' : '') },
    playBtn, wave, time);

  const audio = new Audio(fileUrl(msg.file));
  audio.preload = 'metadata';
  let seeking = false;

  function setPlaying(on) {
    playBtn.classList.toggle('voice__btn--playing', on);
    playBtn.innerHTML = '';
    playBtn.appendChild(icon(on ? 'pause' : 'play', 16));
    if (on) {
      currentPlaying = { pause: () => { try { audio.pause(); } catch (_) { /* noop */ } } };
    }
  }

  playBtn.addEventListener('click', async () => {
    if (audio.paused) {
      stopAllVoice();
      try {
        await audio.play();
      } catch (_) {
        time.textContent = 'не удалось воспроизвести';
      }
    } else {
      audio.pause();
    }
  });

  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('pause', () => setPlaying(false));
  audio.addEventListener('ended', () => {
    setPlaying(false);
    audio.currentTime = 0;
    update(0);
  });
  audio.addEventListener('timeupdate', () => {
    if (!seeking) update(audio.currentTime);
  });

  function update(t) {
    const dur = (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration) || duration || 1;
    const frac = Math.max(0, Math.min(1, t / dur));
    progress.style.width = (frac * 100) + '%';
    for (let i = 0; i < bars.length; i++) {
      bars[i].classList.toggle('voice__bar--on', (i + 0.5) / bars.length <= frac);
    }
    time.textContent = fmtDuration(Math.max(0, dur - t));
  }

  wave.addEventListener('click', (e) => {
    const rect = wave.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration) || duration || 1;
    try {
      audio.currentTime = frac * dur;
    } catch (_) { /* noop */ }
    update(frac * dur);
  });

  return root;
}
