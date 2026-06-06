# The Match Game

A retro game-show inspired two-player game with AI-powered celebrity panelists, deployable to Railway.

Two players, two devices. Players take turns answering fill-in-the-blank prompts while 6 AI-generated celebrity panelists give their own in-character answers. Match a panelist, score a point. Classic ▲ (green triangle) vs ● (red circle) symbols mark each contestant.

## Architecture

```
match-game/
├── client/          # React + Vite frontend
│   ├── src/
│   │   ├── MatchGame.jsx
│   │   ├── main.jsx
│   │   └── styles.css
│   └── package.json
├── server/          # Express backend
│   ├── index.js
│   └── package.json
├── package.json     # Root orchestrator
├── railway.json     # Railway config
└── nixpacks.toml    # Build config
```

The server:
- Serves the built React frontend statically
- Provides REST endpoints for room state, polled every 1.5s by clients
- Calls the Anthropic API to generate the celebrity panel, prompts, and in-character answers
- Stores rooms in memory (rooms expire after 4 hours of inactivity)

## Local development

```bash
# Install everything
npm run install:all

# In one terminal — start the backend
cd server
ANTHROPIC_API_KEY=sk-ant-... OPENAI_API_KEY=sk-... npm run dev

# In another terminal — start the frontend with hot reload
cd client
npm run dev

# Open http://localhost:5173 in two browser windows (or one + your phone)
```

The Vite dev server proxies `/api/*` requests to `http://localhost:3001`, so the same code works in dev and prod.

## Deploy to Railway

1. **Push this directory to a GitHub repo** (new repo, e.g. `match-game`).

2. **Create a new Railway project** from that repo (Dashboard → New Project → Deploy from GitHub).

3. **Add environment variables** in Railway → Variables:
   - `ANTHROPIC_API_KEY` = your Anthropic API key (starts with `sk-ant-...`) — used for panel generation, prompts, and in-character answers
   - `OPENAI_API_KEY` = your OpenAI API key (starts with `sk-...`) — used for text-to-speech (each celebrity gets a distinct AI voice)

   If you skip `OPENAI_API_KEY`, the app still works — it falls back to the browser's built-in speech synthesis (which varies by device).

4. **Generate a public domain** in Railway → Settings → Networking → Generate Domain.

5. **Share that URL** with your players. They each open it on their own phone.

Railway will auto-detect the Node.js project, run `npm run build` (which installs both subdirs and builds the React app), then `npm start` (which serves both API and frontend on the same port).

## How to play

1. Player 1 enters their name, taps "Host a Game", then "Create Room". A 4-letter room code appears.
2. Player 2 opens the URL on their phone, enters their name, taps "Join a Game", types the room code.
3. Host taps "Flip Coin to Begin". A coin animates and lands on ▲ or ●. The winner is triangle and plays Round 1.
4. Host taps "Start Round". A prompt is generated. The active player gets an input field; the other player sees a waiting message.
5. Active player types their answer and locks it in.
6. Panelists reveal their answers one at a time, each spoken aloud. Matches light up the active player's symbol on the matched cards. Points are added.
7. Host taps "Next Round". The losing player goes next (or coin-toss winner if tied).

## Voices

When `OPENAI_API_KEY` is set, each panelist is assigned a voice and custom "speak like this" instructions when the panel is generated. The TTS model (`gpt-4o-mini-tts`) follows those instructions, so Charles Nelson Reilly's panelist sounds animated and theatrical, while Onyx-voiced panelists sound deep and authoritative. The announcer (prompt reader) always uses the `onyx` voice with dramatic 1970s game-show host instructions.

Available OpenAI voices used: alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse. Claude picks one per panelist and tries to diversify across the panel.

Per OpenAI's policies, the UI discloses that voices are AI-generated.

Cost: roughly $0.015 per minute of generated audio. A typical round has ~30 seconds of speech total (6 short panelist answers + 1 prompt reading), so each round costs about $0.0075 in TTS. Combined with Claude API calls (~$0.01/round for panel answers + prompt), a full 10-round game costs around $0.20.

## Future upgrades

- **SQLite persistence**: Rooms currently live in memory. Swap the `Map` for a `better-sqlite3` table to survive restarts.
- **WebSockets**: If polling lag bothers anyone, swap to Socket.IO for sub-second updates.
- **Prompt history / theming**: Let host pick prompt categories (clean, spicy, classroom-safe, etc.).
- **Panel customization**: Let host edit or veto panelists before round 1.
- **Audio prefetch**: Currently each panelist's audio is fetched on demand during reveal. Pre-fetching all 6 in parallel when the round completes would tighten pacing.

## Cost notes

Each round triggers two Claude API calls (prompt generation + panel answers) and 6+ OpenAI TTS calls. Total per round is roughly $0.02 (Sonnet 4.5 + gpt-4o-mini-tts). A full 10-round game is well under $0.25 total.
