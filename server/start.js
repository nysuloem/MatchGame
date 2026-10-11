import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourcePath = path.join(__dirname, 'index.js');
const runtimePath = path.join(__dirname, 'index.runtime.js');

const source = fs.readFileSync(sourcePath, 'utf8');

const oldBlock = `  let basePanel = null;
  let panelError = null;
  for (let attempt = 0; attempt < 3 && !basePanel; attempt++) {
    try { basePanel = await generatePanel(); }
    catch (e) {
      panelError = e;
      if (!e?.retryablePhotoLookup) throw e;
      console.warn(\`Celebrity photo panel retry \${attempt + 1}/3: \${e.message}\`);
    }
  }
  if (!basePanel) throw panelError || new Error('Could not build celebrity panel');
  if (basePanel.some(p => !p?.imageUrl || p.approvedPortrait !== true)) {
    const error = new Error('Six approved color celebrity portraits are required before the game can start. Please try again shortly.');
    error.retryablePhotoLookup = true;
    throw error;
  }`;

const newBlock = `  // If all six panel seats are occupied by human players, no celebrity-photo
  // lookup is needed. Build lightweight templates locally and immediately
  // replace them with the participants' uploaded photos below. This prevents
  // Wikipedia/photo availability from blocking an all-human family game.
  let basePanel = null;
  if (humanCelebIds.length >= 6) {
    basePanel = Array.from({ length: 6 }, (_, i) => ({
      ...MODERN_PANEL_BACKUPS[i % MODERN_PANEL_BACKUPS.length],
      imageUrl: null,
      approvedPortrait: false,
    }));
    console.log('All six celebrity seats are human; skipping external celebrity photo lookup.');
  } else {
    let panelError = null;
    for (let attempt = 0; attempt < 3 && !basePanel; attempt++) {
      try { basePanel = await generatePanel(); }
      catch (e) {
        panelError = e;
        if (!e?.retryablePhotoLookup) throw e;
        console.warn(\`Celebrity photo panel retry \${attempt + 1}/3: \${e.message}\`);
      }
    }
    if (!basePanel) throw panelError || new Error('Could not build celebrity panel');
    if (basePanel.some(p => !p?.imageUrl || p.approvedPortrait !== true)) {
      const error = new Error('Six approved color celebrity portraits are required before the game can start. Please try again shortly.');
      error.retryablePhotoLookup = true;
      throw error;
    }
  }`;

if (!source.includes(oldBlock)) {
  console.error('Runtime patch failed: expected celebrity-panel block was not found.');
  process.exit(1);
}

const roundLogicMarker = '// ─── ROUND LOGIC ──────────────────────────────────────────────';
const prefetchHelper = `// Prepare both regular-round prompt pairs during the intro so the live game never\n// pauses between rounds waiting for OpenAI. If generation fails, startNewRound still\n// has the existing curated fallback path.\nconst prepareRegularRoundPrompts = async (room) => {\n  if (!room) return;\n  room.prefetchedRegularRounds = room.prefetchedRegularRounds || {};\n  if (room.prefetchedRegularRoundsPromise) return room.prefetchedRegularRoundsPromise;\n  room.prefetchedRegularRoundsPromise = (async () => {\n    const usedCharacters = [...(room.usedCharacters || [])];\n    const usedCategories = [...(room.usedCategories || [])];\n    const usedRoundPrompts = [...(room.usedRoundPrompts || [])];\n    let allowDumbDora = !room.dumbDoraUsed;\n    const panelNames = (room.panel || []).map(p => p.name);\n    for (const roundNum of [1, 2]) {\n      if (room.prefetchedRegularRounds[roundNum]) continue;\n      const pack = await generateRoundPrompts(usedCharacters, usedCategories, usedRoundPrompts, allowDumbDora, roundNum, panelNames);\n      room.prefetchedRegularRounds[roundNum] = pack;\n      usedCharacters.push(pack.charA, pack.charB);\n      usedCategories.push(pack.categoryA, pack.categoryB);\n      usedRoundPrompts.push(pack.promptA, pack.promptB);\n      if (isCallbackPrompt(pack.promptA) || isCallbackPrompt(pack.promptB)) allowDumbDora = false;\n      console.log(\`[prefetch] regular round \${roundNum} ready\`);\n    }\n  })().catch(err => {\n    console.warn('[prefetch] regular-round preparation failed; live fallback remains available:', err.message || err);\n  }).finally(() => {\n    room.prefetchedRegularRoundsPromise = null;\n  });\n  return room.prefetchedRegularRoundsPromise;\n};\n\n`;

const liveRoundGeneration = `    const { promptA, promptB, answersA, answersB, categoryA, categoryB, charA, charB } = await generateRoundPrompts(room.usedCharacters, room.usedCategories || [], room.usedRoundPrompts || [], !room.dumbDoraUsed, roundNum, (room.panel || []).map(p => p.name));`;
const cachedRoundGeneration = `    let preparedRound = room.prefetchedRegularRounds?.[roundNum] || null;\n    if (preparedRound) {\n      delete room.prefetchedRegularRounds[roundNum];\n      console.log(\`[prefetch] using prepared regular round \${roundNum}\`);\n    } else {\n      preparedRound = await generateRoundPrompts(room.usedCharacters, room.usedCategories || [], room.usedRoundPrompts || [], !room.dumbDoraUsed, roundNum, (room.panel || []).map(p => p.name));\n    }\n    const { promptA, promptB, answersA, answersB, categoryA, categoryB, charA, charB } = preparedRound;`;

const introBlock = `  room.phase = 'intro';\n  room.introStartedAt = Date.now();\n  room.introCompleted = false;\n  bump(room);`;
const introWithPrefetch = `  room.phase = 'intro';\n  room.introStartedAt = Date.now();\n  room.introCompleted = false;\n  bump(room);\n  // Use the intro animation/narration time to prepare both question pairs.\n  prepareRegularRoundPrompts(room);`;

const humanReadyAnchor = `  if (!allHumanReady) return;\n\n  if (!room.panelAnswersReady && !room.panelGenerationPending) {`;
const humanReadyFastPath = `  if (!allHumanReady) return;\n\n  // When every active panelist is human, their submitted cards ARE the panel answers.\n  // Do not call OpenAI to invent six answers that will immediately be overwritten.\n  const activePanelCount = (room.panel || []).filter((p, i) => !inactiveCelebIndices.includes(i)).length;\n  const allActivePanelistsHuman = requiredHumanCelebs.length === activePanelCount;\n  if (allActivePanelistsHuman && !room.panelAnswersReady) {\n    const readyPanel = room.panel.map((p, i) => {\n      if (inactiveCelebIndices.includes(i)) return { ...p, answer: null, inactiveThisTurn: true };\n      return { ...p, answer: room.humanPanelAnswers?.[i] || '???', inactiveThisTurn: false };\n    });\n    pendingPanelByRoom.set(room, readyPanel);\n    room.panelAnswersReady = true;\n    room.panelGenerationPending = false;\n    // Critical: publish the state change immediately. The contestant UI waits for\n    // panelAnswersReady before enabling the microphone/answer step. Without this\n    // bump an all-human panel can look permanently stuck waiting for celebrities.\n    bump(room);\n    console.log('[answers] all active panelists are human; skipped AI panel-answer generation');\n  }\n\n  if (!room.panelAnswersReady && !room.panelGenerationPending) {`;

const introSignAssignment = `  room.panel = room.panel.map((p,i) => ({ ...p, showIntroSign: signSeats.has(i), signMessage: shortSign(p.signMessage || randomSign()) }));`;
const introSignAssignmentFixed = `  room.panel = room.panel.map((p,i) => ({ ...p, showIntroSign: p.isHuman || signSeats.has(i), signMessage: shortSign(p.signMessage || randomSign()) }));`;

for (const [needle, label] of [
  [roundLogicMarker, 'round logic marker'],
  [liveRoundGeneration, 'live round generation line'],
  [introBlock, 'intro block'],
  [humanReadyAnchor, 'all-human answer anchor'],
  [introSignAssignment, 'celebrity info-card assignment'],
]) {
  if (!source.includes(needle)) {
    console.error(`Runtime patch failed: expected ${label} was not found.`);
    process.exit(1);
  }
}

// GPT-6-family chat completions use max_completion_tokens rather than max_tokens.
// Apply compatibility and live-flow patches to the legacy server without making
// gameplay wait on work that can be done during the intro.
const runtimeSource = source
  .replace(oldBlock, newBlock)
  .replace(roundLogicMarker, prefetchHelper + roundLogicMarker)
  .replace(liveRoundGeneration, cachedRoundGeneration)
  .replace(introBlock, introWithPrefetch)
  .replace(humanReadyAnchor, humanReadyFastPath)
  .replace(introSignAssignment, introSignAssignmentFixed)
  .replace(/\bmax_tokens\s*:/g, 'max_completion_tokens:');

fs.writeFileSync(runtimePath, runtimeSource, 'utf8');
await import(`./index.runtime.js?patched=${Date.now()}`);
