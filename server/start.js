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

const oldSimilarity = `const promptsTooSimilar = (a, b) => {\n  const na = normalizePromptKey(a).replace(/[^a-z0-9 ]/g, ' ');\n  const nb = normalizePromptKey(b).replace(/[^a-z0-9 ]/g, ' ');\n  if (!na || !nb) return false;\n  if (na === nb) return true;\n  const wa = new Set(na.split(/\\s+/).filter(w => w.length > 3));\n  const wb = new Set(nb.split(/\\s+/).filter(w => w.length > 3));\n  if (!wa.size || !wb.size) return false;\n  const overlap = [...wa].filter(w => wb.has(w)).length;\n  return overlap / Math.min(wa.size, wb.size) >= 0.72;\n};`;

const newSimilarity = `const ROUND_THEME_ALIASES = new Map([\n  ['husband','spouse'],['wife','spouse'],['spouse','spouse'],['bride','spouse'],['groom','spouse'],\n  ['dog','dog'],['dogs','dog'],['puppy','dog'],['puppies','dog'],['canine','dog'],['pet','dog'],\n  ['doctor','doctor'],['physician','doctor'],['nurse','doctor'],['dentist','doctor'],\n  ['restaurant','restaurant'],['waiter','restaurant'],['waitress','restaurant'],['diner','restaurant'],\n  ['wedding','wedding'],['honeymoon','wedding'],['marriage','wedding'],\n  ['karaoke','karaoke'],['singing','karaoke'],['singer','karaoke'],\n  ['alarm','alarm'],['clock','alarm'],['party','party'],['reception','party']\n]);\nconst ROUND_THEME_STOPWORDS = new Set([\n  'said','says','asked','asks','told','when','then','that','this','with','from','into','onto','about','after','before',\n  'there','their','they','them','your','have','has','had','just','really','very','because','would','could','should',\n  'blank','last','night','thought','think','thinks','home','came','come','went','going','made','make','looked','looks'\n]);\nconst roundThemeTokens = (prompt='') => normalizePromptKey(prompt)\n  .replace(/[^a-z0-9 ]/g, ' ')\n  .split(/\\s+/)\n  .filter(w => w.length > 3 && !ROUND_THEME_STOPWORDS.has(w))\n  .map(w => ROUND_THEME_ALIASES.get(w) || w);\nconst roundPromptHasBannedPremise = (prompt='') => {\n  const t = new Set(roundThemeTokens(prompt));\n  // This premise has already been overused in real play and should be retired,\n  // even if the model paraphrases husband/wife/pet/canine.\n  return t.has('spouse') && t.has('dog');\n};\nconst promptsTooSimilar = (a, b) => {\n  const na = normalizePromptKey(a).replace(/[^a-z0-9 ]/g, ' ');\n  const nb = normalizePromptKey(b).replace(/[^a-z0-9 ]/g, ' ');\n  if (!na || !nb) return false;\n  if (na === nb) return true;\n  const wa = new Set(na.split(/\\s+/).filter(w => w.length > 3));\n  const wb = new Set(nb.split(/\\s+/).filter(w => w.length > 3));\n  if (wa.size && wb.size) {\n    const overlap = [...wa].filter(w => wb.has(w)).length;\n    if (overlap / Math.min(wa.size, wb.size) >= 0.72) return true;\n  }\n  // Catch repeated premises, not merely repeated wording. Two clues that reuse\n  // the same pair of meaningful concepts are the same Match Game theme even\n  // when the sentence and character names are completely different.\n  const ta = new Set(roundThemeTokens(a));\n  const tb = new Set(roundThemeTokens(b));\n  const shared = [...ta].filter(w => tb.has(w));\n  const strong = new Set(['spouse','dog','doctor','restaurant','wedding','karaoke','alarm','party']);\n  return shared.length >= 3 || (shared.length >= 2 && shared.some(w => strong.has(w)));\n};`;

const staleDogExample = `- Kate said, \"My husband thinks he's a dog and I'm beginning to believe him. Last night he brought home a __________\"`;
const freshStyleExample = `- The magician groaned, \"My assistant quit halfway through the trick, so now I have to pull a __________ out of my own hat.\"`;

const generatedPromptGuard = `        if (isDumb && callbackCountInPair >= 1) continue;\n        if (promptAlreadyUsedOrSimilar(ROUND_PROMPT_KIND, pr.prompt, [...localUsed, ...fresh.map(f => f.prompt)])) continue;`;
const generatedPromptGuardFixed = `        if (isDumb && callbackCountInPair >= 1) continue;\n        if (roundPromptHasBannedPremise(pr.prompt)) continue;\n        if (promptAlreadyUsedOrSimilar(ROUND_PROMPT_KIND, pr.prompt, [...localUsed, ...fresh.map(f => f.prompt)])) continue;`;

const diversityLine = `- DIVERSITY FIRST: choose a setting that feels different from the avoid list. Repeated karaoke/spilled drink/party/date prompts are failures.`;
const diversityLineFixed = `- DIVERSITY FIRST: choose a setting AND comic premise that feel different from the avoid list. Paraphrasing an old premise with new names or wording is still a repeat and is a failure.\n- NEVER use or paraphrase the tired \"spouse/husband/wife behaves like a dog or pet\" premise. It has been retired from this game.\n- Repeated karaoke/spilled drink/party/date prompts are failures.`;

const ttsRouteHead = `app.post('/api/speak', async (req, res) => {\n  const { code, slot, text, isAnnouncer } = req.body;\n  if (!text) return res.status(400).json({ error: 'text required' });`;
const ttsRouteHeadFixed = `app.post('/api/speak', async (req, res) => {\n  let { code, slot, text, isAnnouncer } = req.body;\n  if (!text) return res.status(400).json({ error: 'text required' });\n\n  // The browser historically truncated sentence-style clues at the blank.\n  // Reconstruct the authoritative current clue here so Gene always reads any\n  // meaningful tag after the blank as well. Short Super/Final clues are left alone.\n  if (isAnnouncer && code && /\\bblank\\b/i.test(String(text))) {\n    const room = rooms.get(String(code).toUpperCase());\n    if (room?.chosenPrompt && ['answering','generating_answers'].includes(room.phase)) {\n      let fullPrompt = normalizePromptBlank(room.chosenPrompt);\n      if (isCallbackPrompt(fullPrompt)) {\n        const opening = getCallbackOpening(fullPrompt);\n        const pos = fullPrompt.toLowerCase().indexOf(opening.toLowerCase());\n        fullPrompt = fullPrompt.slice(pos + opening.length).replace(/^,?\\s*/, '').trim();\n      }\n      const parts = fullPrompt.split(BLANK);\n      if ((parts[1] || '').replace(/[\\s.!?\"'’”]+/g, '').length) {\n        text = fullPrompt.replace(BLANK, ' blank ').replace(/\\s+/g, ' ').trim();\n        console.log('[tts] restored words after regular-question blank');\n      }\n    }\n  }`;

for (const [needle, label] of [
  [roundLogicMarker, 'round logic marker'],
  [liveRoundGeneration, 'live round generation line'],
  [introBlock, 'intro block'],
  [humanReadyAnchor, 'all-human answer anchor'],
  [introSignAssignment, 'celebrity info-card assignment'],
  [oldSimilarity, 'prompt similarity logic'],
  [staleDogExample, 'retired dog/spouse style example'],
  [generatedPromptGuard, 'generated prompt repeat guard'],
  [diversityLine, 'prompt diversity instruction'],
  [ttsRouteHead, 'TTS route header'],
]) {
  if (!source.includes(needle)) {
    console.error(`Runtime patch failed: expected ${label} was not found.`);
    process.exit(1);
  }
}

// Apply compatibility and live-flow patches to the legacy server without making
// gameplay wait on work that can be done during the intro.
const runtimeSource = source
  .replace(oldBlock, newBlock)
  .replace(roundLogicMarker, prefetchHelper + roundLogicMarker)
  .replace(liveRoundGeneration, cachedRoundGeneration)
  .replace(introBlock, introWithPrefetch)
  .replace(humanReadyAnchor, humanReadyFastPath)
  .replace(introSignAssignment, introSignAssignmentFixed)
  .replace(oldSimilarity, newSimilarity)
  .replace(staleDogExample, freshStyleExample)
  .replace(generatedPromptGuard, generatedPromptGuardFixed)
  .replace(diversityLine, diversityLineFixed)
  .replace(ttsRouteHead, ttsRouteHeadFixed)
  .replace(/\bmax_tokens\s*:/g, 'max_completion_tokens:');

fs.writeFileSync(runtimePath, runtimeSource, 'utf8');
await import(`./index.runtime.js?patched=${Date.now()}`);
