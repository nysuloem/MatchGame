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

const CLASSIC_MATCH_GAMERS = [
  'Betty White','Richard Dawson','Brett Somers','Charles Nelson Reilly','Fannie Flagg',
  'Nipsey Russell','Patti Deutsch','Marcia Wallace','Joyce Bulifant','Elaine Joyce'
];

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
  'awkward family moments', 'teen and adult dating', 'phones and group chats',
  'streaming and reality TV', 'school and campus life', 'workplace embarrassment',
  'gym and body comedy', 'food delivery and restaurants', 'vacations and hotels',
  'weddings and parties', 'pets behaving badly', 'shopping and money',
  'cars and driving', 'doctors and health mishaps', 'sports and games'
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
  { prompt: "The influencer's beach photo was ruined when a seagull stole her ___.", answers: ['sandwich','phone','bikini'], category: 'social media' },
  { prompt: "At the office party, Steve accidentally photocopied his ___.", answers: ['butt','face','hand'], category: 'work' },
  { prompt: "The hotel said breakfast was included, but it was only a single ___.", answers: ['muffin','egg','banana'], category: 'travel' },
  { prompt: "The dog groomer gave Mr. Jenkins' poodle a haircut that looked like a ___.", answers: ['mop','lion','rat'], category: 'pets' },
  { prompt: "The new car came with heated seats and a talking ___.", answers: ['dashboard','steering wheel','cupholder'], category: 'cars' },
  { prompt: "At karaoke night, Kevin got booed after singing into a ___.", answers: ['banana','remote','brush'], category: 'parties' }
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
  { prompt:'First ___', topAnswers:[{rank:1,answer:'Date',value:500},{rank:2,answer:'Kiss',value:250},{rank:3,answer:'Love',value:100}] }
];

const generatePanel = async () => {
  const classic = CLASSIC_MATCH_GAMERS[Math.floor(Math.random() * CLASSIC_MATCH_GAMERS.length)];
  const varietySeed = Math.random().toString(36).slice(2, 8);
  const text = await callLLM(
    `Generate a panel of 6 well-known public figures for a Match Game style game show.

CRITICAL PANEL RULES:
- Include EXACTLY ONE classic Match Game regular: ${classic}.
- The other 5 panelists must be recognizable to adults and older teenagers in 2026.
- Make the five modern choices highly varied: choose from different categories such as comedians, sitcom actors, musicians, athletes, internet personalities, movie stars, TV hosts, chefs, reality TV figures, and tech/pop-culture figures.
- Avoid politicians.
- Avoid always choosing the same obvious people. Variety seed: ${varietySeed}.
- Do not duplicate fields, vibes, or sketch/avatar types if you can avoid it.

For each panelist provide:
- "name": the short public/stage name they are normally known by on screen. No middle names, initials, titles, suffixes, or overly formal full legal names unless that is how the public usually knows them
- "tag": 3-5 word description of their public persona
- "avatarType": one of these sketch styles that best fits them visually: "man_young", "man_middle", "man_older", "woman_young", "woman_middle", "woman_older", "person_athletic", "person_glamorous"
- "voice": best matching OpenAI TTS voice from: ${TTS_VOICES.join(', ')}. Prefer louder/brighter voices when possible: verse, ash, coral, nova, shimmer, fable. Use onyx only for very deep voices.
- "voiceInstructions": 1-2 sentences on HOW to deliver lines as this person — energetic, crisp, theatrical, easy to hear. Do not imitate a real voice exactly.
- "answerStyle": one of "obvious", "literal", "punny", "wildcard", "deadpan", "chaotic". Use mostly obvious/literal/punny, with only one true wildcard.
- "matchBias": a number from 0.70 to 0.98 describing how hard this panelist usually tries to match contestants.

Assign DIFFERENT voices to different panelists.

Return JSON: {"panel": [{"name":"...","tag":"...","avatarType":"...","voice":"...","voiceInstructions":"...","answerStyle":"...","matchBias":0.85}, ...]}`,
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
      matchBias: 0.92
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

  return panel.slice(0, 6).map(p => ({
    name: cleanPanelName(p.name),
    tag: p.tag,
    avatarType: uniqueAvatarType(p.avatarType),
    voice: TTS_VOICES.includes(p.voice) ? p.voice : 'verse',
    voiceInstructions: p.voiceInstructions || 'Speak clearly, energetically, and loud enough to carry in a game-show room.',
    answerStyle: ['obvious','literal','punny','wildcard','deadpan','chaotic'].includes(p.answerStyle) ? p.answerStyle : 'obvious',
    matchBias: Number.isFinite(Number(p.matchBias)) ? Math.max(0.65, Math.min(0.98, Number(p.matchBias))) : 0.85,
    answer: null,
  }));
};

const generateRoundPrompts = async (usedCharacters = [], usedCategories = []) => {
  const availableChars = CHARACTER_ARCHETYPES.filter(c => !usedCharacters.includes(c));
  const shuffled = availableChars.sort(() => Math.random() - 0.5);
  const charA = shuffled[0] || 'Old Timer Terry';
  const charB = shuffled[1] || 'Newcomer Nick';
  const availableCategories = PROMPT_CATEGORIES.filter(c => !usedCategories.includes(c));
  const cats = (availableCategories.length ? availableCategories : PROMPT_CATEGORIES).sort(() => Math.random() - 0.5).slice(0, 2);
  const seed = Math.random().toString(36).slice(2, 8);

  const text = await callLLM(
    `Generate exactly 2 Match Game fill-in-the-blank prompts with "definitive" answers.

Use character names "${charA}" and "${charB}" — one per prompt.
Use two DIFFERENT comedy categories: "${cats[0]}" and "${cats[1]}".
Variety seed: ${seed}

VERY IMPORTANT: "DEFINITIVE" DOES NOT MEAN BORINGLY OBVIOUS.
A great prompt should make players think, "Oh, there are a few possibilities, but one answer is clearly the Match Game answer."
The blank should NOT be wide open. The top 3 likely answers should be in the same semantic neighborhood.

CRITICAL OUTPUT REQUIREMENT:
For each prompt, include an "answers" array containing the 3 most likely short answers that normal contestants would give, ordered by likelihood.
Also include a "definitiveScore" from 1-10. Only return prompts scoring 8-10.

PROMPT RULES:
- The top answer must be concrete and easy to imagine.
- The #2/#3 answers should be plausible alternatives, not totally different interpretations.
- The setup should be funny, classic Match Game-ish, and family 17+/PG-13.
- Light innuendo is welcome; no explicit sexual content, slurs, or cruelty.
- Avoid very broad blanks like "something", "stuff", "thing", or "place".
- Avoid clues where almost any noun could fit.
- Avoid answers that create awkward redundant phrases.
- 10-22 words per prompt.
- Answers must be 1-2 words each.

GOOD DEFINITIVE EXAMPLES:
- "Grandma Ethel's dating profile said she wanted a man with a big ___." answers: wallet, heart, truck
- "At the office party, Steve accidentally photocopied his ___." answers: butt, face, hand
- "Rookie Randy got nervous at the gym and dropped a ___ on his foot." answers: weight, dumbbell, barbell
- "Tiny Tina's phone autocorrected 'love you' to 'send ___." answers: money, cash, pizza

BAD WIDE-OPEN EXAMPLES:
- "Dumb Dave found a ___ in his kitchen." Too many answers.
- "The teacher brought a ___ to class." Too many answers.
- "On vacation, Linda wanted a ___." Too broad.

Return JSON exactly with keys: promptA, answersA, definitiveScoreA, categoryA, promptB, answersB, definitiveScoreB, categoryB, charA, charB`,
    900, true
  );
  const parsed = extractJSON(text);
  const fallbackA = FALLBACK_ROUND_PROMPTS[Math.floor(Math.random() * FALLBACK_ROUND_PROMPTS.length)];
  const fallbackB = FALLBACK_ROUND_PROMPTS.filter(p => p.prompt !== fallbackA.prompt)[Math.floor(Math.random() * Math.max(1, FALLBACK_ROUND_PROMPTS.length - 1))] || fallbackA;
  const cleanAnswers = (arr, fb) => (Array.isArray(arr) ? arr : fb.answers).map(a => String(a || '').trim()).filter(Boolean).slice(0, 3);
  const scoreA = Number(parsed.definitiveScoreA || 0);
  const scoreB = Number(parsed.definitiveScoreB || 0);
  const validPrompt = (prompt, answers, score) => typeof prompt === 'string' && prompt.includes('___') && answers.length >= 2 && score >= 7;
  const answersA = cleanAnswers(parsed.answersA, fallbackA);
  const answersB = cleanAnswers(parsed.answersB, fallbackB);
  return {
    promptA: validPrompt(parsed.promptA, answersA, scoreA) ? parsed.promptA : fallbackA.prompt,
    promptB: validPrompt(parsed.promptB, answersB, scoreB) ? parsed.promptB : fallbackB.prompt,
    answersA: validPrompt(parsed.promptA, answersA, scoreA) ? answersA : fallbackA.answers,
    answersB: validPrompt(parsed.promptB, answersB, scoreB) ? answersB : fallbackB.answers,
    categoryA: parsed.categoryA || fallbackA.category,
    categoryB: parsed.categoryB || fallbackB.category,
    charA, charB,
  };
};

const generatePanelAnswers = async (panel, promptText, contestantName, roundNum = 1, answerKey = []) => {
  const panelStr = panel.map((p, i) => `${i+1}. ${p.name} (${p.tag}; style=${p.answerStyle || 'obvious'}; matchBias=${p.matchBias ?? 0.8})`).join('\n');
  const key = (answerKey || []).filter(Boolean).slice(0, 3);
  const order = [0,1,2,3,4,5].sort(() => Math.random() - 0.5);
  const funnyIndex = order[0];
  const topSlots = new Set(order.slice(roundNum === 1 ? 1 : 0, roundNum === 1 ? 3 : 4));
  const alternateSlots = new Set(order.slice(roundNum === 1 ? 3 : 4, roundNum === 1 ? 5 : 5));

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
- Use simple concrete words, not explanations.
- The answer must fit the blank naturally when read in the prompt.
- Round 1: answers may vary, but they must stay in the same answer neighborhood. About 2 celebrities should use the #1 answer, 2 should use #2/#3 or close synonyms, 1 should give a plausible in-character answer, and 1 should give a funny answer.
- Round 2: increase matching. Most eligible celebrities should cluster around the #1 answer or a very close synonym. One celebrity may use #2/#3. One may be funny, but still plausibly matchable.
- The funny answer should be a quick laugh, light innuendo is allowed, but it must still make sense for the blank.
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
  answers = answers.map(a => (a || '???').split(/\s+/).slice(0, 2).join(' '));
  while (answers.length < 6) answers.push(key[0] || '???');

  // Safety net: keep the model funny, but enforce Match Game convergence with randomized positions.
  if (key.length) {
    const top = key[0];
    const second = key[1] || key[0];
    const third = key[2] || second;
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

const generateSuperMatchPrompt = async () => {
  const fallback = FALLBACK_SUPER_PROMPTS[Math.floor(Math.random() * FALLBACK_SUPER_PROMPTS.length)];
  const text = await callLLM(
    `Generate ONE Super Match fill-in-the-blank phrase.

STRICT FORMAT: A single short phrase with exactly one blank marked as ___
STRICT LENGTH: 2-5 words total including the blank
The phrase must have three obvious survey answers and a clear #1 answer.
Avoid weird/awkward compounds and avoid repeating the same noun on both sides.
NO character names, NO full sentences, NO punctuation at end.

Good examples:
Television ___
Birthday ___
___ Dog
Phone ___
Hot ___
Movie ___
___ Party
Gym ___
___ Chat
First ___

Return only the phrase.`,
    60
  );
  const firstLine = text.trim().split('\n')[0].trim().replace(/^["'\d.\-\s]+|["']+$/g, '').trim();
  return firstLine.includes('___') ? firstLine : fallback.prompt;
};

const generateSuperMatchAnswers = async (prompt, celebNames) => {
  const fallback = FALLBACK_SUPER_PROMPTS.find(p => p.prompt.toLowerCase() === String(prompt).toLowerCase())
    || FALLBACK_SUPER_PROMPTS[Math.floor(Math.random() * FALLBACK_SUPER_PROMPTS.length)];
  const text = await callLLM(
    `Super Match game show round. Prompt: "${prompt}"

Generate the TOP 3 most popular/obvious survey answers for adults and 17+ teenagers. Classic Match Game survey logic: obvious beats clever.

Also generate suggested answers for these celebrities: ${celebNames.join(', ')}. They are helping the contestant, so at least 2 of the 3 celebrities should suggest one of the top 3 answers exactly.

Prize values must be exactly:
- Rank 1: 500
- Rank 2: 250
- Rank 3: 100

Return JSON:
{
  "topAnswers": [
    {"rank": 1, "answer": "...", "value": 500},
    {"rank": 2, "answer": "...", "value": 250},
    {"rank": 3, "answer": "...", "value": 100}
  ],
  "celebAnswers": ["answer for celeb 1", "answer for celeb 2", "answer for celeb 3"]
}`,
    500, true
  );
  const parsed = extractJSON(text);
  const topAnswers = (Array.isArray(parsed.topAnswers) && parsed.topAnswers.length >= 3 ? parsed.topAnswers : fallback.topAnswers)
    .slice(0, 3)
    .map((ta, i) => ({ rank: i + 1, answer: String(ta.answer || fallback.topAnswers[i].answer).split(/\s+/).slice(0,2).join(' '), value: [500,250,100][i] }));
  let celebAnswers = Array.isArray(parsed.celebAnswers) ? parsed.celebAnswers : [];
  celebAnswers = celebAnswers.slice(0, 3).map((a, i) => String(a || topAnswers[i % topAnswers.length].answer).split(/\s+/).slice(0,2).join(' '));
  while (celebAnswers.length < 3) celebAnswers.push(topAnswers[celebAnswers.length % topAnswers.length].answer);
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

const generateFinalMatchPrompt = async () => {
  const fallback = FINAL_MATCH_PROMPTS[Math.floor(Math.random() * FINAL_MATCH_PROMPTS.length)];
  const text = await callLLM(
    `Generate ONE Final Match clue as JSON.

It must be a short, familiar phrase with exactly one blank marked ___ and one very obvious most-popular answer.
Use clean survey-style phrases like: Birthday ___ -> Cake, Movie ___ -> Star, Phone ___ -> Call, ___ Dog -> Hot.
Avoid awkward clues like "First Date ___" because the answer can create a redundant phrase.
Avoid clever, abstract, or niche clues.

Return JSON: {"prompt":"...", "answers":["most obvious", "second", "third"]}`,
    160, true
  );
  try {
    const parsed = extractJSON(text);
    const prompt = String(parsed.prompt || '').trim();
    const answers = Array.isArray(parsed.answers) ? parsed.answers.map(a => String(a).trim()).filter(Boolean).slice(0,3) : [];
    if (prompt.includes('___') && answers.length) return { prompt, answers };
  } catch {}
  return fallback;
};

const generateFinalMatchCelebAnswer = async (prompt, celeb, contestantName, answerKey = []) => {
  const keyText = (answerKey || []).filter(Boolean).join(', ');
  const text = await callLLM(
    `Final Match game show. Prompt: "${prompt}"
Contestant: ${contestantName}
Celebrity: ${celeb.name} (${celeb.tag})
Likely survey answers: ${keyText || 'infer the obvious answer'}

${celeb.name} is under pressure and trying VERY HARD to match the contestant. The answer should almost always be the #1 obvious answer, not a joke.
Give only the answer, 1-2 words maximum.`,
    30
  );
  let ans = text.trim().replace(/^['"]|['"]$/g, '').split(/\s+/).slice(0, 2).join(' ');
  if (!ans && answerKey?.[0]) ans = answerKey[0];
  return ans;
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
      pendingScoreDelta: 0,
      pendingMatches: [],
      triangleSlot: null,
      cointossWinner: null,
      panel,
      round1Matches: { 1: [], 2: [] },
      promptA: null, promptB: null,
      chosenPrompt: null,
      usedCharacters: [],
      usedCategories: [],
      chosenAnswerKey: [],
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
      finalMatchAnswerKey: [],
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
    room.pendingScoreDelta = 0;
    room.pendingMatches = [];
    room.panel = room.panel.map(p => ({ ...p, answer: null }));
    const { promptA, promptB, answersA, answersB, categoryA, categoryB, charA, charB } = await generateRoundPrompts(room.usedCharacters, room.usedCategories || []);
    room.promptA = promptA;
    room.promptB = promptB;
    room.promptAnswerKeys = { A: answersA, B: answersB };
    room.chosenAnswerKey = [];
    room.usedCharacters.push(charA, charB);
    room.usedCategories = [...(room.usedCategories || []), categoryA, categoryB].slice(-10);

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
    room.pendingScoreDelta = 0;
    room.pendingMatches = [];
    room.panel = room.panel.map(p => ({ ...p, answer: null }));
    const prompt = await generateSuperMatchPrompt();
    room.superMatchPrompt = prompt;
    room.superMatchCelebIndices = [];
    room.superMatchCelebAnswers = [];
    room.superMatchRevealIndex = -1;
    room.superMatchContestantAnswer = null;
    room.superMatchTopAnswers = null;
    room.superMatchTopRevealIndex = -1;
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
    const answers = await generatePanelAnswers(room.panel, room.chosenPrompt, room.players[room.activeSlot], room.round, room.chosenAnswerKey || []);
    room.panel = room.panel.map((p, i) => inactiveCelebIndices.includes(i)
      ? ({ ...p, answer: null, inactiveThisTurn: true })
      : ({ ...p, answer: answers[i] || '???', inactiveThisTurn: false })
    );
    room.panelAnswers = room.panel.map(p => p.answer);
    const matches = scoreAnswer(room.contestantAnswer, room.panel).map((m, i) => inactiveCelebIndices.includes(i) ? false : m);
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
});

// ─── API: REVEAL DONE ─────────────────────────────────────────
app.post('/api/room/:code/reveal-done', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ room: bump(room) });

  // Commit score only AFTER the TV reveal has completed, so the score changes live during reveal.
  const currentActive = room.activeSlot;
  if (room.pendingScoreDelta) {
    room.scores[currentActive] += room.pendingScoreDelta;
  }
  if (room.round === 1 && Array.isArray(room.pendingMatches)) {
    room.round1Matches[currentActive] = [...room.pendingMatches];
  }
  room.pendingScoreDelta = 0;
  room.pendingMatches = [];

  if (room.turnInRound === 1) {
    // First contestant done — second contestant now picks
    room.turnInRound = 2;
    // The "other" prompt goes to the other contestant
    const other = otherSlot(currentActive);
    room.activeSlot = other;
    const remainingIsA = room.promptA !== room.chosenPrompt;
    room.chosenPrompt = remainingIsA ? room.promptA : room.promptB;
    room.chosenAnswerKey = remainingIsA ? (room.promptAnswerKeys?.A || []) : (room.promptAnswerKeys?.B || []);
    // Actually just give them the remaining prompt — no pick for contestant 2
    room.panel = room.panel.map(p => ({ ...p, answer: null, inactiveThisTurn: false }));
    room.contestantAnswer = null;
    room.matches = [];
    room.pendingScoreDelta = 0;
    room.pendingMatches = [];
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
      room.superMatchTopAnswers = [{ rank: 1, answer: (result.celebAnswers || [])[0] || 'answer', value: 500 }];
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
  room.superMatchTopRevealIndex = -1;
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
    const fm = await generateFinalMatchPrompt();
    room.finalMatchPrompt = fm.prompt;
    room.finalMatchAnswerKey = fm.answers || [];
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
      room.finalMatchPrompt, celeb, room.players[room.activeSlot], room.finalMatchAnswerKey || []
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
