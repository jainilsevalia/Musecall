import { loadConfig, type Config } from "../src/config.js";
import { Store } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/auth.js";
import type { Telephony, PlaceCallParams } from "../src/telephony.js";
import type { Extractor } from "../src/outcome.js";

export const API_KEY = "test-key-123";
export const AUTH = { authorization: `Bearer ${API_KEY}` };

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    PUBLIC_BASE_URL: "https://calls.example.com",
    BRIDGE_API_KEY_SHA256: sha256Hex(API_KEY),
    STREAM_TOKEN_SECRET: "s".repeat(40),
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "token",
    TWILIO_DEFAULT_FROM: "+19025550199",
    OPENAI_API_KEY: "sk-test",
    PRINCIPAL_NAME: "Jainil Sevalia",
    DATABASE_PATH: ":memory:",
    MAX_CONCURRENT_CALLS: "5",
    ...overrides,
  });
}

export class FakeTelephony implements Telephony {
  placed: PlaceCallParams[] = [];
  ended: string[] = [];
  failNext: { code: number; message: string } | null = null;
  signaturesValid = true;

  async placeCall(p: PlaceCallParams) {
    if (this.failNext) {
      const err = Object.assign(new Error(this.failNext.message), { code: this.failNext.code });
      this.failNext = null;
      throw err;
    }
    this.placed.push(p);
    return { sid: `CA${String(this.placed.length).padStart(32, "0")}` };
  }
  async endCall(sid: string) {
    this.ended.push(sid);
  }
  validateWebhook() {
    return this.signaturesValid;
  }
}

export const okExtractor: Extractor = async ({ transcript }) => ({
  outcome: "booked",
  summary: `Booked. ${transcript.length} turns.`,
  details: { party_size: 2 },
  options: [],
  follow_up_needed: false,
  follow_up_reason: null,
});

export async function makeApp(opts: { cfg?: Record<string, string>; extract?: Extractor } = {}) {
  const cfg = testConfig(opts.cfg);
  const store = new Store(":memory:");
  const telephony = new FakeTelephony();
  const { app, calls } = await buildApp({ cfg, store, telephony, extract: opts.extract ?? okExtractor, logger: false });
  return { app, calls, store, telephony, cfg };
}

export function createBody(overrides: Record<string, unknown> = {}) {
  return {
    client_request_id: "genie-2026-10-22-0001",
    to: "+19025550123",
    task_type: "restaurant_reservation",
    language: "en",
    max_duration_seconds: 300,
    brief: {
      goal: "Reserve a table for two people for Friday 2026-10-23 at 7:00 pm.",
      business_name: "Example Bistro",
      opening_line: "Hi, I am an AI assistant calling on behalf of Jainil Sevalia.",
      identity: { name_for_booking: "Jainil Sevalia", callback_number: "+19025550100", share_callback_number: true },
      constraints: { party_size: 2, date: "2026-10-23", target_time: "19:00", acceptable_times: ["18:30", "19:00"] },
      hard_limits: ["Do not accept a time that is not in acceptable_times."],
    },
    ...overrides,
  };
}

export const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
export const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };
