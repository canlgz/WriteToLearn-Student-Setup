/**
 * LINE profile / group / room lookups. All return plain JSON objects.
 * Throw on non-2xx so callers can decide to log & continue.
 *
 * Notes:
 * - Group / room endpoints require the OA to have group-feature usage approved
 *   by LINE; some return 403 on consumer-style channels.
 * - getGroupMemberIds_ is paginated (next cursor in response). We don't auto-
 *   paginate; callers needing full member rosters should loop themselves.
 */

function getUserProfile_(userId) {
  return lineApiGet_(`/v2/bot/profile/${encodeURIComponent(userId)}`);
}

function getGroupSummary_(groupId) {
  return lineApiGet_(`/v2/bot/group/${encodeURIComponent(groupId)}/summary`);
}

function getGroupMemberCount_(groupId) {
  const r = lineApiGet_(`/v2/bot/group/${encodeURIComponent(groupId)}/members/count`);
  return r && r.count;
}

function getGroupMemberIds_(groupId, start) {
  const q = start ? `?start=${encodeURIComponent(start)}` : '';
  return lineApiGet_(`/v2/bot/group/${encodeURIComponent(groupId)}/members/ids${q}`);
}

function getGroupMemberProfile_(groupId, userId) {
  return lineApiGet_(`/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`);
}

function getRoomMemberCount_(roomId) {
  const r = lineApiGet_(`/v2/bot/room/${encodeURIComponent(roomId)}/members/count`);
  return r && r.count;
}

function getRoomMemberProfile_(roomId, userId) {
  return lineApiGet_(`/v2/bot/room/${encodeURIComponent(roomId)}/member/${encodeURIComponent(userId)}`);
}

function lineApiGet_(path) {
  const token = getProp_(PROP.LINE_CHANNEL_ACCESS_TOKEN);
  const res = UrlFetchApp.fetch(`https://api.line.me${path}`, {
    method: 'get',
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code >= 300) {
    throw new Error(`LINE GET ${path} failed: ${code} ${res.getContentText().slice(0, 200)}`);
  }
  return JSON.parse(res.getContentText() || '{}');
}
