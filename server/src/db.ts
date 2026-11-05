import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TelemetryEvent } from '@msl/shared';

// node:sqlite is built into Node 22: no native module to compile on deploy.

export interface SessionRow {
  id: string;
  deck_id: string;
  created_at: number;
  ip_hash: string;
  summary: string | null;
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        deck_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        ip_hash TEXT NOT NULL,
        summary TEXT
      );
      CREATE TABLE IF NOT EXISTS calls (
        call_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, at);
    `);
  }

  createSession(row: Omit<SessionRow, 'summary'>) {
    this.db.prepare('INSERT INTO sessions (id, deck_id, created_at, ip_hash) VALUES (?, ?, ?, ?)').run(row.id, row.deck_id, row.created_at, row.ip_hash);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  addCall(callId: string, sessionId: string, at: number) {
    this.db.prepare('INSERT OR IGNORE INTO calls (call_id, session_id, created_at) VALUES (?, ?, ?)').run(callId, sessionId, at);
  }

  countEvents(sessionId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(sessionId) as { n: number };
    return r.n;
  }

  addEvents(sessionId: string, events: TelemetryEvent[]) {
    const stmt = this.db.prepare('INSERT INTO events (session_id, at, type, data) VALUES (?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const e of events) stmt.run(sessionId, Math.round(e.at), e.type, JSON.stringify(e));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getEvents(sessionId: string): TelemetryEvent[] {
    const rows = this.db.prepare('SELECT data FROM events WHERE session_id = ? ORDER BY at, id').all(sessionId) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as TelemetryEvent);
  }

  saveSummary(sessionId: string, summary: string) {
    this.db.prepare('UPDATE sessions SET summary = ? WHERE id = ?').run(summary, sessionId);
  }
}
