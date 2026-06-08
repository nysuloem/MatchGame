import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 3001;

// Memory storage for active game rooms
const rooms = new Map();

// ─── SYSTEM PROMPTS ENFORCING RETRO COMEDY SPIRIT ───

const REGULAR_ROUND_SYSTEM = `
You are the head writer for "The Match Game," a retro 1970s comedy game show. 
Generate a hilarious, classic fill-in-the-blank prompt for the contestants.

CRITICAL RULES FOR THE SPIRIT OF THE GAME:
1. It must use mild innuendo, double entendre, or absurd comedic situations.
2. It should frequently feature recurring classic fictional archetypes (e.g., "Dumb Dora", "Dumb Donald", "Big Betty", "Uncle Fester", "The local streaker").
3. The sentence must contain exactly one "[BLANK]" marker (written as [BLANK]).
4. The setup must be flexible enough that 6 different celebrity panelists can think of completely different funny words that fit grammatically. 
5. Avoid trivia, factual definitions, or questions with only one logical answer.

Good Examples:
- "Dumb Dora is so dumb, she thought a quarterback was a refund on a coin toss. When she went to the game, she brought her [BLANK]."
- "The neighborhood butcher is getting so old, instead of putting his thumb on the scale, he accidently weighed his [BLANK]."
- "Superman decided to spice things up in the bedroom. Instead of wearing his cape, he wore [BLANK]."
- "Big Betty is so large, when she went out into the ocean wearing a yellow swimsuit, a cruise ship mistook her for a [BLANK]."
`;

const SUPER_MATCH_SYSTEM = `
You are generating a "Super Match" prompt for "The Match Game". 
In the Super Match, the question is always a common phrase, phrase completion, or compound noun with one half blanked out.

CRITICAL RULES:
1. Keep it short. It must be a 1-to-3 word phrase featuring a "[BLANK]".
2. It must represent a highly recognizable phrase or idiom that a live studio audience would have diverse answers for.

Good Examples:
- "Pizza [BLANK]" (Audience might say: Hut, Pie, Dough, Cutter)
- "[BLANK] Cake" (Audience might say: Pancake, Birthday, Cup, Piece of)
- "Spit [BLANK]" (Audience might say: Ball, Fire, Take)
- "[BLANK] Jack" (Audience might say: Lumber, Apple, Cracker, Black)
`;

const FINAL_MATCH_SYSTEM = `
You are generating a "Final Match" prompt. This is a short phrase completion question where a contestant must match a single star exactly.
Generate a short compound word or highly recognizable pop-culture/everyday phrase with a "[BLANK]".

Good Examples:
- "Hot [BLANK]" (Dog, Sauce, Tub, Mess)
- "[BLANK] Ticket" (Golden, Speeding, Meal, Lottery)
- "Belly [BLANK]" (Button, Flop, Laugh, Dancer)
`;

// Helper to enforce the negative constraint of used questions
function getForbiddenPromptsInstruction(usedPrompts) {
  if (!usedPrompts || usedPrompts.length === 0) {
    return "No previous questions have been used yet. This is a fresh start.";
  }
  return `CRITICAL NEGATIVE CONSTRAINT: DO NOT generate any questions that match, closely resemble, or contain the core punchline of these previously used prompts:\n${usedPrompts.map(p => `- "${p}"`).join('\n')}`;
}

// ─── GAME STATE CLEANUP LOOP ───
// Rooms expire after 4 hours of inactivity to save memory
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActive > 4 * 60 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000);

// Helper to update room activity timestamps
const touchRoom = (room) => {
  room.lastActive = Date.now();
};

// ─── API ENDPOINTS ───

// Create Room
app.post('/api/room', async (req, res) => {
  try {
    const { playerName, playerCount, soloTest } = req.body;
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    
    // Fallback static panels if OpenAI fails
    const staticPanel = [
      { name: "Charles Nelson Reilly", avatarType: "man_old", tag: "Theatrical & Animated" },
      { name: "Brett Somers", avatarType: "woman_old", tag: "Witty & Sarcastic" },
      { name: "Richard Dawson", avatarType: "man_middle", tag: "Charming Host" },
      { name: "Betty White", avatarType: "woman_old", tag: "Sweet but Sharp" },
      { name: "Gene Rayburn", avatarType: "man_middle", tag: "Energetic Host" },
      { name: "Nipsy Russell", avatarType: "man_middle", tag: "The Poet Laureate" }
    ];

    const newRoom = {
      code,
      phase: 'lobby',
      players: { 1: playerName },
      scores: { 1: 0, 2: 0 },
      version: 1,
      maxPlayers: playerCount || 2,
      soloTest: !!soloTest,
      participants: { 1: playerName },
      roles: { 1: { role: 'contestant', contestantSlot: 1 } },
      panel: staticPanel,
      usedPrompts: [], // <-- Track history per room to prevent duplicates
      lastActive: Date.now()
    };

    // Attempt to dynamically build a tailored panel from OpenAI if key exists
    if (process.env.OPENAI_API_KEY) {
      try {
        const completion = await openai.chat.completions.create({
          model: process.env.OPENAI_LLM_MODEL || "gpt-4o-mini",
          messages: [
            { role: "system", content: "Generate an array of 6 distinct, funny 1970s celebrity characters as a JSON array. Format: [{\"name\":\"Name\", \"avatarType\":\"man_middle|man_old|woman_middle|woman_old\", \"tag\":\"short vibe\"}]" }
          ],
          response_format: { type: "json_object" }
        });
        const data = JSON.parse(completion.choices[0].message.content);
        if (Array.isArray(data.panel)) {
          newRoom.panel = data.panel.slice(0, 6);
        } else if (Array.isArray(data.celebrities)) {
          newRoom.panel = data.celebrities.slice(0, 6);
        }
      } catch (e) {
        console.error("Failed to generate dynamic panel, using retro defaults:", e.message);
      }
    }

    rooms.set(code, newRoom);
    res.json({ room: newRoom });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Join Room
app.post('/api/room/:code/join', (req, res) => {
  const { code } = req.params;
  const { playerName, signMessage, rolePreference } = req.body;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  touchRoom(room);
  const nextSlot = Object.keys(room.participants).length + 1;
  room.participants[nextSlot] = playerName;

  if (nextSlot === 2 && !room.players[2]) {
    room.players[2] = playerName;
    room.roles[nextSlot] = { role: 'contestant', contestantSlot: 2 };
  } else {
    const celebIdx = (nextSlot - 3) % room.panel.length;
    room.roles[nextSlot] = { role: 'celeb', celebIndex: celebIdx };
    if (signMessage) room.panel[celebIdx].signMessage = signMessage;
  }

  if (Object.keys(room.participants).length >= room.maxPlayers) {
    room.phase = 'cointoss';
    room.triangleSlot = Math.random() > 0.5 ? 1 : 2;
    room.activeSlot = room.triangleSlot;
    room.round = 1;
    room.turnInRound = 1;
  }

  room.version += 1;
  res.json({ room, slot: nextSlot });
});

// Get Room State
app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  touchRoom(room);
  res.json({ room });
});

// Pick Prompt (Triggers Question Generation)
app.post('/api/room/:code/pick-prompt', async (req, res) => {
  const { code } = req.params;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  touchRoom(room);
  room.phase = 'answering';
  room.version += 1;

  try {
    const forbiddenInstruction = getForbiddenPromptsInstruction(room.usedPrompts);

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_LLM_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: REGULAR_ROUND_SYSTEM },
        { role: "user", content: `Generate one unique prompt. ${forbiddenInstruction}` }
      ],
      temperature: 0.85
    });

    const generatedPrompt = completion.choices[0].message.content.trim();
    // Reformat generic [BLANK] indicators into match game standard underscores for client speech parsers
    const finalPrompt = generatedPrompt.replace(/\[BLANK\]/gi, "_______");

    room.usedPrompts.push(finalPrompt); // Save to prevent loops
    room.chosenPrompt = finalPrompt;
    room.version += 1;
    res.json({ room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit Main Round Answer
app.post('/api/room/:code/answer', async (req, res) => {
  const { code } = req.params;
  const { slot, answer } = req.body;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  touchRoom(room);
  const role = room.roles[slot];

  if (role?.role === 'contestant') {
    room.contestantAnswer = answer;
    room.phase = 'generating_answers';
    room.version += 1;

    // Trigger AI compilation for all 6 panelists matching the prompt contextually
    try {
      const panelInstructions = room.panel.map((p, idx) => `${idx}: ${p.name} (${p.tag || "witty"})`).join("\n");
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_LLM_MODEL || "gpt-4o-mini",
        messages: [
          { role: "system", content: "You write funny answers for celebrity game show panelists. Fit their retro archetype persona perfectly. Keep responses short (1-4 words Max)." },
          { role: "user", content: `Prompt: "${room.chosenPrompt}"\n\nWrite a short funny answer fitting the prompt blank for each panelist index:\n${panelInstructions}\n\nReturn as valid JSON object containing an array: {"answers": ["ans0", "ans1", "ans2", "ans3", "ans4", "ans5"]}` },
        ],
        response_format: { type: "json_object" }
      });

      const parsed = JSON.parse(completion.choices[0].message.content);
      const aiAnswers = parsed.answers || [];

      // Overlay answers onto panelists (preserving human overrides if provided)
      room.panel.forEach((p, idx) => {
        p.answer = aiAnswers[idx] || "Pass!";
      });

      // Calculate matches using basic fuzzy rules
      room.matches = room.panel.map(p => {
        const a = (p.answer || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const b = (room.contestantAnswer || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        return a === b || a.includes(b) || b.includes(a);
      });

      room.phase = 'revealing';
      room.version += 1;
    } catch (e) {
      room.phase = 'revealing';
      room.panel.forEach(p => p.answer = "Uhhh... [BLANK]!");
      room.matches = [false, false, false, false, false, false];
    }
  }
  res.json({ room });
});

// Reveal Done (Round Cycle Transitions)
app.post('/api/room/:code/reveal-done', async (req, res) => {
  const { code } = req.params;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  touchRoom(room);
  const totalMatches = (room.matches || []).filter(Boolean).length;
  room.scores[room.activeSlot] = (room.scores[room.activeSlot] || 0) + totalMatches;

  // Cleanup past turn variables
  room.contestantAnswer = null;
  room.chosenPrompt = null;
  room.matches = null;
  room.panel.forEach(p => delete p.answer);

  if (room.turnInRound === 1) {
    room.turnInRound = 2;
    room.activeSlot = room.activeSlot === 1 ? 2 : 1;
    room.phase = 'pick_prompt';
  } else {
    // Round concluded
    if (room.round === 1) {
      room.round = 2;
      room.turnInRound = 1;
      // Leading player yields first choice to behind player
      room.activeSlot = room.scores[1] > room.scores[2] ? 2 : 1;
      room.phase = 'pick_prompt';
    } else {
      // End of Round 2: Check for ties or transition to Super Match
      if (room.scores[1] === room.scores[2]) {
        room.phase = 'tiebreaker';
        room.round = 3;
        room.turnInRound = 1;
        room.scores = { 1: 0, 2: 0 }; // Reset for sudden death
        room.phase = 'pick_prompt';
      } else {
        // High score moves to the Big Money phase
        room.activeSlot = room.scores[1] > room.scores[2] ? 1 : 2;
        room.phase = 'superMatch_pickCelebs';

        // Pre-generate Super Match Question safely
        try {
          const forbiddenInstruction = getForbiddenPromptsInstruction(room.usedPrompts);
          const completion = await openai.chat.completions.create({
            model: process.env.OPENAI_LLM_MODEL || "gpt-4o-mini",
            messages: [
              { role: "system", content: SUPER_MATCH_SYSTEM },
              { role: "user", content: `Generate one unique Super Match setup phrase. ${forbiddenInstruction}` }
            ]
          });
          room.superMatchPrompt = completion.choices[0].message.content.trim().replace(/\[BLANK\]/gi, "_______");
          room.usedPrompts.push(room.superMatchPrompt);
          room.superMatchPromptReady = true;
        } catch {
          room.superMatchPrompt = "Holiday [BLANK]";
          room.superMatchPromptReady = true;
        }
      }
    }
  }

  room.version += 1;
  res.json({ room });
});

// Setup Super Match Selection
app.post('/api/room/:code/supermatch-pick', async (req, res) => {
  const { code } = req.params;
  const { celebIndices } = req.body;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  touchRoom(room);
  room.superMatchCelebIndices = celebIndices || [0, 1, 2];
  room.phase = 'superMatch_generating';
  room.version += 1;

  try {
    // Generate top survey answers to display on board
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_LLM_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You provide studio audience completion options for a phrase. Provide three logical completions weighted by popularity values ($500, $250, $100). Output JSON array matching format: {\"options\": [{\"answer\":\"A\", \"value\":500}, {\"answer\":\"B\", \"value\":250}, {\"answer\":\"C\", \"value\":100}]}" },
        { role: "user", content: `Phrase setup: "${room.superMatchPrompt}"` }
      ],
      response_format: { type: "json_object" }
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    room.superMatchTopAnswers = parsed.options || [];

    // Assign helper answers across selected celebrities
    room.superMatchCelebIndices.forEach((panelIdx, i) => {
      if (room.panel[panelIdx]) {
        room.panel[panelIdx].answer = room.superMatchTopAnswers[i]?.answer || "Pass";
      }
    });

    room.superMatchRevealIndex = -1;
    room.phase = 'superMatch_revealing';
  } catch {
    room.phase = 'superMatch_answering';
  }

  room.version += 1;
  res.json({ room });
});

app.post('/api/room/:code/supermatch-reveal-next', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  touchRoom(room);
  room.superMatchRevealIndex = (room.superMatchRevealIndex ?? -1) + 1;
  if (room.superMatchRevealIndex >= (room.superMatchCelebIndices?.length || 3) - 1) {
    room.phase = 'superMatch_answering';
  }
  room.version += 1;
  res.json({ room });
});

app.post('/api/room/:code/supermatch-answer', (req, res) => {
  const { code } = req.params;
  const { answer } = req.body;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  touchRoom(room);
  room.superMatchContestantAnswer = answer;

  // Determine survey payout alignment
  const normalizedContestant = answer.toLowerCase().replace(/[^a-z0-9]/g, "");
  const matchedOption = (room.superMatchTopAnswers || []).find(opt => 
    opt.answer.toLowerCase().replace(/[^a-z0-9]/g, "") === normalizedContestant
  );

  room.superMatchWinnings = matchedOption ? matchedOption.value : 0;
  room.phase = room.superMatchWinnings > 0 ? 'superMatch_won' : 'superMatch_lost';
  room.version += 1;
  res.json({ room });
});

// Setup Final Match Phase (10x Multiplier)
app.post('/api/room/:code/finalmatch-start', async (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  touchRoom(room);
  room.phase = 'finalMatch_pickCeleb';
  room.version += 1;

  try {
    const forbiddenInstruction = getForbiddenPromptsInstruction(room.usedPrompts);
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_LLM_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: FINAL_MATCH_SYSTEM },
        { role: "user", content: `Generate one exact phrase match setup. ${forbiddenInstruction}` }
      ]
    });
    room.finalMatchPrompt = completion.choices[0].message.content.trim().replace(/\[BLANK\]/gi, "_______");
    room.usedPrompts.push(room.finalMatchPrompt);
    room.finalMatchPromptReady = true;
  } catch {
    room.finalMatchPrompt = "Honey [BLANK]";
    room.finalMatchPromptReady = true;
  }

  room.version += 1;
  res.json({ room });
});

app.post('/api/room/:code/finalmatch-pick', (req, res) => {
  const { code } = req.params;
  const { celebIndex } = req.body;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  touchRoom(room);
  room.finalMatchCelebIndex = celebIndex;
  room.phase = 'finalMatch_answering';
  room.version += 1;
  res.json({ room });
});

app.post('/api/room/:code/finalmatch-answer', async (req, res) => {
  const { code } = req.params;
  const { answer } = req.body;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  touchRoom(room);
  room.finalMatchContestantAnswer = answer;
  room.phase = 'finalMatch_generating_celeb';
  room.version += 1;

  try {
    const targetStar = room.panel[room.finalMatchCelebIndex];
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_LLM_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: `You are writing a single word response for the celebrity panelist ${targetStar.name} (${targetStar.tag || "sarcastic"}). Fit their comedic tone.` },
        { role: "user", content: `Provide a funny phrase completion answer for: "${room.finalMatchPrompt}". Return only the answer string, maximum 2 words.` }
      ]
    });

    room.finalMatchCelebAnswer = completion.choices[0].message.content.trim();
    
    const a = room.finalMatchContestantAnswer.toLowerCase().replace(/[^a-z0-9]/g, "");
    const b = room.finalMatchCelebAnswer.toLowerCase().replace(/[^a-z0-9]/g, "");
    
    const match = a === b || a.includes(b) || b.includes(a);
    room.finalMatchWinnings = room.superMatchWinnings * 10;
    room.finalMatchResult = match ? 'win' : 'lose';
    room.phase = 'finalMatch_reveal';
  } catch {
    room.finalMatchCelebAnswer = "Pass!";
    room.finalMatchResult = 'lose';
    room.phase = 'finalMatch_reveal';
  }

  room.version += 1;
  res.json({ room });
});

app.post('/api/room/:code/finalmatch-done', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  touchRoom(room);
  room.phase = 'gameOver';
  room.version += 1;
  res.json({ room });
});

app.post('/api/room/:code/supermatch-lost-done', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  touchRoom(room);
  room.partingGift = "A retro game show home edition box set and a handshake!";
  room.phase = 'gameOver';
  room.version += 1;
  res.json({ room });
});

app.post('/api/room/:code/play-again', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  touchRoom(room);
  // Reset critical game flags preserving participants
  room.phase = 'cointoss';
  room.scores = { 1: 0, 2: 0 };
  room.round = 1;
  room.turnInRound = 1;
  room.triangleSlot = Math.random() > 0.5 ? 1 : 2;
  room.activeSlot = room.triangleSlot;
  room.usedPrompts = []; // Empty prompt history loop tracking for clean game reload
  
  // Wipe out auxiliary subfield components
  delete room.chosenPrompt;
  delete room.contestantAnswer;
  delete room.matches;
  delete room.superMatchPrompt;
  delete room.superMatchTopAnswers;
  delete room.superMatchCelebIndices;
  delete room.superMatchContestantAnswer;
  delete room.superMatchWinnings;
  delete room.finalMatchPrompt;
  delete room.finalMatchCelebIndex;
  delete room.finalMatchContestantAnswer;
  delete room.finalMatchCelebAnswer;
  delete room.finalMatchWinnings;
  delete room.finalMatchResult;
  delete room.partingGift;
  room.panel.forEach(p => { delete p.answer; delete p.signMessage; });

  room.version += 1;
  res.json({ room });
});

// Front-end trigger endpoint setups for intermediate transitions
app.post('/api/room/:code/intro-done', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  touchRoom(room);
  room.phase = 'pick_prompt';
  room.version += 1;
  res.json({ room });
});

app.post('/api/room/:code/intro-done', (req, res) => { res.json({}); });
app.post('/api/room/:code/supermatch-prompt-read', (req, res) => { res.json({}); });
app.post('/api/room/:code/finalmatch-prompt-read', (req, res) => { res.json({}); });

// Text to Speech Endpoint via OpenAI Audio APIs
app.post('/api/speak', async (req, res) => {
  const { text, slot, isAnnouncer } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing speech text' });

  try {
    // Map of standard OpenAI voices
    const voices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'];
    let selectedVoice = 'alloy';

    if (isAnnouncer) {
      selectedVoice = 'onyx'; // Announcer uses deep dramatic show voice
    } else if (slot != null) {
      selectedVoice = voices[slot % voices.length];
    }

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: selectedVoice,
      input: text,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buffer.length
    });
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SERVE FRONTEND STATICALLY IN PRODUCTION ───
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Match Game backend listening intently on port ${PORT}`);
});
