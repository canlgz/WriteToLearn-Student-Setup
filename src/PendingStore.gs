/**
 * Pending-media registry.
 *
 * Lives in ScriptProperties — NOT in meta.json — so that a media event's
 * registration step does not contend with text-ingest writes on the
 * script-wide LockService lock. Each pending entry is its own property key,
 * which means writes are atomic single-key operations and need no explicit
 * locking.
 *
 * Key shape:  pending::<scope.key>::<entry.id>  →  JSON-encoded entry
 *
 * scope.key (e.g. `user_Uabc…`, `group_Cxyz…`) is already URL-safe and short
 * enough that the full key stays well under the ScriptProperties 500-char
 * limit. Total properties cap is ~9000 / 500KB, more than enough for transient
 * pendings that get processed and removed within minutes.
 */

const PENDING_KEY_PREFIX = 'pending::';

function pendingKey_(scope, id) {
  return `${PENDING_KEY_PREFIX}${scope.key}::${id}`;
}

/**
 * Inverse of `scope.key` — rebuild a scope object from `user_Uxxx` /
 * `group_Cxxx` / `room_Rxxx`. Used by the background sweep, which has no
 * inbound event to source a scope from. Returns null on malformed keys.
 */
function scopeFromKey_(scopeKey) {
  const i = scopeKey.indexOf('_');
  if (i < 0) return null;
  const type = scopeKey.slice(0, i);
  const id = scopeKey.slice(i + 1);
  if (type !== 'user' && type !== 'group' && type !== 'room') return null;
  return { type, id, key: scopeKey, userId: type === 'user' ? id : null };
}

/** Atomic write of one pending entry. No lock needed. */
function addPending_(scope, entry) {
  PropertiesService.getScriptProperties().setProperty(
    pendingKey_(scope, entry.id),
    JSON.stringify(entry)
  );
}

/** Read one pending entry; null if missing or malformed. */
function getPending_(scope, id) {
  const v = PropertiesService.getScriptProperties().getProperty(pendingKey_(scope, id));
  if (!v) return null;
  try { return JSON.parse(v); } catch (_) { return null; }
}

/** Atomic delete. Safe to call on already-removed keys. */
function removePending_(scope, id) {
  PropertiesService.getScriptProperties().deleteProperty(pendingKey_(scope, id));
}

/** Enumerate all pending entries for this scope. Order undefined; caller sorts. */
function listPendings_(scope) {
  const scopePrefix = `${PENDING_KEY_PREFIX}${scope.key}::`;
  const all = PropertiesService.getScriptProperties().getProperties();
  const out = [];
  for (const k in all) {
    if (k.indexOf(scopePrefix) !== 0) continue;
    try { out.push(JSON.parse(all[k])); } catch (_) { /* skip malformed */ }
  }
  return out;
}

// A claimed-but-unfinished entry is reclaimable after this long — assume the
// doPost that claimed it died (e.g. hit the 6-min execution limit) before it
// could finish transcription. Comfortably longer than any single Gemini call.
const PENDING_INFLIGHT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Atomically take ownership of a pending entry by marking it in-flight
 * (stamping `claimedAt`) rather than deleting it. The caller is then
 * responsible for finishPending_ (on success) or releasePending_ (on
 * failure). Returns the entry on success, null if another live claim holds
 * it or it doesn't exist.
 *
 * Why mark instead of delete: if we deleted on claim and the doPost then
 * died mid-transcription (6-min limit, crash), the entry would be gone with
 * no record written — the file lost forever. By keeping the entry and
 * stamping claimedAt, a later sweep re-claims it once the claim goes stale
 * (> PENDING_INFLIGHT_TIMEOUT_MS), guaranteeing every upload is eventually
 * transcribed. processPendingMedia_ is idempotent (skips if the record
 * already exists), so a re-claim after a near-miss can't double-write.
 *
 * Lock held only for the read + single rewrite (~tens of ms).
 */
function claimPending_(scope, id) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) {
    console.warn('claimPending_: lock contention, skipping', id, (e && e.message) || e);
    return null;
  }
  try {
    const entry = getPending_(scope, id);
    if (!entry) return null;
    const now = Date.now();
    if (entry.claimedAt && (now - entry.claimedAt) < PENDING_INFLIGHT_TIMEOUT_MS) {
      return null;  // a live claim holds it
    }
    entry.claimedAt = now;
    addPending_(scope, entry);  // rewrite with the in-flight stamp
    return entry;
  } finally {
    lock.releaseLock();
  }
}

/** Mark a claimed entry done — remove it for good. Call after a successful process. */
function finishPending_(scope, id) {
  removePending_(scope, id);
}

/** Release a claim without finishing (processing failed) so it's reclaimable now. */
function releasePending_(scope, id) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) { return; }
  try {
    const entry = getPending_(scope, id);
    if (!entry) return;
    delete entry.claimedAt;
    addPending_(scope, entry);
  } finally {
    lock.releaseLock();
  }
}
