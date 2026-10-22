import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { CallResult, CallStatus, CreateCallRequest, TranscriptTurn, Brief } from "./schemas.js";
import { TERMINAL_STATUSES } from "./schemas.js";

export interface CallRecord {
  id: string;
  client_request_id: string;
  status: CallStatus;
  to: string;
  from: string;
  task_type: string;
  language: string;
  max_duration_seconds: number;
  brief: Brief;
  twilio_call_sid: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  result: CallResult | null;
  failure_code: string | null;
  failure_message: string | null;
  end_reason: string | null;
  answered_by: string | null;
  cancel_requested: boolean;
}

interface CallRow {
  id: string;
  client_request_id: string;
  status: CallStatus;
  to_number: string;
  from_number: string;
  task_type: string;
  language: string;
  max_duration_seconds: number;
  brief_json: string;
  twilio_call_sid: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  result_json: string | null;
  failure_code: string | null;
  failure_message: string | null;
  end_reason: string | null;
  answered_by: string | null;
  cancel_requested: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  to_number TEXT NOT NULL,
  from_number TEXT NOT NULL,
  task_type TEXT NOT NULL,
  language TEXT NOT NULL,
  max_duration_seconds INTEGER NOT NULL,
  brief_json TEXT NOT NULL,
  twilio_call_sid TEXT UNIQUE,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  duration_seconds INTEGER,
  result_json TEXT,
  failure_code TEXT,
  failure_message TEXT,
  end_reason TEXT,
  answered_by TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS calls_status ON calls(status);
CREATE TABLE IF NOT EXISTS transcript_turns (
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  text TEXT NOT NULL,
  at_seconds REAL NOT NULL,
  PRIMARY KEY (call_id, seq)
);
CREATE TABLE IF NOT EXISTS status_events (
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS status_events_call ON status_events(call_id);
`;

function toRecord(r: CallRow): CallRecord {
  return {
    id: r.id,
    client_request_id: r.client_request_id,
    status: r.status,
    to: r.to_number,
    from: r.from_number,
    task_type: r.task_type,
    language: r.language,
    max_duration_seconds: r.max_duration_seconds,
    brief: JSON.parse(r.brief_json),
    twilio_call_sid: r.twilio_call_sid,
    created_at: r.created_at,
    started_at: r.started_at,
    ended_at: r.ended_at,
    duration_seconds: r.duration_seconds,
    result: r.result_json ? JSON.parse(r.result_json) : null,
    failure_code: r.failure_code,
    failure_message: r.failure_message,
    end_reason: r.end_reason,
    answered_by: r.answered_by,
    cancel_requested: r.cancel_requested === 1,
  };
}

export function newCallId(): string {
  return `cb_${randomBytes(12).toString("base64url")}`;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  /**
   * Inserts a call unless one with the same client_request_id exists.
   * Runs synchronously, so two concurrent requests can never both insert.
   */
  createOrGet(req: CreateCallRequest, from: string): { call: CallRecord; created: boolean } {
    const existing = this.getByClientRequestId(req.client_request_id);
    if (existing) return { call: existing, created: false };
    const id = newCallId();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO calls (id, client_request_id, status, to_number, from_number, task_type, language,
           max_duration_seconds, brief_json, created_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, req.client_request_id, req.to, from, req.task_type, req.language, req.max_duration_seconds, JSON.stringify(req.brief), at);
    this.db.prepare(`INSERT INTO status_events (call_id, status, at) VALUES (?, 'queued', ?)`).run(id, at);
    return { call: this.get(id)!, created: true };
  }

  get(id: string): CallRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM calls WHERE id = ?`).get(id) as CallRow | undefined;
    return row && toRecord(row);
  }

  getByClientRequestId(clientRequestId: string): CallRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM calls WHERE client_request_id = ?`).get(clientRequestId) as CallRow | undefined;
    return row && toRecord(row);
  }

  countActive(): number {
    const placeholders = [...TERMINAL_STATUSES].map(() => "?").join(",");
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE status NOT IN (${placeholders})`).get(...TERMINAL_STATUSES) as { n: number };
    return row.n;
  }

  /** Moves a call to a new status. Terminal statuses are sticky; returns false if nothing changed. */
  setStatus(id: string, status: CallStatus): boolean {
    const call = this.get(id);
    if (!call || call.status === status || TERMINAL_STATUSES.has(call.status)) return false;
    const at = nowIso();
    this.db.prepare(`UPDATE calls SET status = ? WHERE id = ?`).run(status, id);
    this.db.prepare(`INSERT INTO status_events (call_id, status, at) VALUES (?, ?, ?)`).run(id, status, at);
    return true;
  }

  update(
    id: string,
    fields: Partial<
      Pick<
        CallRecord,
        "twilio_call_sid" | "started_at" | "ended_at" | "duration_seconds" | "failure_code" | "failure_message" | "end_reason" | "answered_by"
      > & { result: CallResult; cancel_requested: boolean }
    >,
  ) {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      if (k === "result") {
        cols.push("result_json = ?");
        vals.push(JSON.stringify(v));
      } else if (k === "cancel_requested") {
        cols.push("cancel_requested = ?");
        vals.push(v ? 1 : 0);
      } else {
        cols.push(`${k} = ?`);
        vals.push(v);
      }
    }
    if (!cols.length) return;
    this.db.prepare(`UPDATE calls SET ${cols.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  statusHistory(id: string): { status: CallStatus; at: string }[] {
    return this.db.prepare(`SELECT status, at FROM status_events WHERE call_id = ? ORDER BY rowid`).all(id) as {
      status: CallStatus;
      at: string;
    }[];
  }

  addTurn(id: string, turn: TranscriptTurn) {
    const text = turn.text.trim();
    if (!text) return;
    this.db
      .prepare(
        `INSERT INTO transcript_turns (call_id, seq, speaker, text, at_seconds)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM transcript_turns WHERE call_id = ?), ?, ?, ?)`,
      )
      .run(id, id, turn.speaker, text, Math.round(turn.at_seconds * 10) / 10);
  }

  /** Turns ordered by when they were spoken (transcriptions can finish out of order). */
  transcript(id: string): TranscriptTurn[] {
    return this.db
      .prepare(`SELECT speaker, text, at_seconds FROM transcript_turns WHERE call_id = ? ORDER BY at_seconds, seq`)
      .all(id) as TranscriptTurn[];
  }

  /** Deletes calls that ended (or were created, if never ended) more than `days` ago. */
  purgeOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db.prepare(`DELETE FROM calls WHERE COALESCE(ended_at, created_at) < ?`).run(cutoff).changes;
  }
}
