/**
 * One-time setup helpers. Run from the Apps Script editor after entering
 * secrets in Project Settings → Script Properties.
 */

/**
 * Step 1: create the Drive root folder and store its ID in Script Properties.
 * Per-chat subfolders (user_/group_/room_) are created on demand by
 * ChatScope.gs the first time an event arrives for that chat.
 * Re-running is safe.
 */
function setupDriveFolder() {
  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty(PROP.DRIVE_ROOT_FOLDER_ID);
  if (existing) {
    try {
      const f = DriveApp.getFolderById(existing);
      console.log('Existing folder:', f.getName(), f.getUrl());
      return f.getUrl();
    } catch (e) { /* fall through and re-create */ }
  }
  const folder = DriveApp.createFolder('LineBot-Journal');
  props.setProperty(PROP.DRIVE_ROOT_FOLDER_ID, folder.getId());
  console.log('Created folder:', folder.getName(), folder.getUrl());
  return folder.getUrl();
}

/**
 * Step 2: quick smoke test of Gemini credentials and embedding round-trip.
 */
function setupSmokeTest() {
  const text = '我今天學了 RAG 的基本概念。';
  const emb = geminiEmbed_(text);
  console.log('Embedding dims:', emb.length, 'first 4:', emb.slice(0, 4));
  const reply = geminiGenerate_([{ text: '用一句話回覆：你好嗎？' }], { maxOutputTokens: 64 });
  console.log('Gemini reply:', reply);
}

/**
 * Diagnostic: list every model this API key can call for generateContent,
 * so we can pick a valid GENERATION id (model availability varies by key /
 * tier / region). Run from the editor and read the execution log.
 */
function listGeminiModels() {
  const key = getProp_(PROP.GEMINI_API_KEY);
  const res = UrlFetchApp.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`,
    { method: 'get', muteHttpExceptions: true }
  );
  if (res.getResponseCode() >= 300) {
    console.log('ListModels failed:', res.getResponseCode(), res.getContentText().slice(0, 500));
    return;
  }
  const body = JSON.parse(res.getContentText());
  const gen = (body.models || [])
    .filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0)
    .map(m => m.name.replace(/^models\//, ''));
  console.log('generateContent-capable models (' + gen.length + '):');
  gen.sort().forEach(n => console.log('  ' + n));
}

/**
 * Optional helper: store the LINE userId of the bot owner. Owner is the only
 * user that can trigger the bot in 1-on-1 chats. Group/room chats are open.
 */
function setOwner(userId) {
  if (!userId || typeof userId !== 'string' || !userId.startsWith('U')) {
    throw new Error('Call as setOwner("U....") with your LINE userId.');
  }
  PropertiesService.getScriptProperties().setProperty(PROP.OWNER_LINE_USER_ID, userId);
  console.log('Owner set:', userId);
}

/** Print recent doPost events so you can copy your LINE userId. */
function tailRecentEvents() {
  console.log('Tail GAS execution log under "Executions" → click latest doPost.');
}

/**
 * Install (or re-install) the 5-minute time-driven backgroundSweep trigger.
 * Run once from the Apps Script editor after deploying. Re-running is safe —
 * any existing triggers for this handler are removed first so we don't
 * accumulate duplicates.
 *
 * The background sweep guarantees the "every uploaded file eventually
 * reaches the vector model" half of the contract: if a user uploads media
 * and then never sends another message, the per-event sweep never runs and
 * the file would otherwise sit unprocessed forever.
 */
function installBackgroundSweep() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'backgroundSweep') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }
  ScriptApp.newTrigger('backgroundSweep').timeBased().everyMinutes(5).create();
  console.log(`Background sweep trigger installed: every 5 minutes (removed ${removed} stale)`);
}

/**
 * Lazily ensure the 5-minute backgroundSweep trigger exists — called from
 * doPost so the owner never has to run installBackgroundSweep() from the
 * editor. Re-verifies at most every 6 hours (cheap: most webhooks skip the
 * getProjectTriggers() call) and self-heals if the trigger ever disappears.
 * Failures are swallowed — the per-event sweep still works without it.
 */
function ensureBackgroundSweep_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const last = parseInt(props.getProperty('BG_SWEEP_CHECK') || '0', 10);
    // 節流只擋「trigger 還在時的重複檢查」——每 6h 確認一次存在即可（省 getProjectTriggers）。
    // 但**自癒不該被節流擋**：trigger 一旦消失（GAS 重部署/連續失敗被停），下一則訊息就要
    // 立刻重裝，不能等 6h。所以先無條件查存在；存在才吃節流 early-return。
    const exists = ScriptApp.getProjectTriggers()
      .some(t => t.getHandlerFunction() === 'backgroundSweep');
    if (exists) {
      if (Date.now() - last < 6 * 3600 * 1000) return;       // 還在、近期查過 → 不重複
      props.setProperty('BG_SWEEP_CHECK', String(Date.now()));
      return;
    }
    // 不存在 → 立即重裝（不受 6h 節流影響），自癒。
    ScriptApp.newTrigger('backgroundSweep').timeBased().everyMinutes(5).create();
    props.setProperty('BG_SWEEP_CHECK', String(Date.now()));
    console.log('ensureBackgroundSweep_: re-installed 5-minute trigger (was missing)');
  } catch (e) {
    console.warn('ensureBackgroundSweep_ skipped:', e && e.message);
  }
}

