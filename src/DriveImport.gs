/**
 * Drive URL ingest — when a user pastes a Google Drive link as a message,
 * either download the file (single file URL) or show a tappable file list
 * (folder URL) so the user picks which files to ingest. Reuses the existing
 * media pipeline: blob → saveRawBlob_ → addPending_ → mode picker → the
 * same record format as a LINE file upload, just with `sourceDriveFileId`
 * stamped on so dedup works.
 */

const DRIVE_FOLDER_LIST_MAX = 10;
const DRIVE_FOLDER_COUNT_CAP = 200;   // stop counting past this; show "200+" in intro
const DRIVE_FILE_MAX_BYTES = 50 * 1024 * 1024;  // Apps Script Blob ceiling ≈ 50 MB

/**
 * Parse a Google Drive URL into { kind, id }. Returns null if no Drive URL.
 * Patterns:
 *   /file/d/{id}/...                         → file
 *   /drive/folders/{id}                      → folder
 *   /drive/mobile/folders/{id}               → folder
 *   /open?id={id} / /uc?id={id} / ?id={id}   → file (best guess; we resolve via DriveApp)
 */
function parseDriveUrl_(text) {
  if (!text) return null;
  let m;
  m = text.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return { kind: 'file', id: m[1] };
  m = text.match(/drive\.google\.com\/drive\/(?:mobile\/)?folders\/([A-Za-z0-9_-]{20,})/);
  if (m) return { kind: 'folder', id: m[1] };
  m = text.match(/drive\.google\.com\/[^?\s]*\?(?:[^&\s]*&)*id=([A-Za-z0-9_-]{20,})/);
  if (m) return { kind: 'file', id: m[1] };
  return null;
}

/**
 * Try to handle a message that's essentially a Drive URL. Returns true if we
 * handled it (caller should NOT continue to record-as-text); false otherwise.
 * Only short-circuits when the URL is the bulk of the message — a URL embedded
 * in a longer note is left to record normally as text.
 */
function tryHandleDriveLink_(ctx, trimmed) {
  const urlMatch = trimmed && trimmed.match(/https?:\/\/[^\s]+/);
  if (!urlMatch) return false;
  const driveInfo = parseDriveUrl_(urlMatch[0]);
  if (!driveInfo) return false;
  const remainder = trimmed.replace(urlMatch[0], '').replace(/\s/g, '');
  if (remainder.length > 10) return false;
  if (driveInfo.kind === 'folder') return showDriveFolderList_(ctx, driveInfo.id);
  return importDriveFile_(ctx, driveInfo.id);
}

/** Show a Flex carousel listing up to DRIVE_FOLDER_LIST_MAX files in the folder. */
function showDriveFolderList_(ctx, folderId) {
  let folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (_) {
    lineReply_(ctx.replyToken,
      '⚠️ 抓不到這個 Drive 資料夾。\n請把連結設為「知道連結的任何人可檢視」，或把資料夾分享給此 bot。');
    return true;
  }
  // Walk just enough to fill the list and learn there are more — for huge
  // folders (thousands of files) we don't want to enumerate everything just
  // to print an accurate total.
  const files = [];
  let totalCount = 0;
  let truncated = false;
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    totalCount++;
    if (files.length < DRIVE_FOLDER_LIST_MAX) files.push(f);
    if (totalCount >= DRIVE_FOLDER_COUNT_CAP) { truncated = it.hasNext() || truncated; break; }
  }
  if (!files.length) {
    lineReply_(ctx.replyToken, `📁「${folder.getName()}」資料夾沒有檔案。`);
    return true;
  }
  // Dedup hint: mark files that were previously imported into this scope.
  const importedIds = {};
  loadEmbeddingRecords_(ctx.scope).forEach(r => {
    if (r && r.sourceDriveFileId) importedIds[r.sourceDriveFileId] = r;
  });

  const bubbles = files.map(f => buildDriveFileImportBubble_(f, !!importedIds[f.getId()]));
  const remaining = totalCount - files.length;
  const totalLabel = truncated ? `${totalCount}+` : `${totalCount}`;
  const intro = remaining > 0
    ? `📁「${folder.getName()}」共 ${totalLabel} 個檔，顯示前 ${files.length} 個（還有 ${remaining}${truncated ? '+' : ''} 個未列出）：`
    : `📁「${folder.getName()}」共 ${totalLabel} 個檔：`;
  const contents = bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles };
  lineReplyMessages_(ctx.replyToken, [
    { type: 'text', text: intro },
    { type: 'flex', altText: `Drive 資料夾 ${folder.getName()}`, contents: contents }
  ]);
  return true;
}

function buildDriveFileImportBubble_(file, alreadyImported) {
  const name = file.getName();
  const mime = file.getMimeType();
  const fileId = file.getId();
  // Google Workspace native files report size 0; show kind instead so it
  // doesn't render as a confusing "0 B".
  const rawSize = file.getSize();
  const isNative = mime && mime.indexOf('application/vnd.google-apps.') === 0;
  const sizeText = isNative ? '(Google 原生檔，匯出後下載)' : formatFileSize_(rawSize);
  const icon = driveTypeIcon_(mime);
  const btnLabel = alreadyImported ? '已下載過' : '下載並記進脈絡';
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: '📂 Drive 檔案', size: 'xxs', color: THEME.depth.l2.headerSub },
        { type: 'text', text: truncate_(name, 22), size: 'md', weight: 'bold', color: THEME.onDark, wrap: true, margin: 'xs' }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
      contents: [
        { type: 'text', text: `${icon} ${shortMime_(mime)}`, size: 'sm', color: THEME.text },
        { type: 'text', text: sizeText, size: 'xs', color: THEME.muted }
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'sm',
      contents: [{
        type: 'box', layout: 'vertical', cornerRadius: 'md', paddingAll: 'sm',
        backgroundColor: alreadyImported ? THEME.surfaceSoft : THEME.cta,
        action: alreadyImported
          ? { type: 'postback', label: '已下載', data: `action=drive_dup&fid=${fileId}`, displayText: opEcho_('已下載過', name) }
          : { type: 'postback', label: '下載', data: `action=drive_import&fid=${fileId}`, displayText: opEcho_('下載', name) },
        contents: [{ type: 'text', text: btnLabel, size: 'sm', align: 'center', weight: 'bold', color: alreadyImported ? THEME.muted : THEME.onDark }]
      }]
    }
  };
}

/**
 * Download a single Drive file (by source fileId), save into chat folder, and
 * add to pending so the existing mode picker decides how to transcribe.
 * Dedups against any prior record with the same sourceDriveFileId in scope.
 */
function importDriveFile_(ctx, sourceFileId) {
  const dup = loadEmbeddingRecords_(ctx.scope).find(r => r && r.sourceDriveFileId === sourceFileId);
  if (dup) {
    const when = dup.ts ? Utilities.formatDate(new Date(dup.ts), TIME_ZONE, 'MM/dd HH:mm') : '';
    lineReply_(ctx.replyToken,
      `📁「${dup.fileName || '此檔'}」之前已下載過${when ? `（${when}）` : ''}。`);
    return true;
  }
  let file;
  try { file = DriveApp.getFileById(sourceFileId); }
  catch (_) {
    lineReply_(ctx.replyToken,
      '⚠️ 抓不到這個 Drive 檔案。\n請把連結設為「知道連結的任何人可檢視」，或把檔案分享給此 bot。');
    return true;
  }
  // Guard memory: Apps Script's in-memory Blob ceiling is ~50 MB. Above that,
  // fall back to lightweight registration — server-side makeCopy bypasses the
  // ceiling but we lose Gemini transcription (no bytes to feed). Record stays
  // searchable by filename.
  let sizeBytes = 0;
  try { sizeBytes = file.getSize(); } catch (_) {}
  if (sizeBytes > DRIVE_FILE_MAX_BYTES) {
    return importDriveFileLight_(ctx, file, sourceFileId, sizeBytes);
  }
  if (ctx.scope && ctx.scope.type === 'user') {
    try { showLoadingAnimation_(ctx.scope.id, 30); } catch (_) {}
  }
  const originalName = file.getName();
  // For Google Workspace native files (Docs/Sheets/Slides), file.getMimeType()
  // returns the native vnd.google-apps.* type but file.getBlob() auto-exports
  // (typically to PDF). Trust the blob's content-type so the stored mime
  // actually matches the bytes downstream (isOfficeMime_, isTextMime_, etc.).
  // Wrap the blob fetch + save: Apps Script's locale-dependent error message
  // from an exceeded blob limit (e.g. JA "ファイルサイズの上限を超えています")
  // would otherwise bubble up to Main.gs's generic catch and read as a system
  // failure — surface a friendly Chinese message instead.
  let blob, driveFile;
  let effectiveName = originalName;
  let mime, type;
  try {
    blob = file.getBlob();
    const blobMime = blob.getContentType() || file.getMimeType();
    // If the export converted to PDF but the original name has no .pdf
    // extension, append it so the file in raw/ reads correctly.
    if (blobMime === 'application/pdf' && !/\.pdf$/i.test(effectiveName)) {
      effectiveName += '.pdf';
    }
    mime = resolveMime_(blobMime, effectiveName);
    type = inferTypeFromMime_(mime);
  } catch (e) {
    console.warn('importDriveFile_ getBlob failed:', e && e.message);
    lineReply_(ctx.replyToken,
      `⚠️ 下載「${originalName}」失敗：可能超過 Apps Script 處理上限（約 ${formatFileSize_(DRIVE_FILE_MAX_BYTES)}）或來源檔暫時無法存取。`);
    return true;
  }
  const id = newId_();
  const ts = new Date().toISOString();
  const dateStr = Utilities.formatDate(new Date(ts), TIME_ZONE, 'yyyy-MM-dd');
  const fileName = `${dateStr}_${id}_${effectiveName}`;
  try {
    driveFile = saveRawBlob_(ctx.scope, blob, fileName);
  } catch (e) {
    console.warn('importDriveFile_ saveRawBlob failed:', e && e.message);
    lineReply_(ctx.replyToken,
      `⚠️ 儲存「${originalName}」到 Drive 失敗：${(e && e.message) || '未知錯誤'}`);
    return true;
  }

  if (isArchiveFile_(mime, originalName)) {
    lineReply_(ctx.replyToken,
      `📥 已下載「${originalName}」存到 Drive。\n⚠️ 壓縮檔暫不支援自動轉譯，請解壓後重貼每個檔案的連結。`);
    return true;
  }
  addPending_(ctx.scope, {
    id, ts, type,
    userId: (ctx.scope && ctx.scope.id) || '',
    fileId: driveFile.getId(),
    fileName,
    mimeType: mime,
    sourceDriveFileId: sourceFileId
  });
  // Rich preview card (thumbnail + 詳細／摘要／幫我決定 buttons) — same
  // shape as /me's pending list, so a Drive download has visual parity with
  // a LINE upload's follow-up picker. Unlike LINE uploads (where the user
  // already saw their own image in chat), the Drive flow only showed the
  // URL — echoing the thumbnail back is the only way the user can confirm
  // "yes, this is the file I meant".
  const bubble = buildPendingBubble_({
    id, ts, type,
    fileId: driveFile.getId(),
    fileName, mimeType: mime,
    duration: null
  });
  lineReplyMessages_(ctx.replyToken, [
    { type: 'text', text: `📥 準備下載：「${originalName}」` },
    { type: 'flex', altText: `已從 Drive 下載「${originalName}」`, contents: bubble }
  ]);
  return true;
}

/**
 * Lightweight registration for files > DRIVE_FILE_MAX_BYTES: server-side
 * copy via makeCopy (no bytes through script memory) + a minimal record
 * indexed by filename only. /recall finds it by name; no Gemini transcription
 * because the blob ceiling blocks feeding the bytes downstream. `mode: 'light'`
 * marks the record so we can later offer a manual transcribe path if needed.
 */
function importDriveFileLight_(ctx, sourceFile, sourceFileId, sizeBytes) {
  if (ctx.scope && ctx.scope.type === 'user') {
    try { showLoadingAnimation_(ctx.scope.id, 30); } catch (_) {}
  }
  const originalName = sourceFile.getName();
  const mime = sourceFile.getMimeType();
  const id = newId_();
  const ts = new Date().toISOString();
  const dateStr = Utilities.formatDate(new Date(ts), TIME_ZONE, 'yyyy-MM-dd');
  const fileName = `${dateStr}_${id}_${originalName}`;
  let copied;
  try {
    const rawFolder = chatSubFolder_(ctx.scope, FOLDERS.RAW);
    copied = sourceFile.makeCopy(fileName, rawFolder);
    copied.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    console.warn('importDriveFileLight_ makeCopy failed:', e && e.message);
    lineReply_(ctx.replyToken,
      `⚠️ 複製「${originalName}」失敗：${(e && e.message) || '未知錯誤'}`);
    return true;
  }
  const type = inferTypeFromMime_(mime);
  // Filename + mime + size as the searchable hint. Embedding from this so
  // /recall surfaces the file when the user searches by name or topic words
  // that appear in the filename.
  const textForEmbed = `${originalName} ${shortMime_(mime)} ${formatFileSize_(sizeBytes)}`;
  const embedding = geminiEmbed_(textForEmbed);
  const record = {
    id, ts,
    userId: (ctx.scope && ctx.scope.id) || '',
    type,
    fileId: copied.getId(),
    fileName,
    mimeType: mime,
    text: textForEmbed,
    embedding,
    mode: 'light',
    sourceDriveFileId: sourceFileId,
    sizeBytes: sizeBytes
  };
  appendEmbeddingRecord_(ctx.scope, record);
  try { saveTranscript_(ctx.scope, id, textForEmbed, ts); } catch (_) {}
  try { appendToTimeline_(ctx.scope, record); }
  catch (e) { console.error('timeline append failed:', e && e.message); }
  lineReply_(ctx.replyToken,
    `📥 已用輕量模式記下「${originalName}」（${formatFileSize_(sizeBytes)}）\n` +
    `· 檔案複製到你的 chat 資料夾，可用檔名 /recall 搜尋\n` +
    `· 因超過自動轉譯上限（${formatFileSize_(DRIVE_FILE_MAX_BYTES)}），未做內文轉譯`);
  return true;
}

function inferTypeFromMime_(mime) {
  const m = (mime || '').toLowerCase();
  if (m.indexOf('image/') === 0) return 'image';
  if (m.indexOf('audio/') === 0) return 'audio';
  if (m.indexOf('video/') === 0) return 'video';
  return 'file';
}

function formatFileSize_(bytes) {
  if (bytes == null) return '?';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function driveTypeIcon_(mime) {
  const m = (mime || '').toLowerCase();
  if (m.indexOf('image/') === 0) return '🖼️';
  if (m.indexOf('audio/') === 0) return '🎤';
  if (m.indexOf('video/') === 0) return '🎬';
  if (m.indexOf('pdf') >= 0) return '📕';
  if (m.indexOf('sheet') >= 0 || m.indexOf('excel') >= 0) return '📊';
  if (m.indexOf('presentation') >= 0 || m.indexOf('powerpoint') >= 0) return '📺';
  return '📄';
}

function shortMime_(mime) {
  const m = (mime || '').toLowerCase();
  if (!m) return 'file';
  if (m === 'application/pdf') return 'PDF';
  if (m.indexOf('spreadsheet') >= 0) return 'Sheets';
  if (m.indexOf('document') >= 0 && m.indexOf('google') >= 0) return 'Docs';
  if (m.indexOf('presentation') >= 0) return 'Slides';
  if (m.indexOf('/') >= 0) return m.split('/').pop().toUpperCase();
  return m.toUpperCase();
}
