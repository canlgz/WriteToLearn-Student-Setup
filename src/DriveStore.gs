/**
 * Drive IO. All chat data lives under per-chat folders managed by ChatScope.gs;
 * this file only knows how to read/write within a scope.
 *
 *   DRIVE_ROOT_FOLDER_ID/chats/<scope.key>/
 *     meta.json
 *     embeddings.jsonl
 *     raw/  transcripts/  summaries/
 */

function rootFolder_() {
  return DriveApp.getFolderById(getProp_(PROP.DRIVE_ROOT_FOLDER_ID));
}

function saveRawBlob_(scope, blob, fileName) {
  const file = chatSubFolder_(scope, FOLDERS.RAW).createFile(blob.setName(fileName));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file;
}

function saveTranscript_(scope, id, text, ts) {
  const prefix = Utilities.formatDate(new Date(ts || Date.now()), TIME_ZONE, 'yyyyMMdd_HHmmss');
  const blob = Utilities.newBlob(text, 'text/plain; charset=utf-8', `${prefix}_${id}.txt`);
  return chatSubFolder_(scope, FOLDERS.TRANSCRIPTS).createFile(blob);
}

function saveSummary_(scope, name, markdown) {
  const blob = Utilities.newBlob(markdown, 'text/markdown; charset=utf-8', name);
  return chatSubFolder_(scope, FOLDERS.SUMMARIES).createFile(blob);
}

function saveSummaryPdf_(scope, baseName, title, markdown) {
  const html = summaryHtml_(title, markdown);
  const pdf = Utilities.newBlob(html, 'text/html; charset=utf-8', `${baseName}.html`)
    .getAs('application/pdf')
    .setName(`${baseName}.pdf`);
  const file = chatSubFolder_(scope, FOLDERS.SUMMARIES).createFile(pdf);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file;
}

function summaryHtml_(title, markdown) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = markdown.split('\n');
  const body = [];
  let inList = false, inMeta = false;
  const closeList = () => { if (inList) { body.push('</ul>'); inList = false; } };
  const closeMeta = () => { if (inMeta) { body.push('</div>'); inMeta = false; } };
  for (const raw of lines) {
    // blockquote「> …」判在原始 raw（escape 後 > 會變 &gt;）；其餘標記判 escape 後的字串。
    const meta = raw.match(/^>\s+(.*)/);
    if (meta) {
      closeList();
      if (!inMeta) { body.push('<div class="meta">'); inMeta = true; }
      body.push(`<div>${mdBold_(esc(meta[1]))}</div>`);
      continue;
    }
    closeMeta();
    const safe = esc(raw);
    const h1 = safe.match(/^#\s+(.*)/);
    const h2 = safe.match(/^##\s+(.*)/);
    const h3 = safe.match(/^###\s+(.*)/);
    const bullet = safe.match(/^\s*[\*\-]\s+(.*)/);
    if (h3) { closeList(); body.push(`<h3>${mdBold_(h3[1])}</h3>`); }
    else if (h2) { closeList(); body.push(`<h2>${mdBold_(h2[1])}</h2>`); }
    else if (h1) { closeList(); body.push(`<h1>${mdBold_(h1[1])}</h1>`); }
    else if (bullet) {
      if (!inList) { body.push('<ul>'); inList = true; }
      body.push(`<li>${mdBold_(bullet[1])}</li>`);
    } else {
      closeList();
      if (safe.trim()) body.push(`<p>${mdBold_(safe)}</p>`);
    }
  }
  closeList(); closeMeta();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
@page{margin:2.2cm 2cm}
body{font-family:'Noto Sans CJK TC','PingFang TC','Microsoft JhengHei',sans-serif;font-size:11.5pt;line-height:1.75;color:#2b2b2b}
h1{font-size:21pt;color:#1a3a5c;margin:0 0 .5em;padding-bottom:.25em;border-bottom:3px solid #1a4480}
.meta{background:#eef3f8;border-left:4px solid #1a4480;border-radius:6px;padding:10px 14px;margin:0 0 1.8em;color:#55606b;font-size:10pt;line-height:1.6}
.meta div{margin:.1em 0}
h2{font-size:14pt;color:#1a4480;margin:1.6em 0 .4em;padding-left:10px;border-left:4px solid #3a6ea5}
h3{font-size:12.5pt;color:#333;margin:1.1em 0 .3em}
ul{padding-left:1.3em;margin:.3em 0}li{margin:.4em 0}
p{margin:.6em 0}strong{color:#1a3a5c}
.foot{margin-top:2.6em;border-top:1px solid #e3e8ee;padding-top:8px;color:#9aa3ad;font-size:8.5pt}
</style></head><body>
${body.join('\n')}
<div class="foot">由 WriteToLearn 自動彙整生成</div>
</body></html>`;
}

function mdBold_(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/** Append one record to this scope's embeddings.jsonl (lock-protected). */
function appendEmbeddingRecord_(scope, record) {
  const lock = LockService.getScriptLock();
  // 60s headroom: a media event holds the lock briefly several times while
  // updating meta + appending records, and a burst of text events can pile up
  // behind it. 20s was too tight under realistic concurrent ingest.
  lock.waitLock(60000);
  try {
    const file = chatEmbeddingsFile_(scope);
    const prev = file.getBlob().getDataAsString();
    const line = JSON.stringify(record);
    file.setContent(prev ? prev + '\n' + line : line);
  } finally {
    lock.releaseLock();
  }
}

/** Read all records for this scope. */
function loadEmbeddingRecords_(scope) {
  const file = chatEmbeddingsFile_(scope);
  const text = file.getBlob().getDataAsString();
  if (!text) return [];
  const out = [];
  for (const ln of text.split('\n')) {
    const s = ln.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

/**
 * Update one existing record in embeddings.jsonl by id (read all, find,
 * replace that line, write all back — lock-protected like the append path).
 * Returns the mutated record, or null if no record with that id exists.
 *
 * Used by the quote-reply supplement flow to re-embed the original record
 * once new context arrives. Reading + rewriting the whole file each time
 * is acceptable at MVP scale (a few thousand records per chat); when the
 * file grows we'd want a more incremental scheme.
 */
/**
 * Remove one record from embeddings.jsonl by id (read all, drop that line,
 * write back — lock-protected like append/update). Returns the removed record,
 * or null if no record with that id exists. This takes the record out of every
 * semantic surface (recall / ask / themes / episodes / story), which is what
 * "delete from 脈絡" means; the raw chat message itself can't be removed.
 */
function deleteEmbeddingRecord_(scope, id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const file = chatEmbeddingsFile_(scope);
    const text = file.getBlob().getDataAsString();
    if (!text) return null;
    const kept = [];
    let removed = null;
    for (const ln of text.split('\n')) {
      const s = ln.trim();
      if (!s) continue;
      let r;
      try { r = JSON.parse(s); } catch (_) { kept.push(ln); continue; }
      if (r.id === id) { removed = r; continue; }
      kept.push(JSON.stringify(r));
    }
    if (!removed) return null;
    file.setContent(kept.join('\n'));
    return removed;
  } finally {
    lock.releaseLock();
  }
}

/** Best-effort: trash the per-record transcript file (named <prefix>_<id>.txt). */
function deleteTranscript_(scope, id) {
  try {
    const files = chatSubFolder_(scope, FOLDERS.TRANSCRIPTS).getFiles();
    while (files.hasNext()) {
      const f = files.next();
      if (f.getName().indexOf('_' + id + '.txt') >= 0) { f.setTrashed(true); return; }
    }
  } catch (e) { console.warn('deleteTranscript_ failed:', e && e.message); }
}

function updateRecord_(scope, id, mutator) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const file = chatEmbeddingsFile_(scope);
    const text = file.getBlob().getDataAsString();
    if (!text) return null;
    const lines = text.split('\n');
    let updated = null;
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].trim();
      if (!s) continue;
      let r;
      try { r = JSON.parse(s); } catch (_) { continue; }
      if (r.id !== id) continue;
      const next = mutator(r) || r;
      lines[i] = JSON.stringify(next);
      updated = next;
      break;
    }
    if (!updated) return null;
    file.setContent(lines.join('\n'));
    return updated;
  } finally {
    lock.releaseLock();
  }
}
