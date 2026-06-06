import React, { useState, useEffect, useRef } from 'react';

// ─────────────────────────────────────────────────────────────
// THE MATCH GAME — Railway-deployable version
// REST API for cross-device sync via polling
// ─────────────────────────────────────────────────────────────

const POLL_INTERVAL = 1500;

const VOICE_PROFILES = [
  { rate: 0.95, pitch: 1.1 },
  { rate: 1.0,  pitch: 0.85 },
  { rate: 1.1,  pitch: 1.3 },
  { rate: 0.9,  pitch: 0.7 },
  { rate: 1.05, pitch: 1.0 },
  { rate: 0.92, pitch: 0.95 },
];

const ANNOUNCER = { rate: 0.95, pitch: 0.8 };

// ─────────────────────────────── API CLIENT
const api = {
  config: () => fetch('/api/config').then(handleRes),
  createRoom: (playerName) =>
    fetch('/api/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerName }),
    }).then(handleRes),
  joinRoom: (code, playerName) =>
    fetch(`/api/room/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerName }),
    }).then(handleRes),
  getRoom: (code) =>
    fetch(`/api/room/${code}`).then(handleRes),
  cointoss: (code) =>
    fetch(`/api/room/${code}/cointoss`, { method: 'POST' }).then(handleRes),
  proceed: (code) =>
    fetch(`/api/room/${code}/proceed`, { method: 'POST' }).then(handleRes),
  startRound: (code) =>
    fetch(`/api/room/${code}/start-round`, { method: 'POST' }).then(handleRes),
  submitAnswer: (code, slot, answer) =>
    fetch(`/api/room/${code}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot, answer }),
    }).then(handleRes),
  markScored: (code) =>
    fetch(`/api/room/${code}/scored`, { method: 'POST' }).then(handleRes),
  nextRound: (code) =>
    fetch(`/api/room/${code}/next-round`, { method: 'POST' }).then(handleRes),
  speak: (params) =>
    fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),
};

async function handleRes(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─────────────────────────────── SPEECH
// Tracks whether OpenAI TTS is available (set on mount via /api/config)
let TTS_ENABLED = false;

// Currently playing audio (for cancellation)
let currentAudio = null;

const stopAllAudio = () => {
  if (currentAudio) {
    try { currentAudio.pause(); } catch {}
    currentAudio = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
};

const speakBrowser = (text, profile, onEnd) => {
  if (!('speechSynthesis' in window)) { onEnd?.(); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = profile.rate;
  u.pitch = profile.pitch;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length && typeof profile.voiceIdx === 'number') {
    const englishVoices = voices.filter(v => v.lang.startsWith('en'));
    const pool = englishVoices.length ? englishVoices : voices;
    u.voice = pool[profile.voiceIdx % pool.length];
  }
  if (onEnd) u.onend = onEnd;
  window.speechSynthesis.speak(u);
};

// Plays OpenAI TTS audio for a panelist or announcer, with browser-TTS fallback.
// Returns a Promise that resolves when playback ends (or on error).
const speak = async (params) => {
  const { code, slot, text, isAnnouncer, fallbackProfile } = params;
  stopAllAudio();
  if (!TTS_ENABLED) {
    return new Promise((resolve) => {
      speakBrowser(text, fallbackProfile || { rate: 1, pitch: 1, voiceIdx: 0 }, resolve);
    });
  }
  try {
    const res = await api.speak({ code, slot, text, isAnnouncer });
    if (!res.ok) throw new Error('speak request failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    return new Promise((resolve) => {
      const cleanup = () => {
        URL.revokeObjectURL(url);
        if (currentAudio === audio) currentAudio = null;
        resolve();
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      audio.play().catch(() => cleanup());
    });
  } catch (e) {
    console.warn('OpenAI TTS failed, falling back to browser:', e.message);
    return new Promise((resolve) => {
      speakBrowser(text, fallbackProfile || { rate: 1, pitch: 1, voiceIdx: 0 }, resolve);
    });
  }
};

// ─────────────────────────────── MAIN
export default function MatchGame() {
  const [screen, setScreen] = useState('home');
  const [roomCode, setRoomCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [playerSlot, setPlayerSlot] = useState(null);
  const [room, setRoom] = useState(null);
  const [myAnswer, setMyAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revealIndex, setRevealIndex] = useState(-1);
  const [coinFlipping, setCoinFlipping] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const pollRef = useRef(null);
  const lastVersionRef = useRef(null);
  const lastPhaseRef = useRef(null);

  // Poll room state
  useEffect(() => {
    if (!roomCode || screen === 'home' || screen === 'create' || screen === 'join') return;
    const poll = async () => {
      try {
        const { room: r } = await api.getRoom(roomCode);
        if (r.version !== lastVersionRef.current) {
          lastVersionRef.current = r.version;
          setRoom(r);
        }
      } catch (e) {
        // Quietly ignore poll failures; show error only if persistent
        console.warn('poll failed', e.message);
      }
    };
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(pollRef.current);
  }, [roomCode, screen]);

  // React to phase changes
  useEffect(() => {
    if (!room) return;
    const phase = room.phase;
    if (phase === lastPhaseRef.current) return;
    lastPhaseRef.current = phase;

    if (phase === 'cointoss' && screen !== 'cointoss') {
      setScreen('cointoss');
      if (!room.triangleSlot) {
        setCoinFlipping(true);
        setTimeout(() => setCoinFlipping(false), 2500);
      }
    }
    if (phase === 'lobby' && (screen === 'cointoss' || screen === 'scored' || screen === 'reveal' || screen === 'round')) {
      setScreen('lobby');
      setMyAnswer('');
    }
    if (phase === 'round' && screen !== 'round') {
      setScreen('round');
      setMyAnswer('');
      if (room.prompt) {
        setTimeout(() => speak({
          text: room.prompt,
          isAnnouncer: true,
          fallbackProfile: { ...ANNOUNCER, voiceIdx: 0 },
        }), 600);
      }
    }
    if (phase === 'reveal' && screen !== 'reveal') {
      setScreen('reveal');
      setRevealIndex(-1);
      revealSequence(room);
    }
    if (phase === 'scored' && screen !== 'scored') {
      setScreen('scored');
    }
  }, [room?.phase, room?.version]);

  // Preload voices and check server TTS config
  useEffect(() => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }
    api.config().then(cfg => {
      TTS_ENABLED = !!cfg.ttsEnabled;
      setTtsEnabled(!!cfg.ttsEnabled);
    }).catch(() => {
      TTS_ENABLED = false;
      setTtsEnabled(false);
    });
  }, []);

  // Reveal sequence
  const revealSequence = (r) => {
    let i = 0;
    const next = async () => {
      if (i >= r.panel.length) {
        setTimeout(async () => {
          try { await api.markScored(roomCode); } catch {}
        }, 800);
        return;
      }
      setRevealIndex(i);
      if (r.panel[i]) {
        await speak({
          code: roomCode,
          slot: i,
          text: r.panel[i].answer,
          fallbackProfile: { ...VOICE_PROFILES[i % VOICE_PROFILES.length], voiceIdx: i + 1 },
        });
        i++;
        setTimeout(next, 350);
      } else {
        i++;
        setTimeout(next, 1000);
      }
    };
    setTimeout(next, 800);
  };

  // ─── Actions
  const createRoom = async () => {
    if (!playerName.trim()) { setError('Enter your name first'); return; }
    setError(''); setLoading(true);
    try {
      const { room: r, slot } = await api.createRoom(playerName.trim());
      setRoomCode(r.code);
      setPlayerSlot(slot);
      lastVersionRef.current = r.version;
      setRoom(r);
      setScreen('lobby');
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  const joinRoom = async () => {
    if (!playerName.trim()) { setError('Enter your name first'); return; }
    if (roomCode.length !== 4) { setError('Room code is 4 letters'); return; }
    setError(''); setLoading(true);
    try {
      const code = roomCode.toUpperCase();
      const { room: r, slot } = await api.joinRoom(code, playerName.trim());
      setRoomCode(code);
      setPlayerSlot(slot);
      lastVersionRef.current = r.version;
      setRoom(r);
      setScreen('lobby');
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  const flipCoin = async () => {
    try {
      await api.cointoss(roomCode);
    } catch (e) { setError(e.message); }
  };

  const proceedFromToss = async () => {
    try { await api.proceed(roomCode); } catch (e) { setError(e.message); }
  };

  const startRound = async () => {
    setLoading(true);
    try {
      await api.startRound(roomCode);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const submitAnswer = async () => {
    if (!myAnswer.trim() || !room || room.activeSlot !== playerSlot) return;
    try {
      await api.submitAnswer(roomCode, playerSlot, myAnswer.trim());
    } catch (e) { setError(e.message); }
  };

  const nextRound = async () => {
    try { await api.nextRound(roomCode); } catch (e) { setError(e.message); }
  };

  // ─── Symbol helpers
  const slotSymbol = (slot) => {
    if (!room || !room.triangleSlot) return '';
    return slot === room.triangleSlot ? '▲' : '●';
  };
  const slotSymbolClass = (slot) => {
    if (!room || !room.triangleSlot) return '';
    return slot === room.triangleSlot ? 'tri' : 'cir';
  };

  // ───────────────────────────── RENDER
  return (
    <div className="mg-root">
      <div className="mg-card">
        <h1 className="mg-title">The<br/>Match Game</h1>
        <p className="mg-subtitle">— a parlor diversion for two contestants —</p>
        <div className="mg-stars">★ ★ ★ ★ ★ ★ ★</div>

        {error && (
          <div className="mg-error" onClick={() => setError('')}>{error} <span style={{opacity: 0.6, fontSize: 11}}>(tap to dismiss)</span></div>
        )}

        {screen === 'home' && (
          <>
            <p className="mg-help">
              Two players, two phones. One creates a room, the other joins with the code.
              A coin toss decides who's ▲ and who's ●. Players take turns each round.
              Six AI-voiced celebrity panelists answer alongside.
            </p>
            <label className="mg-label">Your Name</label>
            <input
              className="mg-input"
              value={playerName}
              onChange={e => setPlayerName(e.target.value)}
              placeholder="e.g. Gene"
              maxLength={20}
            />
            <div className="mg-row">
              <button className="mg-btn" onClick={() => setScreen('create')} disabled={!playerName.trim()}>
                Host a Game
              </button>
              <button className="mg-btn secondary" onClick={() => setScreen('join')} disabled={!playerName.trim()}>
                Join a Game
              </button>
            </div>
          </>
        )}

        {screen === 'create' && (
          <>
            <p className="mg-status">Ready to host? We'll generate your celebrity panel.</p>
            {loading && <div className="mg-loading">Assembling the celebrity panel</div>}
            <div className="mg-row">
              <button className="mg-btn" onClick={createRoom} disabled={loading}>Create Room</button>
              <button className="mg-btn secondary" onClick={() => setScreen('home')} disabled={loading}>Back</button>
            </div>
          </>
        )}

        {screen === 'join' && (
          <>
            <label className="mg-label">Room Code</label>
            <input
              className="mg-input big"
              value={roomCode}
              onChange={e => setRoomCode(e.target.value.toUpperCase().slice(0, 4))}
              placeholder="ABCD"
              maxLength={4}
            />
            {loading && <div className="mg-loading">Joining</div>}
            <div className="mg-row">
              <button className="mg-btn" onClick={joinRoom} disabled={loading || roomCode.length !== 4}>Join</button>
              <button className="mg-btn secondary" onClick={() => setScreen('home')} disabled={loading}>Back</button>
            </div>
          </>
        )}

        {screen === 'lobby' && room && (
          <>
            {room.round === 0 && (
              <>
                <p className="mg-status">Room Code — share with your opponent</p>
                <div className="mg-roomcode">{room.code}</div>
              </>
            )}

            <div className="mg-contestant-strip">
              <div className="mg-contestant">
                {room.triangleSlot && (
                  <div className={`mg-contestant-symbol ${slotSymbolClass(1)}`}>{slotSymbol(1)}</div>
                )}
                <div className="mg-contestant-name">{room.players[1] || '—'}</div>
                <div className="mg-contestant-num">{room.scores[1]}</div>
              </div>
              <div className="mg-contestant">
                {room.triangleSlot && (
                  <div className={`mg-contestant-symbol ${slotSymbolClass(2)}`}>{slotSymbol(2)}</div>
                )}
                <div className="mg-contestant-name">{room.players[2] || 'waiting…'}</div>
                <div className="mg-contestant-num">{room.scores[2]}</div>
              </div>
            </div>

            {room.round === 0 && (
              <>
                <p className="mg-label" style={{ marginTop: 24 }}>Tonight's Panel</p>
                <div className="mg-panel-grid">
                  {room.panel.map((p, i) => (
                    <div key={i} className="mg-panelist">
                      <div className="mg-panelist-name">{p.name}</div>
                      <div className="mg-panelist-tag">{p.tag}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {!room.players[2] && <p className="mg-status">Waiting for player 2 to join…</p>}

            {room.players[2] && !room.triangleSlot && playerSlot === 1 && (
              <div className="mg-row">
                <button className="mg-btn" onClick={flipCoin}>Flip Coin to Begin</button>
              </div>
            )}
            {room.players[2] && !room.triangleSlot && playerSlot === 2 && (
              <p className="mg-status">Waiting for the host to flip the coin…</p>
            )}

            {room.triangleSlot && playerSlot === 1 && (
              <>
                <p className="mg-status">
                  Next up: <strong>{room.players[room.activeSlot]}</strong> ({slotSymbol(room.activeSlot)})
                  {room.round > 0 && (
                    room.scores[1] === room.scores[2]
                      ? ' — tied, coin-toss winner plays'
                      : ' — currently behind'
                  )}
                </p>
                <div className="mg-row">
                  <button className="mg-btn" onClick={startRound} disabled={loading}>
                    {room.round === 0 ? 'Start Round 1' : `Start Round ${room.round + 1}`}
                  </button>
                </div>
              </>
            )}
            {room.triangleSlot && playerSlot === 2 && (
              <p className="mg-status">Waiting for the host to start the round…</p>
            )}
            {loading && <div className="mg-loading">Polling the panel for their answers</div>}
          </>
        )}

        {screen === 'cointoss' && room && (
          <div className="mg-coin-stage">
            <p className="mg-status">A coin toss decides the symbols and who plays first</p>
            <div className={`mg-coin ${coinFlipping || !room.triangleSlot ? 'flipping' : ''}`}>
              {coinFlipping || !room.triangleSlot ? '?' : (room.triangleSlot === 1 ? '▲' : '●')}
            </div>
            {!coinFlipping && room.triangleSlot && (
              <>
                <p className="mg-status" style={{ fontSize: 20 }}>
                  <strong>{room.players[room.triangleSlot]}</strong> wins the toss
                </p>
                <div className={`mg-bigsymbol ${slotSymbolClass(room.triangleSlot)}`}>
                  {slotSymbol(room.triangleSlot)}
                </div>
                <p className="mg-status">
                  {room.players[room.triangleSlot]} is ▲ • {room.players[room.triangleSlot === 1 ? 2 : 1]} is ●
                  <br/>
                  {room.players[room.triangleSlot]} plays first.
                </p>
                {playerSlot === 1 ? (
                  <div className="mg-row">
                    <button className="mg-btn" onClick={proceedFromToss}>Onward</button>
                  </div>
                ) : (
                  <p className="mg-status">Waiting for the host…</p>
                )}
              </>
            )}
          </div>
        )}

        {screen === 'round' && room && room.prompt && (
          <>
            <div className="mg-contestant-strip">
              <div className={`mg-contestant ${room.activeSlot === 1 ? 'active' : ''}`}>
                <div className={`mg-contestant-symbol ${slotSymbolClass(1)}`}>{slotSymbol(1)}</div>
                <div className="mg-contestant-name">{room.players[1]}</div>
                <div className="mg-contestant-num">{room.scores[1]}</div>
              </div>
              <div className={`mg-contestant ${room.activeSlot === 2 ? 'active' : ''}`}>
                <div className={`mg-contestant-symbol ${slotSymbolClass(2)}`}>{slotSymbol(2)}</div>
                <div className="mg-contestant-name">{room.players[2]}</div>
                <div className="mg-contestant-num">{room.scores[2]}</div>
              </div>
            </div>

            <p className="mg-status">
              Round {room.round} — <strong>{room.players[room.activeSlot]}</strong> ({slotSymbol(room.activeSlot)}) is up
            </p>
            <div className="mg-prompt">
              {room.prompt}
              <button
                className="mg-prompt-speak"
                onClick={() => speak({
                  text: room.prompt,
                  isAnnouncer: true,
                  fallbackProfile: { ...ANNOUNCER, voiceIdx: 0 },
                })}
                title="Read aloud"
              >♪</button>
            </div>

            {room.activeSlot === playerSlot ? (
              <>
                <label className="mg-label">Your Answer (match a panelist for a point!)</label>
                <input
                  className="mg-input"
                  value={myAnswer}
                  onChange={e => setMyAnswer(e.target.value)}
                  placeholder="Fill in the blank"
                  maxLength={50}
                  onKeyDown={e => { if (e.key === 'Enter') submitAnswer(); }}
                />
                <div className="mg-row">
                  <button className="mg-btn" onClick={submitAnswer} disabled={!myAnswer.trim()}>
                    Lock It In
                  </button>
                </div>
              </>
            ) : (
              <p className="mg-status">{room.players[room.activeSlot]} is writing their answer…</p>
            )}
          </>
        )}

        {screen === 'reveal' && room && (
          <>
            <div className="mg-contestant-strip">
              <div className={`mg-contestant ${room.activeSlot === 1 ? 'active' : ''}`}>
                <div className={`mg-contestant-symbol ${slotSymbolClass(1)}`}>{slotSymbol(1)}</div>
                <div className="mg-contestant-name">{room.players[1]}</div>
                <div className="mg-contestant-num">{room.scores[1]}</div>
              </div>
              <div className={`mg-contestant ${room.activeSlot === 2 ? 'active' : ''}`}>
                <div className={`mg-contestant-symbol ${slotSymbolClass(2)}`}>{slotSymbol(2)}</div>
                <div className="mg-contestant-name">{room.players[2]}</div>
                <div className="mg-contestant-num">{room.scores[2]}</div>
              </div>
            </div>

            <p className="mg-status">
              {room.players[room.activeSlot]} ({slotSymbol(room.activeSlot)}) said: <strong>"{room.answer}"</strong>
            </p>
            <div className="mg-prompt">{room.prompt}</div>

            <div className="mg-panel-grid">
              {room.panel.map((p, i) => {
                const shown = i <= revealIndex;
                const matched = shown && room.matches?.[i];
                const activeIsTriangle = room.activeSlot === room.triangleSlot;
                return (
                  <div key={i} className={`mg-panelist ${shown ? 'revealed' : ''} ${matched ? 'matched' : ''}`}>
                    <div className="mg-panelist-name">{p.name}</div>
                    <div className="mg-panelist-tag">{p.tag}</div>
                    <div className={`mg-panelist-answer ${shown ? '' : 'blank'}`}>
                      {shown && p.answer}
                    </div>
                    <div className="mg-symbol-row">
                      <span className={`mg-symbol tri ${matched && activeIsTriangle ? 'lit' : ''}`}>▲</span>
                      <span className={`mg-symbol cir ${matched && !activeIsTriangle ? 'lit' : ''}`}>●</span>
                    </div>
                    {shown && (
                      <button
                        className="mg-speaker-btn"
                        onClick={() => speak({
                          code: roomCode,
                          slot: i,
                          text: p.answer,
                          fallbackProfile: { ...VOICE_PROFILES[i % VOICE_PROFILES.length], voiceIdx: i + 1 },
                        })}
                        title="Hear it again"
                      >♪</button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {screen === 'scored' && room && (
          <>
            <p className="mg-status">Round {room.round} complete</p>

            <div className="mg-contestant-strip">
              <div className="mg-contestant">
                <div className={`mg-contestant-symbol ${slotSymbolClass(1)}`}>{slotSymbol(1)}</div>
                <div className="mg-contestant-name">{room.players[1]}</div>
                <div className="mg-contestant-num">{room.scores[1]}</div>
                {room.activeSlot === 1 && (
                  <div style={{ fontSize: 11, marginTop: 4 }}>+{room.matches.filter(Boolean).length} this round</div>
                )}
              </div>
              <div className="mg-contestant">
                <div className={`mg-contestant-symbol ${slotSymbolClass(2)}`}>{slotSymbol(2)}</div>
                <div className="mg-contestant-name">{room.players[2]}</div>
                <div className="mg-contestant-num">{room.scores[2]}</div>
                {room.activeSlot === 2 && (
                  <div style={{ fontSize: 11, marginTop: 4 }}>+{room.matches.filter(Boolean).length} this round</div>
                )}
              </div>
            </div>

            <div className="mg-prompt">{room.prompt}</div>
            <p className="mg-status">
              {room.players[room.activeSlot]} ({slotSymbol(room.activeSlot)}) said: <strong>"{room.answer}"</strong>
            </p>

            <div className="mg-panel-grid">
              {room.panel.map((p, i) => {
                const matched = room.matches?.[i];
                const activeIsTriangle = room.activeSlot === room.triangleSlot;
                return (
                  <div key={i} className={`mg-panelist revealed ${matched ? 'matched' : ''}`}>
                    <div className="mg-panelist-name">{p.name}</div>
                    <div className="mg-panelist-tag">{p.tag}</div>
                    <div className="mg-panelist-answer">{p.answer}</div>
                    <div className="mg-symbol-row">
                      <span className={`mg-symbol tri ${matched && activeIsTriangle ? 'lit' : ''}`}>▲</span>
                      <span className={`mg-symbol cir ${matched && !activeIsTriangle ? 'lit' : ''}`}>●</span>
                    </div>
                    <button
                      className="mg-speaker-btn"
                      onClick={() => speak({
                        code: roomCode,
                        slot: i,
                        text: p.answer,
                        fallbackProfile: { ...VOICE_PROFILES[i % VOICE_PROFILES.length], voiceIdx: i + 1 },
                      })}
                      title="Hear it again"
                    >♪</button>
                  </div>
                );
              })}
            </div>

            {playerSlot === 1 ? (
              <div className="mg-row">
                <button className="mg-btn" onClick={nextRound}>Next Round</button>
              </div>
            ) : (
              <p className="mg-status">Waiting for the host…</p>
            )}
          </>
        )}

        <p className="mg-help" style={{ marginTop: 28 }}>
          {ttsEnabled
            ? 'Voices are AI-generated by OpenAI text-to-speech. They are not the real voices of the people named on the panel.'
            : 'Voices use your device\'s built-in speech synthesis — they\'ll sound different on different devices.'}
        </p>
      </div>
    </div>
  );
}
