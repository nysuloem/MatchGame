import express from 'express';
import { OpenAI } from 'openai';
// ... import any other necessary modules your server uses

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Mock database / memory store for rooms
const rooms = new Map();

// --- RETRO SYSTEM PROMPTS ---
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

// --- HELPER TO FILTER OUT REPEATS ---
function getForbiddenPromptsInstruction(usedPrompts) {
  if (!usedPrompts || usedPrompts.length === 0) {
    return "No previous questions have been used yet. This is a fresh start.";
  }
  return `CRITICAL NEGATIVE CONSTRAINT: DO NOT generate any questions that match, closely resemble, or contain the core punchline of these previously used prompts:\n${usedPrompts.map(p => `- "${p}"`).join('\n')}`;
}

// --- EXPRESS ROUTES ---

// 1. Creating a room (Inject the tracking array)
app.post('/api/room', async (req, res) => {
  const { playerName, playerCount, soloTest } = req.body;
  const code = Math.random().toString(36).substring(2, 6).toUpperCase(); // Example 4-letter code
  
  const newRoom = {
    code,
    phase: 'lobby',
    players: { 1: playerName },
    scores: { 1: 0, 2: 0 },
    version: 1,
    maxPlayers: playerCount || 2,
    soloTest: !!soloTest,
    usedPrompts: [], // <-- FIX: Track prompt history per room to prevent repetitions
    // ... rest of your initial properties
  };
  
  rooms.set(code, newRoom);
  res.json({ room: newRoom });
});

// 2. Generating a Regular Round Prompt
app.post('/api/room/:code/generate-prompt', async (req, res) => {
  const { code } = req.params;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  try {
    const forbiddenInstruction = getForbiddenPromptsInstruction(room.usedPrompts);

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_LLM_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: REGULAR_ROUND_SYSTEM },
        { role: "user", content: `Generate one unique prompt. ${forbiddenInstruction}` }
      ],
      temperature: 0.85, // Higher temperature fosters creativity and unexpected setups
    });

    const generatedPrompt = completion.choices[0].message.content.trim();
    
    // Convert generic [BLANK] tokens to match your front-end's audio parsing underscores if necessary
    // e.g., promptForSpeech expects multiple underscores
    const finalPrompt = generatedPrompt.replace(/\[BLANK\]/gi, "_______");

    // <-- FIX: Save to memory so it cannot be repeated in this room session
    room.usedPrompts.push(finalPrompt); 
    room.chosenPrompt = finalPrompt;
    room.version += 1;
    
    res.json({ room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Generating a Super Match Prompt
app.post('/api/room/:code/generate-supermatch', async (req, res) => {
  const { code } = req.params;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  try {
    const forbiddenInstruction = getForbiddenPromptsInstruction(room.usedPrompts);

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_LLM_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: SUPER_MATCH_SYSTEM },
        { role: "user", content: `Generate one unique Super Match phrase. ${forbiddenInstruction}` }
      ],
      temperature: 0.7,
    });

    const finalPrompt = completion.choices[0].message.content.trim().replace(/\[BLANK\]/gi, "_______");

    room.usedPrompts.push(finalPrompt);
    room.superMatchPrompt = finalPrompt;
    room.version += 1;

    res.json({ room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Generating a Final Match Prompt
app.post('/api/room/:code/generate-finalmatch', async (req, res) => {
  const { code } = req.params;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  try {
    const forbiddenInstruction = getForbiddenPromptsInstruction(room.usedPrompts);

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_LLM_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: FINAL_MATCH_SYSTEM },
        { role: "user", content: `Generate one unique Final Match phrase. ${forbiddenInstruction}` }
      ],
      temperature: 0.7,
    });

    const finalPrompt = completion.choices[0].message.content.trim().replace(/\[BLANK\]/gi, "_______");

    room.usedPrompts.push(finalPrompt);
    room.finalMatchPrompt = finalPrompt;
    room.version += 1;

    res.json({ room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ... rest of your index.js backend server code
