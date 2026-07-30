// iMessage ingestion — the one channel Unipile can't carry.
//
// Messages live in a local SQLite db (~/Library/Messages/chat.db) that only a
// process with Full Disk Access may open, so this runs in the desktop's main
// process rather than the cloud. Read is done by shelling out to macOS's own
// /usr/bin/sqlite3 (`-json`, read-only URI) so the app keeps its zero-native-
// dependency, no-build-step property.
//
// Apple stores message.date as nanoseconds since 2001-01-01, hence the
// +978307200 shift to unix epoch.
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');

const DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

const SQL = `
SELECT
  m.guid                                   AS id,
  COALESCE(c.guid, c.chat_identifier, '')  AS chat_id,
  COALESCE(c.display_name, '')             AS chat_name,
  COALESCE(h.id, c.chat_identifier, '')    AS handle,
  m.is_from_me                             AS from_me,
  COALESCE(m.text, '')                     AS text,
  strftime('%Y-%m-%dT%H:%M:%SZ', m.date/1000000000 + 978307200, 'unixepoch') AS at,
  (SELECT COUNT(*) FROM chat_handle_join j WHERE j.chat_id = c.ROWID) AS participants
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c               ON c.ROWID = cmj.chat_id
LEFT JOIN handle h        ON h.ROWID = m.handle_id
WHERE COALESCE(m.text,'') <> ''
ORDER BY m.date DESC
LIMIT %LIMIT%;
`;

function query(limit = 200) {
  return new Promise((resolve) => {
    execFile('/usr/bin/sqlite3', ['-json', `file:${DB}?mode=ro`, SQL.replace('%LIMIT%', String(limit))],
      { timeout: 20000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const msg = String(stderr || (err && err.message) || '');
        if (err || msg) {
          // The distinctive failure is macOS TCC refusing the open.
          if (/authorization denied|unable to open database/i.test(msg)) {
            return resolve({ ok: false, needsAccess: true, error: 'Full Disk Access required' });
          }
          return resolve({ ok: false, needsAccess: false, error: msg.trim().slice(0, 200) });
        }
        let rows = [];
        try { rows = JSON.parse(stdout || '[]'); } catch { /* empty db */ }
        resolve({ ok: true, rows });
      });
  });
}

// Shape it exactly like the Unipile-backed /api/inbox rows so the renderer can
// merge iMessage into the same conversation list with no special-casing.
async function inbox(limit = 200) {
  const res = await query(limit);
  if (!res.ok) return res;
  const messages = res.rows.map((r) => {
    const isGroup = Number(r.participants || 0) > 1;
    return {
      id: r.id,
      chat_id: r.chat_id,
      direction: Number(r.from_me) === 1 ? 'out' : 'in',
      who: Number(r.from_me) === 1 ? '' : (r.handle || ''),
      handle: r.handle || '',
      text: r.text || '',
      at: r.at || '',
      is_group: isGroup,
      group_name: isGroup ? (r.chat_name || 'Group chat') : '',
      target_id: 0,
    };
  });
  return { ok: true, messages };
}

module.exports = { inbox, DB };
