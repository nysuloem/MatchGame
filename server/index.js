import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import path from 'path';
import fs from 'fs';
import initSqlJs from 'sql.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '6mb' }));

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
const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);
const clampInt = (n, min, max) => Math.max(min, Math.min(max, Number.parseInt(n, 10) || min));

const normalizePromptKey = (prompt) => String(prompt || '')
  .toLowerCase()
  .replace(/[“”]/g, '"')
  .replace(/[’]/g, "'")
  .replace(/\s+/g, ' ')
  .trim();
// In-memory no-repeat database for the current server process. Each room also tracks
// its own used prompts so a family play-through never sees an exact repeat.
const GLOBAL_USED_ROUND_PROMPTS = new Set();


const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Persistent prompt memory.
// This uses SQLite via sql.js (pure JS/WASM), so prompt history survives
// restarts/redeployments without needing a native SQLite build step.
const PROMPT_DB_FILE = path.join(DATA_DIR, 'match-game-prompts.sqlite');
const SQL = await initSqlJs({
  locateFile: (file) => {
    const local = path.join(__dirname, 'node_modules', 'sql.js', 'dist', file);
    if (fs.existsSync(local)) return local;
    const workspace = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file);
    if (fs.existsSync(workspace)) return workspace;
    return file;
  }
});
const PROMPT_DB = fs.existsSync(PROMPT_DB_FILE)
  ? new SQL.Database(fs.readFileSync(PROMPT_DB_FILE))
  : new SQL.Database();

PROMPT_DB.run(`
  CREATE TABLE IF NOT EXISTS prompt_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    prompt_key TEXT NOT NULL,
    prompt TEXT NOT NULL,
    first_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    times_used INTEGER NOT NULL DEFAULT 1,
    UNIQUE(kind, prompt_key)
  );

  CREATE INDEX IF NOT EXISTS idx_prompt_history_kind_last
    ON prompt_history(kind, last_used_at DESC);
`);

const savePromptDb = () => {
  try {
    fs.writeFileSync(PROMPT_DB_FILE, Buffer.from(PROMPT_DB.export()));
  } catch (err) {
    console.warn('Could not save SQLite prompt database:', err.message);
  }
};

const dbGet = (sql, params = []) => {
  const stmt = PROMPT_DB.prepare(sql);
  try {
    stmt.bind(params);
    return stmt.step() ? stmt.getAsObject() : undefined;
  } finally {
    stmt.free();
  }
};

const dbAll = (sql, params = []) => {
  const stmt = PROMPT_DB.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
};

const hasPromptBeenUsed = (kind, prompt) => Boolean(dbGet(
  'SELECT 1 FROM prompt_history WHERE kind = ? AND prompt_key = ? LIMIT 1',
  [kind, normalizePromptKey(prompt)]
));

const markPromptUsed = (kind, prompt) => {
  const clean = String(prompt || '').trim();
  if (!clean) return;
  PROMPT_DB.run(`
    INSERT INTO prompt_history (kind, prompt_key, prompt)
    VALUES (?, ?, ?)
    ON CONFLICT(kind, prompt_key) DO UPDATE SET
      last_used_at = CURRENT_TIMESTAMP,
      times_used = times_used + 1
  `, [kind, normalizePromptKey(clean), clean]);
  savePromptDb();
};

const usedPromptSamples = (kind, limit = 80) => dbAll(
  'SELECT prompt FROM prompt_history WHERE kind = ? ORDER BY last_used_at DESC LIMIT ?',
  [kind, limit]
).map(row => row.prompt).filter(Boolean);

const migrateLegacyPromptHistory = () => {
  const legacyFile = path.join(DATA_DIR, 'prompt-history.json');
  if (!fs.existsSync(legacyFile)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    for (const kind of ['round', 'super', 'final']) {
      const values = Object.values(parsed[kind] || {});
      for (const item of values) {
        const prompt = typeof item === 'string' ? item : item?.prompt;
        if (prompt) markPromptUsed(kind, prompt);
      }
    }
  } catch (err) {
    console.warn('Could not migrate legacy prompt-history.json:', err.message);
  }
};
migrateLegacyPromptHistory();

const CELEB_IMAGE_FILE = path.join(DATA_DIR, 'celebrity-images.json');
const loadCelebImageCache = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CELEB_IMAGE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CELEB_IMAGE_FILE, 'utf8'));
  } catch (err) {
    console.warn('Could not load celebrity image cache:', err.message);
    return {};
  }
};
const CELEB_IMAGE_CACHE = loadCelebImageCache();
const saveCelebImageCache = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CELEB_IMAGE_FILE, JSON.stringify(CELEB_IMAGE_CACHE, null, 2));
  } catch (err) {
    console.warn('Could not save celebrity image cache:', err.message);
  }
};
const celebImageKey = (name = '') => String(name || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const fetchJsonWithTimeout = async (url, timeoutMs = 5000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'MatchGameFamily/1.0 (celebrity photos via Wikipedia)'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

const fetchWikipediaHeadshot = async (name) => {
  const key = celebImageKey(name);
  if (!key) return null;
  if (key in CELEB_IMAGE_CACHE) return CELEB_IMAGE_CACHE[key] || null;
  let record = null;
  try {
    const search = await fetchJsonWithTimeout(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(name)}&limit=1&namespace=0&format=json`);
    const title = search?.[1]?.[0] || name;
    const summary = await fetchJsonWithTimeout(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    const imageUrl = summary?.originalimage?.source || summary?.thumbnail?.source || null;
    if (imageUrl) {
      record = {
        imageUrl,
        imageTitle: summary?.title || title,
        imagePageUrl: summary?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`,
        imageSource: 'Wikipedia / Wikimedia Commons',
        imageAttribution: 'Photo via Wikipedia / Wikimedia Commons',
        fetchedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn(`Could not fetch Wikipedia image for ${name}:`, err.message);
  }
  CELEB_IMAGE_CACHE[key] = record;
  saveCelebImageCache();
  return record;
};

const enrichPanelWithWikipediaImages = async (panel = []) => {
  const enriched = await Promise.all((panel || []).map(async (p) => {
    if (!p || p.isHuman) return p;
    const img = await fetchWikipediaHeadshot(p.name);
    return img ? { ...p, ...img } : p;
  }));
  return enriched;
};


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


const BLANK = '__________';
const normalizePromptBlank = (prompt = '') => String(prompt || '')
  .replace(/_{3,}/g, BLANK)
  .replace(/\s+/g, ' ')
  .trim();

const blankCount = (prompt = '') => (String(prompt || '').match(/_{3,}/g) || []).length;
const isDumbDoraPrompt = (prompt = '') => /\bDumb Dora\b/i.test(String(prompt || ''));

const promptIsUsable = (prompt, kind = 'round') => {
  const t = normalizePromptBlank(prompt);
  if (blankCount(t) !== 1) return false;
  if (/\bblank\b/i.test(t)) return false;
  if (/favo[u]?rite/i.test(t)) return false; // this became repetitive and too generic

  // Regular prompts should be short, punchy Match Game setups.
  // Super/Final Match prompts are intentionally short survey-style phrases.
  if (kind === 'round') {
    const words = t.split(/\s+/).length;
    const blankPos = t.indexOf(BLANK);
    const afterBlank = t.slice(blankPos + BLANK.length).replace(/[\s.!?"'’”]+/g, '');
    const blankNearEnd = afterBlank.length === 0 || afterBlank.length <= 16;
    return t.length >= 28 && t.length <= 135 && words <= 24 && blankNearEnd;
  }
  return t.length >= 5 && t.length <= 80;
};

const stripAnswerToBlank = (prompt = '', answer = '') => {
  // Celebrities and survey boards should supply ONLY the missing word/phrase.
  // If the prompt is "Dream __________" and the model says "dream job", keep "job".
  const raw = String(answer || '')
    .replace(/^['"“”‘’]+|['"“”‘’.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  const promptText = normalizePromptBlank(prompt);
  const before = promptText.split(BLANK)[0] || '';
  const after = promptText.split(BLANK)[1] || '';
  const cleanWord = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let out = raw;

  const beforeWords = cleanWord(before).split(/\s+/).filter(w => w.length > 2);
  const afterWords = cleanWord(after).split(/\s+/).filter(w => w.length > 2);
  const rawWords = out.split(/\s+/);
  while (rawWords.length > 1 && beforeWords.includes(cleanWord(rawWords[0]))) rawWords.shift();
  while (rawWords.length > 1 && afterWords.includes(cleanWord(rawWords[rawWords.length - 1]))) rawWords.pop();
  out = rawWords.join(' ');

  // Also remove a multi-word prefix that is literally the prompt text before the blank.
  const beforeNorm = cleanWord(before);
  const outNorm = cleanWord(out);
  if (beforeNorm && outNorm.startsWith(beforeNorm + ' ')) {
    const n = beforeNorm.split(/\s+/).length;
    out = out.split(/\s+/).slice(n).join(' ');
  }
  return (out || raw).split(/\s+/).slice(0, 3).join(' ').trim();
};

const promptsTooSimilar = (a, b) => {
  const na = normalizePromptKey(a).replace(/[^a-z0-9 ]/g, ' ');
  const nb = normalizePromptKey(b).replace(/[^a-z0-9 ]/g, ' ');
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = new Set(na.split(/\s+/).filter(w => w.length > 3));
  const wb = new Set(nb.split(/\s+/).filter(w => w.length > 3));
  if (!wa.size || !wb.size) return false;
  const overlap = [...wa].filter(w => wb.has(w)).length;
  return overlap / Math.min(wa.size, wb.size) >= 0.72;
};

const SUPER_FINAL_FORBIDDEN_ROOTS = new Set([
  'pizza', 'favourite', 'favorite'
]);

const promptRootWords = (prompt = '') => normalizePromptKey(prompt)
  .replace(/_/g, ' ')
  .split(/\s+/)
  .map(w => w.replace(/[^a-z0-9]/g, ''))
  .filter(w => w.length > 3 && !['with','from','that','this','your','their','there','match','game'].includes(w));

const promptHasForbiddenSuperFinalRoot = (prompt = '') => promptRootWords(prompt)
  .some(w => SUPER_FINAL_FORBIDDEN_ROOTS.has(w));

const promptRootAlreadyUsed = (prompt = '', localUsed = []) => {
  const roots = new Set(promptRootWords(prompt));
  if (!roots.size) return false;
  return (localUsed || []).some(oldPrompt => promptRootWords(oldPrompt).some(w => roots.has(w)));
};

const promptAlreadyUsedOrSimilar = (kind, prompt, localUsed = []) => {
  const all = [...localUsed, ...usedPromptSamples(kind, 250)];
  return all.some(p => promptsTooSimilar(prompt, p));
};

// ─── GAME GENERATION ──────────────────────────────────────────

const CLASSIC_MATCH_GAMERS = [
  'Betty White','Richard Dawson','Brett Somers','Charles Nelson Reilly','Fannie Flagg',
  'Nipsey Russell','Patti Deutsch','Marcia Wallace','Joyce Bulifant','Elaine Joyce'
];

const WACKY_SIGNS = [
  'Hi Mom!', 'Lakers Forever!', 'I brake for blanks!', 'Send snacks!', 'Team Triangle!',
  'I regret nothing!', 'Call me maybe!', 'I came to match!', 'Blank me gently!',
  'Save me a seat!', 'Is this thing on?', 'No refunds!', 'Vote for Betty!', 'Ask me after dessert!'
];
const randomSign = () => WACKY_SIGNS[Math.floor(Math.random() * WACKY_SIGNS.length)];


const REGULAR_ROUND_WRITER_STYLE = `
You are the head writer for a 1970s Match Game-inspired comedy game.

The prompt must feel like classic Match Game:
- mild innuendo, double entendre, teasing absurdity, or broad sitcom-style embarrassment is encouraged;
- recurring fictional archetypes are welcome: Dumb Dora, Dumb Donald, Big Betty, Weird Willie, the local streaker, the cheap doctor, the nervous newlywed, the confused plumber;
- the setup should be funny before the blank appears;
- keep it short enough to read aloud smoothly.

But this is still a matching game:
- there must be a clear answer neighborhood;
- do not make the blank so wide open that every panelist gives a totally unrelated answer;
- Round 2 should be easier and more definitive than Round 1;
- use exactly one blank marker, written as __________;
- usually put the blank at the end;
- never write the word "blank" in the screen prompt.
`;

const SUPER_MATCH_WRITER_STYLE = `
You are writing a Match Game Super Match audience-survey clue.
It must be a short common phrase, compound phrase, or phrase completion with exactly one __________ marker.
It should produce ordinary studio-audience answers ranked by popularity.
Avoid weird, gross, meta, overly clever, niche, or random answers.
Avoid overused clues, especially Pizza, Favorite/Favourite, or anything too similar to recent clues.
`;

const FINAL_MATCH_WRITER_STYLE = `
You are writing a Final Match clue for a contestant to match one celebrity exactly.
It must be a short, familiar phrase completion with exactly one __________ marker.
The most obvious answer should be strong enough that two people could independently match.
Avoid awkward/redundant clues and avoid overused roots like Pizza or Favorite/Favourite.
`;
const AI_CONTESTANT_NAMES = [
  'Maggie', 'Eddie', 'Linda', 'Tony', 'Sally',
  'Frankie', 'Rita', 'Bobby', 'Connie', 'Vinnie',
  'Diane', 'Marty'
];
const randomAiContestantName = (taken = []) => {
  const lowerTaken = new Set(taken.map(x => String(x || '').toLowerCase()));
  const available = AI_CONTESTANT_NAMES.filter(n => !lowerTaken.has(n.toLowerCase()));
  const pool = available.length ? available : AI_CONTESTANT_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
};

const PARTING_GIFTS = [
  'a year supply of Rice-A-Roni, the San Francisco treat',
  'a toaster that only works on Wednesdays',
  'a deluxe set of blue index cards and one suspicious marker',
  'a home version of our game, provided someone remembers to build it',
  'a slightly used fondue set and a warm handshake',
  'a gift certificate for one imaginary steak dinner',
  'a fashionable 1970s leisure suit in a colour no one requested',
  'a lifetime supply of absolutely nothing, delivered monthly',
  'a handsome clock radio for your bedside table',
  'a mystery box from the prop department'
];
const randomPartingGift = () => PARTING_GIFTS[Math.floor(Math.random() * PARTING_GIFTS.length)];


const MODERN_PANEL_BACKUPS = [
  { name:'Ryan Reynolds', tag:'quick-witted movie star', avatarType:'man_middle', voice:'verse', voiceInstructions:'Bright, fast, playful game-show delivery.', answerStyle:'punny', matchBias:0.86 },
  { name:'Zendaya', tag:'cool pop-culture icon', avatarType:'woman_young', voice:'nova', voiceInstructions:'Confident, warm, crisp, and amused.', answerStyle:'obvious', matchBias:0.88 },
  { name:'Kevin Hart', tag:'high-energy comedian', avatarType:'man_middle', voice:'ash', voiceInstructions:'Big energy, quick timing, and clear delivery.', answerStyle:'punny', matchBias:0.84 },
  { name:'Taylor Swift', tag:'mega pop storyteller', avatarType:'person_glamorous', voice:'shimmer', voiceInstructions:'Warm, bright, playful, and very clear.', answerStyle:'literal', matchBias:0.87 },
  { name:'Dwayne Johnson', tag:'charismatic action star', avatarType:'person_athletic', voice:'onyx', voiceInstructions:'Big, confident, upbeat, and easy to hear.', answerStyle:'obvious', matchBias:0.89 },
  { name:'Mindy Kaling', tag:'sharp sitcom writer', avatarType:'woman_middle', voice:'coral', voiceInstructions:'Clever, upbeat, dry but friendly.', answerStyle:'deadpan', matchBias:0.85 },
  { name:'Gordon Ramsay', tag:'fiery TV chef', avatarType:'man_middle', voice:'fable', voiceInstructions:'Intense but playful, crisp and theatrical.', answerStyle:'literal', matchBias:0.82 },
  { name:'Billie Eilish', tag:'deadpan music star', avatarType:'woman_young', voice:'sage', voiceInstructions:'Cool, dry, low-key, but audible.', answerStyle:'deadpan', matchBias:0.8 },
  { name:"Shaquille O'Neal", tag:'larger-than-life athlete', avatarType:'person_athletic', voice:'onyx', voiceInstructions:'Booming, playful, generous, and clear.', answerStyle:'obvious', matchBias:0.9 }
];

const CHARACTER_ARCHETYPES = [
  'Old Man Henderson','Tiny Tina','Professor Bumbleworth','Chef Rodriguez',
  'Nurse Nancy','Cowboy Pete','Tourist Tim','Grandma Ethel','Rookie Randy',
  'Millionaire Mortimer','Yoga Instructor Yasmine','Plumber Phil',
  'Librarian Louise','Astronaut Al','Kindergarten Teacher Karen',
  'Pirate Pete','Viking Vern','Scientist Sally','Mime Marcel',
  'Lifeguard Larry','Detective Drake','Clown Carlos','Barber Bob',
  'Judge Judy-Ann','Mailman Morris'
];



const PROMPT_CATEGORIES = [
  'classic dumb misunderstandings', 'dating and romance', 'parents and in-laws',
  'teenagers and group chats', 'neighbors and apartment buildings', 'restaurants and bars',
  'airports and airplanes', 'hotels and cruises', 'doctors dentists and pharmacies',
  'gyms locker rooms and spas', 'office jobs and bosses', 'teachers principals and campus life',
  'police judges and traffic stops', 'shopping malls and returns', 'banks bills and money',
  'cars buses taxis and rideshares', 'pets vets and animal trouble', 'sports fans and locker rooms',
  'camping beaches and cottages', 'supermarkets and convenience stores', 'hair salons and barbers',
  'mechanics plumbers and electricians', 'technology smart homes and passwords', 'streaming reality TV and influencers',
  'game nights karaoke and parties', 'holidays birthdays and family dinners', 'fortune tellers magicians and psychics',
  'pirates astronauts cowboys and old movie types', 'light adult innuendo and double meanings'
];

const FALLBACK_ROUND_PROMPTS = [
  // These are deliberately "definitive" Match Game prompts: one likely answer,
  // a couple of plausible alternates, and room for one funny/innuendo panel answer.
  { prompt: "Grandma Ethel's dating profile said she was looking for a man with a big ___.", answers: ['wallet','heart','truck'], category: 'dating' },
  { prompt: "Rookie Randy got nervous at the gym and dropped a ___ on his foot.", answers: ['weight','dumbbell','barbell'], category: 'gym' },
  { prompt: "Tiny Tina's phone autocorrected 'love you' to 'send ___.", answers: ['money','cash','pizza'], category: 'phones' },
  { prompt: "Chef Rodriguez's secret ingredient turned out to be ___.", answers: ['garlic','beer','ketchup'], category: 'food' },
  { prompt: "Professor Bumbleworth's Zoom background accidentally showed his ___.", answers: ['underwear','bed','cat'], category: 'work' },
  { prompt: "Cowboy Pete tried to impress his date by riding a ___.", answers: ['horse','bull','scooter'], category: 'dating' },
  { prompt: "Nurse Nancy said the patient needed less stress and more ___.", answers: ['sleep','wine','vacation'], category: 'health' },
  { prompt: "Tourist Tim packed sunscreen, a swimsuit, and one giant ___.", answers: ['hat','towel','camera'], category: 'vacation' },
  { prompt: "Librarian Louise shushed everyone, then loudly dropped her ___.", answers: ['phone','book','purse'], category: 'work' },
  { prompt: "Millionaire Mortimer surprised everyone by arriving at the wedding in a ___.", answers: ['limo','helicopter','taxi'], category: 'wedding' },
  { prompt: "Yoga Instructor Yasmine said the secret to inner peace is a good ___.", answers: ['nap','stretch','snack'], category: 'gym' },
  { prompt: "Plumber Phil said the bathroom smelled like ___.", answers: ['toilet','fish','garbage'], category: 'home' },
  { prompt: "Detective Drake knew the suspect was guilty when he found the missing ___.", answers: ['phone','wallet','shoe'], category: 'mystery' },
  { prompt: "Astronaut Al's space suit was fine until he sat on a ___.", answers: ['button','rock','taco'], category: 'work' },
  { prompt: "At the family reunion, Uncle Bob hid the good ___ in his jacket.", answers: ['wine','beer','cheese'], category: 'family' },
  { prompt: "Martha's smart fridge refused to open until she said please and bought more ___.", answers: ['milk','beer','cheese'], category: 'home' },
  { prompt: "The gym teacher said the new uniform was just shorts and a giant ___.", answers: ['whistle','shirt','sock'], category: 'school' },
  { prompt: "Dumb Dora thought a dating app swipe meant she had to clean the ___.", answers: ['screen','floor','phone'], category: 'dating apps' },

  { prompt: "Dumb Dora is so dumb, she thought a Hoover was a __________.", answers: ['vacuum','president','dam'], category: 'dumb dora' },
  { prompt: "Dumb Dora is so dumb, she thought Bluetooth was a __________.", answers: ['toothbrush','dentist','phone'], category: 'dumb dora' },
  { prompt: "Dumb Dora is so dumb, she thought a hot spot was a __________.", answers: ['rash','burn','stove'], category: 'dumb dora' },
  { prompt: "Dumb Dora is so dumb, she thought a password was a __________.", answers: ['word','key','door'], category: 'dumb dora' },
  { prompt: "Dumb Dora is so dumb, she thought a streaming service was a __________.", answers: ['plumber','river','shower'], category: 'dumb dora' },
  { prompt: "Dumb Dora is so dumb, she thought an influencer was a __________.", answers: ['doctor','fan','virus'], category: 'dumb dora' },
  { prompt: "The influencer's beach photo was ruined when a seagull stole her ___.", answers: ['sandwich','phone','bikini'], category: 'social media' },
  { prompt: "At the office party, Steve accidentally photocopied his ___.", answers: ['butt','face','hand'], category: 'work' },
  { prompt: "The hotel said breakfast was included, but it was only a single ___.", answers: ['muffin','egg','banana'], category: 'travel' },
  { prompt: "The dog groomer gave Mr. Jenkins' poodle a haircut that looked like a ___.", answers: ['mop','lion','rat'], category: 'pets' },
  { prompt: "The new car came with heated seats and a talking ___.", answers: ['dashboard','steering wheel','cupholder'], category: 'cars' },
  { prompt: "At karaoke night, Kevin got booed after singing into a ___.", answers: ['banana','remote','brush'], category: 'parties' },
  { prompt: "Brett said her new boyfriend was cheap because he proposed with a ___.", answers: ['coupon','ring pop','cheque'], category: 'dating' },
  { prompt: "The dentist told Marvin to open wide, then found a ___ in there.", answers: ['toothbrush','cavity','sandwich'], category: 'health' },
  { prompt: "Dumb Derek brought flowers to his date, but they were actually ___.", answers: ['weeds','plastic','broccoli'], category: 'dating' },
  { prompt: "The lifeguard blew his whistle when he saw Grandma doing ___ in the pool.", answers: ['cannonballs','yoga','laundry'], category: 'vacation' },
  { prompt: "At the buffet, Uncle Lou filled his pockets with ___.", answers: ['shrimp','bread','cheese'], category: 'family' },
  { prompt: "The bride was late because her dress got stuck in the ___.", answers: ['door','car','elevator'], category: 'wedding' },
  { prompt: "The influencer said her secret to beauty was sleep, water, and a little ___.", answers: ['makeup','wine','filter'], category: 'social media' },
  { prompt: "The substitute teacher lost control when the class hid his ___.", answers: ['glasses','phone','pants'], category: 'school' },
  { prompt: "At the dog park, Helen was embarrassed when her dog stole a man's ___.", answers: ['hotdog','hat','shorts'], category: 'pets' },
  { prompt: "The mechanic said the car's problem was too much ___ in the engine.", answers: ['oil','water','cheese'], category: 'cars' },
  { prompt: "The magician's trick went wrong when he pulled a ___ out of his pants.", answers: ['rabbit','phone','sock'], category: 'parties' },
  { prompt: "Grandpa's smartwatch said his heart rate jumped when he saw ___.", answers: ['Grandma','beer','Betty'], category: 'family' },
  { prompt: "The waiter dropped the tray when the customer asked for extra ___.", answers: ['cheese','sauce','napkins'], category: 'restaurants' },
  { prompt: "At the gym, Pamela said she only came to exercise her ___.", answers: ['mouth','thumbs','eyes'], category: 'gym' },
  { prompt: "The office printer jammed because someone tried to print a ___.", answers: ['sandwich','cheque','photo'], category: 'work' },
  { prompt: "On movie night, Dad cried when someone ate the last ___.", answers: ['popcorn','chip','cookie'], category: 'family' },
  { prompt: "The yoga class got awkward when Steve's pose revealed his ___.", answers: ['butt','underwear','belly'], category: 'gym' },
  { prompt: "The teenager said the family vacation was ruined because there was no ___.", answers: ['wifi','signal','phone'], category: 'vacation' },
  { prompt: "The bachelor party ended early when the groom lost his ___.", answers: ['pants','ring','wallet'], category: 'wedding' },
  { prompt: 'Dumb Donald thought a selfie stick was something you used to stir ___.', answers: ['coffee', 'soup', 'paint'], category: 'phones' },
  { prompt: 'At the casino, Aunt Linda bet her entire paycheck on ___.', answers: ['black', 'red', 'horses'], category: 'money' },
  { prompt: 'The dentist told me to floss more, so I tried flossing with ___.', answers: ['string', 'spaghetti', 'hair'], category: 'health' },
  { prompt: 'The dating app said Brenda matched with someone who loved long walks and short ___.', answers: ['pants', 'texts', 'relationships'], category: 'dating' },
  { prompt: 'The food delivery driver got confused and brought us a bag full of ___.', answers: ['fries', 'napkins', 'socks'], category: 'food delivery' },
  { prompt: 'The teenager said the worst punishment was losing access to ___.', answers: ['wifi', 'phone', 'TikTok'], category: 'family' },
  { prompt: 'At Thanksgiving, Grandpa carved the turkey with a ___.', answers: ['chainsaw', 'knife', 'fork'], category: 'family' },
  { prompt: 'The new smart toilet refused to flush until it heard a ___.', answers: ['compliment', 'password', 'song'], category: 'home' },
  { prompt: 'The bride threw her bouquet and knocked over the ___.', answers: ['cake', 'grandma', 'photographer'], category: 'wedding' },
  { prompt: 'The lifeguard said no running, no diving, and absolutely no ___.', answers: ['peeing', 'screaming', 'dancing'], category: 'pool' },
  { prompt: 'At the office meeting, Karen accidentally shared her screen and everyone saw her ___.', answers: ['emails', 'shopping cart', 'calendar'], category: 'work' },
  { prompt: 'The hotel room was romantic until we found a ___ in the bed.', answers: ['sock', 'bug', 'sandwich'], category: 'travel' },
  { prompt: 'The yoga instructor told everyone to breathe deeply, but Bob smelled like ___.', answers: ['garlic', 'cheese', 'feet'], category: 'gym' },
  { prompt: 'At the school dance, the DJ only played songs about ___.', answers: ['love', 'breakups', 'ducks'], category: 'school' },
  { prompt: 'The mechanic said my car was making that noise because it needed a new ___.', answers: ['belt', 'muffler', 'attitude'], category: 'cars' },
  { prompt: 'The dog looked guilty because he had eaten the ___.', answers: ['homework', 'steak', 'shoe'], category: 'pets' },
  { prompt: 'At karaoke, Grandma brought the house down singing into a ___.', answers: ['microphone', 'hairbrush', 'banana'], category: 'parties' },
  { prompt: 'The doctor told me I was allergic to ___.', answers: ['cats', 'work', 'exercise'], category: 'health' },
  { prompt: 'At the fancy restaurant, Dad embarrassed us by asking for extra ___.', answers: ['ketchup', 'gravy', 'cheese'], category: 'restaurants' },
  { prompt: "The bachelor party got quiet when the stripper turned out to be the groom's ___.", answers: ['mother', 'teacher', 'boss'], category: 'wedding' },
  { prompt: 'The new gym opened with treadmills, weights, and a juice bar full of ___.', answers: ['protein', 'smoothies', 'regret'], category: 'gym' },
  { prompt: 'The substitute teacher knew it was going to be a bad day when a student brought a ___.', answers: ['snake', 'drum', 'megaphone'], category: 'school' },
  { prompt: 'My phone died right before I could send a text that said ___.', answers: ['sorry', 'help', 'yes'], category: 'phones' },
  { prompt: 'The influencer said her breakfast routine starts with coffee and ends with ___.', answers: ['crying', 'selfies', 'eggs'], category: 'social media' },
  { prompt: 'The camping trip was ruined when Dad forgot the ___.', answers: ['tent', 'matches', 'beer'], category: 'vacation' },
  { prompt: 'The family dog joined the Zoom call and showed everyone his ___.', answers: ['tail', 'butt', 'toy'], category: 'pets' },
  { prompt: 'The mall Santa got fired after asking every kid for a ___.', answers: ['tip', 'beer', 'hug'], category: 'holiday' },
  { prompt: 'The real estate agent said the house had charm, character, and a family of ___.', answers: ['mice', 'ghosts', 'raccoons'], category: 'home' },
  { prompt: 'The magician asked for a volunteer and accidentally sawed the ___ in half.', answers: ['table', 'assistant', 'sandwich'], category: 'parties' },
  { prompt: 'The wedding DJ announced the first dance, then played the theme from ___.', answers: ['Jaws', 'Rocky', 'Jeopardy'], category: 'wedding' },
  { prompt: 'The teenager cleaned his room only after we threatened to cancel his ___.', answers: ['wifi', 'data', 'allowance'], category: 'family' },
  { prompt: 'The restaurant called it a seafood platter, but it was mostly ___.', answers: ['shrimp', 'fish', 'ice'], category: 'restaurants' },
  { prompt: 'The office Christmas party ended when someone photocopied the ___.', answers: ['boss', 'ham', 'mistletoe'], category: 'work' },
  { prompt: 'The school principal banned phones, hats, and anything shaped like a ___.', answers: ['banana', 'weapon', 'duck'], category: 'school' },
  { prompt: 'On the first date, she knew he was cheap when he split the ___.', answers: ['bill', 'fries', 'coupon'], category: 'dating' },
  { prompt: 'The GPS said turn left, but Uncle Frank drove into a ___.', answers: ['ditch', 'lake', 'driveway'], category: 'cars' },
  { prompt: 'The baby shower got awkward when everyone brought the same ___.', answers: ['diapers', 'blanket', 'cake'], category: 'family' },
  { prompt: 'The hot tub party ended when someone dropped in a ___.', answers: ['phone', 'sandwich', 'dog'], category: 'parties' },
  { prompt: 'The new restaurant serves fusion food: sushi, tacos, and ___.', answers: ['pizza', 'poutine', 'regret'], category: 'restaurants' },
  { prompt: 'The fitness tracker congratulated Dad for walking to the ___.', answers: ['fridge', 'bathroom', 'couch'], category: 'gym' },
  { prompt: "The cruise director said tonight's entertainment is karaoke and competitive ___.", answers: ['dancing', 'bingo', 'napping'], category: 'vacation' },
  { prompt: 'The barber asked what I wanted, and I said anything except a ___.', answers: ['mullet', 'buzzcut', 'perm'], category: 'hair' },
  { prompt: 'The dog trainer said the problem was not the dog, it was the ___.', answers: ['owner', 'leash', 'treats'], category: 'pets' },
  { prompt: 'The dentist said I needed a crown, but I thought he meant a ___.', answers: ['king', 'hat', 'tiara'], category: 'health' },
  { prompt: 'The new dating show is called Love Is Blind, Deaf, and ___.', answers: ['confused', 'hungry', 'broke'], category: 'dating' },
  { prompt: 'The fortune teller looked at my palm and said I would soon lose my ___.', answers: ['money', 'hair', 'patience'], category: 'weird' },
  { prompt: 'The chef cried when the critic compared his soup to ___.', answers: ['dishwater', 'gravy', 'mud'], category: 'food' },
  { prompt: 'The babysitter quit after the children taught the parrot to say ___.', answers: ['no', 'help', 'bad words'], category: 'family' },
  { prompt: 'At the picnic, ants ignored the watermelon and went straight for the ___.', answers: ['cake', 'beer', 'chips'], category: 'food' },
  { prompt: 'The gym posted a sign: please wipe down equipment and do not flirt with the ___.', answers: ['mirror', 'trainer', 'weights'], category: 'gym' },
  { prompt: 'My online order said discreet packaging, but the box was shaped like a giant ___.', answers: ['heart', 'banana', 'toilet'], category: 'shopping' },
  { prompt: 'The boss tried to boost morale by replacing bonuses with ___.', answers: ['pizza', 'coupons', 'hugs'], category: 'work' },
  { prompt: 'The party was BYOB, but Ted thought that meant bring your own ___.', answers: ['blanket', 'banana', 'boss'], category: 'parties' },
  { prompt: 'The airport security guard opened my suitcase and found twelve ___.', answers: ['socks', 'bananas', 'cheeses'], category: 'travel' },
  { prompt: 'The doctor said my blood pressure was high because I watch too much ___.', answers: ['news', 'sports', 'reality TV'], category: 'health' },
  { prompt: 'The family game night ended when Grandma accused everyone of cheating at ___.', answers: ['cards', 'Monopoly', 'bingo'], category: 'family' },
  { prompt: 'The romantic picnic was ruined when it started raining ___.', answers: ['bugs', 'frogs', 'hotdogs'], category: 'dating' },
  { prompt: 'The teacher said my essay was original because no one else wrote about ___.', answers: ['pizza', 'aliens', 'laundry'], category: 'school' },
  { prompt: "The influencer's apology video was sponsored by ___.", answers: ['makeup', 'pizza', 'therapy'], category: 'social media' },
  { prompt: 'The new luxury car has leather seats and a built-in ___.', answers: ['espresso machine', 'massage', 'toaster'], category: 'cars' },
  { prompt: 'The plumber said he found the problem: someone flushed a ___.', answers: ['toy', 'phone', 'sandwich'], category: 'home' },
  { prompt: 'The groom said his vows from the heart, but read them off his ___.', answers: ['phone', 'hand', 'napkin'], category: 'wedding' },
  { prompt: 'The waitress said the soup of the day was ___.', answers: ['chicken', 'tomato', 'mystery'], category: 'restaurants' },
  { prompt: 'The teenager said he was doing homework, but his laptop was open to ___.', answers: ['games', 'YouTube', 'Netflix'], category: 'school' },
  { prompt: 'The camping guide said to scare bears away by waving your ___.', answers: ['arms', 'flashlight', 'sandwich'], category: 'vacation' },
  { prompt: 'The family group chat exploded when Mom sent a picture of her ___.', answers: ['cat', 'dinner', 'feet'], category: 'phones' },
  { prompt: 'The haunted house was scary until the ghost asked for my ___.', answers: ['password', 'number', 'WiFi'], category: 'weird' },
  { prompt: 'The personal trainer said my core was weak, especially my ___.', answers: ['abs', 'back', 'willpower'], category: 'gym' },
  { prompt: 'The bride wanted something blue, so Uncle Lou painted the ___.', answers: ['cake', 'dog', 'car'], category: 'wedding' },
  { prompt: 'The waiter said the special comes with fries and a side of ___.', answers: ['salad', 'sauce', 'judgment'], category: 'restaurants' },
  { prompt: 'The new app helps you find parking, romance, and lost ___.', answers: ['keys', 'dogs', 'dignity'], category: 'phones' },
  { prompt: 'The nurse said the thermometer was broken because it read ___.', answers: ['hot', 'dead', 'pizza'], category: 'health' },
  { prompt: 'The reality show was cancelled when all the contestants fell in love with the ___.', answers: ['host', 'producer', 'camera man'], category: 'tv' },
  { prompt: 'The family vacation photo was perfect until Dad lost his ___.', answers: ['pants', 'hat', 'glasses'], category: 'vacation' }
];

const FALLBACK_SUPER_PROMPTS = [
  { prompt:'Television ___', topAnswers:[{rank:1,answer:'Show',value:500},{rank:2,answer:'Set',value:250},{rank:3,answer:'Remote',value:100}] },
  { prompt:'Birthday ___', topAnswers:[{rank:1,answer:'Cake',value:500},{rank:2,answer:'Party',value:250},{rank:3,answer:'Gift',value:100}] },
  { prompt:'___ Dog', topAnswers:[{rank:1,answer:'Hot',value:500},{rank:2,answer:'Guard',value:250},{rank:3,answer:'Big',value:100}] },
  { prompt:'Phone ___', topAnswers:[{rank:1,answer:'Call',value:500},{rank:2,answer:'Case',value:250},{rank:3,answer:'Number',value:100}] },
  { prompt:'Hot ___', topAnswers:[{rank:1,answer:'Dog',value:500},{rank:2,answer:'Tub',value:250},{rank:3,answer:'Sauce',value:100}] },
  { prompt:'Movie ___', topAnswers:[{rank:1,answer:'Star',value:500},{rank:2,answer:'Night',value:250},{rank:3,answer:'Theater',value:100}] },
  { prompt:'___ Party', topAnswers:[{rank:1,answer:'Birthday',value:500},{rank:2,answer:'House',value:250},{rank:3,answer:'Pool',value:100}] },
  { prompt:'Gym ___', topAnswers:[{rank:1,answer:'Rat',value:500},{rank:2,answer:'Bag',value:250},{rank:3,answer:'Class',value:100}] },
  { prompt:'___ Chat', topAnswers:[{rank:1,answer:'Group',value:500},{rank:2,answer:'Video',value:250},{rank:3,answer:'Snap',value:100}] },
  { prompt:'First ___', topAnswers:[{rank:1,answer:'Date',value:500},{rank:2,answer:'Kiss',value:250},{rank:3,answer:'Love',value:100}] },
  { prompt:'Coffee ___', topAnswers:[{rank:1,answer:'Cup',value:500},{rank:2,answer:'Shop',value:250},{rank:3,answer:'Break',value:100}] },
  { prompt:'Wedding ___', topAnswers:[{rank:1,answer:'Cake',value:500},{rank:2,answer:'Ring',value:250},{rank:3,answer:'Dress',value:100}] },
  { prompt:'School ___', topAnswers:[{rank:1,answer:'Bus',value:500},{rank:2,answer:'Dance',value:250},{rank:3,answer:'Lunch',value:100}] },
  { prompt:'Christmas ___', topAnswers:[{rank:1,answer:'Tree',value:500},{rank:2,answer:'Gift',value:250},{rank:3,answer:'Party',value:100}] },
  { prompt:'Rock ___', topAnswers:[{rank:1,answer:'Star',value:500},{rank:2,answer:'Music',value:250},{rank:3,answer:'Band',value:100}] },
  { prompt:'Car ___', topAnswers:[{rank:1,answer:'Keys',value:500},{rank:2,answer:'Wash',value:250},{rank:3,answer:'Seat',value:100}] },
  { prompt:'Pizza ___', topAnswers:[{rank:1,answer:'Pie',value:500},{rank:2,answer:'Slice',value:250},{rank:3,answer:'Delivery',value:100}] },
  { prompt:'Dating ___', topAnswers:[{rank:1,answer:'App',value:500},{rank:2,answer:'Game',value:250},{rank:3,answer:'Profile',value:100}] },
  { prompt:'___ Room', topAnswers:[{rank:1,answer:'Living',value:500},{rank:2,answer:'Bed',value:250},{rank:3,answer:'Dining',value:100}] },
  { prompt:'___ Money', topAnswers:[{rank:1,answer:'Cash',value:500},{rank:2,answer:'Prize',value:250},{rank:3,answer:'Blood',value:100}] },
  { prompt:'Game ___', topAnswers:[{rank:1,answer:'Show',value:500},{rank:2,answer:'Night',value:250},{rank:3,answer:'Board',value:100}] },
  { prompt:'Blank ___', topAnswers:[{rank:1,answer:'Slate',value:500},{rank:2,answer:'Check',value:250},{rank:3,answer:'Page',value:100}] },
  { prompt:'Family ___', topAnswers:[{rank:1,answer:'Feud',value:500},{rank:2,answer:'Dinner',value:250},{rank:3,answer:'Tree',value:100}] },
  { prompt:'Ice ___', topAnswers:[{rank:1,answer:'Cream',value:500},{rank:2,answer:'Cube',value:250},{rank:3,answer:'Skate',value:100}] },
  { prompt:'Baby ___', topAnswers:[{rank:1,answer:'Shower',value:500},{rank:2,answer:'Bottle',value:250},{rank:3,answer:'Food',value:100}] },
  { prompt:'Bank ___', topAnswers:[{rank:1,answer:'Account',value:500},{rank:2,answer:'Robber',value:250},{rank:3,answer:'Teller',value:100}] },
  { prompt:'___ Night', topAnswers:[{rank:1,answer:'Date',value:500},{rank:2,answer:'Game',value:250},{rank:3,answer:'Movie',value:100}] },
  { prompt:'___ Face', topAnswers:[{rank:1,answer:'Poker',value:500},{rank:2,answer:'Baby',value:250},{rank:3,answer:'Duck',value:100}] },
  { prompt:'Magic ___', topAnswers:[{rank:1,answer:'Trick',value:500},{rank:2,answer:'Wand',value:250},{rank:3,answer:'Show',value:100}] },
  { prompt:'Love ___', topAnswers:[{rank:1,answer:'Letter',value:500},{rank:2,answer:'Song',value:250},{rank:3,answer:'Boat',value:100}] },
  { prompt:'Dinner ___', topAnswers:[{rank:1,answer:'Table',value:500},{rank:2,answer:'Date',value:250},{rank:3,answer:'Party',value:100}] },
  { prompt:'___ School', topAnswers:[{rank:1,answer:'High',value:500},{rank:2,answer:'Old',value:250},{rank:3,answer:'Night',value:100}] },
  { prompt:'___ Check', topAnswers:[{rank:1,answer:'Rain',value:500},{rank:2,answer:'Blank',value:250},{rank:3,answer:'Pay',value:100}] },
  { prompt:'Kitchen ___', topAnswers:[{rank:1,answer:'Sink',value:500},{rank:2,answer:'Table',value:250},{rank:3,answer:'Knife',value:100}] },
  { prompt:'Party ___', topAnswers:[{rank:1,answer:'Animal',value:500},{rank:2,answer:'Hat',value:250},{rank:3,answer:'Favor',value:100}] },
  { prompt:'___ Bag', topAnswers:[{rank:1,answer:'Garbage',value:500},{rank:2,answer:'Gym',value:250},{rank:3,answer:'Tea',value:100}] },
  { prompt:'Blue ___', topAnswers:[{rank:1,answer:'Moon',value:500},{rank:2,answer:'Jeans',value:250},{rank:3,answer:'Cheese',value:100}] },
  { prompt:'Rain ___', topAnswers:[{rank:1,answer:'Coat',value:500},{rank:2,answer:'Check',value:250},{rank:3,answer:'Drop',value:100}] },
  { prompt:'Pay ___', topAnswers:[{rank:1,answer:'Check',value:500},{rank:2,answer:'Day',value:250},{rank:3,answer:'Phone',value:100}] },
  { prompt:'Dream ___', topAnswers:[{rank:1,answer:'Job',value:500},{rank:2,answer:'House',value:250},{rank:3,answer:'Girl',value:100}] },
  { prompt:'Chicken ___', topAnswers:[{rank:1,answer:'Soup',value:500},{rank:2,answer:'Wing',value:250},{rank:3,answer:'Dance',value:100}] },
  { prompt:'Cold ___', topAnswers:[{rank:1,answer:'Beer',value:500},{rank:2,answer:'Water',value:250},{rank:3,answer:'Feet',value:100}] },
  { prompt:'Big ___', topAnswers:[{rank:1,answer:'Mouth',value:500},{rank:2,answer:'Deal',value:250},{rank:3,answer:'Mac',value:100}] },
  { prompt:'Fast ___', topAnswers:[{rank:1,answer:'Food',value:500},{rank:2,answer:'Car',value:250},{rank:3,answer:'Money',value:100}] },
  { prompt:'Slow ___', topAnswers:[{rank:1,answer:'Dance',value:500},{rank:2,answer:'Motion',value:250},{rank:3,answer:'Cooker',value:100}] },
  { prompt:'Dirty ___', topAnswers:[{rank:1,answer:'Laundry',value:500},{rank:2,answer:'Dancing',value:250},{rank:3,answer:'Joke',value:100}] },
  { prompt:'Sweet ___', topAnswers:[{rank:1,answer:'Tooth',value:500},{rank:2,answer:'Heart',value:250},{rank:3,answer:'Tea',value:100}] },
  { prompt:'Bad ___', topAnswers:[{rank:1,answer:'Boy',value:500},{rank:2,answer:'Dog',value:250},{rank:3,answer:'News',value:100}] },
  { prompt:'Good ___', topAnswers:[{rank:1,answer:'Luck',value:500},{rank:2,answer:'Night',value:250},{rank:3,answer:'Boy',value:100}] },
  { prompt:'Private ___', topAnswers:[{rank:1,answer:'Eye',value:500},{rank:2,answer:'School',value:250},{rank:3,answer:'Party',value:100}] },
  { prompt:'Secret ___', topAnswers:[{rank:1,answer:'Agent',value:500},{rank:2,answer:'Santa',value:250},{rank:3,answer:'Sauce',value:100}] },
  { prompt:'House ___', topAnswers:[{rank:1,answer:'Party',value:500},{rank:2,answer:'Key',value:250},{rank:3,answer:'Cat',value:100}] },
  { prompt:'Pool ___', topAnswers:[{rank:1,answer:'Party',value:500},{rank:2,answer:'Table',value:250},{rank:3,answer:'Boy',value:100}] },
  { prompt:'Beach ___', topAnswers:[{rank:1,answer:'Ball',value:500},{rank:2,answer:'House',value:250},{rank:3,answer:'Bum',value:100}] },
  { prompt:'Office ___', topAnswers:[{rank:1,answer:'Party',value:500},{rank:2,answer:'Chair',value:250},{rank:3,answer:'Romance',value:100}] },
  { prompt:'Remote ___', topAnswers:[{rank:1,answer:'Control',value:500},{rank:2,answer:'Work',value:250},{rank:3,answer:'Island',value:100}] },
  { prompt:'Text ___', topAnswers:[{rank:1,answer:'Message',value:500},{rank:2,answer:'Book',value:250},{rank:3,answer:'Bubble',value:100}] },
  { prompt:'Group ___', topAnswers:[{rank:1,answer:'Chat',value:500},{rank:2,answer:'Photo',value:250},{rank:3,answer:'Hug',value:100}] },
  { prompt:'Video ___', topAnswers:[{rank:1,answer:'Game',value:500},{rank:2,answer:'Call',value:250},{rank:3,answer:'Tape',value:100}] },
  { prompt:'Credit ___', topAnswers:[{rank:1,answer:'Card',value:500},{rank:2,answer:'Score',value:250},{rank:3,answer:'Union',value:100}] },
  { prompt:'Paper ___', topAnswers:[{rank:1,answer:'Towel',value:500},{rank:2,answer:'Bag',value:250},{rank:3,answer:'Boy',value:100}] },
  { prompt:'Back ___', topAnswers:[{rank:1,answer:'Seat',value:500},{rank:2,answer:'Door',value:250},{rank:3,answer:'Pain',value:100}] },
  { prompt:'Front ___', topAnswers:[{rank:1,answer:'Door',value:500},{rank:2,answer:'Seat',value:250},{rank:3,answer:'Page',value:100}] },
  { prompt:'Side ___', topAnswers:[{rank:1,answer:'Dish',value:500},{rank:2,answer:'Eye',value:250},{rank:3,answer:'Hustle',value:100}] },
  { prompt:'Power ___', topAnswers:[{rank:1,answer:'Nap',value:500},{rank:2,answer:'Tool',value:250},{rank:3,answer:'Couple',value:100}] },
  { prompt:'Love ___', topAnswers:[{rank:1,answer:'Song',value:500},{rank:2,answer:'Letter',value:250},{rank:3,answer:'Bird',value:100}] },
  { prompt:'Money ___', topAnswers:[{rank:1,answer:'Bag',value:500},{rank:2,answer:'Tree',value:250},{rank:3,answer:'Talks',value:100}] },
  { prompt:'Sports ___', topAnswers:[{rank:1,answer:'Car',value:500},{rank:2,answer:'Bar',value:250},{rank:3,answer:'Bra',value:100}] },
  { prompt:'Dinner ___', topAnswers:[{rank:1,answer:'Party',value:500},{rank:2,answer:'Table',value:250},{rank:3,answer:'Plate',value:100}] },
  { prompt:'Kitchen ___', topAnswers:[{rank:1,answer:'Table',value:500},{rank:2,answer:'Sink',value:250},{rank:3,answer:'Knife',value:100}] },
  { prompt:'Bathroom ___', topAnswers:[{rank:1,answer:'Sink',value:500},{rank:2,answer:'Break',value:250},{rank:3,answer:'Humor',value:100}] },
  { prompt:'Bedroom ___', topAnswers:[{rank:1,answer:'Eyes',value:500},{rank:2,answer:'Set',value:250},{rank:3,answer:'Door',value:100}] },
  { prompt:'Morning ___', topAnswers:[{rank:1,answer:'Coffee',value:500},{rank:2,answer:'Person',value:250},{rank:3,answer:'Sickness',value:100}] },
  { prompt:'Night ___', topAnswers:[{rank:1,answer:'Owl',value:500},{rank:2,answer:'Light',value:250},{rank:3,answer:'Club',value:100}] },
  { prompt:'Happy ___', topAnswers:[{rank:1,answer:'Hour',value:500},{rank:2,answer:'Birthday',value:250},{rank:3,answer:'Meal',value:100}] },
  { prompt:'Open ___', topAnswers:[{rank:1,answer:'Bar',value:500},{rank:2,answer:'House',value:250},{rank:3,answer:'Door',value:100}] }
];

const generatePanel = async () => {
  const classic = CLASSIC_MATCH_GAMERS[Math.floor(Math.random() * CLASSIC_MATCH_GAMERS.length)];
  const varietySeed = Math.random().toString(36).slice(2, 8);
  const text = await callLLM(
    `Generate a panel of 6 well-known public figures for a Match Game style game show.

CRITICAL PANEL RULES:
- Include EXACTLY ONE classic Match Game regular: ${classic}.
- The other 5 panelists should feel like people who plausibly belong on a current IMDb STARmeter / current pop-culture Top 100 list: recognizable film/TV actors, comedians, hosts, musicians, athletes, and internet/pop-culture figures. Do not actually claim you checked IMDb live.
- Make the five modern choices highly varied: choose from different categories such as comedians, sitcom actors, musicians, athletes, internet personalities, movie stars, TV hosts, chefs, reality TV figures, and tech/pop-culture figures.
- Avoid politicians.
- Avoid always choosing the same obvious people. Variety seed: ${varietySeed}.
- Do not duplicate fields, vibes, or sketch/avatar types if you can avoid it.

For each panelist provide:
- "name": the short public/stage name they are normally known by on screen. No middle names, initials, titles, suffixes, or overly formal full legal names unless that is how the public usually knows them
- "signMessage": a short silly 1970s-style card/sign message they might hold up during the intro, like "Hi Mom!", "Send snacks!", or "Lakers Forever!". 2-5 words, not a description.
- "tag": keep this short internally, but it will not be shown on screen
- "avatarType": one of these sketch styles that best fits them visually: "man_young", "man_middle", "man_older", "woman_young", "woman_middle", "woman_older", "person_athletic", "person_glamorous"
- "voice": best matching OpenAI TTS voice from: ${TTS_VOICES.join(', ')}. Prefer louder/brighter voices when possible: verse, ash, coral, nova, shimmer, fable. Use onyx only for very deep voices.
- "voiceInstructions": 1-2 sentences on HOW to deliver lines as this person — energetic, crisp, theatrical, easy to hear. Do not imitate a real voice exactly.
- "answerStyle": one of "obvious", "literal", "punny", "wildcard", "deadpan", "chaotic". Use mostly obvious/literal/punny, with only one true wildcard.
- "matchBias": a number from 0.70 to 0.98 describing how hard this panelist usually tries to match contestants.

Assign DIFFERENT voices to different panelists.

Return JSON: {"panel": [{"name":"...","tag":"...","avatarType":"...","voice":"...","voiceInstructions":"...","answerStyle":"...","matchBias":0.85,"signMessage":"Hi Mom!"}, ...]}`,
    1500, true
  );
  const parsed = extractJSON(text);
  let panel = Array.isArray(parsed) ? parsed : (parsed.panel || []);

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

  // Hard guarantee: exactly one classic Match Game regular is present.
  const hasClassic = panel.some(p => cleanPanelName(p.name).toLowerCase() === classic.toLowerCase());
  if (!hasClassic) {
    panel = [{
      name: classic,
      tag: 'classic Match Game star',
      avatarType: classic === 'Betty White' || classic === 'Brett Somers' || classic === 'Fannie Flagg' || classic === 'Patti Deutsch' || classic === 'Marcia Wallace' || classic === 'Joyce Bulifant' || classic === 'Elaine Joyce' ? 'woman_older' : 'man_older',
      voice: classic === 'Richard Dawson' ? 'fable' : 'coral',
      voiceInstructions: 'Deliver with warm, witty, classic game-show timing. Clear, upbeat, and a little mischievous.',
      answerStyle: 'obvious',
      matchBias: 0.92,
      signMessage: randomSign()
    }, ...panel.filter(p => !CLASSIC_MATCH_GAMERS.map(x => x.toLowerCase()).includes(cleanPanelName(p.name).toLowerCase()))];
  } else {
    // If more than one classic appears, keep the requested one if possible and remove extras.
    const seenClassic = new Set();
    panel = panel.filter(p => {
      const nm = cleanPanelName(p.name).toLowerCase();
      if (!CLASSIC_MATCH_GAMERS.map(x => x.toLowerCase()).includes(nm)) return true;
      if (nm === classic.toLowerCase() && !seenClassic.has(nm)) { seenClassic.add(nm); return true; }
      return false;
    });
  }

  const usedNames = new Set();
  panel = panel.filter(p => {
    const nm = cleanPanelName(p.name).toLowerCase();
    if (!nm || usedNames.has(nm)) return false;
    usedNames.add(nm);
    return true;
  });
  for (const backup of MODERN_PANEL_BACKUPS.sort(() => Math.random() - 0.5)) {
    if (panel.length >= 6) break;
    if (!usedNames.has(backup.name.toLowerCase())) {
      panel.push(backup);
      usedNames.add(backup.name.toLowerCase());
    }
  }

  const normalizedPanel = panel.slice(0, 6).map(p => ({
    name: cleanPanelName(p.name),
    tag: p.tag,
    signMessage: String(p.signMessage || p.tag || randomSign()).slice(0, 32),
    avatarType: uniqueAvatarType(p.avatarType),
    voice: TTS_VOICES.includes(p.voice) ? p.voice : 'verse',
    voiceInstructions: p.voiceInstructions || 'Speak clearly, energetically, and loud enough to carry in a game-show room.',
    answerStyle: ['obvious','literal','punny','wildcard','deadpan','chaotic'].includes(p.answerStyle) ? p.answerStyle : 'obvious',
    matchBias: Number.isFinite(Number(p.matchBias)) ? Math.max(0.65, Math.min(0.98, Number(p.matchBias))) : 0.85,
    answer: null,
  }));
  return await enrichPanelWithWikipediaImages(normalizedPanel);
};

const generateRoundPrompts = async (usedCharacters = [], usedCategories = [], usedRoundPrompts = [], allowDumbDora = true, roundNum = 1) => {
  const availableChars = CHARACTER_ARCHETYPES.filter(c => !usedCharacters.includes(c));
  const shuffled = shuffle(availableChars);
  const charA = shuffled[0] || 'Old Timer Terry';
  const charB = shuffled[1] || 'Newcomer Nick';
  const localUsed = [
    ...(usedRoundPrompts || []),
    ...(usedCategories || []).filter(x => String(x).startsWith('PROMPT:')).map(x => String(x).slice(7)),
    ...usedPromptSamples('round', 120)
  ];
  const avoidList = localUsed.slice(-80).map(p => `- ${p}`).join('\n');
  const categories = shuffle(PROMPT_CATEGORIES.filter(c => allowDumbDora || !/dumb/i.test(c))).slice(0, 6).join(', ');
  const roundSpecificGuidance = roundNum >= 2
    ? 'ROUND 2 MUST BE MORE MATCHABLE: write prompts with a clearer, more definitive best answer. The #1 answer should be something an ordinary player and at least 4 celebrities could plausibly converge on. Still funny, but less ambiguous than Round 1.'
    : 'ROUND 1 can allow a little more variety, but it still needs a clear answer neighborhood with one best answer.';

  // GenAI should be the engine, but the database/history is still essential as a guardrail:
  // generate fresh prompts, reject repeats/similar prompts, and only fall back to curated prompts if needed.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const text = await callLLM(
        `${REGULAR_ROUND_WRITER_STYLE}

Generate TWO brand-new Match Game-style fill-in-the-blank prompts for a family game with adults and 17+ teens. Keep each prompt SHORT and punchy. ${roundSpecificGuidance}

IMPORTANT: These must not repeat or closely resemble any prior prompt listed below.
Avoid prior prompts:\n${avoidList || '(none)'}

Use fresh situations from these areas: ${categories}.
${allowDumbDora ? 'You may include AT MOST ONE Dumb Dora prompt in this pair. A valid Dumb Dora prompt should look like: \"Dumb Dora is so dumb, she thought a Hoover was a __________.\" The screen prompt should NOT include the audience callback; the TV host will pause after \"Dumb Dora is so dumb\" so the audience can yell \"How dumb is she?\"' : 'Do NOT generate a Dumb Dora prompt in this pair; this game has already used that style.'}

CRITICAL PROMPT QUALITY RULES:
- Do NOT use generic "Favourite __________" prompts.
- Do NOT use trivia, factual definitions, niche references, or questions with only one logical fact-answer.
- Do NOT use prompts where the blank could be almost any object/body part/food/place.
- The prompt should allow funny panel variation, but all plausible answers must live in the same answer neighborhood.
- Round 1: one clear best answer plus two plausible alternatives.
- Round 2: a clearer, more definitive best answer so matching is likely.
- Use exactly one blank marker, written as __________. Never use [BLANK]. Never write the word blank in the prompt.
- Keep the setup to one sentence, usually 10-20 words. Put the blank almost always at the END.
- Light innuendo is encouraged; keep it TV-PG/PG-13, playful, not explicit.

For each prompt return 3 likely answers in order. The #1 answer should be the answer the panel can cluster around. For Round 2, make the #1 answer especially strong and concrete.
Return JSON exactly:
{"prompts":[{"prompt":"short setup ending with __________","answers":["best","second","third"],"category":"...","character":"..."},{"prompt":"short setup ending with __________","answers":["best","second","third"],"category":"...","character":"..."}]}`,
        700, true
      );
      const parsed = extractJSON(text);
      const prompts = (parsed.prompts || [])
        .map(x => ({ ...x, prompt: normalizePromptBlank(x.prompt) }))
        .filter(x => promptIsUsable(x.prompt) && Array.isArray(x.answers) && x.answers.length >= 2);
      const fresh = [];
      let dumbCountInPair = 0;
      for (const pr of prompts) {
        const isDumb = isDumbDoraPrompt(pr.prompt);
        if (isDumb && !allowDumbDora) continue;
        if (isDumb && dumbCountInPair >= 1) continue;
        if (promptAlreadyUsedOrSimilar('round', pr.prompt, [...localUsed, ...fresh.map(f => f.prompt)])) continue;
        fresh.push(pr);
        if (isDumb) dumbCountInPair += 1;
      }
      if (fresh.length >= 2) {
        const [a,b] = fresh;
        GLOBAL_USED_ROUND_PROMPTS.add(normalizePromptKey(a.prompt));
        GLOBAL_USED_ROUND_PROMPTS.add(normalizePromptKey(b.prompt));
        markPromptUsed('round', a.prompt);
        markPromptUsed('round', b.prompt);
        return {
          promptA: a.prompt, promptB: b.prompt,
          answersA: a.answers.slice(0,3).map(ans => stripAnswerToBlank(a.prompt, ans)), answersB: b.answers.slice(0,3).map(ans => stripAnswerToBlank(b.prompt, ans)),
          categoryA: 'PROMPT:' + a.prompt, categoryB: 'PROMPT:' + b.prompt,
          charA: a.character || charA, charB: b.character || charB,
        };
      }
    } catch (e) {
      console.warn('fresh prompt generation failed:', e.message);
    }
  }

  // Fallback only: curated bank still exists so the game never crashes if API generation fails.
  let unused = FALLBACK_ROUND_PROMPTS
    .filter(p => allowDumbDora || !isDumbDoraPrompt(p.prompt))
    .filter(p => !promptAlreadyUsedOrSimilar('round', p.prompt, localUsed));
  if (unused.length < 2) unused = FALLBACK_ROUND_PROMPTS
    .filter(p => allowDumbDora || !isDumbDoraPrompt(p.prompt))
    .filter(p => !localUsed.some(u => normalizePromptKey(u) === normalizePromptKey(p.prompt)));
  if (unused.length < 2) unused = FALLBACK_ROUND_PROMPTS.filter(p => allowDumbDora || !isDumbDoraPrompt(p.prompt));
  if (unused.length < 2) unused = FALLBACK_ROUND_PROMPTS;
  const pool = shuffle(unused);
  const a = { ...pool[0], prompt: normalizePromptBlank(pool[0].prompt) };
  const b0 = pool.find(p => normalizePromptKey(p.prompt) !== normalizePromptKey(a.prompt) && !(isDumbDoraPrompt(a.prompt) && isDumbDoraPrompt(p.prompt))) || pool.find(p => normalizePromptKey(p.prompt) !== normalizePromptKey(a.prompt)) || pool[1] || a;
  const b = { ...b0, prompt: normalizePromptBlank(b0.prompt) };
  markPromptUsed('round', a.prompt);
  markPromptUsed('round', b.prompt);
  return {
    promptA: a.prompt, promptB: b.prompt,
    answersA: a.answers.map(ans => stripAnswerToBlank(a.prompt, ans)), answersB: b.answers.map(ans => stripAnswerToBlank(b.prompt, ans)),
    categoryA: 'PROMPT:' + a.prompt, categoryB: 'PROMPT:' + b.prompt,
    charA: a.prompt.match(/^([^'’]+)'/)?.[1] || charA,
    charB: b.prompt.match(/^([^'’]+)'/)?.[1] || charB,
  };
};

const generatePanelAnswers = async (panel, promptText, contestantName, roundNum = 1, answerKey = []) => {
  const panelStr = panel.map((p, i) => `${i+1}. ${p.name} (${p.tag}; style=${p.answerStyle || 'obvious'}; matchBias=${p.matchBias ?? 0.8})`).join('\n');
  const key = (answerKey || []).filter(Boolean).slice(0, 3);
  const order = [0,1,2,3,4,5].sort(() => Math.random() - 0.5);
  const funnyIndex = order[0];
  const topSlots = new Set(order.slice(roundNum === 1 ? 1 : 0, roundNum === 1 ? 3 : 5));
  const alternateSlots = new Set(order.slice(roundNum === 1 ? 3 : 5, roundNum === 1 ? 5 : 6));

  const text = await callLLM(
    `You are writing celebrity panel answers for Match Game.

Prompt: "${promptText}"
Contestant: ${contestantName}
Round: ${roundNum}
Definitive likely answers, in order: ${key.length ? key.join(', ') : 'infer the obvious answers'}
Designated funny/innuendo celebrity position: ${funnyIndex + 1}

THE BIG FIX:
The game should feel like classic Match Game. Answers must be matchable, but still funny.
The panel should NOT give six unrelated answers.

ANSWER RULES:
- 1-2 WORDS MAXIMUM per celebrity.
- Fill ONLY the missing blank. Do NOT repeat words already in the prompt. If the clue is "Dream __________", answer "job", not "dream job".
- Use simple concrete words, not explanations.
- The answer must fit the blank naturally when read in the prompt.
- Round 1: answers may vary, but they must stay in the same answer neighborhood. About 2 celebrities should use the #1 answer, 2 should use #2/#3 or close synonyms, 1 should give a plausible in-character answer, and 1 should give a funny answer.
- Round 2: make matching VERY likely. At least 5 eligible celebrities should use the #1 answer or a very close variant. If there is a funny/adult-innuendo answer, it should still usually be the #1 answer with a playful adjective, not a totally different answer.
- The funny answer should be a quick laugh. Lean into classic Match Game double-entendre and adult innuendo when the prompt allows it, but keep it non-explicit and TV-PG/PG-13.
- Do NOT make the same celebrity type the oddball every time; follow the designated funny position.
- Do NOT make every celebrity different. That ruins the game.
- Do NOT be too clever, abstract, or niche.

Panel:
${panelStr}

Return JSON: {"answers": ["answer1","answer2","answer3","answer4","answer5","answer6"]}`,
    550, true
  );
  const parsed = extractJSON(text);
  let answers = Array.isArray(parsed) ? parsed : (parsed.answers || []);
  answers = answers.map(a => stripAnswerToBlank(promptText, a || '???').split(/\s+/).slice(0, 2).join(' '));
  while (answers.length < 6) answers.push(key[0] || '???');

  // Safety net: keep the model funny, but enforce Match Game convergence with randomized positions.
  if (key.length) {
    const top = stripAnswerToBlank(promptText, key[0]);
    const second = stripAnswerToBlank(promptText, key[1] || key[0]);
    const third = stripAnswerToBlank(promptText, key[2] || second);
    if (roundNum === 1) {
      for (const i of topSlots) answers[i] = top;
      for (const i of alternateSlots) answers[i] = Math.random() < 0.5 ? second : third;
      // Leave funnyIndex and the final remaining panelist's model answers if they are plausible-looking.
      // If the funny answer is empty, give it a slightly playful but still matchable alternate.
      if (!answers[funnyIndex] || answers[funnyIndex] === '???') answers[funnyIndex] = third;
    } else {
      for (const i of topSlots) answers[i] = top;
      for (const i of alternateSlots) answers[i] = second;
      if (!answers[funnyIndex] || answers[funnyIndex] === '???') answers[funnyIndex] = Math.random() < 0.5 ? second : third;
    }
  }
  return answers.slice(0, 6);
};

const generateSuperMatchPrompt = async (usedPrompts = []) => {
  const localUsed = [...(usedPrompts || []), ...usedPromptSamples('super', 120)];
  const avoidList = localUsed.slice(-90).map(p => `- ${p}`).join('\n');

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const text = await callLLM(
        `${SUPER_MATCH_WRITER_STYLE}

Generate ONE brand-new Super Match survey-board prompt.
It should be a short phrase with exactly one blank marker: __________
Examples of the FORM: "Hot __________", "__________ Dog", "Wedding __________", "Phone __________", "__________ Ticket".
Generate a clean, classic survey-board clue. It should have MANY ordinary answers a real audience might give, with one very obvious top answer and two plausible runners-up.
Do NOT use "Favourite" or "Favorite" anywhere. Do NOT use Pizza. Avoid any clue root already listed below.
Avoid vague adjectives where the top answers would be random. Avoid obscure slang, niche pop culture, or clues that invite silly nonsense.
It must be obvious enough to produce top 3 survey answers, but not be identical or similar to anything below.
Avoid prior prompts:\n${avoidList || '(none)'}

Return JSON exactly: {"prompt":"... ___ ..."}`,
        140, true
      );
      const parsed = extractJSON(text);
      const prompt = normalizePromptBlank(parsed.prompt || '');
      if (promptIsUsable(prompt, 'short') && !promptHasForbiddenSuperFinalRoot(prompt) && !promptRootAlreadyUsed(prompt, localUsed) && !promptAlreadyUsedOrSimilar('super', prompt, localUsed)) {
        markPromptUsed('super', prompt);
        return prompt;
      }
    } catch (e) {
      console.warn('fresh super prompt generation failed:', e.message);
    }
  }

  let unused = FALLBACK_SUPER_PROMPTS.filter(p => !promptHasForbiddenSuperFinalRoot(p.prompt) && !promptRootAlreadyUsed(p.prompt, localUsed) && !promptAlreadyUsedOrSimilar('super', p.prompt, localUsed));
  if (!unused.length) unused = FALLBACK_SUPER_PROMPTS.filter(p => !promptHasForbiddenSuperFinalRoot(p.prompt) && !(usedPrompts || []).some(u => normalizePromptKey(u) === normalizePromptKey(p.prompt)));
  if (!unused.length) unused = FALLBACK_SUPER_PROMPTS;
  const chosen = shuffle(unused)[0];
  const superPrompt = normalizePromptBlank(chosen.prompt);
  markPromptUsed('super', superPrompt);
  return superPrompt;
};


const cleanSurveyAnswer = (prompt, answer) => stripAnswerToBlank(prompt, String(answer || '')).split(/\s+/).slice(0, 2).join(' ').trim();

const surveyBoardLooksBad = (prompt, answers = []) => {
  const cleaned = answers.map(a => cleanSurveyAnswer(prompt, a.answer || a)).filter(Boolean);
  if (cleaned.length < 3) return true;
  if (new Set(cleaned.map(a => canonPhrase(a))).size < 3) return true;
  for (const a of cleaned) {
    const c = canonPhrase(a);
    if (!c || c.length < 2) return true;
    if (/^(thing|stuff|something|anything|whatever|blank|answer|person|place|object|item)$/.test(c)) return true;
    if (/[!?]/.test(a)) return true;
    if (a.split(/\s+/).length > 2) return true;
  }
  return false;
};

const generateSuperMatchAnswers = async (prompt, celebNames) => {
  const fallback = FALLBACK_SUPER_PROMPTS.find(p => p.prompt.toLowerCase() === String(prompt).toLowerCase())
    || FALLBACK_SUPER_PROMPTS[Math.floor(Math.random() * FALLBACK_SUPER_PROMPTS.length)];

  // IMPORTANT: The survey board and celebrity suggestions are generated in two separate calls.
  // The celebrities are NOT shown the top-three survey answers. This prevents the AI panel
  // from suspiciously giving the exact $500/$250/$100 answers every time.
  let topAnswers = fallback.topAnswers.map((ta, i) => ({
    rank: i + 1,
    answer: cleanSurveyAnswer(prompt, ta.answer),
    value: [500,250,100][i]
  }));

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const surveyText = await callLLM(
      `Super Match survey board. Prompt: "${prompt}"

Generate the TOP 3 most popular/obvious survey answers for adults and 17+ teenagers.
Classic Match Game survey logic: obvious beats clever. These are the hidden studio-audience results, NOT celebrity guesses.

Rules:
- Each answer must be 1-2 words.
- Each answer must be ONLY the missing word/phrase, not the whole completed phrase. For "Dream __________", answer "job", not "dream job".
- Answers must fit the blank naturally when inserted into the prompt.
- Use COMMON, boring, survey-plausible answers. Do not be quirky, meta, gross, random, overly clever, or absurd.
- The #1 answer should be the answer a normal audience would most likely say first.
- The #2 and #3 answers should also be strong ordinary completions, not joke answers.
- Reject answers that only make sense as a joke, a prop, or a forced association.
- The three answers should be distinct.
- Prize values must be exactly 500, 250, 100.

Return JSON only:
{
  "topAnswers": [
    {"rank": 1, "answer": "...", "value": 500},
    {"rank": 2, "answer": "...", "value": 250},
    {"rank": 3, "answer": "...", "value": 100}
  ]
}`,
      350, true
    );
    const parsedSurvey = extractJSON(surveyText);
    if (Array.isArray(parsedSurvey.topAnswers) && parsedSurvey.topAnswers.length >= 3 && !surveyBoardLooksBad(prompt, parsedSurvey.topAnswers)) {
      topAnswers = parsedSurvey.topAnswers.slice(0, 3).map((ta, i) => ({
        rank: i + 1,
        answer: cleanSurveyAnswer(prompt, ta.answer || fallback.topAnswers[i].answer),
        value: [500,250,100][i]
      }));
      break;
    }
    } catch (e) {
      console.warn('super survey generation failed:', e.message);
    }
  }

  let celebAnswers = [];
  try {
    const celebText = await callLLM(
      `Super Match celebrity advice. Prompt: "${prompt}"

Celebrities selected by the contestant: ${celebNames.join(', ')}

Generate ONE suggested answer from each celebrity. They are trying to help the contestant guess what a studio audience might have said, but they DO NOT know the survey board.

Rules:
- 1-2 WORDS max per answer.
- Each answer must be ONLY the missing word/phrase, not the whole completed phrase. For "Dream __________", answer "job", not "dream job".
- Answers must fit the blank naturally.
- Make the suggestions plausible and helpful, but not magically perfect.
- Avoid making all three celebrities give the same answer.
- It is okay if one celebrity gives the obvious answer and another gives a plausible second-choice or funny in-character answer.
- Do NOT mention ranks, money, or survey positions.

Return JSON only: {"celebAnswers": ["answer for celeb 1", "answer for celeb 2", "answer for celeb 3"]}`,
      300, true
    );
    const parsedCelebs = extractJSON(celebText);
    celebAnswers = Array.isArray(parsedCelebs.celebAnswers) ? parsedCelebs.celebAnswers : [];
  } catch (e) {
    console.warn('super celeb suggestion generation failed:', e.message);
  }

  // Fallback: if celebrity generation fails, give plausible but not perfect suggestions.
  // Prefer not to hand them the entire board; mix in fallback alternatives and shuffle.
  const fallbackSuggestions = shuffle([
    ...(fallback.answers || []),
    ...(fallback.topAnswers || []).map(a => a.answer),
    topAnswers[0]?.answer,
    topAnswers[1]?.answer,
    topAnswers[2]?.answer
  ].filter(Boolean));

  celebAnswers = celebAnswers.slice(0, 3).map((a, i) => stripAnswerToBlank(prompt, String(a || fallbackSuggestions[i] || topAnswers[i % topAnswers.length].answer)).split(/\s+/).slice(0,2).join(' '));
  while (celebAnswers.length < 3) celebAnswers.push(stripAnswerToBlank(prompt, String(fallbackSuggestions[celebAnswers.length] || topAnswers[celebAnswers.length % topAnswers.length].answer)).split(/\s+/).slice(0,2).join(' '));

  return { topAnswers, celebAnswers };
};

const FINAL_MATCH_PROMPTS = [
  { prompt:'Birthday ___', answers:['Cake','Party','Gift'] },
  { prompt:'Movie ___', answers:['Star','Night','Theater'] },
  { prompt:'Phone ___', answers:['Call','Case','Number'] },
  { prompt:'Hot ___', answers:['Dog','Tub','Sauce'] },
  { prompt:'First ___', answers:['Date','Kiss','Love'] },
  { prompt:'___ Dog', answers:['Hot','Guard','Big'] },
  { prompt:'___ Party', answers:['Birthday','House','Pool'] },
  { prompt:'Wedding ___', answers:['Cake','Ring','Dress'] },
  { prompt:'Rock ___', answers:['Star','Music','Band'] },
  { prompt:'Coffee ___', answers:['Cup','Shop','Break'] },
  { prompt:'School ___', answers:['Bus','Dance','Lunch'] },
  { prompt:'Christmas ___', answers:['Tree','Gift','Party'] }
];

const generateFinalMatchPrompt = async (usedPrompts = []) => {
  const localUsed = [...(usedPrompts || []), ...usedPromptSamples('final', 120), ...usedPromptSamples('super', 80)];
  const avoidList = localUsed.slice(-120).map(p => `- ${p}`).join('\n');

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const text = await callLLM(
        `${FINAL_MATCH_WRITER_STYLE}

Generate ONE brand-new Final Match clue as JSON.

It must be a short, familiar survey-style phrase with exactly one blank marker written as __________.
Examples of the FORM ONLY: "Birthday __________", "Movie __________", "Phone __________", "__________ Dog", "Hot __________", "Golden __________". Answers must be ONLY the missing word/phrase, not the entire completed phrase.
Avoid "Favourite/Favorite" entirely. Do NOT use Pizza. Avoid any clue root already listed below.
Avoid awkward/redundant clues like "First Date ___".
Avoid anything identical or similar to these previous Super/Final Match prompts:
${avoidList || '(none)'}

Return JSON exactly: {"prompt":"... __________", "answers":["most obvious", "second", "third"]}`,
        180, true
      );
      const parsed = extractJSON(text);
      const prompt = String(parsed.prompt || '').trim();
      const answers = Array.isArray(parsed.answers) ? parsed.answers.map(a => stripAnswerToBlank(prompt, String(a).trim())).filter(Boolean).slice(0,3) : [];
      if (promptIsUsable(prompt, 'short') && answers.length && !promptHasForbiddenSuperFinalRoot(prompt) && !promptRootAlreadyUsed(prompt, localUsed) && !promptAlreadyUsedOrSimilar('final', prompt, localUsed)) {
        markPromptUsed('final', prompt);
        return { prompt, answers };
      }
    } catch (e) {
      console.warn('fresh final prompt generation failed:', e.message);
    }
  }

  let unused = FINAL_MATCH_PROMPTS.filter(p => !promptHasForbiddenSuperFinalRoot(p.prompt) && !promptRootAlreadyUsed(p.prompt, localUsed) && !promptAlreadyUsedOrSimilar('final', p.prompt, localUsed));
  if (!unused.length) unused = FINAL_MATCH_PROMPTS.filter(p => !promptHasForbiddenSuperFinalRoot(p.prompt) && !(usedPrompts || []).some(u => normalizePromptKey(u) === normalizePromptKey(p.prompt)));
  if (!unused.length) unused = FINAL_MATCH_PROMPTS;
  const fallback = shuffle(unused)[0];
  const finalFallback = { ...fallback, prompt: normalizePromptBlank(fallback.prompt) };
  markPromptUsed('final', finalFallback.prompt);
  return { ...finalFallback, answers: finalFallback.answers.map(ans => stripAnswerToBlank(finalFallback.prompt, ans)) };
};

const generateFinalMatchCelebAnswer = async (prompt, celeb, contestantName, answerKey = []) => {
  const keyText = (answerKey || []).filter(Boolean).join(', ');
  const text = await callLLM(
    `Final Match game show. Prompt: "${prompt}"
Contestant: ${contestantName}
Celebrity: ${celeb.name} (${celeb.tag})
Likely survey answers: ${keyText || 'infer the obvious answer'}

${celeb.name} is under pressure and trying VERY HARD to match the contestant. The answer should almost always be the #1 obvious answer, not a joke.
Give only the missing word/phrase, 1-2 words maximum. Do NOT repeat words already in the prompt. If the clue is "Dream __________", answer "job", not "dream job".`,
    30
  );
  let ans = stripAnswerToBlank(prompt, text.trim().replace(/^['"]|['"]$/g, '')).split(/\s+/).slice(0, 2).join(' ');
  if (!ans && answerKey?.[0]) ans = answerKey[0];
  return ans;
};

// ─── SCORING ──────────────────────────────────────────────────
const SYNONYM_GROUPS = [
  // Keep these deliberately narrow. Match Game should not match a general
  // category with a specific member of that category. These groups are mostly
  // spelling variants, abbreviations, and near-identical everyday wording.
  ['tv','television','telly'],
  ['cellphone','cell phone','mobile phone','phone','iphone','smartphone'],
  ['cheque','check'],
  ['paycheque','paycheck'],
  ['abs','abdominals','sixpack','six pack'],
  ['mom','mother','mum','mama'],
  ['dad','father','papa'],
  ['bathroom','washroom','restroom','loo'],
  ['text','message','dm'],
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

const editDistance = (a, b) => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
};

const fuzzyMatch = (a, b) => {
  const na = canonPhrase(a), nb = canonPhrase(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const tokensA = na.split(/\s+/).filter(Boolean);
  const tokensB = nb.split(/\s+/).filter(Boolean);
  // If the contestant gave a concise answer and that exact word/phrase appears
  // inside the celebrity's longer answer, count it: "skills" matches
  // "unbelievable skills". This is intentionally one-way so broad celebrity
  // answers do not swallow specific contestant answers.
  if (tokensA.length <= 2 && tokensA.every(w => w.length > 2)) {
    for (let i = 0; i <= tokensB.length - tokensA.length; i++) {
      if (tokensA.every((w, j) => tokensB[i + j] === w)) return true;
    }
  }

  // Allow obvious typos only when both answers are short single-word attempts.
  // Do NOT use broad substring/word-overlap matching; that caused bad matches such as
  // related-but-different answers being accepted.
  const oneWordA = !na.includes(' ');
  const oneWordB = !nb.includes(' ');
  if (oneWordA && oneWordB && Math.max(na.length, nb.length) >= 5) {
    return editDistance(na, nb) <= 1;
  }
  return false;
};

const llmMatch = async (prompt, a, b) => {
  if (fuzzyMatch(a, b)) return true;
  // Conservative API judge for true edge cases only. It should save spelling and
  // abbreviation misses, not award broad association/category matches.
  try {
    const text = await callLLM(
      `You are the STRICT match judge for a 1970s Match Game-style fill-in-the-blank game.
Prompt: "${prompt || ''}"
Contestant answer: "${a || ''}"
Celebrity answer: "${b || ''}"

Judge whether these are essentially the SAME answer for this exact blank.

COUNT AS MATCH ONLY FOR:
- spelling variants or typos: cheque/check, color/colour
- singular/plural of the same word
- abbreviations of the same phrase: TV/television, cell/cellphone
- very narrow same-meaning wording that creates the same completed phrase
- the contestant's exact concise word/phrase appears as a complete word/phrase inside the celebrity answer, e.g. skills/unbelievable skills

DO NOT MATCH:
- general category vs specific member: animal/cat, drink/beer, vehicle/car
- related or associated words: salt/pepper, pepper/shaker for "Salt ___"
- container/tool/object pairs: drink/glass, salt/shaker
- two different common completions of the same clue
- answers that are merely in the same topic area

Useful test: put each answer into the blank. If they make two meaningfully different phrases, return false.
Return JSON only: {"match":true} or {"match":false}`,
      60, true
    );
    const parsed = extractJSON(text);
    return Boolean(parsed.match);
  } catch (e) {
    console.warn('llm match judge failed:', e.message);
    return false;
  }
};

const scoreAnswerAsync = async (playerAnswer, panel, prompt = '') => {
  const results = [];
  for (const p of panel) results.push(await llmMatch(prompt, playerAnswer, p.answer || ''));
  return results;
};


// ─── AI SOLO-PLAYER HELPERS ───────────────────────────────────
const isAiContestantSlot = (room, slot) => (room?.aiContestantSlots || []).includes(Number(slot));

const aiContestantAnswer = async (prompt, answerKey = []) => {
  const key = (answerKey || []).filter(Boolean);
  if (key.length) {
    const r = Math.random();
    if (r < 0.62) return key[0];
    if (r < 0.84) return key[1] || key[0];
    return key[2] || key[1] || key[0];
  }
  try {
    const text = await callLLM(
      `Give ONE short Match Game contestant answer for this prompt. Use 1-2 words only.\nPrompt: "${prompt}"\nReturn JSON: {"answer":"..."}`,
      80, true
    );
    const parsed = extractJSON(text);
    return stripAnswerToBlank(prompt, String(parsed.answer || 'answer').trim()).split(/\s+/).slice(0,2).join(' ');
  } catch {
    return 'answer';
  }
};

const scheduleAi = (room, kind, delayMs, fn) => {
  if (!room) return;
  const key = `${kind}|${room.phase}|${room.round}|${room.turnInRound}|${room.activeSlot}|${room.chosenPrompt || room.superMatchPrompt || room.finalMatchPrompt || ''}`;
  if (room.aiActionKey === key) return;
  room.aiActionKey = key;
  setTimeout(async () => {
    try {
      const liveRoom = rooms.get(room.code);
      if (!liveRoom || liveRoom !== room) return;
      await fn();
    } catch (e) {
      console.error('AI solo action failed:', e);
      room.phase = 'error';
      bump(room);
    }
  }, delayMs);
};

const maybeScheduleAiAction = (room) => {
  if (!room || !isAiContestantSlot(room, room.activeSlot)) return;

  if (room.phase === 'pick_prompt') {
    scheduleAi(room, 'pickPrompt', 1200, async () => {
      if (room.phase !== 'pick_prompt' || !isAiContestantSlot(room, room.activeSlot)) return;
      const choice = Math.random() < 0.5 ? 'A' : 'B';
      room.chosenPrompt = choice === 'A' ? room.promptA : room.promptB;
      room.chosenAnswerKey = choice === 'A' ? (room.promptAnswerKeys?.A || []) : (room.promptAnswerKeys?.B || []);
      room.phase = 'answering';
      bump(room);
      maybeScheduleAiAction(room);
    });
  }

  if (room.phase === 'answering') {
    scheduleAi(room, 'answerPrompt', 2600, async () => {
      if (room.phase !== 'answering' || !isAiContestantSlot(room, room.activeSlot) || room.contestantAnswer) return;
      room.contestantAnswer = await aiContestantAnswer(room.chosenPrompt, room.chosenAnswerKey || []);
      bump(room);
      await maybeFinishAnswerPhase(room);
    });
  }

  if (room.phase === 'superMatch_pickCelebs') {
    scheduleAi(room, 'superPick', 1500, async () => {
      if (room.phase !== 'superMatch_pickCelebs' || !isAiContestantSlot(room, room.activeSlot)) return;
      room.superMatchCelebIndices = shuffle([0,1,2,3,4,5]).slice(0,3);
      room.superMatchHumanAnswers = {};
      const humanSelected = room.superMatchCelebIndices.filter(i => room.panel[i]?.isHuman);
      if (humanSelected.length) {
        room.phase = 'superMatch_human_answering';
        bump(room);
      } else {
        await completeSuperMatchGeneration(room);
      }
    });
  }

  if (room.phase === 'superMatch_answering' && !room.superMatchContestantAnswer) {
    scheduleAi(room, 'superAnswer', 1500, async () => {
      if (room.phase !== 'superMatch_answering' || !isAiContestantSlot(room, room.activeSlot) || room.superMatchContestantAnswer) return;
      const choices = (room.superMatchCelebIndices || []).map(i => room.panel[i]?.answer).filter(Boolean);
      const top = (room.superMatchTopAnswers || []).map(a => a.answer).filter(Boolean);
      const answer = choices[0] || top[0] || 'answer';
      await completeSuperMatchContestantAnswer(room, answer);
    });
  }

  if (room.phase === 'finalMatch_pickCeleb') {
    scheduleAi(room, 'finalPick', 1400, async () => {
      if (room.phase !== 'finalMatch_pickCeleb' || !isAiContestantSlot(room, room.activeSlot)) return;
      room.finalMatchCelebIndex = Math.floor(Math.random() * (room.panel?.length || 6));
      room.finalMatchHumanAnswers = {};
      room.phase = 'finalMatch_answering';
      bump(room);
      maybeScheduleAiAction(room);
    });
  }

  if (room.phase === 'finalMatch_answering' && !room.finalMatchContestantAnswer) {
    scheduleAi(room, 'finalAnswer', 1800, async () => {
      if (room.phase !== 'finalMatch_answering' || !isAiContestantSlot(room, room.activeSlot) || room.finalMatchContestantAnswer) return;
      room.finalMatchContestantAnswer = await aiContestantAnswer(room.finalMatchPrompt, room.finalMatchAnswerKey || []);
      const celeb = room.panel[room.finalMatchCelebIndex];
      if (celeb?.isHuman && !room.finalMatchHumanAnswers?.[room.finalMatchCelebIndex]) {
        room.phase = 'finalMatch_human_celeb_answering';
        bump(room);
      } else {
        await completeFinalMatchReveal(room);
      }
    });
  }
};

// ─── API: HEALTH & CONFIG ──────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/config', (req, res) => res.json({ ttsEnabled: true }));

// ─── API: ROOM MANAGEMENT ─────────────────────────────────────
const makeAiPanelSeat = async () => (await generatePanel())[0] || MODERN_PANEL_BACKUPS[0];

const assignRolesAndStart = async (room) => {
  if (room.rolesAssigned) return;
  room.rolesAssigned = true;
  const ids = Object.keys(room.participants || {}).map(Number);
  const prefs = room.participantPreferences || {};

  // Respect preferences when possible: two contestants are chosen first from people
  // who prefer contestant, then surprise, then celebrity. Remaining players become live stars.
  const contestantPool = [
    ...shuffle(ids.filter(id => prefs[id] === 'contestant')),
    ...shuffle(ids.filter(id => !prefs[id] || prefs[id] === 'surprise')),
    ...shuffle(ids.filter(id => prefs[id] === 'celebrity')),
  ];
  const c1 = contestantPool[0];
  const c2 = room.soloTest ? null : (contestantPool.find(id => id !== c1) || null);
  room.playerIds = { 1: c1, 2: c2 };
  room.players = { 1: room.participants[c1] || 'Player 1', 2: c2 ? room.participants[c2] : randomAiContestantName(Object.values(room.participants || {})) };
  room.roles = {};
  if (c1) room.roles[c1] = { role: 'contestant', contestantSlot: 1 };
  if (c2) room.roles[c2] = { role: 'contestant', contestantSlot: 2 };
  room.aiContestantSlots = []; // v26: no AI opponent in normal play; solo test uses one contestant only

  const remaining = ids.filter(id => id !== c1 && id !== c2);
  const humanCelebIds = [
    ...shuffle(remaining.filter(id => prefs[id] === 'celebrity')),
    ...shuffle(remaining.filter(id => !prefs[id] || prefs[id] === 'surprise')),
    ...shuffle(remaining.filter(id => prefs[id] === 'contestant')),
  ].slice(0, 6);
  const basePanel = await generatePanel();
  let panel = [...basePanel];
  for (let i = 0; i < humanCelebIds.length && i < 6; i++) {
    const pid = humanCelebIds[i];
    const template = panel[i] || MODERN_PANEL_BACKUPS[i % MODERN_PANEL_BACKUPS.length];
    room.roles[pid] = { role: 'celeb', celebIndex: i };
    panel[i] = {
      ...template,
      name: room.participants[pid],
      tag: 'family celebrity panelist',
      signMessage: room.participantMessages?.[pid] || randomSign(),
      isHuman: true,
      playerId: pid,
      imageUrl: room.participantPhotos?.[pid] || null,
      imageTitle: null,
      imagePageUrl: null,
      imageSource: null,
      imageAttribution: null,
      voice: template.voice || 'alloy',
      voiceInstructions: 'Read clearly and playfully like a family game-show panelist.',
      answerStyle: 'human',
      matchBias: 0.85,
      answer: null,
    };
  }
  // Fill any empty panel seats with AI celebs.
  for (let i = 0; i < 6; i++) {
    if (!panel[i]) panel[i] = MODERN_PANEL_BACKUPS[i % MODERN_PANEL_BACKUPS.length];
  }
  room.panel = panel.slice(0, 6);
  room.triangleSlot = Math.random() < 0.5 ? 1 : 2;
  room.cointossWinner = room.triangleSlot;
  room.phase = 'intro';
  room.introStartedAt = Date.now();
  room.introCompleted = false;
  bump(room);
};


const resetRoomForPlayAgain = (room) => {
  const preservedUsedRoundPrompts = room.usedRoundPrompts || [];
  const preservedUsedSuperPrompts = room.usedSuperPrompts || [];
  const preservedUsedFinalPrompts = room.usedFinalPrompts || [];
  room.rolesAssigned = false;
  room.roles = {};
  room.playerIds = { 1: null, 2: null };
  room.round = 0;
  room.activeSlot = null;
  room.turnInRound = 1;
  room.players = { 1: null, 2: null };
  room.aiContestantSlots = [];
  room.aiActionKey = null;
  room.scores = { 1: 0, 2: 0 };
  room.pendingScoreDelta = 0;
  room.pendingMatches = [];
  room.triangleSlot = null;
  room.cointossWinner = null;
  room.panel = [];
  room.round1Matches = { 1: [], 2: [] };
  room.promptA = null; room.promptB = null; room.chosenPrompt = null;
  room.usedCharacters = [];
  room.usedCategories = [];
  room.usedRoundPrompts = preservedUsedRoundPrompts;
  room.usedSuperPrompts = preservedUsedSuperPrompts;
  room.usedFinalPrompts = preservedUsedFinalPrompts;
  room.dumbDoraUsed = false;
  room.chosenAnswerKey = [];
  room.contestantAnswer = null;
  room.panelAnswers = [];
  room.humanPanelAnswers = {};
  room.matches = [];
  room.superMatchPrompt = null;
  room.superMatchTopAnswers = null;
  room.superMatchCelebIndices = [];
  room.superMatchCelebAnswers = [];
  room.superMatchRevealIndex = -1;
  room.superMatchContestantAnswer = null;
  room.superMatchWinnings = 0;
  room.superMatchPromptReady = false;
  room.finalMatchPrompt = null;
  room.finalMatchAnswerKey = [];
  room.finalMatchCelebIndex = null;
  room.finalMatchContestantAnswer = null;
  room.finalMatchCelebAnswer = null;
  room.finalMatchHumanAnswers = {};
  room.finalMatchResult = null;
  room.finalMatchWinnings = 0;
  room.finalMatchPromptReady = false;
  room.partingGift = null;
  room.phase = 'lobby';
  room.introCompleted = false;
  room.introStartedAt = null;
};

const maybeFinishAnswerPhase = async (room) => {
  if (!room || room.phase !== 'answering' || !room.contestantAnswer) return;
  const inactiveCelebIndices = room.round === 2 ? (room.round1Matches?.[room.activeSlot] || []) : [];
  const requiredHumanCelebs = (room.panel || [])
    .map((p, i) => ({ p, i }))
    .filter(({p, i}) => p?.isHuman && !inactiveCelebIndices.includes(i));
  const allHumanReady = requiredHumanCelebs.every(({i}) => room.humanPanelAnswers?.[i]);
  if (!allHumanReady) return;

  room.phase = 'generating_answers';
  bump(room);
  try {
    const answers = await generatePanelAnswers(room.panel, room.chosenPrompt, room.players[room.activeSlot], room.round, room.chosenAnswerKey || []);
    room.panel = room.panel.map((p, i) => {
      if (inactiveCelebIndices.includes(i)) return { ...p, answer: null, inactiveThisTurn: true };
      if (p.isHuman) return { ...p, answer: room.humanPanelAnswers?.[i] || '???', inactiveThisTurn: false };
      return { ...p, answer: answers[i] || '???', inactiveThisTurn: false };
    });
    room.panelAnswers = room.panel.map(p => p.answer);
    const matches = (await scoreAnswerAsync(room.contestantAnswer, room.panel, room.chosenPrompt)).map((m, i) => inactiveCelebIndices.includes(i) ? false : m);
    room.matches = matches;
    const matchCount = matches.filter(Boolean).length;
    room.pendingScoreDelta = matchCount;
    room.pendingMatches = matches.map((m,i) => m ? i : -1).filter(i => i >= 0);
    room.phase = 'revealing';
    bump(room);
  } catch(e) {
    console.error('generate answers:', e);
    room.phase = 'error';
    bump(room);
  }
};

app.post('/api/room', async (req, res) => {
  const { playerName, playerCount, soloTest } = req.body;
  if (!playerName?.trim()) return res.status(400).json({ error: 'playerName required' });
  const isDisplay = playerName.trim() === '__display__';
  try {
    const code = makeRoomCode();
    const isSoloTest = Boolean(soloTest);
    const maxPlayers = isSoloTest ? 1 : clampInt(playerCount || 2, 2, 8);
    const room = {
      code, version: 1, lastActivity: Date.now(),
      phase: 'lobby',
      maxPlayers,
      soloTest: isSoloTest,
      participants: {},
      participantMessages: {},
      participantPreferences: {},
      participantPhotos: {},
      nextParticipantId: 1,
      rolesAssigned: false,
      roles: {},
      playerIds: { 1: null, 2: null },
      round: 0,
      activeSlot: null,
      turnInRound: 1,
      players: { 1: null, 2: null },
      aiContestantSlots: [],
      aiActionKey: null,
      hasDisplay: isDisplay,
      scores: { 1: 0, 2: 0 },
      pendingScoreDelta: 0,
      pendingMatches: [],
      triangleSlot: null,
      cointossWinner: null,
      panel: [],
      round1Matches: { 1: [], 2: [] },
      promptA: null, promptB: null,
      chosenPrompt: null,
      usedCharacters: [],
      usedCategories: [],
      usedSuperPrompts: [],
      usedFinalPrompts: [],
      dumbDoraUsed: false,
      chosenAnswerKey: [],
      contestantAnswer: null,
      panelAnswers: [],
      humanPanelAnswers: {},
      matches: [],
      superMatchPrompt: null,
      superMatchTopAnswers: null,
      superMatchCelebIndices: [],
      superMatchCelebAnswers: [],
      superMatchRevealIndex: -1,
      superMatchContestantAnswer: null,
      superMatchWinnings: 0,
      superMatchPromptReady: false,
      finalMatchPrompt: null,
      finalMatchAnswerKey: [],
      finalMatchCelebIndex: null,
      finalMatchContestantAnswer: null,
      finalMatchCelebAnswer: null,
      finalMatchHumanAnswers: {},
      finalMatchResult: null,
      finalMatchWinnings: 0,
      finalMatchPromptReady: false,
      partingGift: null,
    };
    rooms.set(code, room);
    res.json({ room, slot: null });
  } catch (e) {
    console.error('create room:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/room/:code/join', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'No room with that code' });
  const { playerName, signMessage, rolePreference, selfieData } = req.body;
  if (!playerName?.trim()) return res.status(400).json({ error: 'playerName required' });
  if (room.rolesAssigned) return res.status(409).json({ error: 'Game already started' });
  if (Object.keys(room.participants || {}).length >= room.maxPlayers) return res.status(409).json({ error: 'Room is full' });
  const slot = room.nextParticipantId++;
  room.participants[slot] = playerName.trim().slice(0, 20);
  room.participantMessages = room.participantMessages || {};
  room.participantMessages[slot] = String(signMessage || '').trim().slice(0, 32) || randomSign();
  room.participantPreferences = room.participantPreferences || {};
  room.participantPreferences[slot] = ['contestant','celebrity','surprise'].includes(rolePreference) ? rolePreference : 'surprise';
  room.participantPhotos = room.participantPhotos || {};
  const photo = String(selfieData || '');
  if (/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(photo) && photo.length < 5_000_000) {
    room.participantPhotos[slot] = photo;
  }
  bump(room);
  res.json({ room, slot });
  if (Object.keys(room.participants).length >= room.maxPlayers) {
    setTimeout(() => assignRolesAndStart(room).catch(e => { console.error('assign roles:', e); room.phase = 'error'; bump(room); }), 1000);
  }
});


app.post('/api/room/:code/intro-done', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.phase !== 'intro') return res.json({ room });
  if (room.introCompleted) return res.json({ room });
  room.introCompleted = true;
  if (room.soloTest) {
    res.json({ room });
    try { await startNewRound(room, 1); }
    catch(e) { console.error('start solo round 1:', e); room.phase = 'error'; bump(room); }
    return;
  }
  room.phase = 'cointoss';
  room.coinTossStartedAt = Date.now();
  bump(room);
  res.json({ room });
  setTimeout(async () => {
    try {
      const liveRoom = rooms.get(room.code);
      if (!liveRoom || liveRoom !== room || room.phase !== 'cointoss') return;
      await startNewRound(room, 1);
    }
    catch(e) { console.error('start round 1 after coin toss:', e); room.phase = 'error'; bump(room); }
  }, 7600);
});

app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.lastActivity = Date.now();
  maybeScheduleAiAction(room);
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
    room.humanPanelAnswers = {};
    room.pendingScoreDelta = 0;
    room.pendingMatches = [];
    room.panel = room.panel.map(p => ({ ...p, answer: null, inactiveThisTurn: false }));
    const { promptA, promptB, answersA, answersB, categoryA, categoryB, charA, charB } = await generateRoundPrompts(room.usedCharacters, room.usedCategories || [], room.usedRoundPrompts || [], !room.dumbDoraUsed, roundNum);
    room.promptA = promptA;
    room.promptB = promptB;
    room.promptAnswerKeys = { A: answersA, B: answersB };
    room.chosenAnswerKey = [];
    room.usedCharacters.push(charA, charB);
    room.usedCategories = [...(room.usedCategories || []), categoryA, categoryB];
    room.usedRoundPrompts = [...(room.usedRoundPrompts || []), promptA, promptB];
    if (isDumbDoraPrompt(promptA) || isDumbDoraPrompt(promptB)) room.dumbDoraUsed = true;

    // Determine who picks first
    if (room.soloTest) {
      // Solo Test is one human contestant against the AI celebrity panel, not an AI opponent.
      // Keep the human in control for both regular rounds.
      room.activeSlot = 1;
    } else if (roundNum === 1) {
      room.activeSlot = room.cointossWinner;
    } else {
      // Lower score picks first (or slot 1 if tied after wipe)
      const s1 = room.scores[1], s2 = room.scores[2];
      room.activeSlot = s1 <= s2 ? 1 : 2;
    }
    room.turnInRound = 1;
    room.phase = 'pick_prompt';
    bump(room);
    maybeScheduleAiAction(room);
  } else {
    // Super Match
    room.chosenPrompt = null;
    room.contestantAnswer = null;
    room.matches = [];
    room.humanPanelAnswers = {};
    room.pendingScoreDelta = 0;
    room.pendingMatches = [];
    room.panel = room.panel.map(p => ({ ...p, answer: null, inactiveThisTurn: false }));
    const prompt = await generateSuperMatchPrompt(room.usedSuperPrompts || []);
    room.superMatchPrompt = prompt;
    room.usedSuperPrompts = [...(room.usedSuperPrompts || []), prompt];
    room.superMatchCelebIndices = [];
    room.superMatchCelebAnswers = [];
    room.superMatchRevealIndex = -1;
    room.superMatchContestantAnswer = null;
    room.superMatchTopAnswers = null;
    room.superMatchTopRevealIndex = -1;
    room.phase = 'superMatch_pickCelebs';
    bump(room);
    maybeScheduleAiAction(room);
  }
};

// Determine the "other" contestant slot
const otherSlot = (slot) => slot === 1 ? 2 : 1;

// ─── API: PICK PROMPT ─────────────────────────────────────────
app.post('/api/room/:code/pick-prompt', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room || room.phase !== 'pick_prompt') return res.status(400).json({ error: 'Not in pick_prompt phase' });
  const { slot, choice } = req.body; // choice: 'A' or 'B'
  const role = room.roles?.[slot];
  if (!role || role.role !== 'contestant' || role.contestantSlot !== room.activeSlot) return res.status(403).json({ error: 'Not your turn to pick' });

  room.chosenPrompt = choice === 'A' ? room.promptA : room.promptB;
  room.chosenAnswerKey = choice === 'A' ? (room.promptAnswerKeys?.A || []) : (room.promptAnswerKeys?.B || []);
  room.phase = 'answering';
  bump(room);
  res.json({ room });
});

// ─── API: SUBMIT ANSWER ───────────────────────────────────────
app.post('/api/room/:code/answer', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room || room.phase !== 'answering') return res.status(400).json({ error: 'Not in answering phase' });
  const { slot, answer } = req.body;
  if (!answer?.trim()) return res.status(400).json({ error: 'answer required' });
  const role = room.roles?.[slot];
  if (!role) return res.status(403).json({ error: 'Not in this room' });
  const cleanAnswer = answer.trim().slice(0, 50);

  if (role.role === 'contestant') {
    if (role.contestantSlot !== room.activeSlot) return res.status(403).json({ error: 'Not your turn' });
    room.contestantAnswer = cleanAnswer;
  } else if (role.role === 'celeb') {
    const inactiveCelebIndices = room.round === 2 ? (room.round1Matches?.[room.activeSlot] || []) : [];
    if (inactiveCelebIndices.includes(role.celebIndex)) return res.status(403).json({ error: 'You already matched this contestant' });
    room.humanPanelAnswers = room.humanPanelAnswers || {};
    room.humanPanelAnswers[role.celebIndex] = cleanAnswer;
  } else {
    return res.status(403).json({ error: 'Unknown role' });
  }
  bump(room);
  res.json({ room });
  maybeFinishAnswerPhase(room).catch(e => console.error('finish answer phase:', e));
});

// ─── API: REVEAL DONE ─────────────────────────────────────────
app.post('/api/room/:code/reveal-done', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });

  // Idempotency guard: React StrictMode, polling races, or a double-click/retry should not
  // commit the same reveal twice or advance a round early. Only a live reveal can be finalized.
  if (room.phase !== 'revealing') {
    return res.json({ room });
  }

  // Commit score only AFTER the TV reveal has completed. The TV shows a temporary live score
  // during the reveal; the stored score changes here once, after the reveal is done.
  const currentActive = room.activeSlot;
  if (room.pendingScoreDelta) {
    room.scores[currentActive] = (room.scores[currentActive] || 0) + room.pendingScoreDelta;
  }
  if (room.round === 1 && Array.isArray(room.pendingMatches)) {
    room.round1Matches[currentActive] = [...room.pendingMatches];
  }
  room.pendingScoreDelta = 0;
  room.pendingMatches = [];

  if (room.soloTest && room.turnInRound === 1) {
    // Solo Test mode: one human contestant plays two regular rounds, then moves on.
    room.phase = 'round_end';
    bump(room);
    res.json({ room });
    setTimeout(async () => {
      try {
        if (Number(room.round) < 2) await startNewRound(room, Number(room.round) + 1);
        else await startNewRound(room, 'super');
      }
      catch(e) { console.error('solo next round/super match:', e); }
    }, 3000);
    return;
  }

  if (room.turnInRound === 1) {
    // First contestant done. In Round 2+, if the second contestant is already ahead,
    // classic Match Game logic says they don't need to answer — they win immediately.
    const other = otherSlot(currentActive);
    if (room.round >= 2 && (room.scores[other] || 0) > (room.scores[currentActive] || 0)) {
      room.activeSlot = other;
      room.panel = room.panel.map(p => ({ ...p, answer: null, inactiveThisTurn: false }));
      room.phase = 'round_end';
      bump(room);
      res.json({ room });
      setTimeout(async () => {
        try { await startNewRound(room, 'super'); }
        catch(e) { console.error('start super match:', e); }
      }, 3500);
      return;
    }
    // Otherwise, second contestant now answers the remaining prompt.
    room.turnInRound = 2;
    room.activeSlot = other;
    const remainingIsA = room.promptA !== room.chosenPrompt;
    room.chosenPrompt = remainingIsA ? room.promptA : room.promptB;
    room.chosenAnswerKey = remainingIsA ? (room.promptAnswerKeys?.A || []) : (room.promptAnswerKeys?.B || []);
    room.panel = room.panel.map(p => ({ ...p, answer: null, inactiveThisTurn: false }));
    room.humanPanelAnswers = {};
    room.contestantAnswer = null;
    room.matches = [];
    room.phase = 'answering';
    bump(room);
    maybeScheduleAiAction(room);
    return res.json({ room });
  }

  // Both contestants have now played this round.
  if (room.round === 1) {
    room.phase = 'round_end';
    bump(room);
    res.json({ room });
    setTimeout(async () => {
      try { await startNewRound(room, 2); }
      catch(e) { console.error('start round 2:', e); }
    }, 3000);
    return;
  }

  if (room.round >= 2) {
    const s1 = room.scores[1], s2 = room.scores[2];
    if (s1 === s2) {
      room.scores = { 1: 0, 2: 0 };
      room.round1Matches = { 1: [], 2: [] };
      room.panel = room.panel.map(p => ({ ...p, answer: null, inactiveThisTurn: false }));
      room.phase = 'tiebreaker';
      bump(room);
      res.json({ room });
      setTimeout(async () => {
        try { await startNewRound(room, room.round + 1); }
        catch(e) { console.error('start tiebreaker:', e); }
      }, 4000);
      return;
    }

    const leader = s1 > s2 ? 1 : 2;
    room.activeSlot = leader;
    room.panel = room.panel.map(p => ({ ...p, answer: null, inactiveThisTurn: false }));
    room.phase = 'round_end';
    bump(room);
    res.json({ room });
    setTimeout(async () => {
      try { await startNewRound(room, 'super'); }
      catch(e) { console.error('start super match:', e); }
    }, 4000);
    return;
  }

  room.phase = 'round_end';
  bump(room);
  return res.json({ room });
});


const completeSuperMatchGeneration = async (room) => {
  const safeIndices = room.superMatchCelebIndices || [];
  room.phase = 'superMatch_generating';
  bump(room);
  const celebNames = safeIndices.map(i => room.panel[i].name);
  const result = await generateSuperMatchAnswers(room.superMatchPrompt, celebNames);
  room.superMatchTopAnswers = Array.isArray(result.topAnswers) ? result.topAnswers : [];
  if (room.superMatchTopAnswers.length === 0) {
    room.superMatchTopAnswers = [{ rank: 1, answer: (result.celebAnswers || [])[0] || 'answer', value: 500 }];
  }
  safeIndices.forEach((panelIdx, i) => {
    const humanAnswer = room.superMatchHumanAnswers?.[panelIdx];
    room.panel[panelIdx] = {
      ...room.panel[panelIdx],
      answer: humanAnswer || (result.celebAnswers || [])[i] || '???'
    };
  });
  room.superMatchRevealIndex = -1;
  room.phase = 'superMatch_revealing';
  bump(room);
};

// ─── API: SUPER MATCH — PICK CELEBS ───────────────────────────
app.post('/api/room/:code/supermatch-pick', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room || room.phase !== 'superMatch_pickCelebs') return res.status(400).json({ error: 'Wrong phase' });
  const { celebIndices } = req.body;
  if (!Array.isArray(celebIndices) || celebIndices.length !== 3) return res.status(400).json({ error: '3 celebs required' });

  const safeIndices = celebIndices.map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < room.panel.length).slice(0, 3);
  if (safeIndices.length !== 3) return res.status(400).json({ error: 'Invalid celebrity selection' });

  room.superMatchCelebIndices = safeIndices;
  room.superMatchHumanAnswers = {};
  const humanSelected = safeIndices.filter(i => room.panel[i]?.isHuman);
  if (humanSelected.length) {
    room.phase = 'superMatch_human_answering';
    bump(room);
    res.json({ room });
    return;
  }

  room.phase = 'superMatch_generating';
  bump(room);
  res.json({ room });
  try { await completeSuperMatchGeneration(room); }
  catch(e) { console.error('supermatch generate:', e); room.phase = 'error'; bump(room); }
});

app.post('/api/room/:code/supermatch-celeb-answer', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room || room.phase !== 'superMatch_human_answering') return res.status(400).json({ error: 'Wrong phase' });
  const { slot, answer } = req.body;
  if (!answer?.trim()) return res.status(400).json({ error: 'answer required' });
  const role = room.roles?.[slot];
  if (!role || role.role !== 'celeb' || !(room.superMatchCelebIndices || []).includes(role.celebIndex)) {
    return res.status(403).json({ error: 'Not a selected celebrity' });
  }
  room.superMatchHumanAnswers = room.superMatchHumanAnswers || {};
  room.superMatchHumanAnswers[role.celebIndex] = answer.trim().slice(0, 50);
  bump(room);
  res.json({ room });
  const selectedHumans = (room.superMatchCelebIndices || []).filter(i => room.panel[i]?.isHuman);
  const allReady = selectedHumans.every(i => room.superMatchHumanAnswers?.[i]);
  if (allReady) {
    try { await completeSuperMatchGeneration(room); }
    catch(e) { console.error('supermatch generate:', e); room.phase = 'error'; bump(room); }
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
  maybeScheduleAiAction(room);
  res.json({ room });
});

// ─── API: SUPER MATCH — CONTESTANT ANSWER ─────────────────────
const completeSuperMatchContestantAnswer = async (room, answer) => {
  room.superMatchContestantAnswer = String(answer || '').trim().slice(0, 50);

  // Score against top answers
  const topAnswers = room.superMatchTopAnswers || [];
  let winnings = 0;
  for (const ta of topAnswers) {
    if (await llmMatch(room.superMatchPrompt, room.superMatchContestantAnswer, ta.answer)) {
      winnings = ta.value;
      break;
    }
  }
  room.superMatchWinnings = winnings;
  room.partingGift = winnings > 0 ? null : randomPartingGift();
  room.superMatchTopRevealIndex = -1;
  room.phase = winnings > 0 ? 'superMatch_won' : 'superMatch_lost';
  bump(room);
};

app.post('/api/room/:code/supermatch-answer', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { answer } = req.body;
  if (!answer?.trim()) return res.status(400).json({ error: 'answer required' });
  await completeSuperMatchContestantAnswer(room, answer);
  res.json({ room });
});



app.post('/api/room/:code/supermatch-prompt-read', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.phase === 'superMatch_pickCelebs') {
    room.superMatchPromptReady = true;
    bump(room);
  }
  res.json({ room });
});

app.post('/api/room/:code/finalmatch-prompt-read', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.phase === 'finalMatch_answering' || room.phase === 'finalMatch_human_celeb_answering') {
    room.finalMatchPromptReady = true;
    bump(room);
  }
  res.json({ room });
});

const completeFinalMatchReveal = async (room) => {
  const celeb = room.panel[room.finalMatchCelebIndex];
  let celebAnswer = null;
  if (celeb?.isHuman) celebAnswer = room.finalMatchHumanAnswers?.[room.finalMatchCelebIndex];
  if (!celebAnswer) {
    celebAnswer = await generateFinalMatchCelebAnswer(
      room.finalMatchPrompt, celeb, room.players[room.activeSlot], room.finalMatchAnswerKey || []
    );
  }
  room.finalMatchCelebAnswer = String(celebAnswer || '').trim().slice(0, 50) || (room.finalMatchAnswerKey?.[0] || 'answer');
  const matched = await llmMatch(room.finalMatchPrompt, room.finalMatchContestantAnswer, room.finalMatchCelebAnswer);
  room.finalMatchResult = matched ? 'win' : 'lose';
  room.finalMatchWinnings = matched ? room.superMatchWinnings * 10 : 0;
  room.phase = 'finalMatch_reveal';
  bump(room);
};

// ─── API: FINAL MATCH ─────────────────────────────────────────
app.post('/api/room/:code/finalmatch-start', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.phase?.startsWith('finalMatch')) return res.json({ room });
  if (room.phase !== 'superMatch_won') return res.status(400).json({ error: 'Final Match can only start after a Super Match win' });
  room.phase = 'finalMatch_generating';
  bump(room);
  res.json({ room });

  try {
    const fm = await generateFinalMatchPrompt(room.usedFinalPrompts || []);
    room.finalMatchPrompt = fm.prompt;
    room.usedFinalPrompts = [...(room.usedFinalPrompts || []), fm.prompt];
    room.finalMatchAnswerKey = fm.answers || [];
    room.finalMatchCelebIndex = null;
    room.finalMatchContestantAnswer = null;
    room.finalMatchCelebAnswer = null;
    room.finalMatchHumanAnswers = {};
    room.finalMatchPromptReady = false;
    room.phase = 'finalMatch_pickCeleb';
    bump(room);
    maybeScheduleAiAction(room);
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
  room.finalMatchHumanAnswers = {};
  room.finalMatchPromptReady = false;
  room.phase = 'finalMatch_answering';
  bump(room);
  maybeScheduleAiAction(room);
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
    if (celeb?.isHuman && !room.finalMatchHumanAnswers?.[room.finalMatchCelebIndex]) {
      room.phase = 'finalMatch_human_celeb_answering';
      bump(room);
      return;
    }
    await completeFinalMatchReveal(room);
  } catch(e) {
    console.error('finalmatch celeb answer:', e);
    room.phase = 'error';
    bump(room);
  }
});

app.post('/api/room/:code/finalmatch-celeb-answer', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!['finalMatch_answering','finalMatch_human_celeb_answering'].includes(room.phase)) return res.status(400).json({ error: 'Wrong phase' });
  const { slot, answer } = req.body;
  if (!answer?.trim()) return res.status(400).json({ error: 'answer required' });
  const role = room.roles?.[slot];
  if (!role || role.role !== 'celeb' || role.celebIndex !== room.finalMatchCelebIndex || !room.panel[role.celebIndex]?.isHuman) {
    return res.status(403).json({ error: 'Not the selected Final Match celebrity' });
  }
  room.finalMatchHumanAnswers = room.finalMatchHumanAnswers || {};
  room.finalMatchHumanAnswers[role.celebIndex] = answer.trim().slice(0, 50);
  bump(room);
  res.json({ room });

  if (room.finalMatchContestantAnswer) {
    try { await completeFinalMatchReveal(room); }
    catch(e) { console.error('finalmatch human celeb answer:', e); room.phase = 'error'; bump(room); }
  }
});


app.post('/api/room/:code/supermatch-lost-done', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.phase !== 'superMatch_lost') return res.json({ room });
  room.phase = 'gameOver';
  bump(room);
  res.json({ room });
});

app.post('/api/room/:code/finalmatch-done', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.phase = 'gameOver';
  bump(room);
  res.json({ room });
});


app.post('/api/room/:code/play-again', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!['gameOver','error'].includes(room.phase)) return res.status(400).json({ error: 'Play Again is only available after the game ends' });
  try {
    resetRoomForPlayAgain(room);
    bump(room);
    res.json({ room });
    setTimeout(() => assignRolesAndStart(room).catch(e => { console.error('play again:', e); room.phase = 'error'; bump(room); }), 400);
  } catch (e) {
    console.error('play again:', e);
    room.phase = 'error'; bump(room);
    res.status(500).json({ error: e.message });
  }
});

// ─── API: TTS ─────────────────────────────────────────────────
app.post('/api/speak', async (req, res) => {
  const { code, slot, text, isAnnouncer } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  let voice = 'alloy', instructions = '';
  if (isAnnouncer) {
    voice = 'verse';
    instructions = 'Speak like a very enthusiastic 1970s game-show host: bright, energetic, smiling, theatrical, quick but clear, with big excitement on contestant names and prize reveals.';
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
