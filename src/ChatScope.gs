/**
 * Per-chat scoping. Every LINE event maps to a chat (1-on-1 user, group,
 * or multi-person room), and each chat gets its own Drive subfolder so
 * data (raw, transcripts, summaries, embeddings) stays isolated.
 *
 * Drive layout (folder names are human-readable; stable identifier is the
 * `id` field inside meta.json):
 *   DRIVE_ROOT_FOLDER_ID/
 *     林冠澤/                     ← 1-on-1, name = LINE displayName
 *       meta.json                 (type/id/name/memberCount/...)
 *       embeddings.jsonl
 *       raw/  transcripts/  summaries/
 *     沙丁魚研究群（8人）/        ← group, name = groupName + count
 *       (same internal layout)
 *     多人房（5人）/              ← room
 */

const META_FILE = 'meta.json';
const FOLDER_CACHE_PREFIX = 'folder:';

/** Build a scope from an event's source object. Returns null if unknown. */
function scopeFromEvent_(ev) {
  const s = ev && ev.source;
  if (!s) return null;
  if (s.type === 'user')  return { type: 'user',  id: s.userId,  key: `user_${s.userId}`,   userId: s.userId };
  if (s.type === 'group') return { type: 'group', id: s.groupId, key: `group_${s.groupId}`, userId: s.userId || null };
  if (s.type === 'room')  return { type: 'room',  id: s.roomId,  key: `room_${s.roomId}`,   userId: s.userId || null };
  return null;
}

/**
 * Get the per-chat folder; create with meta.json + subfolders on first use.
 * Lookup order:
 *   1. ScriptProperties cache (scope.key → folderId).
 *   2. Scan root, match by meta.json's `id` & `type`.
 *   3. Create new folder named via readableFolderName_().
 *
 * The slow path (scan + create) is serialized via LockService so two
 * concurrent webhook events (e.g. unfollow + follow firing back-to-back
 * after the user deleted the folder in Drive) cannot both reach
 * createFolder and produce duplicates.
 */
function chatFolder_(scope) {
  if (!scope) throw new Error('chatFolder_: no scope');
  const props = PropertiesService.getScriptProperties();
  const cacheKey = FOLDER_CACHE_PREFIX + scope.key;

  // Fast path — no lock needed when cache is hot.
  const cached = resolveFromCache_(props, cacheKey);
  if (cached) return cached;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // Another thread may have just resolved this while we were waiting.
    const recheck = resolveFromCache_(props, cacheKey);
    if (recheck) return recheck;

    const root = rootFolder_();
    const found = findFolderByMeta_(root, scope);
    if (found) {
      props.setProperty(cacheKey, found.getId());
      return found;
    }

    const folder = root.createFolder(readableFolderName_(scope));
    folder.createFolder(FOLDERS.RAW);
    folder.createFolder(FOLDERS.TRANSCRIPTS);
    folder.createFolder(FOLDERS.SUMMARIES);
    folder.createFile(EMBEDDINGS_FILE, '', MimeType.PLAIN_TEXT);
    writeInitialMeta_(scope, folder);
    props.setProperty(cacheKey, folder.getId());
    return folder;
  } finally {
    lock.releaseLock();
  }
}

function resolveFromCache_(props, cacheKey) {
  const cachedId = props.getProperty(cacheKey);
  if (!cachedId) return null;
  try {
    const f = DriveApp.getFolderById(cachedId);
    if (!f.isTrashed()) return f;
  } catch (_) { /* deleted */ }
  props.deleteProperty(cacheKey);
  return null;
}

/** Read-only check: does this scope already have a Drive folder? */
function chatFolderExists_(scope) {
  if (!scope) return false;
  const props = PropertiesService.getScriptProperties();
  const cacheKey = FOLDER_CACHE_PREFIX + scope.key;
  if (resolveFromCache_(props, cacheKey)) return true;
  return !!findFolderByMeta_(rootFolder_(), scope);
}

/** Scan root for a folder whose meta.json matches this scope. */
function findFolderByMeta_(root, scope) {
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    const it = f.getFilesByName(META_FILE);
    if (!it.hasNext()) continue;
    try {
      const meta = JSON.parse(it.next().getBlob().getDataAsString() || '{}');
      if (meta.id === scope.id && meta.type === scope.type) return f;
    } catch (_) { /* skip malformed meta */ }
  }
  return null;
}

/** Build a Drive-safe, human-readable folder name from LINE profile/group data. */
function readableFolderName_(scope) {
  const sanitize = (s) => (s || '').replace(/[\\/<>:|?*"]/g, ' ').trim().slice(0, 80);
  try {
    if (scope.type === 'user') {
      const p = getUserProfile_(scope.id);
      return sanitize((p && p.displayName) || '一對一') || '一對一';
    }
    if (scope.type === 'group') {
      const s = getGroupSummary_(scope.id);
      const name = sanitize((s && s.groupName) || '群組') || '群組';
      let count = '';
      try { count = `（${getGroupMemberCount_(scope.id)}人）`; } catch (_) {}
      return `${name}${count}`;
    }
    if (scope.type === 'room') {
      let count = '';
      try { count = `（${getRoomMemberCount_(scope.id)}人）`; } catch (_) {}
      return `多人房${count}`;
    }
  } catch (_) { /* best-effort */ }
  return scope.type;
}

/** Rename the folder to reflect the latest readableFolderName_ (e.g. member count change). */
function refreshChatFolderName_(scope) {
  try {
    const folder = chatFolder_(scope);
    const want = readableFolderName_(scope);
    if (want && folder.getName() !== want) folder.setName(want);
  } catch (e) {
    console.warn('refreshChatFolderName_:', e && e.message);
  }
}

function chatSubFolder_(scope, name) {
  const parent = chatFolder_(scope);
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function chatEmbeddingsFile_(scope) {
  const parent = chatFolder_(scope);
  const it = parent.getFilesByName(EMBEDDINGS_FILE);
  if (it.hasNext()) return it.next();
  return parent.createFile(EMBEDDINGS_FILE, '', MimeType.PLAIN_TEXT);
}

function chatMetaFile_(scope) {
  const parent = chatFolder_(scope);
  const it = parent.getFilesByName(META_FILE);
  if (it.hasNext()) return it.next();
  return parent.createFile(META_FILE, '{}', MimeType.PLAIN_TEXT);
}

function loadChatMeta_(scope) {
  try { return JSON.parse(chatMetaFile_(scope).getBlob().getDataAsString() || '{}'); }
  catch (e) { return {}; }
}

function saveChatMeta_(scope, meta) {
  chatMetaFile_(scope).setContent(JSON.stringify(meta, null, 2));
}

/** Lock → load → mutate → save. */
function updateChatMeta_(scope, mutator) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const meta = loadChatMeta_(scope);
    const next = mutator(meta) || meta;
    saveChatMeta_(scope, next);
    return next;
  } finally {
    lock.releaseLock();
  }
}

/** Best-effort initial population using LINE profile/group APIs. */
function writeInitialMeta_(scope, folder) {
  const now = new Date().toISOString();
  const meta = {
    type: scope.type,
    id: scope.id,
    name: '',
    memberCount: scope.type === 'user' ? 1 : null,
    createdAt: now,
    archivedAt: null,
    members: []
  };
  try {
    if (scope.type === 'user') {
      const p = getUserProfile_(scope.id);
      meta.name = (p && p.displayName) || '';
      meta.members.push({ userId: scope.id, displayName: meta.name, joinedAt: now, leftAt: null });
    } else if (scope.type === 'group') {
      const s = getGroupSummary_(scope.id);
      meta.name = (s && s.groupName) || '';
      try { meta.memberCount = getGroupMemberCount_(scope.id); } catch (_) {}
    } else if (scope.type === 'room') {
      try { meta.memberCount = getRoomMemberCount_(scope.id); } catch (_) {}
    }
  } catch (e) {
    console.warn('writeInitialMeta_:', e && e.message);
  }
  folder.createFile(META_FILE, JSON.stringify(meta, null, 2), MimeType.PLAIN_TEXT);
}
