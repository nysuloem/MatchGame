import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import path from 'path';
import fs from 'fs';
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
const PROMPT_HISTORY_FILE = path.join(DATA_DIR, 'prompt-history.json');
const loadPromptHistory = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(PROMPT_HISTORY_FILE)) return { round: {}, super: {} };
    const parsed = JSON.parse(fs.readFileSync(PROMPT_HISTORY_FILE, 'utf8'));
    return { round: parsed.round || {}, super: parsed.super || {} };
  } catch (err) {
    console.warn('Could not load prompt history:', err.message);
    return { round: {}, super: {} };
  }
};
const PROMPT_HISTORY = loadPromptHistory();
const savePromptHistory = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PROMPT_HISTORY_FILE, JSON.stringify(PROMPT_HISTORY, null, 2));
  } catch (err) {
    console.warn('Could not save prompt history:', err.message);
  }
};
const hasPromptBeenUsed = (kind, prompt) => Boolean(PROMPT_HISTORY[kind]?.[normalizePromptKey(prompt)]);
const markPromptUsed = (kind, prompt) => {
  const key = normalizePromptKey(prompt);
  if (!PROMPT_HISTORY[kind]) PROMPT_HISTORY[kind] = {};
  PROMPT_HISTORY[kind][key] = { prompt, usedAt: new Date().toISOString() };
  savePromptHistory();
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


const promptIsUsable = (prompt) => {
  const t = String(prompt || '').trim();
  if (!t.includes('___')) return false;
  if (t.length < 40 || t.length > 150) return false;
  if (/favo[u]?rite/i.test(t)) return false; // this became repetitive and too generic
  if ((t.match(/___/g) || []).length !== 1) return false;
  return true;
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

const usedPromptSamples = (kind, limit = 80) => Object.values(PROMPT_HISTORY[kind] || {})
  .slice(-limit)
  .map(x => x.prompt)
  .filter(Boolean);

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
- The other 5 panelists must be recognizable to adults and older teenagers in 2026.
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

  return panel.slice(0, 6).map(p => ({
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
};

const generateRoundPrompts = async (usedCharacters = [], usedCategories = [], usedRoundPrompts = []) => {
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
  const categories = shuffle(PROMPT_CATEGORIES).slice(0, 6).join(', ');

  // GenAI should be the engine, but the database/history is still essential as a guardrail:
  // generate fresh prompts, reject repeats/similar prompts, and only fall back to curated prompts if needed.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const text = await callLLM(
        `Generate TWO brand-new Match Game-style fill-in-the-blank prompts for a family game with adults and 17+ teens.

IMPORTANT: These must not repeat or closely resemble any prior prompt listed below.
Avoid prior prompts:\n${avoidList || '(none)'}

Use fresh situations from these areas: ${categories}.
Do NOT use generic "Favourite ___" prompts.
Do NOT use trivia, niche references, or questions that are too wide open.
Each prompt needs a "definitive" best answer: not obvious to everyone, but constrained enough that several people might match.
Light innuendo is okay; keep it TV-PG/PG-13, playful, not explicit.

For each prompt return 3 likely answers in order. The #1 answer should be the answer the panel can cluster around.
Return JSON exactly:
{"prompts":[{"prompt":"... ___ ...","answers":["best","second","third"],"category":"...","character":"..."},{"prompt":"... ___ ...","answers":["best","second","third"],"category":"...","character":"..."}]}`,
        700, true
      );
      const parsed = extractJSON(text);
      const prompts = (parsed.prompts || []).filter(x => promptIsUsable(x.prompt) && Array.isArray(x.answers) && x.answers.length >= 2);
      const fresh = [];
      for (const pr of prompts) {
        if (promptAlreadyUsedOrSimilar('round', pr.prompt, [...localUsed, ...fresh.map(f => f.prompt)])) continue;
        fresh.push(pr);
      }
      if (fresh.length >= 2) {
        const [a,b] = fresh;
        GLOBAL_USED_ROUND_PROMPTS.add(normalizePromptKey(a.prompt));
        GLOBAL_USED_ROUND_PROMPTS.add(normalizePromptKey(b.prompt));
        markPromptUsed('round', a.prompt);
        markPromptUsed('round', b.prompt);
        return {
          promptA: a.prompt, promptB: b.prompt,
          answersA: a.answers.slice(0,3), answersB: b.answers.slice(0,3),
          categoryA: 'PROMPT:' + a.prompt, categoryB: 'PROMPT:' + b.prompt,
          charA: a.character || charA, charB: b.character || charB,
        };
      }
    } catch (e) {
      console.warn('fresh prompt generation failed:', e.message);
    }
  }

  // Fallback only: curated bank still exists so the game never crashes if API generation fails.
  let unused = FALLBACK_ROUND_PROMPTS.filter(p => !promptAlreadyUsedOrSimilar('round', p.prompt, localUsed));
  if (unused.length < 2) unused = FALLBACK_ROUND_PROMPTS.filter(p => !localUsed.some(u => normalizePromptKey(u) === normalizePromptKey(p.prompt)));
  if (unused.length < 2) unused = FALLBACK_ROUND_PROMPTS;
  const pool = shuffle(unused);
  const a = pool[0];
  const b = pool.find(p => normalizePromptKey(p.prompt) !== normalizePromptKey(a.prompt)) || pool[1] || a;
  markPromptUsed('round', a.prompt);
  markPromptUsed('round', b.prompt);
  return {
    promptA: a.prompt, promptB: b.prompt,
    answersA: a.answers, answersB: b.answers,
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
- Round 2: increase matching strongly. At least 4 eligible celebrities should use the #1 answer or an obvious synonym. One celebrity may use #2/#3. One may be funny/lightly innuendo-based, but still plausibly matchable.
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

const generateSuperMatchPrompt = async (usedPrompts = []) => {
  const localUsed = [...(usedPrompts || []), ...usedPromptSamples('super', 120)];
  const avoidList = localUsed.slice(-90).map(p => `- ${p}`).join('\n');

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const text = await callLLM(
        `Generate ONE brand-new Super Match survey-board prompt.
It should be a short phrase with exactly one blank: ___
Examples of the FORM: "Hot ___", "___ Dog", "Wedding ___", "Phone ___".
Do NOT overuse "Favourite" or "Favorite". In fact, avoid that word entirely.
It must be obvious enough to produce top 3 survey answers, but not be identical or similar to anything below.
Avoid prior prompts:\n${avoidList || '(none)'}

Return JSON exactly: {"prompt":"... ___ ..."}`,
        140, true
      );
      const parsed = extractJSON(text);
      const prompt = String(parsed.prompt || '').trim();
      if (promptIsUsable(prompt) && !promptAlreadyUsedOrSimilar('super', prompt, localUsed)) {
        markPromptUsed('super', prompt);
        return prompt;
      }
    } catch (e) {
      console.warn('fresh super prompt generation failed:', e.message);
    }
  }

  let unused = FALLBACK_SUPER_PROMPTS.filter(p => !promptAlreadyUsedOrSimilar('super', p.prompt, localUsed));
  if (!unused.length) unused = FALLBACK_SUPER_PROMPTS.filter(p => !(usedPrompts || []).some(u => normalizePromptKey(u) === normalizePromptKey(p.prompt)));
  if (!unused.length) unused = FALLBACK_SUPER_PROMPTS;
  const chosen = shuffle(unused)[0];
  markPromptUsed('super', chosen.prompt);
  return chosen.prompt;
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
  ['money','cash','bucks','dollars','dough','cheque','check','paycheck','paycheque'],
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

const llmMatch = async (prompt, a, b) => {
  if (fuzzyMatch(a, b)) return true;
  // Conservative API judge for edge cases: spelling, Canadian/American variants,
  // close synonyms, singular/plural, and common-sense equivalents.
  try {
    const text = await callLLM(
      `You are the match judge for a Match Game-style fill-in-the-blank game.
Prompt: "${prompt || ''}"
Contestant answer: "${a || ''}"
Celebrity answer: "${b || ''}"

Count as a match for spelling variants, Canadian/American variants, plural/singular, abbreviations, and ordinary synonyms that would fit the same blank. Examples: cheque/check, TV/television, abs/muscles, beer/drink.
Do NOT count as a match if they are merely related but would make meaningfully different answers.
Return JSON only: {"match":true} or {"match":false}`,
      40, true
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
  const c1 = contestantPool[0], c2 = contestantPool.find(id => id !== c1);
  room.playerIds = { 1: c1, 2: c2 };
  room.players = { 1: room.participants[c1], 2: room.participants[c2] };
  room.roles = {};
  room.roles[c1] = { role: 'contestant', contestantSlot: 1 };
  room.roles[c2] = { role: 'contestant', contestantSlot: 2 };

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
  const { playerName, playerCount } = req.body;
  if (!playerName?.trim()) return res.status(400).json({ error: 'playerName required' });
  const isDisplay = playerName.trim() === '__display__';
  try {
    const code = makeRoomCode();
    const maxPlayers = clampInt(playerCount || 2, 2, 8);
    const room = {
      code, version: 1, lastActivity: Date.now(),
      phase: 'lobby',
      maxPlayers,
      participants: {},
      participantMessages: {},
      participantPreferences: {},
      nextParticipantId: 1,
      rolesAssigned: false,
      roles: {},
      playerIds: { 1: null, 2: null },
      round: 0,
      activeSlot: null,
      turnInRound: 1,
      players: { 1: null, 2: null },
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
      finalMatchPrompt: null,
      finalMatchAnswerKey: [],
      finalMatchCelebIndex: null,
      finalMatchContestantAnswer: null,
      finalMatchCelebAnswer: null,
      finalMatchHumanAnswers: {},
      finalMatchResult: null,
      finalMatchWinnings: 0,
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
  const { playerName, signMessage, rolePreference } = req.body;
  if (!playerName?.trim()) return res.status(400).json({ error: 'playerName required' });
  if (room.rolesAssigned) return res.status(409).json({ error: 'Game already started' });
  if (Object.keys(room.participants || {}).length >= room.maxPlayers) return res.status(409).json({ error: 'Room is full' });
  const slot = room.nextParticipantId++;
  room.participants[slot] = playerName.trim().slice(0, 20);
  room.participantMessages = room.participantMessages || {};
  room.participantMessages[slot] = String(signMessage || '').trim().slice(0, 32) || randomSign();
  room.participantPreferences = room.participantPreferences || {};
  room.participantPreferences[slot] = ['contestant','celebrity','surprise'].includes(rolePreference) ? rolePreference : 'surprise';
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
  bump(room);
  res.json({ room });
  setTimeout(async () => {
    try { await startNewRound(room, 1); }
    catch(e) { console.error('start round 1 after intro:', e); room.phase = 'error'; bump(room); }
  }, 500);
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
    room.humanPanelAnswers = {};
    room.pendingScoreDelta = 0;
    room.pendingMatches = [];
    room.panel = room.panel.map(p => ({ ...p, answer: null, inactiveThisTurn: false }));
    const { promptA, promptB, answersA, answersB, categoryA, categoryB, charA, charB } = await generateRoundPrompts(room.usedCharacters, room.usedCategories || [], room.usedRoundPrompts || []);
    room.promptA = promptA;
    room.promptB = promptB;
    room.promptAnswerKeys = { A: answersA, B: answersB };
    room.chosenAnswerKey = [];
    room.usedCharacters.push(charA, charB);
    room.usedCategories = [...(room.usedCategories || []), categoryA, categoryB];
    room.usedRoundPrompts = [...(room.usedRoundPrompts || []), promptA, promptB];

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
    if (await llmMatch(room.superMatchPrompt, room.superMatchContestantAnswer, ta.answer)) {
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
    const fm = await generateFinalMatchPrompt();
    room.finalMatchPrompt = fm.prompt;
    room.finalMatchAnswerKey = fm.answers || [];
    room.finalMatchCelebIndex = null;
    room.finalMatchContestantAnswer = null;
    room.finalMatchCelebAnswer = null;
    room.finalMatchHumanAnswers = {};
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
  room.finalMatchHumanAnswers = {};
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
