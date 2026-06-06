import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3001;
const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';
const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'];

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const TTS_ENABLED = !!openai;
console.log(`TTS: ${TTS_ENABLED ? 'ENABLED (OpenAI)' : 'DISABLED (no OPENAI_API_KEY) — clients will use browser fallback'}`);

// ─────────────────────────────────────────────────────────────
// IN-MEMORY ROOM STORE
// ─────────────────────────────────────────────────────────────
const rooms = new Map();
const ROOM_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours

// Cleanup stale rooms every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}, 1000 * 60 * 30);

const makeRoomCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
};

// ─────────────────────────────────────────────────────────────
// CLAUDE HELPERS
// ─────────────────────────────────────────────────────────────
const callClaude = async (prompt, maxTokens = 1200) => {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content.map(b => b.text || '').join('');
};

const extractJSON = (text) => {
  const clean = text.replace(/```json|```/g, '').trim();
  const match = clean.match(/[\[{][\s\S]*[\]}]/);
  return JSON.parse(match ? match[0] : clean);
};

const generatePanel = async () => {
  const text = await callClaude(
    `Generate a panel of 6 well-known public figures for a Match Game style game show. Mix actors, musicians, athletes, comedians, TV hosts, and tech figures who are widely recognizable in 2026. Make it a FUN, ECLECTIC mix — different ages, fields, and personalities. Avoid politicians.

For each panelist, provide:
- "name": their full name
- "tag": a short 3-5 word description of their public persona
- "voice": the BEST matching OpenAI TTS voice from this list: ${TTS_VOICES.join(', ')}. Match by gender, pitch, and general tone (e.g. onyx is deep authoritative male; nova is bright friendly female; fable is animated British male; coral is warm expressive female; ballad is slow melodic; sage is thoughtful; verse is dynamic).
- "voiceInstructions": 1-2 sentence instructions telling the TTS model HOW to deliver lines as this person — their pace, energy, accent, distinctive speech patterns, mood. Be specific to their known mannerisms.

IMPORTANT: assign DIFFERENT voices to different panelists when possible. Avoid using the same voice for two panelists in the same panel.

Return ONLY valid JSON, no other text:
[{"name":"...","tag":"...","voice":"...","voiceInstructions":"..."}, ...]`,
    1500
  );
  const panel = extractJSON(text);
  return panel.slice(0, 6).map(p => ({
    name: p.name,
    tag: p.tag,
    voice: TTS_VOICES.includes(p.voice) ? p.voice : 'alloy',
    voiceInstructions: p.voiceInstructions || '',
    answer: null,
  }));
};

const generatePrompt = async () => {
  const text = await callClaude(
    `Generate ONE Match Game style fill-in-the-blank prompt. Match Game prompts are short, slightly absurd, and invite funny one-word or short-phrase answers. They often start with a character name ("Dumb Dora", "Old Man Periwinkle", "Tiny Tina") doing something exaggerated.

Examples of the style:
- "Dumb Dora was so dumb, she tried to eat her ___."
- "The fish was so big, it took ___ people to reel it in."
- "When the magician waved his wand, the audience turned into ___."
- "My uncle is so cheap, for his wedding he gave the bride a ___."

Generate ONE new prompt in this style. Use ___ as the blank. Keep it PG-13 — mildly cheeky is fine, but nothing offensive. Return ONLY the prompt itself, no quotes, no preamble.`,
    200
  );
  return text.trim().replace(/^["']|["']$/g, '');
};

const generatePanelAnswers = async (panel, promptText) => {
  const panelStr = panel.map((p, i) => `${i + 1}. ${p.name} (${p.tag})`).join('\n');
  const text = await callClaude(
    `You are running a Match Game style game show. The fill-in-the-blank prompt is:

"${promptText}"

These 6 celebrity panelists each give an answer IN CHARACTER as themselves — reflecting their public persona, speech patterns, and known interests. Each answer should be a short word or phrase (1-6 words) that fills the blank. Make answers FUNNY and distinctive — some panelists might give similar answers (that's how players score matches!), others wildly different.

Panel:
${panelStr}

Return ONLY valid JSON, an array of 6 strings in the same order as the panel:
["answer1","answer2","answer3","answer4","answer5","answer6"]`,
    500
  );
  return extractJSON(text);
};

// ─────────────────────────────────────────────────────────────
// SCORING
// ─────────────────────────────────────────────────────────────
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

const scoreAnswer = (playerAnswer, panel) => {
  const a = norm(playerAnswer);
  return panel.map(p => {
    const pa = norm(p.answer || '');
    if (!a || !pa) return false;
    if (a === pa) return true;
    if (a.length >= 3 && pa.includes(a)) return true;
    if (pa.length >= 3 && a.includes(pa)) return true;
    const wordsA = a.split(/\s+/).filter(w => w.length >= 3);
    const wordsB = pa.split(/\s+/).filter(w => w.length >= 3);
    return wordsA.some(w => wordsB.includes(w));
  });
};

// ─────────────────────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

// Create room
app.post('/api/room', async (req, res) => {
  const { playerName } = req.body;
  if (!playerName || !playerName.trim()) {
    return res.status(400).json({ error: 'playerName required' });
  }
  try {
    const panel = await generatePanel();
    const code = makeRoomCode();
    const room = {
      code,
      phase: 'lobby',
      players: { 1: playerName.trim().slice(0, 20), 2: null },
      scores: { 1: 0, 2: 0 },
      triangleSlot: null,
      activeSlot: null,
      cointossWinner: null,
      round: 0,
      prompt: null,
      panel,
      answer: null,
      matches: [],
      version: 1,
      lastActivity: Date.now(),
    };
    rooms.set(code, room);
    res.json({ room, slot: 1 });
  } catch (e) {
    console.error('create room failed:', e);
    res.status(500).json({ error: 'Could not assemble panel: ' + e.message });
  }
});

// Join room
app.post('/api/room/:code/join', (req, res) => {
  const code = req.params.code.toUpperCase();
  const { playerName } = req.body;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'No room with that code' });
  if (room.players[2]) return res.status(409).json({ error: 'Room is full' });
  if (!playerName || !playerName.trim()) {
    return res.status(400).json({ error: 'playerName required' });
  }
  room.players[2] = playerName.trim().slice(0, 20);
  room.version++;
  room.lastActivity = Date.now();
  res.json({ room, slot: 2 });
});

// Poll room state (frontend hits this every ~1.5s)
app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.lastActivity = Date.now();
  res.json({ room });
});

// Flip coin (host only)
app.post('/api/room/:code/cointoss', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.players[2]) return res.status(400).json({ error: 'Waiting for player 2' });
  room.phase = 'cointoss';
  // Resolve after a delay so clients can animate
  setTimeout(() => {
    const triangleSlot = Math.random() < 0.5 ? 1 : 2;
    room.triangleSlot = triangleSlot;
    room.cointossWinner = triangleSlot;
    room.activeSlot = triangleSlot;
    room.version++;
    room.lastActivity = Date.now();
  }, 2500);
  room.version++;
  room.lastActivity = Date.now();
  res.json({ room });
});

// Proceed from coin toss back to lobby (ready to start round)
app.post('/api/room/:code/proceed', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.phase = 'lobby';
  room.version++;
  room.lastActivity = Date.now();
  res.json({ room });
});

// Determine who plays next round
const determineActive = (room) => {
  if (room.round === 0) return room.cointossWinner;
  const s1 = room.scores[1], s2 = room.scores[2];
  if (s1 < s2) return 1;
  if (s2 < s1) return 2;
  return room.cointossWinner;
};

// Start a round (host only)
app.post('/api/room/:code/start-round', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.triangleSlot) return res.status(400).json({ error: 'Coin toss first' });

  try {
    const activeSlot = determineActive(room);
    const promptText = await generatePrompt();
    const answers = await generatePanelAnswers(room.panel, promptText);
    const newPanel = room.panel.map((p, i) => ({ ...p, answer: answers[i] || '???' }));

    room.phase = 'round';
    room.round += 1;
    room.activeSlot = activeSlot;
    room.prompt = promptText;
    room.panel = newPanel;
    room.answer = null;
    room.matches = [];
    room.version++;
    room.lastActivity = Date.now();
    res.json({ room });
  } catch (e) {
    console.error('start round failed:', e);
    res.status(500).json({ error: 'Could not start round: ' + e.message });
  }
});

// Submit answer (active player only)
app.post('/api/room/:code/answer', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { slot, answer } = req.body;
  if (slot !== room.activeSlot) return res.status(403).json({ error: 'Not your turn' });
  if (!answer || !answer.trim()) return res.status(400).json({ error: 'Answer required' });
  if (room.phase !== 'round') return res.status(400).json({ error: 'Not in round phase' });

  const trimmed = answer.trim().slice(0, 50);
  const matches = scoreAnswer(trimmed, room.panel);
  room.answer = trimmed;
  room.matches = matches;
  room.scores[room.activeSlot] += matches.filter(Boolean).length;
  room.phase = 'reveal';
  room.version++;
  room.lastActivity = Date.now();
  res.json({ room });
});

// Mark reveal complete (any client can call; idempotent)
app.post('/api/room/:code/scored', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.phase === 'reveal') {
    room.phase = 'scored';
    room.version++;
    room.lastActivity = Date.now();
  }
  res.json({ room });
});

// Next round (host only) - resets to lobby waiting state
app.post('/api/room/:code/next-round', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.phase = 'lobby';
  room.prompt = null;
  room.answer = null;
  room.matches = [];
  room.panel = room.panel.map(p => ({ ...p, answer: null }));
  room.version++;
  room.lastActivity = Date.now();
  res.json({ room });
});

// Frontend config (so client knows whether to attempt OpenAI TTS or fall back)
app.get('/api/config', (req, res) => {
  res.json({ ttsEnabled: TTS_ENABLED });
});

// Text-to-speech - returns MP3 audio
// Body: { slot: 0-5 for panelist, OR isAnnouncer: true, text: string, code?: string }
app.post('/api/speak', async (req, res) => {
  if (!openai) {
    return res.status(503).json({ error: 'TTS not configured on server' });
  }
  const { code, slot, text, isAnnouncer } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }

  let voice = 'alloy';
  let instructions = '';

  if (isAnnouncer) {
    voice = 'onyx';
    instructions = 'Speak with the dramatic, theatrical flair of a 1970s game show announcer. Deep, deliberate, with anticipatory pauses. Slightly amused, like you are in on a joke with the audience.';
  } else if (code && typeof slot === 'number') {
    const room = rooms.get(code.toUpperCase());
    if (room && room.panel[slot]) {
      voice = room.panel[slot].voice || 'alloy';
      instructions = room.panel[slot].voiceInstructions || '';
    }
  }

  try {
    const audioResponse = await openai.audio.speech.create({
      model: TTS_MODEL,
      voice,
      input: text.slice(0, 500),
      instructions,
      response_format: 'mp3',
    });
    const buffer = Buffer.from(await audioResponse.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (e) {
    console.error('TTS error:', e.message);
    res.status(500).json({ error: 'TTS generation failed: ' + e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// SERVE FRONTEND (built React app)
// ─────────────────────────────────────────────────────────────
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Match Game server listening on port ${PORT}`);
});
