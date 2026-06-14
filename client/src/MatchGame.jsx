import React, { useState, useEffect, useRef } from 'react';
import CelebAvatar from './CelebAvatar.jsx';

// ─────────────────────────────────────────────────────────────
// THE MATCH GAME
// Three modes: 'home' | 'display' (TV/laptop) | 'phone' (contestant)
// ─────────────────────────────────────────────────────────────

const POLL_INTERVAL = 1500;
const VOICE_PROFILES = [
  { rate:0.95, pitch:1.1 }, { rate:1.0, pitch:0.85 },
  { rate:1.1, pitch:1.3 },  { rate:0.9, pitch:0.7 },
  { rate:1.05, pitch:1.0 }, { rate:0.92, pitch:0.95 },
];
const ANNOUNCER_PROFILE = { rate:1.06, pitch:1.18 };

// ─── API ──────────────────────────────────────────────────────
const req = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

const api = {
  createRoom:   (playerName, playerCount=2, soloTest=false) => req('/api/room', { method:'POST', body:{playerName, playerCount, soloTest} }),
  joinRoom:     (code, playerName, signMessage='', rolePreference='surprise', selfieData='') => req(`/api/room/${code}/join`, { method:'POST', body:{playerName, signMessage, rolePreference, selfieData} }),
  getRoom:      (code) => req(`/api/room/${code}`),
  pickPrompt:   (code, slot, choice) => req(`/api/room/${code}/pick-prompt`, { method:'POST', body:{slot,choice} }),
  submitAnswer: (code, slot, answer) => req(`/api/room/${code}/answer`, { method:'POST', body:{slot,answer} }),
  revealDone:   (code) => req(`/api/room/${code}/reveal-done`, { method:'POST' }),
  introDone:     (code) => req(`/api/room/${code}/intro-done`, { method:'POST' }),
  superMatchPick: (code, celebIndices) => req(`/api/room/${code}/supermatch-pick`, { method:'POST', body:{celebIndices} }),
  superMatchRevealNext: (code) => req(`/api/room/${code}/supermatch-reveal-next`, { method:'POST' }),
  superMatchCelebAnswer: (code, slot, answer) => req(`/api/room/${code}/supermatch-celeb-answer`, { method:'POST', body:{slot,answer} }),
  superMatchAnswer: (code, answer, source={type:'own'}) => req(`/api/room/${code}/supermatch-answer`, { method:'POST', body:{answer, sourceType:source.type, celebIndex:source.celebIndex} }),
  superMatchPromptRead: (code) => req(`/api/room/${code}/supermatch-prompt-read`, { method:'POST' }),
  finalMatchStart: (code) => req(`/api/room/${code}/finalmatch-start`, { method:'POST' }),
  finalMatchPick:  (code, celebIndex) => req(`/api/room/${code}/finalmatch-pick`, { method:'POST', body:{celebIndex} }),
  finalMatchAnswer:(code, answer) => req(`/api/room/${code}/finalmatch-answer`, { method:'POST', body:{answer} }),
  finalMatchPromptRead:(code) => req(`/api/room/${code}/finalmatch-prompt-read`, { method:'POST' }),
  finalMatchPickReady:(code) => req(`/api/room/${code}/finalmatch-pick-ready`, { method:'POST' }),
  finalMatchCelebAnswer:(code, slot, answer) => req(`/api/room/${code}/finalmatch-celeb-answer`, { method:'POST', body:{slot,answer} }),
  finalMatchDone:  (code) => req(`/api/room/${code}/finalmatch-done`, { method:'POST' }),
  roundEndDone:   (code) => req(`/api/room/${code}/round-end-done`, { method:'POST' }),
  superMatchLostDone: (code) => req(`/api/room/${code}/supermatch-lost-done`, { method:'POST' }),
  playAgain: (code) => req(`/api/room/${code}/play-again`, { method:'POST' }),
  creditsBits: () => fetch('/api/credits-bits').then(r => r.json()),
  speak: (params) => fetch('/api/speak', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(params) }),
};

// ─── SPEECH ───────────────────────────────────────────────────
let currentAudio = null;
let sharedAudioCtx = null;
const getAudioCtx = () => {
  try {
    sharedAudioCtx = sharedAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();
    return sharedAudioCtx;
  } catch { return null; }
};
const playAudience = () => {};
let thinkingMusicTimer = null;
let thinkingMusicAudio = null;
let introMusicAudio = null;
let creditsMusicAudio = null;
const THEME_TRACK = '/audio/match-game-73.mp3';
const REGULAR_TRACK = '/audio/regular-music.mp3';
const safePlayAudio = (audio) => audio.play().catch(() => {});
const fadeAndStop = (audio, ms = 450) => {
  if (!audio) return;
  const startVol = audio.volume || 0.01;
  const steps = 12;
  let n = 0;
  const id = setInterval(() => {
    n += 1;
    audio.volume = Math.max(0, startVol * (1 - n / steps));
    if (n >= steps) {
      clearInterval(id);
      try { audio.pause(); audio.currentTime = 0; } catch {}
    }
  }, Math.max(25, ms / steps));
};
const playRetroSting = () => {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  [392, 494, 587, 784, 988].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.12);
    gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.12 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + i * 0.12);
    osc.stop(now + i * 0.12 + 0.18);
  });
};
const startIntroMusic = () => {
  if (introMusicAudio) return;
  try {
    introMusicAudio = new Audio(THEME_TRACK);
    introMusicAudio.loop = true;
    introMusicAudio.volume = 0.14;
    safePlayAudio(introMusicAudio);
  } catch { playRetroSting(); }
};
const stopIntroMusic = () => {
  if (!introMusicAudio) return;
  fadeAndStop(introMusicAudio, 650);
  introMusicAudio = null;
};
const startCreditsMusic = () => {
  if (creditsMusicAudio) return;
  try {
    creditsMusicAudio = new Audio(THEME_TRACK);
    creditsMusicAudio.loop = true;
    creditsMusicAudio.volume = 0.16;
    safePlayAudio(creditsMusicAudio);
  } catch { playRetroSting(); }
};
const stopCreditsMusic = () => {
  if (!creditsMusicAudio) return;
  fadeAndStop(creditsMusicAudio, 650);
  creditsMusicAudio = null;
};
const startThinkingMusic = () => {
  if (thinkingMusicAudio || thinkingMusicTimer) return;
  try {
    thinkingMusicAudio = new Audio(REGULAR_TRACK);
    thinkingMusicAudio.loop = true;
    thinkingMusicAudio.volume = 0.28;
    thinkingMusicAudio.play().catch(() => {
      thinkingMusicAudio = null;
      startSyntheticThinkingMusic();
    });
  } catch { startSyntheticThinkingMusic(); }
};
const startSyntheticThinkingMusic = () => {
  if (thinkingMusicTimer) return;
  const tick = () => {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [261.63, 329.63, 392.0, 493.88].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.055, now + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.18);
      osc.stop(now + i * 0.18 + 0.18);
    });
  };
  tick();
  thinkingMusicTimer = setInterval(tick, 900);
};
const stopThinkingMusic = () => {
  if (thinkingMusicTimer) clearInterval(thinkingMusicTimer);
  thinkingMusicTimer = null;
  if (thinkingMusicAudio) {
    fadeAndStop(thinkingMusicAudio, 350);
    thinkingMusicAudio = null;
  }
};
const ttsCache = new Map();
const ttsKey = ({ text, code, slot, isAnnouncer }) => `${code || ''}|${slot ?? ''}|${isAnnouncer ? 'announcer' : 'panel'}|${text}`;
const prefetchTTS = (params) => {
  if (!params?.text) return Promise.resolve(null);
  const key = ttsKey(params);
  if (ttsCache.has(key)) return ttsCache.get(key);
  const promise = api.speak({
    text: params.text,
    code: params.code,
    slot: params.slot,
    isAnnouncer: params.isAnnouncer,
  }).then(res => {
    if (!res.ok) throw new Error('TTS failed');
    return res.blob();
  }).then(blob => URL.createObjectURL(blob))
    .catch(err => { ttsCache.delete(key); throw err; });
  ttsCache.set(key, promise);
  return promise;
};
const stopAudio = () => {
  if (currentAudio) { try { currentAudio.pause(); } catch{} currentAudio = null; }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
};

const speakBrowser = (text, profile) => new Promise(resolve => {
  if (!('speechSynthesis' in window)) { resolve(); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = profile.rate; u.pitch = profile.pitch;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length) {
    const en = voices.filter(v => v.lang.startsWith('en'));
    u.voice = (en.length ? en : voices)[0];
  }
  u.onend = resolve; u.onerror = resolve;
  window.speechSynthesis.speak(u);
});

const speakTTS = async (params) => {
  stopAudio();
  const { text, fallbackProfile } = params;
  const key = ttsKey(params);
  try {
    const url = await prefetchTTS(params);
    const audio = new Audio(url);
    audio.volume = 1.0;
    try {
      const ctx = getAudioCtx();
      if (ctx) {
        const src = ctx.createMediaElementSource(audio);
        const gain = ctx.createGain();
        gain.gain.value = params.isAnnouncer ? 1.18 : 1.35;
        src.connect(gain).connect(ctx.destination);
      }
    } catch {}
    currentAudio = audio;
    return new Promise(resolve => {
      const done = () => {
        if (currentAudio===audio) currentAudio=null;
        if (ttsCache.get(key)) {
          URL.revokeObjectURL(url);
          ttsCache.delete(key);
        }
        resolve();
      };
      audio.onended = done; audio.onerror = done;
      audio.play().catch(done);
    });
  } catch {
    return speakBrowser(text, fallbackProfile || ANNOUNCER_PROFILE);
  }
};

// ─── HELPERS ──────────────────────────────────────────────────
const slotSymbol = (room, slot) => !room?.triangleSlot ? '' : slot === room.triangleSlot ? '▲' : '●';
const slotClass  = (room, slot) => !room?.triangleSlot ? '' : slot === room.triangleSlot ? 'tri' : 'cir';
const fmt$ = (n) => `$${n.toLocaleString()}`;
const quickNorm = (s='') => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const quickCanon = (s='') => {
  let out = quickNorm(s);
  const groups = [
    ['tv','television','telly'], ['abs','muscles','muscle','six pack','sixpack'],
    ['beer','drink','drinks','booze','alcohol','liquor','wine','cocktail','beverage'],
    ['phone','cell','cellphone','mobile','iphone'], ['car','auto','vehicle','truck'],
    ['money','cash','bucks','dollars','cheque','check','paycheque','paycheck'], ['bathroom','toilet','washroom','restroom'],
  ];
  for (const group of groups) {
    for (const alias of group) out = out.replace(new RegExp(`\\b${quickNorm(alias).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'g'), group[0]);
  }
  return out;
};
const quickFuzzyMatch = (a,b) => {
  const x = quickCanon(a), y = quickCanon(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const tx = x.split(/\s+/).filter(Boolean);
  const ty = y.split(/\s+/).filter(Boolean);
  // Visual-only quick match should mirror server logic: a concise contestant
  // answer can be contained inside a longer celebrity answer, e.g. skills /
  // unbelievable skills, but not broad partial/associated word overlap.
  if (tx.length <= 2 && tx.every(w => w.length > 2)) {
    for (let i = 0; i <= ty.length - tx.length; i++) {
      if (tx.every((w, j) => ty[i + j] === w)) return true;
    }
  }
  if (tx.length === 1 && ty.length === 1) {
    const shorter = tx[0].length <= ty[0].length ? tx[0] : ty[0];
    const longer = tx[0].length <= ty[0].length ? ty[0] : tx[0];
    if (shorter.length >= 4 && longer.length >= shorter.length + 2 &&
        (longer.endsWith(shorter) || longer.startsWith(shorter))) return true;
  }
  return false;
};
const speechClean = (s='') => String(s || '')
  .replace(/\.{2,}|…+/g, ' ')
  .replace(/\bdot\s+dot(?:\s+dot)?\b/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const promptForSpeech = (s='') => {
  let text = speechClean(s).replace(/_+/g, ' __________ ').replace(/\s+/g, ' ').trim();
  const before = text.split('__________')[0] || '';
  const after = text.split('__________')[1] || '';
  const beforeWords = before.trim().split(/\s+/).filter(Boolean).length;
  const afterWords = after.replace(/[.,;:!?]/g, ' ').trim().split(/\s+/).filter(Boolean).length;

  // Sentence-style regular questions should end at the blank. If the generator
  // accidentally leaves words after it ("blank on"), do not read those words.
  // Short survey clues like "__________ Dog" or "Hot __________" are preserved.
  if (beforeWords > 3 && afterWords > 0) text = `${before.trim()} __________`;

  return text
    .replace(/\s*__________\s*/g, ' blank ')
    .replace(/[\s,.;:!?]*\bblank\b[\s,.;:!?]*/gi, ' blank ')
    .replace(/\s+/g, ' ')
    .trim();
};
const getCallbackOpening = (s='') => {
  const text = String(s || '').trim();
  const m = text.match(/^\s*((?:[A-Z][A-Za-z'’-]*)(?:\s+[A-Z][A-Za-z'’-]*)?\s+is\s+so\s+\w+)\b/i);
  return m ? m[1] : '';
};
const isCallbackPrompt = (s='') => Boolean(getCallbackOpening(s));
const readGamePrompt = async (prompt, roomCode) => {
  const text = String(prompt || '').trim();
  if (!isCallbackPrompt(text)) {
    await speakTTS({ text: promptForSpeech(text), isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
    return;
  }
  // Classic Match Game call-and-response: the host says the opening
  // ("Dumb Dora is so dumb!" / "Drunk Danny is so clumsy!") and pauses.
  // The people playing provide the callback; the host does not say it.
  const opening = getCallbackOpening(text);
  const rest = text.slice(text.toLowerCase().indexOf(opening.toLowerCase()) + opening.length).replace(/^,?\s*/,'').trim();
  await speakTTS({ text: `${opening}!`, isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
  await delay(1600);
  await speakTTS({ text: promptForSpeech(rest), isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
};

const PHASE_LABELS = {
  lobby: 'Waiting for players…',
  cointoss: 'Flipping the coin…',
  generating: 'Preparing the round…',
  pick_prompt: 'Choose your question!',
  answering: 'Fill in the blank!',
  generating_answers: 'Waiting for panelists to write down their answers…',
  revealing: 'Reveal!',
  round_end: 'Round complete…',
  tiebreaker: "It's a tie — tiebreaker round!",
  intro: 'Meet the panel!',
  superMatch_pickCelebs: 'Super Match — choose your celebrities!',
  superMatch_generating: 'Panel is preparing…',
  superMatch_human_answering: 'The stars are writing…',
  superMatch_revealing: 'The panel reveals…',
  superMatch_answering: 'Super Match — make your choice!',
  superMatch_won: 'Super Match complete!',
  superMatch_lost: 'Super Match complete.',
  finalMatch_generating: 'Final Match — generating prompt…',
  finalMatch_pickCeleb: 'Final Match — choose one celebrity!',
  finalMatch_answering: 'Final Match — writing answers…',
  finalMatch_generating_celeb: 'The celebrity is thinking…',
  finalMatch_human_celeb_answering: 'Final Match — celebrity is writing…',
  finalMatch_reveal: 'Final Match Reveal!',
  gameOver: 'Game Over!',
  error: 'Something went wrong.',
};

// ─── ROOT COMPONENT ───────────────────────────────────────────
export default function MatchGame() {
  const [mode, setMode] = useState('home'); // home | display | phone
  const [roomCode, setRoomCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [signMessage, setSignMessage] = useState('');
  const [rolePreference, setRolePreference] = useState('surprise');
  const [selfieData, setSelfieData] = useState('');
  const [playerSlot, setPlayerSlot] = useState(null);
  const [room, setRoom] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [joinFromQr, setJoinFromQr] = useState(false);
  const [playerCount, setPlayerCount] = useState(2);
  const [soloTest, setSoloTest] = useState(false);
  const pollRef = useRef(null);
  const lastVersionRef = useRef(null);

  // Poll room
  useEffect(() => {
    if (!roomCode || mode === 'home') return;
    const poll = async () => {
      try {
        const { room: r } = await api.getRoom(roomCode);
        if (r.version !== lastVersionRef.current) {
          lastVersionRef.current = r.version;
          setRoom(r);
        }
      } catch {}
    };
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(pollRef.current);
  }, [roomCode, mode]);

  useEffect(() => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }
  }, []);


  // QR/deep-link support: scanning the TV QR opens the phone directly to the name-entry screen.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const joinCode = (params.get('room') || params.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (joinCode) {
      setRoomCode(joinCode);
      setJoinFromQr(true);
    }
  }, []);

  // Display: auto-creates a room on mount, then watches for 2nd player and auto-starts coin toss
  const startAsDisplay = async () => {
    setLoading(true); setError('');
    try {
      // The Start Display click is a user gesture, so use it to prime browser audio before the QR screen appears.
      try { const ctx = getAudioCtx(); if (ctx?.state === 'suspended') ctx.resume(); } catch {}
      // Create room with a placeholder name for the display device
      const { room: r } = await api.createRoom('__display__', soloTest ? 1 : playerCount, soloTest);
      lastVersionRef.current = r.version;
      setRoomCode(r.code);
      setRoom(r);
      setMode('display');
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const handleSelfieFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxSide = 520;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        setSelfieData(canvas.toDataURL('image/jpeg', 0.78));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  const joinAsContestant = async () => {
    if (!playerName.trim()) { setError('Enter your name'); return; }
    if (roomCode.length !== 4) { setError('Enter the 4-letter room code'); return; }
    setLoading(true); setError('');
    try {
      const code = roomCode.toUpperCase();
      // Slot 1 is reserved for display — join as slot 2 or 3
      const { room: r, slot } = await api.joinRoom(code, playerName.trim(), signMessage.trim(), rolePreference, selfieData);
      setRoom(r); setPlayerSlot(slot);
      lastVersionRef.current = r.version;
      setRoomCode(code);
      setMode('phone');
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  if (mode === 'display') return <DisplayView room={room} roomCode={roomCode} setRoom={setRoom} />;
  if (mode === 'phone') return <PhoneView room={room} roomCode={roomCode} playerSlot={playerSlot} />;

  // ── HOME SCREEN ──
  return (
    <div className="mg-root">
      <div className="mg-card">
        <h1 className="mg-title">The<br/>Match Game</h1>
        <p className="mg-subtitle">— a family game show for 2–8 players —</p>
        {error && <div className="mg-error" onClick={()=>setError('')}>{error}</div>}

        {joinFromQr ? (
          <div className="mg-home-sections qr-join-only">
            <div className="mg-home-section qr-join-card">
              <div className="mg-home-section-title">🎮 Join the Match Game</div>
              <p className="mg-help">You scanned the TV QR code. Just enter your name.</p>
              <label className="mg-label">Your Name</label>
              <input className="mg-input" value={playerName}
                onChange={e=>setPlayerName(e.target.value)}
                placeholder="e.g. Jason" maxLength={20} autoFocus />
              <label className="mg-label">Your intro card</label>
              <input className="mg-input" value={signMessage}
                onChange={e=>setSignMessage(e.target.value)}
                placeholder="e.g. Hi Mom!" maxLength={32} />
              <label className="mg-label">What would you prefer?</label>
              <select className="mg-input" value={rolePreference} onChange={e=>setRolePreference(e.target.value)}>
                <option value="surprise">Surprise me</option>
                <option value="contestant">I'd rather be a contestant</option>
                <option value="celebrity">I'd rather be a celebrity</option>
              </select>
              <label className="mg-label">Optional panel photo</label>
              <div className="mg-photo-options">
                <label className="mg-photo-pick">
                  Take selfie
                  <input type="file" accept="image/*" capture="user"
                    onChange={e=>handleSelfieFile(e.target.files?.[0])} />
                </label>
                <label className="mg-photo-pick secondary">
                  Choose from photos
                  <input type="file" accept="image/*"
                    onChange={e=>handleSelfieFile(e.target.files?.[0])} />
                </label>
              </div>
              <p className="mg-help" style={{marginTop:6}}>Used only if you become a celebrity panelist.</p>
              {selfieData && <div className="mg-selfie-preview">
                <img src={selfieData} alt="Panel photo preview" />
                <button className="mg-linkbtn" type="button" onClick={()=>setSelfieData('')}>Remove photo</button>
              </div>}
              <div className="mg-row">
                <button className="mg-btn" onClick={joinAsContestant}
                  disabled={loading || !playerName.trim() || roomCode.length !== 4}>
                  {loading ? 'Joining…' : 'Join Game'}
                </button>
              </div>
              <button className="mg-linkbtn" onClick={()=>{ setJoinFromQr(false); window.history.replaceState({}, '', window.location.pathname); }}>
                I need to join a different game
              </button>
            </div>
          </div>
        ) : (
          <div className="mg-home-sections">
            {/* TV DISPLAY */}
            <div className="mg-home-section">
              <div className="mg-home-section-title">📺 TV Screen (Laptop)</div>
              <p className="mg-help">Open this on the laptop everyone can see. Everyone scans the QR code. The game randomly chooses 2 contestants and makes the rest celebrity panelists. Use Solo Test when you just want to test the flow alone.</p>
              <label className="mg-label">How many people are playing?</label>
              <select className="mg-input" value={playerCount} onChange={e=>setPlayerCount(Number(e.target.value))}>
                {[2,3,4,5,6,7,8].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <label className="mg-check" style={{marginTop:14}}><input type="checkbox" checked={soloTest} onChange={e=>setSoloTest(e.target.checked)} /> Solo test mode</label>
              <div className="mg-row" style={{marginTop:24}}>
                <button className="mg-btn secondary" onClick={startAsDisplay} disabled={loading}>
                  {loading ? 'Starting…' : 'Start Display'}
                </button>
              </div>
            </div>

            <div className="mg-home-divider">or</div>

            {/* CONTESTANT FALLBACK */}
            <div className="mg-home-section">
              <div className="mg-home-section-title">🎮 Contestant (Phone)</div>
              <p className="mg-help">Normally you can scan the QR code on the TV. Use this fallback only if scanning is not working.</p>
              <label className="mg-label">Your Name</label>
              <input className="mg-input" value={playerName}
                onChange={e=>setPlayerName(e.target.value)}
                placeholder="e.g. Gene" maxLength={20} />
              <label className="mg-label">Your intro card</label>
              <input className="mg-input" value={signMessage}
                onChange={e=>setSignMessage(e.target.value)}
                placeholder="e.g. Hi Mom!" maxLength={32} />
              <label className="mg-label">What would you prefer?</label>
              <select className="mg-input" value={rolePreference} onChange={e=>setRolePreference(e.target.value)}>
                <option value="surprise">Surprise me</option>
                <option value="contestant">I'd rather be a contestant</option>
                <option value="celebrity">I'd rather be a celebrity</option>
              </select>
              <label className="mg-label">Room Code</label>
              <input className="mg-input big" value={roomCode}
                onChange={e=>setRoomCode(e.target.value.toUpperCase().slice(0,4))}
                placeholder="ABCD" maxLength={4} />
              <div className="mg-row">
                <button className="mg-btn" onClick={joinAsContestant}
                  disabled={loading || !playerName.trim() || roomCode.length !== 4}>
                  Join Game
                </button>
              </div>
            </div>
          </div>
        )}

        <p className="mg-help" style={{marginTop:24}}>
          AI voices are generated by OpenAI — not real celebrity voices.
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// DISPLAY VIEW — the TV screen everyone watches
// ─────────────────────────────────────────────────────────────

const getJoinUrl = (roomCode) => {
  if (!roomCode || typeof window === 'undefined') return '';
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}?room=${encodeURIComponent(roomCode)}`;
};

const getQrSrc = (url) => url
  ? `https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=14&data=${encodeURIComponent(url)}`
  : '';

function DisplayView({ room, roomCode, setRoom }) {
  const prevPhaseRef = useRef(null);
  const prevVersionRef = useRef(null);
  const [revealIndex, setRevealIndex] = useState(-1);
  const [coinFlipping, setCoinFlipping] = useState(false);
  const [coinResult, setCoinResult] = useState(null);
  const [audioUnlocked, setAudioUnlocked] = useState(true);
  const [introIndex, setIntroIndex] = useState(-1);
  const [introStage, setIntroStage] = useState('waiting');
  const [introComplete, setIntroComplete] = useState(false);
  const [promptReadyFor, setPromptReadyFor] = useState(null);
  const [superPromptReady, setSuperPromptReady] = useState(false);
  const introRunRef = useRef(false);
  const turnPromptAnnouncedRef = useRef(null);
  const inheritedTurnAnnouncedRef = useRef(null);
  const revealRunRef = useRef(null);
  const pickPromptSpeechRef = useRef({ key: '', promise: Promise.resolve() });
  const finalMatchSpeechRef = useRef({ pick: '', answer: '' });

  const unlockAudio = () => {
    try {
      const ctx = getAudioCtx();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination); src.start(0); ctx.resume();
    } catch {}
    setAudioUnlocked(true);
  };

  useEffect(() => {
    if (!room || !audioUnlocked) return;
    if (room.version === prevVersionRef.current) return;
    prevVersionRef.current = room.version;
    const phase = room.phase;
    const prevPhase = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    // Play Again keeps the same TV component alive, so refs from the previous
    // game must be reset or the new intro/round flow can get stuck.
    if (phase === 'lobby' && ['gameOver','error'].includes(prevPhase)) {
      introRunRef.current = false;
      turnPromptAnnouncedRef.current = null;
      inheritedTurnAnnouncedRef.current = null;
      revealRunRef.current = null;
      pickPromptSpeechRef.current = { key: '', promise: Promise.resolve() };
      finalMatchSpeechRef.current = { pick: '', answer: '' };
      setIntroIndex(-1);
      setIntroStage('waiting');
      setIntroComplete(false);
      setPromptReadyFor(null);
      setSuperPromptReady(false);
      setRevealIndex(-1);
    }

    if (phase === 'intro' && prevPhase !== 'intro' && !introRunRef.current && room.panel?.length > 0) {
      introRunRef.current = true;
      runIntro(room);
    }
    if (phase === 'cointoss' && prevPhase !== 'cointoss') {
      setCoinFlipping(true); setCoinResult(null);
      setTimeout(() => {
        setCoinFlipping(false); setCoinResult(room.triangleSlot);
        if (room.triangleSlot)
          speakTTS({ text: `${room.players[room.triangleSlot]} wins the toss and plays first!`, isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
      }, 2500);
    }
    if (phase === 'pick_prompt') {
      setPromptReadyFor(null);
      const turnKey = `${room.round}-${room.turnInRound}-${room.activeSlot}`;
      if (turnPromptAnnouncedRef.current !== `${turnKey}-pick`) {
        turnPromptAnnouncedRef.current = `${turnKey}-pick`;
        const promise = speakTTS({
          text: `${room.players[room.activeSlot]}, it's your turn. Would you like Question A or B?`,
          isAnnouncer: true,
          fallbackProfile: ANNOUNCER_PROFILE,
        });
        // If the contestant taps A/B quickly, the question waits until this line finishes.
        pickPromptSpeechRef.current = { key: turnKey, promise };
      }
    }
    if (phase === 'answering' && room.chosenPrompt) {
      const turnKey = `${room.round}-${room.turnInRound}-${room.activeSlot}`;
      const answerKey = `${turnKey}-${room.chosenPrompt}`;
      if (promptReadyFor !== room.chosenPrompt) setPromptReadyFor(null);
      (async () => {
        const pendingPickSpeech = pickPromptSpeechRef.current;
        if (prevPhase === 'pick_prompt' && pendingPickSpeech?.key === turnKey) {
          await pendingPickSpeech.promise.catch(() => {});
          await delay(250);
        } else {
          await delay(350);
        }
        // If the player inherited the remaining question, announce their turn once here.
        if (prevPhase !== 'pick_prompt' && inheritedTurnAnnouncedRef.current !== answerKey) {
          inheritedTurnAnnouncedRef.current = answerKey;
          await speakTTS({ text: `${room.players[room.activeSlot]}, it's your turn.`, isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
          await delay(250);
        }
        if (promptReadyFor !== room.chosenPrompt) {
          await readGamePrompt(room.chosenPrompt, roomCode);
          setPromptReadyFor(room.chosenPrompt);
          startThinkingMusic();
        }
      })();
    }
    if (phase === 'revealing') {
      const revealKey = `${room.round}-${room.turnInRound}-${room.activeSlot}-${room.contestantAnswer || ''}-${room.version}`;
      if (revealRunRef.current !== revealKey) {
        revealRunRef.current = revealKey;
        setRevealIndex(-1); runReveal(room);
      }
    }
    // Regular-round thinking music should begin only after the host has finished reading
    // the question. It continues while answers are being collected/generated and stops
    // before reveals.
    if (['generating_answers','superMatch_generating','finalMatch_generating_celeb'].includes(phase)) startThinkingMusic();
    else if (phase !== 'answering') stopThinkingMusic();
    if (phase === 'tiebreaker' && prevPhase !== 'tiebreaker') {
      speakTTS({ text: "It's a tie! Scores reset — tiebreaker round!", isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
    }
    if (phase === 'round_end' && room.eliminatedSlot && room.eliminatedPartingGift && prevPhase !== 'round_end') {
      (async () => {
        const loserName = room.players?.[room.eliminatedSlot] || 'there';
        await speakTTS({
          text: `Well, ${loserName}, we have to say goodbye to you at this point, but we've got a lovely parting gift for you.`,
          isAnnouncer: true,
          fallbackProfile: ANNOUNCER_PROFILE,
        });
        await delay(350);
        await speakTTS({
          text: `${loserName} will receive ${room.eliminatedPartingGift}!`,
          isAnnouncer: true,
          fallbackProfile: { rate: 1.03, pitch: 1.15 },
        });
        await delay(500);
        try { await api.roundEndDone(roomCode); } catch {}
      })();
    }
    if (phase === 'superMatch_pickCelebs' && prevPhase !== 'superMatch_pickCelebs') {
      setSuperPromptReady(false);
      (async () => {
        await speakTTS({ text: `${room.players[room.activeSlot]}, you're moving on to the Super Match!`, isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
        await delay(250);
        await speakTTS({ text: `Time for the Super Match. We polled a recent studio audience and got their best responses to this.`, isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
        await delay(250);
        await readGamePrompt(room.superMatchPrompt, roomCode);
        await delay(250);
        await speakTTS({ text: `${room.players[room.activeSlot]}, you get to ask three celebrities for their advice. Which ones do you choose?`, isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
        try { await api.superMatchPromptRead(roomCode); } catch {}
        setSuperPromptReady(true);
      })();
    }
    if (phase === 'finalMatch_pickCeleb' && prevPhase !== 'finalMatch_pickCeleb') {
      const key = `${room.activeSlot}-${room.superMatchWinnings}`;
      if (finalMatchSpeechRef.current.pick !== key) {
        finalMatchSpeechRef.current.pick = key;
        (async () => {
          await speakTTS({
            text: `${room.players[room.activeSlot]}, you're now going to play for ${fmt$(Number(room.superMatchWinnings || 0) * 10)} by matching one celebrity exactly. Who do you choose?`,
            isAnnouncer: true,
            fallbackProfile: ANNOUNCER_PROFILE,
          });
          try { await api.finalMatchPickReady(roomCode); } catch {}
        })();
      }
    }
    if (phase === 'finalMatch_answering' && prevPhase !== 'finalMatch_answering' && room.finalMatchPrompt) {
      const key = `${room.activeSlot}-${room.finalMatchCelebIndex}-${room.finalMatchPrompt}`;
      if (finalMatchSpeechRef.current.answer !== key) {
        finalMatchSpeechRef.current.answer = key;
        (async () => {
          await delay(300);
          const chosen = room.panel?.[room.finalMatchCelebIndex]?.name || 'our celebrity';
          await speakTTS({ text: `${room.players[room.activeSlot]} has chosen ${chosen}.`, isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
          await delay(250);
          await speakTTS({ text: `Here's the question.`, isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
          await delay(200);
          await readGamePrompt(room.finalMatchPrompt, roomCode);
          try { await api.finalMatchPromptRead(roomCode); } catch {}
        })();
      }
    }
  }, [room?.version, audioUnlocked]);

  // Also run intro when audio gets unlocked if panel is already ready
  useEffect(() => {
    if (audioUnlocked && room?.phase === 'intro' && room?.panel?.length > 0 && !introRunRef.current) {
      introRunRef.current = true;
      runIntro(room);
    }
  }, [audioUnlocked]);

  const runIntro = async (r) => {
    setIntroComplete(false);
    setIntroStage('waiting');
    setIntroIndex(-1);
    await delay(500);
    startIntroMusic();
    await delay(500);
    await speakTTS({ text: "Get ready to match the stars!", isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
    await delay(450);
    // Classic opening: the announcer introduces exactly one star at a time.
    for (let i = 0; i < r.panel.length; i++) {
      setIntroStage('celeb');
      setIntroIndex(i);
      await delay(120);
      await speakTTS({ text: r.panel[i].name, isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
      playAudience(i % 2 === 0 ? 'applause' : 'cheer');
      await delay(950);
    }
    setIntroStage('finale');
    setIntroIndex(r.panel.length);
    await delay(250);
    await speakTTS({ text: 'As we play the star-studded Big Money... Match Game!', isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
    await delay(2200);
    stopIntroMusic();
    setIntroComplete(true);
    try { await api.introDone(roomCode); } catch {}
  };

  const runReveal = async (r) => {
    await Promise.all((r.panel || []).map((p, i) => p.answer ? prefetchTTS({
      text: speechClean(p.answer), code: roomCode, slot: i, fallbackProfile: VOICE_PROFILES[i % VOICE_PROFILES.length],
    }).catch(() => null) : Promise.resolve(null)));
    await delay(350);
    await speakTTS({
      text: `${r.players[r.activeSlot]} said, ${r.contestantAnswer}.`,
      isAnnouncer: true,
      fallbackProfile: ANNOUNCER_PROFILE,
    });
    await delay(350);
    for (let i = 0; i < r.panel.length; i++) {
      setRevealIndex(i);
      if (r.panel[i].answer) {
        await speakTTS({ text: speechClean(r.panel[i].answer), code: roomCode, slot: i, fallbackProfile: VOICE_PROFILES[i % VOICE_PROFILES.length] });
        if (r.matches?.[i]) playAudience('cheer');
        else playAudience(i % 2 === 0 ? 'chuckle' : 'groan');
        await delay(r.matches?.[i] ? 700 : 420);
      } else {
        await delay(150);
      }
    }
    try { await api.revealDone(roomCode); } catch {}
  };

  if (!room) return (
    <div className="mg-root display-mode" style={{alignItems:'center',justifyContent:'center'}}>
      <div className="mg-display-waiting"><h1 className="mg-title">The Match Game</h1><p className="mg-status">Connecting…</p></div>
    </div>
  );

  if (!audioUnlocked) return (
    <div className="mg-root display-mode" style={{cursor:'pointer'}} onClick={unlockAudio}>
      <div className="mg-display-waiting" style={{justifyContent:'center',alignItems:'center',flexDirection:'column',gap:24}}>
        <h1 className="mg-title">The<br/>Match Game</h1>
        <div style={{background:'var(--orange)',color:'var(--cream)',fontFamily:'Bowlby One,sans-serif',fontSize:28,padding:'24px 48px',border:'4px solid var(--brown)',boxShadow:'6px 6px 0 var(--brown)',letterSpacing:'0.08em',textAlign:'center'}}>
          TAP ANYWHERE TO BEGIN
        </div>
        <p className="mg-help" style={{fontSize:16}}>Tap once to enable audio — game starts automatically</p>
      </div>
    </div>
  );

  const phase = room.phase;
  if (phase === 'gameOver') {
    return <DisplayGameOver room={room} roomCode={roomCode} setRoom={setRoom} />;
  }

  const p1name = room.players[1] || '—';
  const p2name = room.soloTest ? 'Solo Test' : (room.players[2] || 'Waiting…');
  const isActive = (slot) => room.activeSlot === slot && ['pick_prompt','answering','generating_answers'].includes(phase);

  const activeStyle = (slot) => {
    if (!isActive(slot)) return {};
    const isTriangle = slot === room.triangleSlot;
    return isTriangle
      ? {background:'rgba(76,175,80,0.22)',borderTop:'5px solid var(--tri-green)',transition:'background 0.4s'}
      : {background:'rgba(211,47,47,0.22)',borderTop:'5px solid var(--cir-red)',transition:'background 0.4s'};
  };

  const displayScores = { ...(room.scores || {1:0,2:0}) };
  if (phase === 'revealing' && room.activeSlot && Array.isArray(room.matches)) {
    const liveMatches = room.matches.slice(0, Math.max(0, revealIndex + 1)).filter(Boolean).length;
    displayScores[room.activeSlot] = (displayScores[room.activeSlot] || 0) + liveMatches;
  }

  return (
    <div className="mg-root display-mode">
      <div className="mg-display-header">
        <div className="mg-display-contestant left" style={activeStyle(1)}>
          <div className="mg-contestant-score-block">
            <div className={`mg-contestant-score-shape ${slotClass(room,1) || 'tri'}`}>
              <span className="mg-contestant-num">{displayScores[1]}</span>
            </div>
            <div className="mg-contestant-name-side">{p1name}</div>
          </div>
        </div>
        <div className="mg-display-title-center">
          <div className="mg-display-show-title">The Match Game</div>
          <div className="mg-display-phase">{PHASE_LABELS[phase]||phase}</div>
          {room.round>0 && room.round<=2 && <div className="mg-display-round">Round {room.round}</div>}
          {room.round>2 && !phase.startsWith('superMatch') && !phase.startsWith('finalMatch') && phase!=='tiebreaker' && <div className="mg-display-round">Tiebreaker</div>}
          {phase==='tiebreaker' && <div className="mg-display-round" style={{color:'var(--pink)'}}>⚡ Tiebreaker!</div>}
          {phase.startsWith('superMatch') && <div className="mg-display-round super">★ Super Match ★</div>}
          {phase.startsWith('finalMatch') && <div className="mg-display-round final">★★ Final Match ★★</div>}
          <div className="mg-display-code">{['lobby','intro'].includes(phase) ? 'Scan QR to join' : ''}</div>
        </div>
        <div className="mg-display-contestant right" style={activeStyle(2)}>
          <div className="mg-contestant-score-block reverse">
            <div className="mg-contestant-name-side">{p2name}</div>
            <div className={`mg-contestant-score-shape ${slotClass(room,2) || 'cir'}`}>
              <span className="mg-contestant-num">{displayScores[2]}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mg-display-main">
        {(phase==='lobby'||phase==='intro') && (
          <div className="mg-display-center-msg">
            {phase === 'lobby' && (
              <>
                <p className="mg-status" style={{fontSize:22}}>Everyone scan this QR code with your phone</p>
                <div className="mg-qr-wrap">
                  <img className="mg-qr" src={getQrSrc(getJoinUrl(roomCode))} alt="QR code to join this Match Game room" />
                </div>
                <p className="mg-status">Joined: {Object.keys(room.participants || {}).length} / {room.maxPlayers || 2}</p>
                <p className="mg-help tiny-fallback">Fallback code: {roomCode}</p>
              </>
            )}
            {phase === 'intro' && !introComplete && <DisplayIntroSpotlight room={room} introIndex={introIndex} introStage={introStage} />}
            
          </div>
        )}
        {phase==='cointoss' && (
          <div className="mg-display-center-msg">
            <div className={`mg-coin ${coinFlipping?'flipping':''}`}>{coinFlipping||!coinResult?'?':(coinResult===room.triangleSlot?'▲':'●')}</div>
            {!coinFlipping&&coinResult&&<p className="mg-status" style={{fontSize:24}}><strong>{room.players[coinResult]}</strong> wins the toss and plays first!</p>}
          </div>
        )}
        {['generating','generating_answers','round_end','superMatch_generating','finalMatch_generating','finalMatch_generating_celeb','tiebreaker'].includes(phase) && (
          <div className="mg-display-center-msg">
            <div className="mg-loading">
              {phase==='generating'&&'Preparing questions'}
              {phase==='generating_answers'&&'Waiting for panelists to write down their answers'}
              {phase==='round_end'&&'Calculating scores'}
              {phase==='tiebreaker'&&"It's a tie — resetting scores"}
              {phase==='superMatch_generating'&&'Consulting the panel'}
              {phase==='superMatch_human_answering'&&'Waiting for the live stars'}
              {phase==='finalMatch_generating'&&'Preparing the Final Match'}
              {phase==='finalMatch_generating_celeb'&&`${room.panel[room.finalMatchCelebIndex]?.name} is writing an answer`}
            </div>
            <DisplayPanelGrid room={room} revealIndex={-1}/>
          </div>
        )}
        {['pick_prompt','answering'].includes(phase) && <DisplayRoundActive room={room} promptVisible={promptReadyFor === room.chosenPrompt}/>}
        {phase==='revealing' && <DisplayReveal room={room} revealIndex={revealIndex} roomCode={roomCode}/>}
        {phase==='superMatch_pickCelebs' && <DisplaySuperMatchPickCelebs room={room} promptVisible={superPromptReady}/>}
        {phase==='superMatch_revealing' && <DisplaySuperMatchReveal room={room} roomCode={roomCode} setRevealIndex={setRevealIndex}/>}
        {phase==='superMatch_answering' && <DisplaySuperMatchReveal room={room} roomCode={roomCode} setRevealIndex={setRevealIndex}/>}
        {['superMatch_won','superMatch_lost'].includes(phase) && <DisplaySuperMatchResult room={room} roomCode={roomCode}/>}
        {['finalMatch_pickCeleb','finalMatch_answering','finalMatch_human_celeb_answering'].includes(phase) && <DisplayFinalMatchActive room={room}/>}
        {phase==='finalMatch_reveal' && <DisplayFinalMatchReveal room={room} roomCode={roomCode}/>}
        {phase==='gameOver' && <DisplayGameOver room={room} roomCode={roomCode} setRoom={setRoom} />}
      </div>
    </div>
  );
}


function CelebVisual({ celeb, size = 100, className = '' }) {
  if (celeb?.imageUrl) {
    const width = Math.round(size * 0.9);
    const height = Math.round(size * 1.18);
    return (
      <img
        src={celeb.imageUrl}
        alt={celeb?.name || 'Celebrity'}
        className={`mg-celeb-photo ${className}`.trim()}
        style={{ width, height }}
      />
    );
  }
  return <CelebAvatar avatarType={celeb?.avatarType || 'man_middle'} size={size} />;
}

function DisplayIntroSpotlight({ room, introIndex, introStage }) {
  const p = room?.panel?.[introIndex];
  if (introStage === 'finale') {
    return (
      <div className="mg-intro-stage finale">
        <div className="mg-big-money-logo-wrap">
          <img className="mg-big-money-logo" src="/images/match-game-logo.png" alt="Match Game" />
        </div>
      </div>
    );
  }
  return (
    <div className="mg-intro-stage">
      {!p ? (
        <div className="mg-intro-waiting-dark" aria-label="Opening music" />
      ) : (
        <div className="mg-intro-card" key={introIndex}>
          <CelebVisual celeb={p} size={260} className="intro" />
          <div className="mg-intro-name">{p.name}</div>
          <div className="mg-intro-sign">{p.signMessage || 'Hi Mom!'}</div>
        </div>
      )}
    </div>
  );
}



function DisplayPanelGrid({ room, revealIndex, roomCode, matches, introIndex }) {
  const activeIsTriangle = room?.activeSlot === room?.triangleSlot;
  const round1MatchedByActive = room?.round >= 2
    ? (room?.round1Matches?.[room?.activeSlot] || [])
    : [];

  return (
    <div className="mg-panel-grid display">
      {(room?.panel || []).map((p, i) => {
        const shown = revealIndex != null && i <= revealIndex;
        const matched = matches && shown && matches[i];
        const prelit = round1MatchedByActive.includes(i);
        const litAsTriangle = (matched && activeIsTriangle) || (prelit && room?.triangleSlot === room?.activeSlot);
        const litAsCircle   = (matched && !activeIsTriangle) || (prelit && room?.triangleSlot !== room?.activeSlot);
        // (opacity handled inline via introIndex prop)
        return (
          <div key={i}
            className={`mg-panelist ${shown ? 'revealed' : ''} ${matched ? 'matched' : ''} ${prelit ? 'prelit' : ''}`}
            style={{
              opacity: introIndex === undefined ? 1 : (i <= introIndex ? 1 : 0),
              transform: introIndex === undefined ? 'scale(1)' : (i <= introIndex ? 'scale(1)' : 'scale(0.85)'),
              transition: 'opacity 0.35s ease-out, transform 0.35s ease-out'
            }}>
            <CelebVisual celeb={p} size={100} />
            <div className="mg-panelist-name">{p.name}</div>
            <div className={`mg-panelist-answer hand-${i % 6} ${shown ? 'blue-card' : 'blank'}`}>
              {shown ? (p.answer || (prelit ? 'Matched' : '')) : ''}
            </div>
            <div className="mg-symbol-row">
              <span className={`mg-symbol tri ${litAsTriangle ? 'lit' : ''}`}>▲</span>
              <span className={`mg-symbol cir ${litAsCircle ? 'lit' : ''}`}>●</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DisplayRoundActive({ room, promptVisible = true }) {
  const showPrompt = room.chosenPrompt && promptVisible;
  return (
    <div className="mg-display-round-active">
      {showPrompt
        ? <div className="mg-prompt">{room.chosenPrompt}</div>
        : <div className="mg-prompt muted">{room.chosenPrompt ? 'Listen carefully…' : 'Contestant is choosing their question…'}</div>}
      <DisplayPanelGrid room={room} revealIndex={-1} />
    </div>
  );
}

function DisplayReveal({ room, revealIndex, roomCode }) {
  return (
    <div className="mg-display-round-active">
      <div className="mg-prompt">{room.chosenPrompt}</div>
      <div className="mg-contestant-answer-display">
        <span style={{fontFamily:'Bowlby One,sans-serif',opacity:0.7}}>
          {room.players[room.activeSlot]} said:
        </span>
        {' '}<strong style={{fontSize:28}}>{room.contestantAnswer}</strong>
      </div>
      <DisplayPanelGrid room={room} revealIndex={revealIndex} roomCode={roomCode} matches={room.matches} />
    </div>
  );
}

function DisplaySuperMatchPickCelebs({ room, promptVisible = true }) {
  return (
    <div className="mg-display-center-msg">
      <div className="mg-display-round super" style={{fontSize:32,marginBottom:16}}>★ Super Match ★</div>
      <div className="mg-prompt">{promptVisible ? room.superMatchPrompt : 'Listen carefully…'}</div>
      <p className="mg-status" style={{fontSize:20}}>
        {promptVisible ? `${room.players[room.activeSlot]} — choose 3 celebrities on your phone!` : 'The Super Match question is coming up…'}
      </p>
      <DisplayPanelGrid room={room} revealIndex={-1} />
    </div>
  );
}

function DisplaySuperMatchReveal({ room, roomCode, setRevealIndex = () => {} }) {
  const doneRef = useRef(false);
  useEffect(() => {
    if (doneRef.current || room.phase === 'superMatch_answering') return;
    doneRef.current = true;
    runSuperReveal();
  }, []);

  const runSuperReveal = async () => {
    const indices = room.superMatchCelebIndices || [];
    const chosenNames = indices.map(i => room.panel?.[i]?.name).filter(Boolean);
    if (chosenNames.length) {
      const list = chosenNames.length === 3
        ? `${chosenNames[0]}, ${chosenNames[1]}, and ${chosenNames[2]}`
        : chosenNames.join(', ');
      await speakTTS({
        text: `${room.players[room.activeSlot]} has chosen ${list}.`,
        isAnnouncer: true,
        fallbackProfile: ANNOUNCER_PROFILE,
      });
      await delay(450);
    }
    await Promise.all(indices.map(panelIdx => prefetchTTS({
      text: room.panel[panelIdx]?.answer || '',
      code: roomCode, slot: panelIdx,
      fallbackProfile: VOICE_PROFILES[panelIdx % VOICE_PROFILES.length],
    }).catch(() => null)));
    for (let i = 0; i < indices.length; i++) {
      setRevealIndex(i);
      const panelIdx = indices[i];
      // Announce the celebrity name first
      await speakTTS({
        text: room.panel[panelIdx]?.name + ' says...',
        isAnnouncer: true,
        fallbackProfile: ANNOUNCER_PROFILE,
      });
      await delay(300);
      // Then their answer in their own voice
      await speakTTS({
        text: room.panel[panelIdx]?.answer || '',
        code: roomCode, slot: panelIdx,
        fallbackProfile: VOICE_PROFILES[panelIdx % VOICE_PROFILES.length],
      });
      playAudience(i % 2 === 0 ? 'applause' : 'chuckle');
      // Advance server-side reveal index so phone knows this celeb is done
      try { await api.superMatchRevealNext(roomCode); } catch {}
      await delay(600);
    }
  };

  const allRevealed = room.phase === 'superMatch_answering' || room.superMatchRevealIndex >= (room.superMatchCelebIndices?.length || 0) - 1;

  return (
    <div className="mg-display-center-msg">
      <div className="mg-prompt">{room.superMatchPrompt}</div>
      <div className="mg-super-celeb-grid">
        {(room.superMatchCelebIndices || []).map((panelIdx, i) => {
          const p = room.panel[panelIdx];
          const shown = i <= (room.superMatchRevealIndex ?? -1);
          return (
            <div key={i} className={`mg-super-celeb-card ${shown ? 'revealed' : ''}`}>
              <CelebVisual celeb={p} size={92} />
              <div className="mg-panelist-name">{p?.name}</div>
              <div className="mg-panelist-answer" style={{fontSize:28}}>
                {shown ? p?.answer : '???'}
              </div>
            </div>
          );
        })}
      </div>
      {allRevealed && (
        <p className="mg-status" style={{marginTop:16,fontSize:20}}>
          {room.players[room.activeSlot]} — make your choice on your phone!
        </p>
      )}
    </div>
  );
}

function Confetti() {
  return (
    <div className="mg-confetti" aria-hidden="true">
      {Array.from({length: 48}).map((_, i) => (
        <span key={i} style={{left:`${(i*37)%100}%`, animationDelay:`${(i%12)*0.08}s`}} />
      ))}
    </div>
  );
}

function DisplaySuperMatchResult({ room, roomCode }) {
  const topAnswers = [...(room.superMatchTopAnswers || [])].sort((a,b) => (a.value || 0) - (b.value || 0));
  const contestantAnswer = room.superMatchContestantAnswer;
  const winnings = room.superMatchWinnings;
  const [visibleCount, setVisibleCount] = useState(0);
  const [celebrated, setCelebrated] = useState(false);
  const [matchedValue, setMatchedValue] = useState(null);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    let cancelled = false;
    (async () => {
      await delay(500);
      const name = room.players[room.activeSlot] || 'Our contestant';
      const src = room.superMatchAnswerSource || { type: 'own' };
      if (src.type === 'celeb') {
        await speakTTS({
          text: `${name} has decided to go with ${src.celebName || 'a celebrity'}'s answer: ${speechClean(contestantAnswer)}.`,
          isAnnouncer: true,
          fallbackProfile: ANNOUNCER_PROFILE,
        });
      } else {
        await speakTTS({
          text: `${name} has decided to go with their own answer: ${speechClean(contestantAnswer)}.`,
          isAnnouncer: true,
          fallbackProfile: ANNOUNCER_PROFILE,
        });
      }
      await delay(450);
      let foundMatch = false;
      for (let i = 0; i < topAnswers.length; i++) {
        if (cancelled) return;
        const ta = topAnswers[i];
        playAudience('drumroll');
        await delay(450);
        await speakTTS({ text: `For ${fmt$(ta.value)}. ${speechClean(ta.answer)}`, isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
        setVisibleCount(i + 1);
        const isMatch = winnings > 0 && ta.value === winnings;
        if (isMatch) {
          foundMatch = true;
          setMatchedValue(ta.value);
          playAudience('win');
          setCelebrated(true);
          await speakTTS({ text: `It's a match! ${room.players[room.activeSlot]} wins ${fmt$(winnings)}!`, isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
          if (i < topAnswers.length - 1) {
            await delay(750);
            await speakTTS({ text: `But let's see the rest of the board!`, isAnnouncer: true, fallbackProfile: ANNOUNCER_PROFILE });
          }
        } else {
          playAudience(i === topAnswers.length - 1 ? 'groan' : 'applause');
        }
        await delay(750);
      }
      if (!cancelled && foundMatch && winnings > 0) {
        await delay(1800);
        if (!cancelled) {
          try { await api.finalMatchStart(roomCode); } catch {}
        }
      }
      if (!cancelled && winnings <= 0) {
        const name = room.players[room.activeSlot] || 'there';
        const gift = room.partingGift || 'a lovely parting gift from the prop department';
        await speakTTS({
          text: `Well ${name}, I'm sorry you didn't make a match, but I hope you had a good time. I think we have a parting gift for you anyway.`,
          isAnnouncer: true,
          fallbackProfile: ANNOUNCER_PROFILE,
        });
        await delay(400);
        await speakTTS({
          text: `${name} will receive ${gift}! Congratulations!`,
          isAnnouncer: true,
          fallbackProfile: { rate: 1.03, pitch: 1.15 },
        });
        await delay(1600);
        if (!cancelled) { try { await api.superMatchLostDone(roomCode); } catch { try { await api.finalMatchDone(roomCode); } catch {} } }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="mg-display-center-msg">
      {celebrated && <Confetti />}
      <div className="mg-prompt">{room.superMatchPrompt}</div>
      <p className="mg-status">{room.players[room.activeSlot]} chose: <strong>"{contestantAnswer}"</strong></p>
      <div className="mg-top-answers">
        {topAnswers.slice(0, visibleCount).map((ta, i) => {
          const isMatch = winnings > 0 && ta.value === winnings;
          return (
            <div key={i} className={`mg-top-answer ${isMatch ? 'matched' : ''}`}>
              <span className="mg-top-answer-value">{fmt$(ta.value)}</span>
              <span className="mg-top-answer-text">{ta.answer}</span>
            </div>
          );
        })}
      </div>
      {winnings > 0 && celebrated
        ? <div className="mg-super-win">
            <div className="mg-bigsymbol" style={{fontSize:72,color:'var(--tri-green)',textShadow:'0 0 24px currentColor'}}>MATCH!</div>
            <div>{fmt$(winnings)}!!!</div>
            {visibleCount < topAnswers.length
              ? <p className="mg-status" style={{fontSize:20,marginTop:12}}>Let's see the rest of the board...</p>
              : <p className="mg-status" style={{fontSize:20,marginTop:12}}>Moving on to the Final Match...</p>}
          </div>
        : visibleCount >= topAnswers.length && winnings <= 0
          ? <p className="mg-status" style={{fontSize:20}}>No match this time.</p>
          : <p className="mg-status" style={{fontSize:20}}>Survey says...</p>}
    </div>
  );
}

function DisplayGameOver({ room, roomCode, setRoom }) {
  const [creditBits, setCreditBits] = useState({
    wardrobe: 'Someone\'s Closet',
    food: 'the snack table',
    blueCards: 'imagination',
    travel: 'a man with a clipboard'
  });
  const creditCelebs = (room?.panel || []).filter(Boolean);
  const [creditCelebIndex, setCreditCelebIndex] = useState(0);
  const safeMoney = (n) => `$${Number(n || 0).toLocaleString()}`;
  let headline = 'Thanks for playing!';
  try {
    const slot = room && room.activeSlot;
    const name = (room && room.players && room.players[slot]) || 'Our contestant';
    if (room && room.finalMatchResult === 'win') headline = `${name} wins ${safeMoney(room.finalMatchWinnings)}!`;
    else if (room && Number(room.superMatchWinnings || 0) > 0) headline = `${name} goes home with ${safeMoney(room.superMatchWinnings)}!`;
    else if (room && room.partingGift) headline = `Parting gift: ${room.partingGift}`;
  } catch {}

  const nextShows = [
    'Password',
    'Tattletales',
    'The Newlywed Game',
    'Hollywood Squares',
    'Family Feud',
    'The Gong Show',
    'Card Sharks',
    'The Price Is Right',
    'To Tell the Truth',
    'Let\'s Make a Deal'
  ];
  const nextShow = nextShows[Math.floor(Math.random() * nextShows.length)];

  useEffect(() => {
    let cancelled = false;
    api.creditsBits().then(bits => { if (!cancelled && bits) setCreditBits(bits); }).catch(() => {});
    const musicTimer = setTimeout(() => {
      try { startCreditsMusic(); } catch {}
    }, 350);
    const voiceTimer = setTimeout(() => {
      if (cancelled) return;
      speakTTS({
        text: `Match Game is a Jason Brown, Claude, and Chat GPT production. Stay tuned for ${nextShow}.`,
        isAnnouncer: true,
        fallbackProfile: ANNOUNCER_PROFILE,
      }).catch(() => {});
    }, 900);
    const celebTimer = setInterval(() => {
      setCreditCelebIndex(i => creditCelebs.length ? (i + 1) % creditCelebs.length : 0);
    }, 3200);
    return () => {
      cancelled = true;
      clearTimeout(musicTimer);
      clearTimeout(voiceTimer);
      clearInterval(celebTimer);
      try { stopCreditsMusic(); } catch {}
    };
  }, []);

  const handlePlayAgain = async () => {
    try {
      try { stopCreditsMusic(); } catch {}
      const { room: updated } = await api.playAgain(roomCode);
      if (setRoom) setRoom(updated);
    } catch (e) {
      alert(e.message || 'Could not start a new game');
    }
  };

  return (
    <div className="mg-credit-only-screen scrolling">
      <div className="mg-credit-only-headline">{headline}</div>
      {creditCelebs.length > 0 && (
        <div className="mg-credit-celeb-spotlight">
          <CelebVisual celeb={creditCelebs[creditCelebIndex % creditCelebs.length]} size={150} />
          <div className="mg-credit-celeb-name">{creditCelebs[creditCelebIndex % creditCelebs.length]?.name}</div>
          <div className="mg-credit-celeb-caption">appeared as themselves</div>
        </div>
      )}
      <div className="mg-credit-only-card scrolling">
        <div className="mg-credit-scroll-content">
          <div className="mg-credit-only-title">Match Game</div>
          <div>A Jason Brown / Claude / ChatGPT production</div>
          <div>Stay tuned for more questionable television</div>
          <div>Created by Jason Brown</div>
          <div>Question chaos by Claude AI</div>
          <div>Code wrangling by ChatGPT</div>
          <div>Photos via Wikipedia / Wikimedia Commons where available</div>
          <div>Wardrobe provided by {creditBits.wardrobe}</div>
          <div>Blue cards supplied by {creditBits.blueCards}</div>
          <div>Celebrity handwriting approved by nobody</div>
          <div>Legal services by Dewey, Cheatem & Howe</div>
          <div>Travel arranged by {creditBits.travel}</div>
          <div>Catering by {creditBits.food}</div>
          <div>No actual celebrities were harmed</div>
          <div>Good night, stars!</div>
        </div>
      </div>
      <button className="mg-btn mg-credit-play-again" onClick={handlePlayAgain}>Play Again</button>
    </div>
  );
}

function DisplayFinalMatchActive({ room }) {
  return (
    <div className="mg-display-center-msg">
      <div className="mg-display-round final" style={{fontSize:28,marginBottom:12}}>★★ Final Match ★★</div>
      {room.phase !== 'finalMatch_pickCeleb' && room.finalMatchPrompt && <div className="mg-prompt">{room.finalMatchPrompt}</div>}
      {room.finalMatchCelebIndex != null && (
        <div className="mg-super-celeb-card revealed" style={{margin:'16px auto',maxWidth:240}}>
          <div className="mg-panelist-name">{room.panel[room.finalMatchCelebIndex]?.name}</div>
          <div className="mg-panelist-tag">{room.panel[room.finalMatchCelebIndex]?.tag}</div>
          <div className="mg-panelist-answer" style={{fontSize:22}}>thinking…</div>
        </div>
      )}
      <p className="mg-status">
        {room.phase === 'finalMatch_pickCeleb'
          ? (room.finalMatchPickReady ? `${room.players[room.activeSlot]} is choosing a celebrity…` : 'The host is introducing the Final Match…')
          : `${room.players[room.activeSlot]} is writing their answer…`}
      </p>
    </div>
  );
}

function DisplayFinalMatchReveal({ room, roomCode }) {
  const won = room.finalMatchResult === 'win';
  const celeb = room.panel[room.finalMatchCelebIndex];
  const [stage, setStage] = useState('thinking'); // thinking | reveal | result
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    let cancelled = false;
    (async () => {
      await delay(500);
      playAudience('applause');
      await speakTTS({
        text: `Now, let's see if ${celeb?.name || 'our star'} can match ${room.players[room.activeSlot]}.`,
        isAnnouncer: true,
        fallbackProfile: ANNOUNCER_PROFILE,
      });
      if (cancelled) return;
      await delay(350);
      await speakTTS({
        text: `${room.players[room.activeSlot]} said, ${room.finalMatchContestantAnswer}.`,
        isAnnouncer: true,
        fallbackProfile: ANNOUNCER_PROFILE,
      });
      if (cancelled) return;
      await delay(450);
      await speakTTS({
        text: `${celeb?.name || 'Our star'} ${['looks nervous','looks sweaty','looks pale','looks worried','looks a little dejected','looks like they need a commercial break'][Math.floor(Math.random()*6)]}.`,
        isAnnouncer: true,
        fallbackProfile: ANNOUNCER_PROFILE,
      });
      if (cancelled) return;
      playAudience('drumroll');
      await delay(650);
      setStage('reveal');
      await speakTTS({
        text: speechClean(room.finalMatchCelebAnswer || ''),
        code: roomCode,
        slot: room.finalMatchCelebIndex,
        fallbackProfile: VOICE_PROFILES[(room.finalMatchCelebIndex || 0) % VOICE_PROFILES.length],
      });
      if (cancelled) return;
      await delay(250);
      setStage('result');
      if (won) {
        playAudience('win');
        await speakTTS({
          text: `It's a match! ${room.players[room.activeSlot]} wins ${fmt$(room.finalMatchWinnings)}!`,
          isAnnouncer: true,
          fallbackProfile: ANNOUNCER_PROFILE,
        });
        await delay(1800);
        if (!cancelled) { try { await api.finalMatchDone(roomCode); } catch {} }
      } else {
        playAudience('aww');
        await speakTTS({
          text: `Well, ${room.players[room.activeSlot]}, you didn't win the Final Match, but you're still going home with ${fmt$(room.superMatchWinnings || 0)}.`,
          isAnnouncer: true,
          fallbackProfile: ANNOUNCER_PROFILE,
        });
        await delay(1800);
        if (!cancelled) { try { await api.finalMatchDone(roomCode); } catch {} }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="mg-display-center-msg">
      {stage === 'result' && won && <Confetti />}
      <div className="mg-display-round final" style={{fontSize:28,marginBottom:12}}>★★ Final Match ★★</div>
      <div className="mg-prompt">{room.finalMatchPrompt}</div>
      <p className="mg-status" style={{fontSize:22,marginTop:16}}>
        {room.players[room.activeSlot]} said: <strong>"{room.finalMatchContestantAnswer}"</strong>
      </p>

      <div className={`mg-final-celeb-focus ${stage === 'thinking' ? 'stressed' : ''} ${stage !== 'thinking' ? 'revealed' : ''}`}>
        <div style={{width:150,height:150,margin:'0 auto 10px'}}>
          <CelebVisual celeb={celeb} size={150} />
        </div>
        <div className="mg-panelist-name" style={{fontSize:30}}>{celeb?.name}</div>
        <div className="mg-panelist-tag">{stage === 'thinking' ? 'looks nervous…' : 'reveals:'}</div>
        <div className="mg-panelist-answer" style={{fontSize: stage === 'thinking' ? 34 : 48, minHeight:64}}>
          {stage === 'thinking' ? '???' : room.finalMatchCelebAnswer}
        </div>
      </div>

      {stage === 'result' ? (won
        ? <div style={{textAlign:'center'}}>
            <div className="mg-bigsymbol" style={{fontSize:60,color:'var(--tri-green)',textShadow:'0 0 20px currentColor'}}>✓ MATCH!</div>
            <div style={{fontFamily:'Bowlby One,sans-serif',fontSize:48,color:'var(--orange-deep)'}}>
              {fmt$(room.finalMatchWinnings)}!!!
            </div>
          </div>
        : <div style={{textAlign:'center',fontFamily:'Bowlby One,sans-serif',fontSize:32,color:'var(--cir-red)'}}>
            No Final Match — credits coming up!
          </div>)
        : <p className="mg-status" style={{fontSize:20}}>The star looks nervous...</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// PHONE VIEW — contestant input only
// ─────────────────────────────────────────────────────────────
function PhoneView({ room, roomCode, playerSlot }) {
  const [myAnswer, setMyAnswer] = useState('');
  const [selectedCelebs, setSelectedCelebs] = useState([]); // for super match
  const [submitted, setSubmitted] = useState(false);
  const prevPhaseRef = useRef(null);

  // Reset submitted flag when phase changes
  useEffect(() => {
    if (!room) return;
    const key = `${room.phase}|${room.round}|${room.turnInRound}|${room.activeSlot}|${room.chosenPrompt || ''}|${room.superMatchPrompt || ''}|${room.finalMatchPrompt || ''}|${room.finalMatchCelebIndex ?? ''}`;
    if (key !== prevPhaseRef.current) {
      prevPhaseRef.current = key;
      setSubmitted(false);
      setMyAnswer('');
      setSelectedCelebs([]);
    }
  }, [room?.phase, room?.round, room?.turnInRound, room?.activeSlot, room?.chosenPrompt, room?.superMatchPrompt, room?.finalMatchPrompt]);

  if (!room) return <PhoneWaiting />;

  const phase = room.phase;
  const myRole = room.roles?.[playerSlot];
  const isContestant = myRole?.role === 'contestant';
  const isHumanCeleb = myRole?.role === 'celeb';
  const contestantSlot = myRole?.contestantSlot;
  const celebIndex = myRole?.celebIndex;
  const isMyTurn = isContestant && room.activeSlot === contestantSlot;
  const myName = room.participants?.[playerSlot] || room.players?.[contestantSlot] || 'You';
  const sym = isContestant ? slotSymbol(room, contestantSlot) : '★';

  const handlePickPrompt = async (choice) => {
    setSubmitted(true);
    try { await api.pickPrompt(roomCode, playerSlot, choice); }
    catch(e) { setSubmitted(false); }
  };

  const handleSubmitAnswer = async () => {
    if (!myAnswer.trim()) return;
    setSubmitted(true);
    try { await api.submitAnswer(roomCode, playerSlot, myAnswer); }
    catch(e) { setSubmitted(false); }
  };

  const handleSuperMatchPick = async () => {
    if (selectedCelebs.length !== 3) return;
    setSubmitted(true);
    try { await api.superMatchPick(roomCode, selectedCelebs); }
    catch(e) { setSubmitted(false); }
  };

  const toggleCeleb = (i) => {
    setSelectedCelebs(prev =>
      prev.includes(i) ? prev.filter(x => x !== i)
      : prev.length < 3 ? [...prev, i]
      : prev
    );
  };

  const handleSuperMatchAnswer = async (answer, source={type:'own'}) => {
    setSubmitted(true);
    try { await api.superMatchAnswer(roomCode, answer || myAnswer, source); }
    catch(e) { setSubmitted(false); }
  };

  const handleSuperMatchCelebAnswer = async () => {
    if (!myAnswer.trim()) return;
    setSubmitted(true);
    try { await api.superMatchCelebAnswer(roomCode, playerSlot, myAnswer); }
    catch(e) { setSubmitted(false); }
  };

  const handleFinalMatchPick = async (celebIndex) => {
    setSubmitted(true);
    try { await api.finalMatchPick(roomCode, celebIndex); }
    catch(e) { setSubmitted(false); }
  };

  const handleFinalMatchAnswer = async () => {
    if (!myAnswer.trim()) return;
    setSubmitted(true);
    try { await api.finalMatchAnswer(roomCode, myAnswer); }
    catch(e) { setSubmitted(false); }
  };

  const handleFinalMatchCelebAnswer = async () => {
    if (!myAnswer.trim()) return;
    setSubmitted(true);
    try { await api.finalMatchCelebAnswer(roomCode, playerSlot, myAnswer); }
    catch(e) { setSubmitted(false); }
  };

  const handleFinalMatchDone = async () => {
    try { await api.finalMatchDone(roomCode); } catch {}
  };

  const handleStartFinalMatch = async () => {
    try { await api.finalMatchStart(roomCode); } catch {}
  };

  // ── RENDER PHONE ──
  return (
    <div className="mg-root phone-mode">
      <div className="mg-phone-card">
        <div className="mg-phone-header">
          <span className={`mg-phone-symbol ${isContestant ? slotClass(room, contestantSlot) : 'star'}`}>{sym || '★'}</span>
          <span className="mg-phone-name">{myName}</span>
          <span className="mg-phone-score">{isContestant ? room.scores[contestantSlot] : 'STAR'}</span>
        </div>

        {/* Lobby */}
        {phase === 'lobby' && (
          <div className="mg-phone-body">
            <p className="mg-status">
              You're in! Waiting for everyone else to join: {Object.keys(room.participants || {}).length} / {room.maxPlayers || 2}
            </p>
            <p className="mg-help">Keep watching the TV screen.</p>
          </div>
        )}

        {/* Intro / role reveal */}
        {phase === 'intro' && (
          <div className="mg-phone-body">
            <p className="mg-status">
              {isContestant ? `You are a contestant! Watch the TV to see when it's your turn.` :
               isHumanCeleb ? `You are one of the celebrity panelists! Watch the TV for your introduction.` :
               'Roles are being assigned — watch the TV!'}
            </p>
          </div>
        )}

        {/* Coin toss */}
        {phase === 'cointoss' && (
          <div className="mg-phone-body">
            <p className="mg-status">Watch the TV screen for who goes first!</p>
          </div>
        )}

        {/* Generating */}
        {['generating','generating_answers','round_end','superMatch_generating','finalMatch_generating','finalMatch_generating_celeb'].includes(phase) && (
          <div className="mg-phone-body">
            <div className="mg-loading">
              {phase === 'generating' && 'Preparing questions'}
              {phase === 'generating_answers' && 'Panel is conferring'}
              {phase === 'round_end' && 'Scoring round'}
              {phase === 'superMatch_generating' && 'Consulting the panel'}
                            {phase === 'finalMatch_generating' && 'Preparing Final Match'}
              {phase === 'finalMatch_generating_celeb' && 'Celebrity is thinking'}
            </div>
          </div>
        )}

        {/* Pick prompt — only for the active contestant */}
        {phase === 'pick_prompt' && (
          <div className="mg-phone-body">
            {isMyTurn && !room.contestantAnswer ? (
              <>
                <p className="mg-status" style={{fontSize:18}}>Choose your question:</p>
                <div className="mg-row" style={{flexDirection:'column', gap:16, marginTop:24}}>
                  <button className="mg-btn" style={{fontSize:22, padding:'20px 40px'}}
                    onClick={() => handlePickPrompt('A')}>Question A</button>
                  <button className="mg-btn secondary" style={{fontSize:22, padding:'20px 40px'}}
                    onClick={() => handlePickPrompt('B')}>Question B</button>
                </div>
                <p className="mg-help" style={{marginTop:16}}>You can't see the questions — trust your gut!</p>
              </>
            ) : (
              <p className="mg-status">
                {isMyTurn ? 'Locked in!' : `${room.players[room.activeSlot]} is choosing their question…`}
              </p>
            )}
          </div>
        )}

        {/* Answering */}
        {phase === 'answering' && (
          <div className="mg-phone-body">
            {isMyTurn && !room.contestantAnswer ? (
              <>
                <p className="mg-status" style={{fontSize:18,marginBottom:8}}>
                  Fill in the blank:
                </p>
                <input className="mg-input" value={myAnswer}
                  onChange={e => setMyAnswer(e.target.value)}
                  placeholder="Your answer (1-2 words)" maxLength={50}
                  onKeyDown={e => { if (e.key==='Enter') handleSubmitAnswer(); }}
                  autoFocus style={{fontSize:24,padding:'18px 16px'}} />
                <div className="mg-row">
                  <button className="mg-btn" onClick={handleSubmitAnswer} disabled={!myAnswer.trim()}>
                    Lock It In
                  </button>
                </div>
                <p className="mg-help" style={{marginTop:12}}>Listen to the TV for the question!</p>
              </>
            ) : isHumanCeleb && room.panel?.[celebIndex] && !(room.round === 2 && (room.round1Matches?.[room.activeSlot] || []).includes(celebIndex)) && !room.humanPanelAnswers?.[celebIndex] ? (
              <>
                <p className="mg-status" style={{fontSize:18,marginBottom:8}}>
                  You are a celebrity panelist. Listen to the TV, then write your answer before the contestant is revealed:
                </p>
                <p className="mg-help" style={{marginBottom:12}}>The question is only shown on the TV screen.</p>
                <input className="mg-input" value={myAnswer}
                  onChange={e => setMyAnswer(e.target.value)}
                  placeholder="Your celeb answer" maxLength={50}
                  onKeyDown={e => { if (e.key==='Enter') handleSubmitAnswer(); }}
                  autoFocus style={{fontSize:24,padding:'18px 16px'}} />
                <div className="mg-row">
                  <button className="mg-btn" onClick={handleSubmitAnswer} disabled={!myAnswer.trim()}>
                    Lock In Celeb Answer
                  </button>
                </div>
              </>
            ) : isHumanCeleb && room.round === 2 && (room.round1Matches?.[room.activeSlot] || []).includes(celebIndex) ? (
              <p className="mg-status">You already matched in the previous round, so you sit out this Round 2 question. Watch the TV!</p>
            ) : (
              <p className="mg-status">
                {isMyTurn ? `Locked in!` : isHumanCeleb ? 'Answer locked in — watch the TV!' : `${room.players[room.activeSlot]} is answering…`}
              </p>
            )}
          </div>
        )}

        {/* Revealing */}
        {phase === 'revealing' && (
          <div className="mg-phone-body">
            <p className="mg-status">
              {isMyTurn
                ? <>Your answer: <strong>"{room.contestantAnswer}"</strong></>
                : `${room.players[room.activeSlot]} answered — watch the TV!`}
            </p>
            <p className="mg-status">Watch the TV screen for the reveal!</p>
          </div>
        )}

        {/* Super Match — pick 3 celebs */}
        {phase === 'superMatch_pickCelebs' && isMyTurn && !submitted && (
          <div className="mg-phone-body">
            <div className="mg-display-round super">★ Super Match ★</div>
            {!room.superMatchPromptReady ? (
              <p className="mg-status">Watch the TV — the host is about to reveal the Super Match prompt.</p>
            ) : (
              <>
                <div className="mg-prompt phone">{room.superMatchPrompt}</div>
                <p className="mg-status">Pick 3 celebrities to help you ({selectedCelebs.length}/3):</p>
                <div className="mg-phone-celeb-grid">
                  {room.panel.map((p, i) => (
                    <button key={i}
                      className={`mg-phone-celeb-btn ${selectedCelebs.includes(i) ? 'selected' : ''}`}
                      onClick={() => toggleCeleb(i)}
                      disabled={!selectedCelebs.includes(i) && selectedCelebs.length >= 3}>
                      {p.name}
                    </button>
                  ))}
                </div>
                <div className="mg-row">
                  <button className="mg-btn" onClick={handleSuperMatchPick}
                    disabled={selectedCelebs.length !== 3}>Ask Them!</button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Super Match — selected live celebrities answer first */}
        {phase === 'superMatch_human_answering' && (
          <div className="mg-phone-body">
            {isHumanCeleb && (room.superMatchCelebIndices || []).includes(celebIndex) && !room.superMatchHumanAnswers?.[celebIndex] && !submitted ? (
              <>
                <div className="mg-display-round super">★ Super Match ★</div>
                <p className="mg-status">You were selected to help. Listen to the TV, then write your answer:</p>
                <p className="mg-help" style={{marginBottom:12}}>The prompt is only shown on the TV screen.</p>
                <input className="mg-input" value={myAnswer}
                  onChange={e => setMyAnswer(e.target.value)}
                  placeholder="Your Super Match answer" maxLength={30}
                  onKeyDown={e => { if (e.key==='Enter') handleSuperMatchCelebAnswer(); }}
                  autoFocus />
                <div className="mg-row">
                  <button className="mg-btn" onClick={handleSuperMatchCelebAnswer} disabled={!myAnswer.trim()}>
                    Lock In Answer
                  </button>
                </div>
              </>
            ) : (
              <p className="mg-status">Watch the TV — selected stars are writing their answers!</p>
            )}
          </div>
        )}

        {/* Super Match — reveal in progress + answer choice when all revealed */}
        {['superMatch_revealing','superMatch_answering'].includes(phase) && isMyTurn && (
          <div className="mg-phone-body">
            {phase !== 'superMatch_answering' && room.superMatchRevealIndex < (room.superMatchCelebIndices?.length || 0) - 1 ? (
              <p className="mg-status">Watch the TV — the celebrities are answering!</p>
            ) : !room.superMatchContestantAnswer ? (
              <>
                <p className="mg-status" style={{fontWeight:'bold'}}>All celebrities have answered. Choose:</p>
                {(room.superMatchCelebIndices || []).map((panelIdx, i) => (
                  <button key={i} className="mg-btn" style={{width:'100%', marginTop:10, fontSize:16}}
                    onClick={() => { setSubmitted(true); handleSuperMatchAnswer(room.panel[panelIdx]?.answer, {type:'celeb', celebIndex: panelIdx}); }}>
                    {room.panel[panelIdx]?.name}: <em>"{room.panel[panelIdx]?.answer}"</em>
                  </button>
                ))}
                <div style={{marginTop:20, borderTop:`2px dashed var(--brown)`, paddingTop:16}}>
                  <label className="mg-label">Or write your own:</label>
                  <input className="mg-input" value={myAnswer}
                    onChange={e => setMyAnswer(e.target.value)}
                    placeholder="Your answer" maxLength={30} style={{fontSize:20}} />
                  <div className="mg-row">
                    <button className="mg-btn secondary" onClick={() => { setSubmitted(true); handleSuperMatchAnswer(myAnswer, {type:'own'}); }}
                      disabled={!myAnswer.trim()}>Use My Answer</button>
                  </div>
                </div>
              </>
            ) : (
              <p className="mg-status">Answer locked in — watch the TV!</p>
            )}
          </div>
        )}

        {['superMatch_revealing','superMatch_answering'].includes(phase) && !isMyTurn && (
          <div className="mg-phone-body">
            <p className="mg-status">Watch the TV — {room.players[room.activeSlot]} is playing the Super Match!</p>
          </div>
        )}

        {/* Super Match result */}
        {phase === 'superMatch_won' && (
          <div className="mg-phone-body">
            <p className="mg-status">Watch the TV — the Final Match will start automatically!</p>
          </div>
        )}

        {phase === 'superMatch_lost' && (
          <div className="mg-phone-body">
            <p className="mg-status">Nice try! Watch the TV for the reveal.</p>
          </div>
        )}

        {/* Final Match — pick celeb */}
        {phase === 'finalMatch_pickCeleb' && isMyTurn && !submitted && (
          <div className="mg-phone-body">
            <div className="mg-display-round final">★★ Final Match ★★</div>
            {!room.finalMatchPickReady ? (
              <p className="mg-status">Watch the TV — the host is introducing the Final Match.</p>
            ) : (
              <>
                <p className="mg-status">Pick ONE celebrity to try to match exactly:</p>
                <div className="mg-phone-celeb-grid">
                  {room.panel.map((p, i) => (
                    <button key={i} className="mg-phone-celeb-btn"
                      onClick={() => { setSubmitted(true); handleFinalMatchPick(i); }}>
                      {p.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Final Match — contestant writes answer */}
        {phase === 'finalMatch_answering' && isMyTurn && !submitted && (
          <div className="mg-phone-body">
            {!room.finalMatchPromptReady ? (
              <p className="mg-status">Watch the TV — the host is reading the Final Match question.</p>
            ) : (
              <>
                <div className="mg-prompt phone">{room.finalMatchPrompt}</div>
                <label className="mg-label">Your Answer</label>
                <input className="mg-input" value={myAnswer}
                  onChange={e => setMyAnswer(e.target.value)}
                  placeholder="1-2 words" maxLength={30}
                  onKeyDown={e => { if (e.key==='Enter') handleFinalMatchAnswer(); }}
                  autoFocus />
                <p className="mg-help">
                  {room.panel[room.finalMatchCelebIndex]?.name} is also writing their answer right now!
                </p>
                <div className="mg-row">
                  <button className="mg-btn" onClick={handleFinalMatchAnswer} disabled={!myAnswer.trim()}>
                    Lock It In!
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Final Match — selected human celebrity writes answer */}
        {['finalMatch_answering','finalMatch_human_celeb_answering'].includes(phase) && isHumanCeleb && celebIndex === room.finalMatchCelebIndex && !room.finalMatchHumanAnswers?.[celebIndex] && !submitted && (
          <div className="mg-phone-body">
            <div className="mg-display-round final">★★ Final Match ★★</div>
            {!room.finalMatchPromptReady ? (
              <p className="mg-status">Watch the TV — the host is reading the Final Match question.</p>
            ) : (
              <>
                <p className="mg-status">You were chosen for the Final Match. Listen to the TV, then write your answer now:</p>
                <p className="mg-help" style={{marginBottom:12}}>The prompt is only shown on the TV screen.</p>
                <input className="mg-input" value={myAnswer}
                  onChange={e => setMyAnswer(e.target.value)}
                  placeholder="Your Final Match answer" maxLength={30}
                  onKeyDown={e => { if (e.key==='Enter') handleFinalMatchCelebAnswer(); }}
                  autoFocus />
                <div className="mg-row">
                  <button className="mg-btn" onClick={handleFinalMatchCelebAnswer} disabled={!myAnswer.trim()}>
                    Lock In Celeb Answer
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {phase === 'finalMatch_human_celeb_answering' && !(isHumanCeleb && celebIndex === room.finalMatchCelebIndex && !room.finalMatchHumanAnswers?.[celebIndex] && !submitted) && (
          <div className="mg-phone-body">
            <p className="mg-status">Waiting for {room.panel[room.finalMatchCelebIndex]?.name} to write their Final Match answer. Watch the TV!</p>
          </div>
        )}

        {/* Final Match — reveal */}
        {phase === 'finalMatch_reveal' && (
          <div className="mg-phone-body">
            <p className="mg-status">Watch the TV for the Final Match reveal and credits.</p>
          </div>
        )}

        {/* Game Over */}
        {phase === 'gameOver' && (
          <div className="mg-phone-body">
            <p className="mg-status">Thanks for playing!</p>
          </div>
        )}

        {/* Waiting states for non-active player */}
        {!isMyTurn && ['superMatch_pickCelebs','finalMatch_pickCeleb','finalMatch_answering'].includes(phase) && !(phase==='finalMatch_answering' && isHumanCeleb && celebIndex === room.finalMatchCelebIndex) && (
          <div className="mg-phone-body">
            <p className="mg-status">Watch the TV — {room.players[room.activeSlot]} is playing the {
              phase.startsWith('finalMatch') ? 'Final Match' : 'Super Match'
            }!</p>
          </div>
        )}

        {['error'].includes(phase) && (
          <div className="mg-phone-body">
            <div className="mg-error">Something went wrong. Refresh and rejoin.</div>
          </div>
        )}

        {submitted && !['superMatch_pickCelebs','finalMatch_pickCeleb','finalMatch_answering','finalMatch_human_celeb_answering','finalMatch_reveal'].includes(phase) && (
          <div className="mg-phone-locked">✓ Locked in — watch the TV!</div>
        )}
      </div>
    </div>
  );
}

function PhoneWaiting() {
  return (
    <div className="mg-root phone-mode">
      <div className="mg-phone-card">
        <div className="mg-loading" style={{marginTop:48}}>Connecting</div>
      </div>
    </div>
  );
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));
