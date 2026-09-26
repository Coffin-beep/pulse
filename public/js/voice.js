// Голосовые каналы Pulse (Discord-style): WebRTC-меш + сигналинг через сервер

import { api } from './api.js';

const ICE_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

const SPEAK_THRESHOLD = 16; // RMS-порог «говорит»

/**
 * VoiceClient — один активный голосовой канал на вкладку.
 * hooks: onEnded, onKicked, onPeersChanged, onLevels(levelsMap)
 */
export class VoiceClient {
  constructor(cid, hooks = {}) {
    this.cid = cid;
    this.hooks = hooks;
    this.roomId = null;
    this.chatId = null;
    this.roomName = '';
    this.localStream = null;
    this.listenOnly = false;
    this.muted = false;
    this.peers = new Map(); // cid -> { pc, userId, stream, audio }
    this.audioCtx = null;
    this.analysers = new Map(); // cid -> { analyser, buf }
    this._raf = null;
  }

  get active() {
    return !!this.roomId;
  }

  async join(chatId, roomId, roomName) {
    if (this.roomId === roomId) return;
    if (this.roomId) await this.leave();
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('Ваш браузер не поддерживает WebRTC');
    }

    // микрофон (не обязателен — можно зайти слушателем)
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.listenOnly = false;
    } catch (_) {
      this.localStream = null;
      this.listenOnly = true;
    }

    const res = await api.post(`/api/voice/${roomId}/join`, { cid: this.cid });
    this.roomId = roomId;
    this.chatId = res.chatId;
    this.roomName = roomName || '';
    this.muted = false;

    // подключаемся ко всем, кто уже в комнате (мы инициируем offer)
    for (const p of res.peers) {
      this._makePeer(p.cid, p.userId, true);
    }
    this._startLevels();
    if (this.hooks.onPeersChanged) this.hooks.onPeersChanged();
    return res;
  }

  async leave() {
    const roomId = this.roomId;
    this._cleanup();
    if (roomId) {
      try { await api.post(`/api/voice/${roomId}/leave`, { cid: this.cid }); } catch (_) { /* noop */ }
    }
  }

  async setMuted(muted) {
    this.muted = !!muted;
    if (this.localStream) {
      for (const t of this.localStream.getAudioTracks()) t.enabled = !this.muted;
    }
    if (this.roomId) {
      try {
        await api.post(`/api/voice/${this.roomId}/state`, { cid: this.cid, muted: this.muted });
      } catch (_) { /* noop */ }
    }
  }

  // ---------- сигналинг ----------

  async handleSignal(ev) {
    if (!this.roomId || ev.roomId !== this.roomId) return;
    const from = ev.from;
    const data = ev.data || {};
    let peer = this.peers.get(from);

    try {
      if (data.kind === 'offer') {
        if (!peer) peer = this._makePeer(from, ev.userId, false);
        await peer.pc.setRemoteDescription(data.sdp);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        await this._signal(from, { kind: 'answer', sdp: peer.pc.localDescription });
      } else if (data.kind === 'answer' && peer) {
        if (peer.pc.signalingState !== 'stable') {
          await peer.pc.setRemoteDescription(data.sdp);
        }
      } else if (data.kind === 'ice' && peer) {
        await peer.pc.addIceCandidate(data.candidate);
      }
    } catch (_) { /* битый кандидат/ошибка renegotiation — переживаем */ }
  }

  handleVoiceState(ev) {
    if (ev.action === 'kick' && ev.connId === this.cid) {
      this._cleanup();
      if (this.hooks.onKicked) this.hooks.onKicked();
      return;
    }
    if (!this.roomId || ev.roomId !== this.roomId) return;
    if (ev.action === 'leave' && ev.connId !== this.cid) {
      this._dropPeer(ev.connId);
      if (this.hooks.onPeersChanged) this.hooks.onPeersChanged();
    }
    // join от других: они сами пришлют offer, ничего не делаем
  }

  async _signal(to, data) {
    if (!this.roomId) return;
    try {
      await api.post(`/api/voice/${this.roomId}/signal`, { cid: this.cid, to, data });
    } catch (_) { /* партнёр мог выйти */ }
  }

  // ---------- WebRTC ----------

  _makePeer(peerCid, userId, initiator) {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    const peer = { pc, userId, stream: null, audio: null };
    this.peers.set(peerCid, peer);

    if (this.localStream) {
      for (const t of this.localStream.getAudioTracks()) pc.addTrack(t, this.localStream);
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this._signal(peerCid, { kind: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      peer.stream = e.streams[0];
      this._attachAudio(peerCid, peer.stream);
      if (this.hooks.onPeersChanged) this.hooks.onPeersChanged();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this._dropPeer(peerCid);
        if (this.hooks.onPeersChanged) this.hooks.onPeersChanged();
      }
    };

    if (initiator) {
      pc.createOffer().then(async (offer) => {
        await pc.setLocalDescription(offer);
        await this._signal(peerCid, { kind: 'offer', sdp: pc.localDescription.toJSON() });
      }).catch(() => this._dropPeer(peerCid));
    }
    return peer;
  }

  _dropPeer(peerCid) {
    const peer = this.peers.get(peerCid);
    if (!peer) return;
    this.peers.delete(peerCid);
    try { peer.pc.close(); } catch (_) { /* noop */ }
    if (peer.audio) {
      try { peer.audio.pause(); peer.audio.srcObject = null; peer.audio.remove(); } catch (_) { /* noop */ }
    }
    this.analysers.delete(peerCid);
  }

  _attachAudio(peerCid, stream) {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.srcObject = stream;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    audio.play().catch(() => { /* автоплей может отклониться до жеста — повторим при клике */ });
    audio.addEventListener('click', () => audio.play().catch(() => { /* noop */ }));
    const peer = this.peers.get(peerCid);
    if (peer) peer.audio = audio;
    this._makeAnalyser(peerCid, stream);
  }

  // ---------- индикация говорящего ----------

  _makeAnalyser(cid, stream) {
    try {
      if (!this.audioCtx) return;
      const src = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this.analysers.set(cid, { analyser, buf: new Uint8Array(analyser.fftSize) });
    } catch (_) { /* noop */ }
  }

  _startLevels() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.audioCtx = this.audioCtx || new Ctx();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => { /* noop */ });
      if (this.localStream) this._makeAnalyser(this.cid, this.localStream);
    } catch (_) { /* noop */ }

    const loop = () => {
      if (!this.roomId) return;
      const levels = {};
      let any = false;
      for (const [cid, { analyser, buf }] of this.analysers) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 4) {
          const v = buf[i] - 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / (buf.length / 4));
        levels[cid] = rms > SPEAK_THRESHOLD;
        any = true;
      }
      if (any && this.hooks.onLevels) this.hooks.onLevels(levels);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  // ---------- очистка ----------

  _cleanup() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    for (const cid of [...this.peers.keys()]) this._dropPeer(cid);
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) {
        try { t.stop(); } catch (_) { /* noop */ }
      }
      this.localStream = null;
    }
    this.analysers.clear();
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch (_) { /* noop */ }
      this.audioCtx = null;
    }
    this.roomId = null;
    this.chatId = null;
    this.roomName = '';
    this.muted = false;
    this.listenOnly = false;
    if (this.hooks.onEnded) this.hooks.onEnded();
  }
}
