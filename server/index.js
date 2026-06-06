import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3001;
const LLM_MODEL = process.env.OPENAI_LLM_MODEL || 'gpt-4o-mini';
const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_VOICES = ['alloy','ash','ballad','coral','echo','fable','onyx','nova','sage','shimmer','verse'];

if (!process.env.OPENAI_API_KEY) {
  console.error('FATAL: OPENAI_API_KEY environment variable is not set.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
console.log(`Match Game server starting. LLM: ${LLM_MODEL}, TTS: ${TTS_MODEL}`);

// ─── ROOM STORE ───────────────────────────────────────────────
const rooms = new Map();
const ROOM_TTL_MS = 1000 * 60 * 60 * 4;

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > ROOM_TTL_MS) rooms.delete(code);
  }
}, 1000 * 60 * 30);

const makeRoomCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
};

const bump = (room) => { room.version++; room.lastActivity = Date.now(); return room; };

// ─── LLM HELPERS ──────────────────────────────────────────────
const callLLM = async (prompt, maxTokens = 1200, jsonMode = false) => {
  const params = {
    model: LLM_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (jsonMode) params.response_format = { type: 'json_object' };
  const response = await openai.chat.completions.create(params);
  return response.choices[0]?.message?.content || '';
};

const extractJSON = (text) => {
  const clean = text.replace(/```json|```/g, '').trim();
  const match = clean.match(/[\[{][\s\S]*[\]}]/);
  return JSON.parse(match ? match[0] : clean);
};

// ─── GAME GENERATION ──────────────────────────────────────────

const CHARACTER_ARCHETYPES = [
  'Old Man Henderson','Tiny Tina','Professor Bumbleworth','Chef Rodriguez',
  'Nurse Nancy','Cowboy Pete','Tourist Tim','Grandma Ethel','Rookie Randy',
  'Millionaire Mortimer','Yoga Instructor Yasmine','Plumber Phil',
  'Librarian Louise','Astronaut Al','Kindergarten Teacher Karen',
  'Pirate Pete','Viking Vern','Scientist Sally','Mime Marcel',
  'Lifeguard Larry','Detective Drake','Clown Carlos','Barber Bob',
  'Judge Judy-Ann','Mailman Morris'
];

const generatePanel = async () => {
  const text = await callLLM(
    `Generate a panel of 6 well-known public figures for a Match Game style game show. Mix actors, musicians, athletes, comedians, TV hosts, internet personalities, and tech figures widely recognizable to adults and older teenagers in 2026. Make it FUN and ECLECTIC — different ages, fields, personalities. Avoid politicians.

For each panelist provide:
- "name": the short public/stage name they are normally known by on screen. No middle names, initials, titles, suffixes, or overly formal full legal names unless that is how the public usually knows them
- "tag": 3-5 word description of their public persona
- "avatarType": one of these sketch styles that best fits them visually: "man_young", "man_middle", "man_older", "woman_young", "woman_middle", "woman_older", "person_athletic", "person_glamorous"
- "voice": best matching OpenAI TTS voice from: ${TTS_VOICES.join(', ')}. (onyx=deep authoritative male, nova=bright friendly female, fable=animated British male, coral=warm expressive female, shimmer=bright female, echo=calm male, alloy=neutral)
- "voiceInstructions": 1-2 sentences on HOW to deliver lines as this person — pace, energy, accent, mannerisms.
- "answerStyle": one of "obvious", "literal", "punny", "wildcard", "deadpan", "chaotic". Use mostly obvious/literal/punny, with only one true wildcard.
- "matchBias": a number from 0.65 to 0.95 describing how hard this panelist usually tries to match contestants.

Assign DIFFERENT voices to different panelists.

Return JSON: {"panel": [{"name":"...","tag":"...","avatarType":"...","voice":"...","voiceInstructions":"...","answerStyle":"...","matchBias":0.8}, ...]}`,
    1500, true
  );
  const parsed = extractJSON(text);
  const panel = Array.isArray(parsed) ? parsed : (parsed.panel || []);
  const validAvatarTypes = ['man_young','man_middle','man_older','woman_young','woman_middle','woman_older','person_athletic','person_glamorous'];
  const usedAvatarTypes = new Set();
  const uniqueAvatarType = (requested) => {
    const preferred = validAvatarTypes.includes(requested) ? requested : 'man_middle';
    if (!usedAvatarTypes.has(preferred)) { usedAvatarTypes.add(preferred); return preferred; }
    const fallback = validAvatarTypes.find(t => !usedAvatarTypes.has(t)) || preferred;
    usedAvatarTypes.add(fallback);
    return fallback;
  };
  const cleanPanelName = (name = '') => String(name)
    .replace(/\b(Mr|Mrs|Ms|Miss|Dr|Sir|Dame)\.?\s+/gi, '')
    .replace(/\s+(Jr|Sr|II|III|IV)\.?$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return panel.slice(0, 6).map(p => ({
    name: cleanPanelName(p.name),
    tag: p.tag,
    avatarType: uniqueAvatarType(p.avatarType),
    voice: TTS_VOICES.includes(p.voice) ? p.voice : 'alloy',
    voiceInstructions: p.voiceInstructions || '',
    answerStyle: ['obvious','literal','punny','wildcard','deadpan','chaotic'].includes(p.answerStyle) ? p.answerStyle : 'obvious',
    matchBias: Number.isFinite(Number(p.matchBias)) ? Math.max(0.55, Math.min(0.98, Number(p.matchBias))) : 0.8,
    answer: null,
  }));
};

const generateRoundPrompts = async (usedCharacters = []) => {
  const available = CHARACTER_ARCHETYPES.filter(c => !usedCharacters.includes(c));
  const shuffled = available.sort(() => Math.random() - 0.5);
  const charA = shuffled[0] || 'Old Timer Terry';
  const charB = shuffled[1] || 'Newcomer Nick';

  const text = await callLLM(
    `Generate exactly 2 Match Game style fill-in-the-blank prompts. Use character names "${charA}" and "${charB}" (one per prompt).

WHAT MAKES A GREAT MATCH GAME PROMPT:
1. The blank has ONE obvious intended meaning — no ambiguity about what is being described.
2. The blank invites funny, surprising, cheeky, or mildly risqué 1-2 word answers.
3. The setup gives enough context that everyone immediately understands the situation.
4. A family audience of adults and 17+ teenagers would naturally converge on 2-3 common answers.
5. The best answer should be a normal noun or short phrase, not a complicated sentence.

STYLE TARGET:
- Mostly classic 1970s Match Game setups, but updated with phones, streaming, dating apps, group chats, gyms, TikTok, DoorDash, gaming, school, work, parents, vacations, weddings, and awkward family moments.
- Funny and PG-13 is good; crude, hateful, political, or mean-spirited is bad.

BAD PROMPT (avoid): "Nurse Nancy gave a shot but missed and hit ___"
WHY IT'S BAD: Unclear what she was aiming at. "Arm" is confusing — was that the target or not?

GOOD PROMPTS (this style):
- "Tiny Tina's phone autocorrected 'love you' to 'send ___." (clear: what got sent)
- "Chef Rodriguez's secret ingredient was ___." (clear: what's IN the food)
- "Grandma Ethel joined a dating app and listed ___ as her hobby." (clear: hobby)
- "Rookie Randy got nervous at the gym and dropped a ___ on his foot." (clear: object)
- "Professor Bumbleworth's Zoom background accidentally showed his ___." (clear: embarrassing item/person)
- "Cowboy Pete tried to impress his date by riding a ___." (clear: thing ridden)

SELF-AUDIT BEFORE RETURNING:
For each prompt, silently identify the 3 most likely answers. Reject the prompt and make a new one if the top answers would be scattered, abstract, or hard to spell.

STRUCTURE RULES:
- Vary the structure — don't use the same sentence pattern for both prompts.
- The blank must be at the END or clearly defined in the middle.
- Keep it PG-13 — cheeky is fine, crude is not.
- 10-20 words total per prompt.

Return JSON: {"promptA": "...", "promptB": "...", "charA": "${charA}", "charB": "${charB}"}`,
    500, true
  );
  const parsed = extractJSON(text);
  return {
    promptA: parsed.promptA || `${charA} forgot to bring ___ to the party.`,
    promptB: parsed.promptB || `${charB}'s doctor said they needed more ___ in their life.`,
    charA, charB,
  };
};

const generatePanelAnswers = async (panel, promptText, contestantName, roundNum = 1) => {
  const panelStr = panel.map((p, i) => `${i+1}. ${p.name} (${p.tag}; style=${p.answerStyle || 'obvious'}; matchBias=${p.matchBias ?? 0.8})`).join('\n');
  const targetCommonCount = roundNum === 1 ? 3 : 5;
  const targetCreativeCount = 6 - targetCommonCount;
  const text = await callLLM(
    `You are running a Match Game. The prompt is: "${promptText}"

STEP 1 — Identify the 2-3 most obvious, common answers most people would give for this blank. Think of what a general audience would say most often.

STEP 2 — Each celebrity below gives their answer. IMPORTANT RULES:
- This is regular Round ${roundNum}. Round 1 should be harder; Round 2 should be easier, like classic Match Game.
- EXACTLY ${targetCommonCount} of the 6 celebrities should choose one of the 2-3 obvious answers or a very close synonym.
- The remaining ${targetCreativeCount} can be more creative/in-character, but still plausible.
- Each answer reflects the celebrity's personality in HOW they'd say it, but most still aim for the obvious answer.
- 1-2 WORDS MAXIMUM per answer, no exceptions.
- Celebrities are trying to match ${contestantName}'s answer, so they lean toward common, concrete responses.
- Prefer answer words that are easy to match by synonyms: TV/television, beer/drink, abs/muscles, car/vehicle, phone/cell.

Panel:
${panelStr}

Return JSON: {"answers": ["word","word","word","word","word","word"]}`,
    400, true
  );
  const parsed = extractJSON(text);
  const answers = Array.isArray(parsed) ? parsed : (parsed.answers || []);
  return answers.map(a => (a || '???').split(/\s+/).slice(0, 2).join(' '));
};

const generateSuperMatchPrompt = async () => {
  const text = await callLLM(
    `Generate ONE Super Match fill-in-the-blank phrase. 

STRICT FORMAT: A single short phrase with exactly one blank marked as ___
STRICT LENGTH: 2-5 words total (including the blank)
NO character names, NO sentences, NO punctuation at end
Return ONLY the phrase — nothing else, no explanation, no options, no numbering

GOOD examples (return exactly this style):
Television ___
___ Dog  
Birthday ___
___ Party
Hot ___
Baby ___
Rock ___
Christmas ___
___ Star
Netflix ___
Phone ___
___ Chat
Gym ___
___ Selfie

Return one phrase only:`,
    60
  );
  // Take only the first line to prevent multi-prompt responses
  const firstLine = text.trim().split('\n')[0].trim();
  return firstLine.replace(/^["'\d.\-\s]+|["']+$/g, '').trim();
};

const generateSuperMatchAnswers = async (prompt, celebNames) => {
  // Generate the 3 canonical "best" answers AND the celeb suggestions
  const text = await callLLM(
    `Super Match game show round. The fill-in-the-blank prompt is: "${prompt}"

Part 1: Generate the TOP 3 most popular/obvious answers that a general audience survey of adults and 17+ teenagers would give. Rank them 1st (most popular), 2nd, 3rd. Each must be 1-2 words. Use classic Match Game survey logic: obvious beats clever.

Part 2: Generate suggested answers for these celebrities: ${celebNames.join(', ')}. Each celeb gives 1-2 words — they're trying to help the contestant guess the most popular answer. At least 2 of the 3 celebrities should suggest one of the top 3 answers exactly or a close synonym.

Return JSON:
{
  "topAnswers": [
    {"rank": 1, "answer": "...", "value": 1000},
    {"rank": 2, "answer": "...", "value": 250},
    {"rank": 3, "answer": "...", "value": 100}
  ],
  "celebAnswers": ["answer for celeb 1", "answer for celeb 2", "answer for celeb 3"]
}`,
    500, true
  );
  return extractJSON(text);
};

const generateFinalMatchPrompt = async () => {
  const text = await callLLM(
    `Generate a Final Match fill-in-the-blank prompt. Similar to Super Match — short, 2-5 words total, one blank. Should have one VERY obvious most-popular answer that two people thinking alike would likely both say.

Use classic Match Game survey-answer logic, but modern examples are welcome.
Examples: "New Year's ___", "___ Ball", "Rock ___", "___ Music", "___ Star", "Netflix ___", "Phone ___"

Return just the prompt text, nothing else.`,
    80
  );
  return text.trim().replace(/^["']|["']$/g, '');
};

const generateFinalMatchCelebAnswer = async (prompt, celeb, contestantName) => {
  const text = await callLLM(
    `Final Match game show. "${contestantName}" just answered the prompt: "${prompt}"

${celeb.name} (${celeb.tag}) is TRYING VERY HARD to match exactly what ${contestantName} would say. They think carefully about what the most obvious, common answer is — the one most people would give. They want to win for the contestant.

Give ${celeb.name}'s answer. 1-2 WORDS MAXIMUM. Just the answer, nothing else.`,
    30
  );
  return text.trim().split(/\s+/).slice(0, 2).join(' ');
};

// ─── SCORING ──────────────────────────────────────────────────
const SYNONYM_GROUPS = [
  ['tv','television','telly','screen'],
  ['abs','ab','muscle','muscles','sixpack','six pack','pecs','biceps','body'],
  ['beer','drink','drinks','booze','alcohol','liquor','wine','cocktail','beverage'],
  ['phone','cell','cellphone','mobile','iphone','smartphone'],
  ['car','auto','automobile','vehicle','truck','ride'],
  ['money','cash','bucks','dollars','dough'],
  ['butt','bum','rear','behind','bottom'],
  ['bathroom','toilet','washroom','restroom','loo'],
  ['dog','puppy','pooch'],
  ['cat','kitten','kitty'],
  ['mom','mother','mum','mama'],
  ['dad','father','papa'],
  ['doctor','physician','doc'],
  ['cop','police','officer'],
  ['gym','fitness','workout'],
  ['text','message','dm','chat'],
  ['television show','tv show','show','series'],
];

const norm = (s) => (s||'')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9 ]/g,' ')
  .replace(/\b(a|an|the|my|your|his|her|their|some)\b/g, ' ')
  .replace(/\s+/g,' ')
  .trim();

const singularize = (w) => w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
const canonToken = (token) => {
  const t = singularize(token);
  for (const group of SYNONYM_GROUPS) {
    if (group.map(norm).map(singularize).includes(t)) return norm(group[0]);
  }
  return t;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const canonPhrase = (s) => {
  let out = norm(s).replace(/six pack/g, 'sixpack');
  for (const group of SYNONYM_GROUPS) {
    const canonical = norm(group[0]);
    for (const alias of group) {
      const a = norm(alias).replace(/six pack/g, 'sixpack');
      out = out.replace(new RegExp(`\\b${escapeRegex(a)}\\b`, 'g'), canonical);
    }
  }
  return out.split(/\s+/).filter(Boolean).map(canonToken).join(' ').trim();
};

const fuzzyMatch = (a, b) => {
  const na = canonPhrase(a), nb = canonPhrase(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 3 && nb.includes(na)) return true;
  if (nb.length >= 3 && na.includes(nb)) return true;
  const wa = na.split(/\s+/).filter(w => w.length >= 3).map(canonToken);
  const wb = nb.split(/\s+/).filter(w => w.length >= 3).map(canonToken);
  return wa.some(w => wb.includes(w));
};

const scoreAnswer = (playerAnswer, panel) =>
  panel.map(p => fuzzyMatch(playerAnswer, p.answer || ''));

// ─── API: HEALTH & CONFIG ──────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/config', (req, res) => res.json({ ttsEnabled: true }));

// ─── API: ROOM MANAGEMENT ─────────────────────────────────────
app.post('/api/room', async (req, res) => {
  const { playerName } = req.body;
  if (!playerName?.trim()) return res.status(400).json({ error: 'playerName required' });
  const isDisplay = playerName.trim() === '__display__';
  try {
    const panel = await generatePanel();
    const code = makeRoomCode();
    const room = {
      code, version: 1, lastActivity: Date.now(),
      phase: 'lobby',
      round: 0,
      activeSlot: null,
      turnInRound: 1,
      // Display device created the room — slots 1 and 2 are for contestants
      players: { 1: null, 2: null },
      hasDisplay: isDisplay,
      scores: { 1: 0, 2: 0 },
      triangleSlot: null,
      cointossWinner: null,
      panel,
      round1Matches: { 1: [], 2: [] },
      promptA: null, promptB: null,
      chosenPrompt: null,
      usedCharacters: [],
      contestantAnswer: null,
      panelAnswers: [],
      matches: [],
      superMatchPrompt: null,
      superMatchTopAnswers: null,
      superMatchCelebIndices: [],
      superMatchCelebAnswers: [],
      superMatchRevealIndex: -1,
      superMatchContestantAnswer: null,
      superMatchWinnings: 0,
      finalMatchPrompt: null,
      finalMatchCelebIndex: null,
      finalMatchContestantAnswer: null,
      finalMatchCelebAnswer: null,
      finalMatchResult: null,
      finalMatchWinnings: 0,
    };
    rooms.set(code, room);
    // Display gets no slot; contestants will join as slot 1 and 2
    res.json({ room, slot: null });
  } catch (e) {
    console.error('create room:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/room/:code/join', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'No room with that code' });
  const { playerName } = req.body;
  if (!playerName?.trim()) return res.status(400).json({ error: 'playerName required' });

  // Assign to first open contestant slot
  let slot;
  if (!room.players[1]) {
    slot = 1;
    room.players[1] = playerName.trim().slice(0, 20);
  } else if (!room.players[2]) {
    slot = 2;
    room.players[2] = playerName.trim().slice(0, 20);
  } else {
    return res.status(409).json({ error: 'Room is full' });
  }

  bump(room);
  res.json({ room, slot });

  // Auto-start coin toss when both contestants have joined
  if (room.players[1] && room.players[2]) {
    setTimeout(async () => {
      try {
        room.phase = 'cointoss';
        bump(room);
        setTimeout(() => {
          const winner = Math.random() < 0.5 ? 1 : 2;
          room.triangleSlot = winner;
          room.cointossWinner = winner;
          bump(room);
          setTimeout(async () => {
            try { await startNewRound(room, 1); }
            catch(e) { console.error('start round 1:', e); }
          }, 3000);
        }, 2500);
      } catch(e) { console.error('auto cointoss:', e); }
    }, 1500); // brief pause so both players see the lobby first
  }
});

app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.lastActivity = Date.now();
  res.json({ room });
});

// ─── ROUND LOGIC ──────────────────────────────────────────────
const startNewRound = async (room, roundNum) => {
  const isSuper = roundNum === 'super';
  if (!isSuper) room.round = roundNum;
  room.phase = 'generating';
  bump(room);

  if (!isSuper) {
    // Regular round (1, 2, or tiebreaker 3+)
    room.chosenPrompt = null;
    room.contestantAnswer = null;
    room.panelAnswers = [];
    room.matches = [];
    room.panel = room.panel.map(p => ({ ...p, answer: null }));
    const { promptA, promptB, charA, charB } = await generateRoundPrompts(room.usedCharacters);
    room.promptA = promptA;
    room.promptB = promptB;
    room.usedCharacters.push(charA, charB);

    // Determine who picks first
    if (roundNum === 1) {
      room.activeSlot = room.cointossWinner;
    } else {
      // Lower score picks first (or slot 1 if tied after wipe)
      const s1 = room.scores[1], s2 = room.scores[2];
      room.activeSlot = s1 <= s2 ? 1 : 2;
    }
    room.turnInRound = 1;
    room.phase = 'pick_prompt';
    bump(room);
  } else {
    // Super Match
    room.chosenPrompt = null;
    room.contestantAnswer = null;
    room.matches = [];
    room.panel = room.panel.map(p => ({ ...p, answer: null }));
    const prompt = await generateSuperMatchPrompt();
    room.superMatchPrompt = prompt;
    room.superMatchCelebIndices = [];
    room.superMatchCelebAnswers = [];
    room.superMatchRevealIndex = -1;
    room.superMatchContestantAnswer = null;
    room.superMatchTopAnswers = null;
    room.phase = 'superMatch_pickCelebs';
    bump(room);
  }
};

// Determine the "other" contestant slot
const otherSlot = (slot) => slot === 1 ? 2 : 1;

// ─── API: PICK PROMPT ─────────────────────────────────────────
app.post('/api/room/:code/pick-prompt', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room || room.phase !== 'pick_prompt') return res.status(400).json({ error: 'Not in pick_prompt phase' });
  const { slot, choice } = req.body; // choice: 'A' or 'B'
  if (slot !== room.activeSlot) return res.status(403).json({ error: 'Not your turn to pick' });

  room.chosenPrompt = choice === 'A' ? room.promptA : room.promptB;
  room.phase = 'answering';
  bump(room);
  res.json({ room });
});

// ─── API: SUBMIT ANSWER ───────────────────────────────────────
app.post('/api/room/:code/answer', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room || room.phase !== 'answering') return res.status(400).json({ error: 'Not in answering phase' });
  const { slot, answer } = req.body;
  if (slot !== room.activeSlot) return res.status(403).json({ error: 'Not your turn' });

  room.contestantAnswer = answer.trim().slice(0, 50);
  room.phase = 'generating_answers';
  bump(room);
  res.json({ room });

  try {
    // Generate panel answers for current contestant's prompt. In Round 2, celebrities
    // already matched by this contestant in Round 1 sit out, just like classic Match Game.
    const inactiveCelebIndices = room.round === 2
      ? (room.round1Matches?.[room.activeSlot] || [])
      : [];
    const answers = await generatePanelAnswers(room.panel, room.chosenPrompt, room.players[room.activeSlot], room.round);
    room.panel = room.panel.map((p, i) => inactiveCelebIndices.includes(i)
      ? ({ ...p, answer: null, inactiveThisTurn: true })
      : ({ ...p, answer: answers[i] || '???', inactiveThisTurn: false })
    );
    room.panelAnswers = room.panel.map(p => p.answer);
    const matches = scoreAnswer(room.contestantAnswer, room.panel).map((m, i) => inactiveCelebIndices.includes(i) ? false : m);
    room.matches = matches;
    const matchCount = matches.filter(Boolean).length;
    room.scores[room.activeSlot] += matchCount;

    // Track which celebs this contestant matched in round 1
    if (room.round === 1) {
      room.round1Matches[room.activeSlot] = matches.map((m,i) => m ? i : -1).filter(i => i >= 0);
    }

    room.phase = 'revealing';
    bump(room);
  } catch(e) {
    console.error('generate answers:', e);
    room.phase = 'error';
    bump(room);
  }
});

// ─── API: REVEAL DONE ─────────────────────────────────────────
app.post('/api/room/:code/reveal-done', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ room: bump(room) });

  // Determine what happens next
  const currentActive = room.activeSlot;

  if (room.turnInRound === 1) {
    // First contestant done — second contestant now picks
    room.turnInRound = 2;
    // The "other" prompt goes to the other contestant
    const other = otherSlot(currentActive);
    room.activeSlot = other;
    room.chosenPrompt = currentActive === 1
      ? (room.promptA === room.chosenPrompt ? room.promptB : room.promptA)
      : (room.promptA === room.chosenPrompt ? room.promptB : room.promptA);
    // Actually just give them the remaining prompt — no pick for contestant 2
    room.panel = room.panel.map(p => ({ ...p, answer: null }));
    room.contestantAnswer = null;
    room.matches = [];
    room.phase = 'answering'; // contestant 2 goes straight to answering
    bump(room);
  } else {
    // Both contestants done this round
    if (room.round === 1) {
      setTimeout(async () => {
        try { await startNewRound(room, 2); }
        catch(e) { console.error('start round 2:', e); }
      }, 3000);
    } else if (room.round >= 2) {
      const s1 = room.scores[1], s2 = room.scores[2];
      if (s1 === s2) {
        // TIE — run a tiebreaker round: wipe scores, start fresh round
        room.scores = { 1: 0, 2: 0 };
        room.round1Matches = { 1: [], 2: [] };
        room.panel = room.panel.map(p => ({ ...p, answer: null }));
        room.phase = 'tiebreaker';
        bump(room);
        setTimeout(async () => {
          try { await startNewRound(room, room.round + 1); }
          catch(e) { console.error('start tiebreaker:', e); }
        }, 4000);
      } else {
        // Winner determined — go to super match
        const leader = s1 > s2 ? 1 : 2;
        room.activeSlot = leader;
        room.panel = room.panel.map(p => ({ ...p, answer: null }));
        room.phase = 'round_end';
        bump(room);
        setTimeout(async () => {
          try { await startNewRound(room, 'super'); }
          catch(e) { console.error('start super match:', e); }
        }, 4000);
      }
    }
  }
});

// ─── API: SUPER MATCH — PICK CELEBS ───────────────────────────
app.post('/api/room/:code/supermatch-pick', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room || room.phase !== 'superMatch_pickCelebs') return res.status(400).json({ error: 'Wrong phase' });
  const { celebIndices } = req.body; // array of 3 panel indices
  if (!Array.isArray(celebIndices) || celebIndices.length !== 3) return res.status(400).json({ error: '3 celebs required' });

  const safeIndices = celebIndices.map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < room.panel.length).slice(0, 3);
  if (safeIndices.length !== 3) return res.status(400).json({ error: 'Invalid celebrity selection' });

  room.superMatchCelebIndices = safeIndices;
  room.phase = 'superMatch_generating';
  bump(room);
  res.json({ room });

  try {
    const celebNames = safeIndices.map(i => room.panel[i].name);
    const result = await generateSuperMatchAnswers(room.superMatchPrompt, celebNames);
    room.superMatchTopAnswers = Array.isArray(result.topAnswers) ? result.topAnswers : [];
    if (room.superMatchTopAnswers.length === 0) {
      room.superMatchTopAnswers = [{ rank: 1, answer: (result.celebAnswers || [])[0] || 'answer', value: 1000 }];
    }
    // Store celeb answers on the panel entries
    safeIndices.forEach((panelIdx, i) => {
      room.panel[panelIdx] = {
        ...room.panel[panelIdx],
        answer: (result.celebAnswers || [])[i] || '???'
      };
    });
    room.superMatchRevealIndex = -1;
    room.phase = 'superMatch_revealing';
    bump(room);
  } catch(e) {
    console.error('supermatch generate:', e);
    room.phase = 'error';
    bump(room);
  }
});

// ─── API: SUPER MATCH — ADVANCE REVEAL ───────────────────────
// Called by display after each celeb answer plays, so phone knows when all are revealed
app.post('/api/room/:code/supermatch-reveal-next', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.superMatchRevealIndex = (room.superMatchRevealIndex ?? -1) + 1;
  const total = room.superMatchCelebIndices?.length || 0;
  if (total > 0 && room.superMatchRevealIndex >= total - 1) {
    room.phase = 'superMatch_answering';
  }
  bump(room);
  res.json({ room });
});

// ─── API: SUPER MATCH — CONTESTANT ANSWER ─────────────────────
app.post('/api/room/:code/supermatch-answer', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { answer } = req.body;
  if (!answer?.trim()) return res.status(400).json({ error: 'answer required' });
  room.superMatchContestantAnswer = answer.trim().slice(0, 50);

  // Score against top answers
  const topAnswers = room.superMatchTopAnswers || [];
  let winnings = 0;
  for (const ta of topAnswers) {
    if (fuzzyMatch(room.superMatchContestantAnswer, ta.answer)) {
      winnings = ta.value;
      break;
    }
  }
  room.superMatchWinnings = winnings;
  room.phase = winnings > 0 ? 'superMatch_won' : 'superMatch_lost';
  bump(room);
  res.json({ room });
});

// ─── API: FINAL MATCH ─────────────────────────────────────────
app.post('/api/room/:code/finalmatch-start', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.phase = 'finalMatch_generating';
  bump(room);
  res.json({ room });

  try {
    const prompt = await generateFinalMatchPrompt();
    room.finalMatchPrompt = prompt;
    room.finalMatchCelebIndex = null;
    room.finalMatchContestantAnswer = null;
    room.finalMatchCelebAnswer = null;
    room.phase = 'finalMatch_pickCeleb';
    bump(room);
  } catch(e) {
    console.error('finalmatch start:', e);
    room.phase = 'error';
    bump(room);
  }
});

app.post('/api/room/:code/finalmatch-pick', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { celebIndex } = req.body;
  if (!Number.isInteger(Number(celebIndex)) || Number(celebIndex) < 0 || Number(celebIndex) >= room.panel.length) {
    return res.status(400).json({ error: 'Invalid celebrity' });
  }
  room.finalMatchCelebIndex = Number(celebIndex);
  room.phase = 'finalMatch_answering';
  bump(room);
  res.json({ room });
});

app.post('/api/room/:code/finalmatch-answer', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { answer } = req.body;
  if (!answer?.trim()) return res.status(400).json({ error: 'answer required' });
  room.finalMatchContestantAnswer = answer.trim().slice(0, 50);
  room.phase = 'finalMatch_generating_celeb';
  bump(room);
  res.json({ room });

  try {
    const celeb = room.panel[room.finalMatchCelebIndex];
    const celebAnswer = await generateFinalMatchCelebAnswer(
      room.finalMatchPrompt, celeb, room.players[room.activeSlot]
    );
    room.finalMatchCelebAnswer = celebAnswer;
    const matched = fuzzyMatch(room.finalMatchContestantAnswer, celebAnswer);
    room.finalMatchResult = matched ? 'win' : 'lose';
    room.finalMatchWinnings = matched ? room.superMatchWinnings * 10 : 0;
    room.phase = 'finalMatch_reveal';
    bump(room);
  } catch(e) {
    console.error('finalmatch celeb answer:', e);
    room.phase = 'error';
    bump(room);
  }
});

app.post('/api/room/:code/finalmatch-done', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.phase = 'gameOver';
  bump(room);
  res.json({ room });
});

// ─── API: TTS ─────────────────────────────────────────────────
app.post('/api/speak', async (req, res) => {
  const { code, slot, text, isAnnouncer } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  let voice = 'alloy', instructions = '';
  if (isAnnouncer) {
    voice = 'onyx';
    instructions = 'Speak with dramatic, theatrical flair of a 1970s game show announcer. Deep, deliberate, with anticipatory pauses. Slightly amused.';
  } else if (code && typeof slot === 'number') {
    const room = rooms.get(code?.toUpperCase());
    if (room?.panel[slot]) {
      voice = room.panel[slot].voice || 'alloy';
      instructions = room.panel[slot].voiceInstructions || '';
    }
  }

  try {
    const audioResponse = await openai.audio.speech.create({
      model: TTS_MODEL, voice,
      input: text.slice(0, 500),
      instructions, response_format: 'mp3',
    });
    const buffer = Buffer.from(await audioResponse.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg').set('Cache-Control', 'no-store').send(buffer);
  } catch(e) {
    console.error('TTS:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── SERVE FRONTEND ───────────────────────────────────────────
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));

app.listen(PORT, () => console.log(`Match Game listening on port ${PORT}`));
