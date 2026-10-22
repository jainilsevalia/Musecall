import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import type { CallRecord, Store } from "./db.js";
import type { Extractor } from "./outcome.js";
import { fallbackResult } from "./outcome.js";
import type { CreateCallRequest } from "./schemas.js";
import { TERMINAL_STATUSES } from "./schemas.js";
import type { Telephony } from "./telephony.js";
import { isMachine, mapTwilioStatus } from "./telephony.js";

export class ApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What CallService needs from a live media session. */
export interface LiveSession {
  /** Resolves once the session has flushed its transcript and closed. */
  readonly closed: Promise<void>;
  /** Stops the session (e.g. voicemail detected out of band). */
  close(reason: string): void;
}

// Extra seconds Twilio allows past max_duration_seconds, so the bridge's own
// wrap-up and hang up run first and Twilio's limit is only a backstop.
const TWILIO_TIME_LIMIT_BUFFER_SECONDS = 15;
const SESSION_FLUSH_TIMEOUT_MS = 5000;

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export class CallService {
  readonly sessions = new Map<string, LiveSession>();
  private finalizing = new Set<string>();
  /** Background work started by this service; tests await it. */
  readonly pending = new Set<Promise<unknown>>();

  constructor(
    private cfg: Config,
    private store: Store,
    private telephony: Telephony,
    private extract: Extractor,
    private log: FastifyBaseLogger,
  ) {}

  private track(p: Promise<unknown>) {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => {});
  }

  async settle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  create(req: CreateCallRequest): { call: CallRecord; created: boolean } {
    const existing = this.store.getByClientRequestId(req.client_request_id);
    if (existing) return { call: existing, created: false };

    const prefixes = this.cfg.ALLOWED_TO_PREFIXES;
    if (prefixes.length && !prefixes.some((p) => req.to.startsWith(p))) {
      throw new ApiError(400, "invalid_request", `'to' must start with one of: ${prefixes.join(", ")}`);
    }
    const from = req.from ?? this.cfg.TWILIO_DEFAULT_FROM;
    if (from === req.to) throw new ApiError(400, "invalid_request", "'to' and 'from' must differ");
    if (req.max_duration_seconds > this.cfg.MAX_DURATION_CAP_SECONDS) {
      throw new ApiError(400, "invalid_request", `max_duration_seconds may not exceed ${this.cfg.MAX_DURATION_CAP_SECONDS}`);
    }
    if (this.store.countActive() >= this.cfg.MAX_CONCURRENT_CALLS) {
      throw new ApiError(409, "too_many_active_calls", `At most ${this.cfg.MAX_CONCURRENT_CALLS} call(s) may be active at once`);
    }

    const result = this.store.createOrGet(req, from);
    if (result.created) this.track(this.dial(result.call));
    return result;
  }

  private async dial(call: CallRecord) {
    try {
      const { sid } = await this.telephony.placeCall({
        callId: call.id,
        to: call.to,
        from: call.from,
        timeLimitSeconds: call.max_duration_seconds + TWILIO_TIME_LIMIT_BUFFER_SECONDS,
      });
      this.store.update(call.id, { twilio_call_sid: sid });
      this.store.setStatus(call.id, "dialing");
      this.log.info({ call_id: call.id, client_request_id: call.client_request_id, twilio_call_sid: sid }, "call placed");
      // A cancel that arrived while we were dialing could not reach Twilio yet.
      if (this.store.get(call.id)?.cancel_requested) await this.telephony.endCall(sid);
    } catch (err) {
      const e = err as { code?: number | string; message?: string };
      this.store.update(call.id, {
        failure_code: e.code != null ? `twilio_${e.code}` : "dial_error",
        failure_message: e.message ?? String(err),
        ended_at: nowIso(),
      });
      this.store.setStatus(call.id, "failed");
      this.log.warn({ call_id: call.id, client_request_id: call.client_request_id, err: e.message }, "call placement failed");
    }
  }

  async cancel(id: string): Promise<CallRecord> {
    const call = this.store.get(id);
    if (!call) throw new ApiError(404, "not_found", "No call with that call_id");
    if (TERMINAL_STATUSES.has(call.status)) return call;
    this.store.update(id, { cancel_requested: true });
    if (call.twilio_call_sid) {
      await this.telephony.endCall(call.twilio_call_sid);
      this.sessions.get(id)?.close("canceled");
    }
    // Final timestamps arrive with Twilio's status callback; the status itself is decided here.
    this.store.setStatus(id, "canceled");
    if (!call.twilio_call_sid) this.store.update(id, { ended_at: nowIso() });
    this.log.info({ call_id: id, client_request_id: call.client_request_id }, "call canceled");
    return this.store.get(id)!;
  }

  /** Twilio status callback. */
  onStatus(id: string, p: Record<string, string>) {
    const call = this.store.get(id);
    if (!call) return;
    if (p.CallSid && !call.twilio_call_sid) this.store.update(id, { twilio_call_sid: p.CallSid });
    if (p.AnsweredBy) this.store.update(id, { answered_by: p.AnsweredBy });

    const twilioStatus = p.CallStatus ?? "";
    this.log.info({ call_id: id, client_request_id: call.client_request_id, twilio_status: twilioStatus }, "twilio status");

    if (twilioStatus === "in-progress" || twilioStatus === "answered") {
      if (!call.started_at) this.store.update(id, { started_at: nowIso() });
      this.store.setStatus(id, "in_progress");
      return;
    }
    if (twilioStatus === "completed") {
      this.store.update(id, {
        ended_at: nowIso(),
        duration_seconds: p.CallDuration ? Number(p.CallDuration) : undefined,
      });
      this.track(this.finalize(id));
      return;
    }
    const mapped = mapTwilioStatus(twilioStatus);
    if (!mapped) return;
    if (TERMINAL_STATUSES.has(mapped)) {
      this.store.update(id, { ended_at: nowIso() });
      if (mapped === "failed") {
        this.store.update(id, {
          failure_code: p.ErrorCode ? `twilio_${p.ErrorCode}` : p.SipResponseCode ? `sip_${p.SipResponseCode}` : "call_failed",
          failure_message: p.ErrorMessage ?? (p.SipResponseCode ? `Carrier returned SIP ${p.SipResponseCode}` : "Twilio reported the call as failed"),
        });
      }
    }
    this.store.setStatus(id, mapped);
  }

  /** Twilio async answering machine detection callback. */
  async onAmd(id: string, answeredBy: string | undefined) {
    const call = this.store.get(id);
    if (!call || !answeredBy) return;
    this.store.update(id, { answered_by: answeredBy });
    if (!isMachine(answeredBy)) return;
    this.log.info({ call_id: id, answered_by: answeredBy }, "machine detected, hanging up");
    this.store.update(id, { end_reason: "voicemail" });
    this.sessions.get(id)?.close("voicemail");
    if (call.twilio_call_sid) await this.telephony.endCall(call.twilio_call_sid);
  }

  /** Decides the terminal status of an answered call and builds its result. */
  private async finalize(id: string) {
    if (this.finalizing.has(id)) return;
    const call = this.store.get(id);
    if (!call || TERMINAL_STATUSES.has(call.status)) return;
    this.finalizing.add(id);
    try {
      const session = this.sessions.get(id);
      if (session) {
        session.close("call ended");
        await Promise.race([session.closed, new Promise((r) => setTimeout(r, SESSION_FLUSH_TIMEOUT_MS))]);
      }
      const latest = this.store.get(id)!;
      if (latest.cancel_requested) {
        this.store.setStatus(id, "canceled");
        return;
      }
      if (isMachine(latest.answered_by ?? undefined) || latest.end_reason === "voicemail") {
        this.store.setStatus(id, "voicemail");
        return;
      }
      if (!latest.started_at) {
        // Twilio reports "completed" for some calls that never connected.
        this.store.setStatus(id, "no_answer");
        return;
      }
      let result;
      try {
        result = await this.extract({
          brief: latest.brief,
          taskType: latest.task_type,
          businessNumber: latest.to,
          endReason: latest.end_reason,
          transcript: this.store.transcript(id),
          principal: this.cfg.PRINCIPAL_NAME,
        });
      } catch (err) {
        this.log.error({ call_id: id, err: (err as Error).message }, "outcome extraction failed");
        result = fallbackResult((err as Error).message);
      }
      this.store.update(id, { result });
      this.store.setStatus(id, "completed");
      this.log.info({ call_id: id, client_request_id: latest.client_request_id, outcome: result.outcome }, "call completed");
    } finally {
      this.finalizing.delete(id);
    }
  }
}
