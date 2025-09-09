// db.js
import Database from 'better-sqlite3';

let db;

export function initDB() {
  db = new Database('warbot.db');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS wars (
      id INTEGER PRIMARY KEY,                -- matches "War Sign-up #"
      message_id TEXT NOT NULL,              -- Discord message id
      opponent TEXT,
      format TEXT,
      start_et TEXT,                         -- human-readable ET we show in embeds
      locked_at TEXT,                        -- ISO when roster locked
      vod_url TEXT
    );

    CREATE TABLE IF NOT EXISTS war_players (
      war_id INTEGER,
      user_id TEXT,
      name TEXT,
      role TEXT CHECK(role IN ('starter','backup')),
      PRIMARY KEY (war_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS maps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      war_id INTEGER,
      map_order INTEGER,                     -- 1,2,3...
      map_name TEXT,
      our_score INTEGER,
      opp_score INTEGER
    );

    CREATE TABLE IF NOT EXISTS substitutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      war_id INTEGER,
      user_in TEXT,
      user_out TEXT,
      note TEXT,
      at_iso TEXT
    );

    CREATE TABLE IF NOT EXISTS no_shows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      war_id INTEGER,
      user_id TEXT,
      name TEXT,
      at_iso TEXT
    );
  `);
}
export function getMaxWarId() {
  return db.prepare(`SELECT IFNULL(MAX(id),0)+1 AS id FROM wars`).get()?.id || 1;
}

export function recordLockedWar({ warId, messageId, opponent, format, startET, starters, backups }) {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO wars (id, message_id, opponent, format, start_et, locked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(warId, messageId, opponent || null, format, startET, now);

    const upsert = db.prepare(`
      INSERT OR REPLACE INTO war_players (war_id, user_id, name, role)
      VALUES (?, ?, ?, ?)
    `);

    starters.forEach(p => upsert.run(warId, p.userId, p.name, 'starter'));
    backups.forEach(p  => upsert.run(warId, p.userId, p.name, 'backup'));
  });
  tx();
}

/** Add a single map. our/opp can be null if scores aren’t known yet. */
export function addMap({ warId, mapName, our = null, opp = null, mapOrder = null }) {
  const next = db.prepare(`SELECT IFNULL(MAX(map_order),0)+1 AS n FROM maps WHERE war_id=?`).get(warId);
  const ord = mapOrder ?? (next?.n || 1);
  db.prepare(`
    INSERT INTO maps (war_id, map_order, map_name, our_score, opp_score)
    VALUES (?, ?, ?, ?, ?)
  `).run(warId, ord, mapName, our, opp);
  return ord;
}

/** Add multiple maps in order with no scores yet (used at lock time). */
export function addMapsDraft({ warId, mapNames }) {
  const tx = db.transaction(() => {
    const next = db.prepare(`SELECT IFNULL(MAX(map_order),0)+1 AS n FROM maps WHERE war_id=?`).get(warId);
    let ord = next?.n || 1;
    for (const name of mapNames) {
      db.prepare(`
        INSERT INTO maps (war_id, map_order, map_name, our_score, opp_score)
        VALUES (?, ?, ?, NULL, NULL)
      `).run(warId, ord++, name);
    }
  });
  tx();
}

export function setVOD({ warId, url }) {
  db.prepare(`UPDATE wars SET vod_url=? WHERE id=?`).run(url, warId);
}

export function addSub({ warId, userIn, userOut, note }) {
  db.prepare(`
    INSERT INTO substitutions (war_id, user_in, user_out, note, at_iso)
    VALUES (?, ?, ?, ?, ?)
  `).run(warId, userIn, userOut, note || null, new Date().toISOString());
}

export function addNoShow({ warId, userId, name }) {
  db.prepare(`
    INSERT INTO no_shows (war_id, user_id, name, at_iso)
    VALUES (?, ?, ?, ?)
  `).run(warId, userId, name, new Date().toISOString());
}

export function getPlayerStats(userId) {
  const wars = db.prepare(`
    SELECT w.id, w.opponent, w.format, w.start_et,
           SUM(CASE WHEN (m.our_score > m.opp_score) THEN 1 ELSE 0 END) AS maps_won,
           COUNT(m.id) AS maps_total
    FROM wars w
    LEFT JOIN maps m ON m.war_id = w.id
    JOIN war_players p ON p.war_id = w.id AND p.user_id = ?
    GROUP BY w.id
    ORDER BY w.id DESC
  `).all(userId);

  const totals = wars.reduce((acc, w) => {
    acc.wars += 1;
    if (w.maps_total > 0) {
      if (w.maps_won > (w.maps_total / 2)) acc.wins += 1;
      else acc.losses += 1;
    }
    acc.mapWins += (w.maps_won || 0);
    acc.mapLosses += (w.maps_total || 0) - (w.maps_won || 0);
    return acc;
  }, { wars: 0, wins: 0, losses: 0, mapWins: 0, mapLosses: 0 });

  const recentMaps = db.prepare(`
    SELECT m.war_id, m.map_order, m.map_name, m.our_score, m.opp_score
    FROM maps m
    JOIN war_players p ON p.war_id = m.war_id AND p.user_id = ?
    ORDER BY m.war_id DESC, m.map_order DESC
    LIMIT 5
  `).all(userId);

  const noshows = db.prepare(`SELECT COUNT(*) as c FROM no_shows WHERE user_id=?`).get(userId)?.c || 0;

  return { totals, wars, recentMaps, noshows };
}

/** Get maps for a war, ordered */
export function getMaps(warId) {
  return db.prepare(`
    SELECT map_order, map_name, our_score, opp_score
    FROM maps
    WHERE war_id = ?
    ORDER BY map_order ASC
  `).all(warId);
}

/** Create or update a map’s score (and optional name) by map_order */
export function updateMapScore({ warId, mapOrder, our, opp, mapName }) {
  const existing = db.prepare(`SELECT id FROM maps WHERE war_id=? AND map_order=?`).get(warId, mapOrder);
  if (existing) {
    db.prepare(`
      UPDATE maps
      SET our_score = ?, opp_score = ?, map_name = COALESCE(?, map_name)
      WHERE id = ?
    `).run(our, opp, (mapName || null), existing.id);
  } else {
    db.prepare(`
      INSERT INTO maps (war_id, map_order, map_name, our_score, opp_score)
      VALUES (?, ?, ?, ?, ?)
    `).run(warId, mapOrder, (mapName || ('Map ' + mapOrder)), our, opp);
  }
}
