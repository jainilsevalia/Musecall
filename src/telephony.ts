import twilio from "twilio";
import type { Config } from "./config.js";

export interface PlaceCallParams {
  callId: string;
  to: string;
  from: string;
  timeLimitSeconds: number;
}

/** The slice of Twilio the bridge uses, so tests can swap in a fake. */
export interface Telephony {
  placeCall(p: PlaceCallParams): Promise<{ sid: string }>;
  /** Ends a call: cancels it if not yet answered, hangs up otherwise. */
  endCall(sid: string): Promise<void>;
  validateWebhook(signature: string | undefined, url: string, params: Record<string, string>): boolean;
}

export class TwilioTelephony implements Telephony {
  private client: twilio.Twilio;

  constructor(private cfg: Config) {
    this.client = twilio(cfg.TWILIO_ACCOUNT_SID, cfg.TWILIO_AUTH_TOKEN);
  }

  async placeCall(p: PlaceCallParams) {
    const base = this.cfg.PUBLIC_BASE_URL;
    const q = `call_id=${encodeURIComponent(p.callId)}`;
    const amd =
      this.cfg.AMD_MODE === "sync"
        ? { machineDetection: "Enable" as const }
        : this.cfg.AMD_MODE === "async"
          ? {
              machineDetection: "Enable" as const,
              asyncAmd: "true",
              asyncAmdStatusCallback: `${base}/twilio/amd?${q}`,
              asyncAmdStatusCallbackMethod: "POST",
            }
          : {};
    const call = await this.client.calls.create({
      to: p.to,
      from: p.from,
      url: `${base}/twilio/voice?${q}`,
      method: "POST",
      statusCallback: `${base}/twilio/status?${q}`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      timeout: this.cfg.RING_TIMEOUT_SECONDS,
      timeLimit: p.timeLimitSeconds,
      record: false,
      ...amd,
    });
    return { sid: call.sid };
  }

  async endCall(sid: string) {
    const call = await this.client.calls(sid).fetch();
    const notAnswered = call.status === "queued" || call.status === "ringing";
    if (call.status === "completed" || call.status === "canceled" || call.status === "failed" || call.status === "busy" || call.status === "no-answer") return;
    await this.client.calls(sid).update({ status: notAnswered ? "canceled" : "completed" });
  }

  validateWebhook(signature: string | undefined, url: string, params: Record<string, string>) {
    if (!this.cfg.TWILIO_VALIDATE_SIGNATURES) return true;
    if (!signature) return false;
    return twilio.validateRequest(this.cfg.TWILIO_AUTH_TOKEN, signature, url, params);
  }
}

/** Maps Twilio's CallStatus to the bridge status. Returns null for "completed", which needs more context. */
export function mapTwilioStatus(s: string): "dialing" | "ringing" | "in_progress" | "busy" | "no_answer" | "failed" | "canceled" | null {
  switch (s) {
    case "queued":
    case "initiated":
      return "dialing";
    case "ringing":
      return "ringing";
    case "in-progress":
    case "answered":
      return "in_progress";
    case "busy":
      return "busy";
    case "no-answer":
      return "no_answer";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return null;
  }
}

export function isMachine(answeredBy: string | undefined): boolean {
  return !!answeredBy && (answeredBy.startsWith("machine") || answeredBy === "fax");
}
