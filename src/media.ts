import WebSocket from "ws";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import type { Store } from "./db.js";
import type { CallService, LiveSession } from "./calls.js";
import type { Telephony } from "./telephony.js";
import { checkStreamToken } from "./auth.js";
import { buildInstructions, END_CALL_TOOL, WRAP_UP_MESSAGE } from "./prompt.js";
import { TERMINAL_STATUSES } from "./schemas.js";

export interface MediaDeps {
  cfg: Config;
  store: Store;
  telephony: Telephony;
  calls: CallService;
  log: FastifyBaseLogger;
}

// How long to wait for the agent's goodbye to finish playing before hanging up anyway.
const HANGUP_SAFETY_MS = 8000;
// How long to wait for in-flight transcriptions after the call audio stops.
const TRANSCRIPT_FLUSH_MS = 2500;
const WRAP_UP_LEAD_SECONDS = 20;

type Json = Record<string, any>;

/**
 * Bridges one Twilio Media Stream to one OpenAI Realtime session (spec section 8, option A).
 * Audio is G.711 u-law 8 kHz in both directions, so payloads pass through untouched.
 */
export class MediaSession implements LiveSession {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;

  private callId: string | null = null;
  private callSid: string | null = null;
  private streamSid: string | null = null;
  private openai: WebSocket | null = null;
  private openaiReady = false;
  private queuedAudio: string[] = [];

  // Playback tracking for barge-in (Twilio marks echo back once audio has played).
  private latestMediaTs = 0;
  private currentAgentItem: string | null = null;
  private agentItemStartTs = 0;
  private markQueue: string[] = [];

  // Transcript timing: when each item started, in seconds since the stream began.
  private itemStart = new Map<string, number>();
  private pendingTranscriptions = new Set<string>();

  private pendingHangup = false;
  private hungUp = false;
  private closing = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private twilioWs: WebSocket,
    private deps: MediaDeps,
  ) {
    this.closed = new Promise((r) => (this.resolveClosed = r));
    twilioWs.on("message", (data) => this.onTwilioMessage(data.toString()));
    twilioWs.on("close", () => this.close("twilio stream closed"));
    twilioWs.on("error", (err) => deps.log.warn({ call_id: this.callId, err: err.message }, "twilio ws error"));
  }

  private get elapsed() {
    return this.latestMediaTs / 1000;
  }

  private sendTwilio(msg: Json) {
    if (this.twilioWs.readyState === WebSocket.OPEN) this.twilioWs.send(JSON.stringify(msg));
  }

  private sendOpenAI(msg: Json) {
    if (this.openai?.readyState === WebSocket.OPEN) this.openai.send(JSON.stringify(msg));
  }

  private onTwilioMessage(raw: string) {
    let msg: Json;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.event) {
      case "start":
        this.onStart(msg.start);
        break;
      case "media":
        this.latestMediaTs = Number(msg.media?.timestamp ?? this.latestMediaTs);
        if (!this.callId || this.closing) return;
        if (this.openaiReady) this.sendOpenAI({ type: "input_audio_buffer.append", audio: msg.media.payload });
        else if (this.queuedAudio.length < 500) this.queuedAudio.push(msg.media.payload);
        break;
      case "mark":
        this.markQueue.shift();
        if (this.pendingHangup && this.markQueue.length === 0) this.hangUp();
        break;
      case "stop":
        this.close("twilio stream stopped");
        break;
    }
  }

  private onStart(start: Json) {
    const { cfg, store, calls, log } = this.deps;
    const callId = start?.customParameters?.call_id as string | undefined;
    const token = start?.customParameters?.token as string | undefined;
    if (!callId || !checkStreamToken(callId, token, cfg.STREAM_TOKEN_SECRET)) {
      log.warn({ call_id: callId }, "media stream rejected: bad token");
      this.twilioWs.close();
      return;
    }
    const call = store.get(callId);
    if (!call || TERMINAL_STATUSES.has(call.status) || call.cancel_requested) {
      log.warn({ call_id: callId }, "media stream rejected: call not active");
      this.twilioWs.close();
      return;
    }
    this.callId = callId;
    this.callSid = start.callSid ?? call.twilio_call_sid;
    this.streamSid = start.streamSid;
    calls.sessions.set(callId, this);
    log.info({ call_id: callId, client_request_id: call.client_request_id }, "media stream started");

    const url = `${cfg.OPENAI_REALTIME_URL}?model=${encodeURIComponent(cfg.OPENAI_REALTIME_MODEL)}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.OPENAI_API_KEY}` } });
    this.openai = ws;
    ws.on("open", () => {
      this.sendOpenAI({
        type: "session.update",
        session: {
          type: "realtime",
          model: cfg.OPENAI_REALTIME_MODEL,
          output_modalities: ["audio"],
          instructions: buildInstructions(call.brief, { principal: cfg.PRINCIPAL_NAME, language: call.language, amdMode: cfg.AMD_MODE }),
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              transcription: { model: cfg.OPENAI_TRANSCRIBE_MODEL, language: call.language.slice(0, 2) },
              turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true },
            },
            output: { format: { type: "audio/pcmu" }, voice: cfg.OPENAI_REALTIME_VOICE },
          },
          tools: [END_CALL_TOOL],
          tool_choice: "auto",
        },
      });
      this.openaiReady = true;
      for (const audio of this.queuedAudio) this.sendOpenAI({ type: "input_audio_buffer.append", audio });
      this.queuedAudio = [];
      // The agent speaks first unless we are waiting for the callee (async AMD).
      if (cfg.AMD_MODE !== "async") this.sendOpenAI({ type: "response.create" });
    });
    ws.on("message", (data) => this.onOpenAIMessage(data.toString()));
    ws.on("error", (err) => log.error({ call_id: callId, err: err.message }, "openai ws error"));
    ws.on("close", (code) => {
      this.openaiReady = false;
      if (!this.closing) {
        log.error({ call_id: callId, code }, "openai ws closed unexpectedly, ending call");
        store.addTurn(callId, { speaker: "system", text: "Voice agent disconnected; call ended.", at_seconds: this.elapsed });
        this.hangUp();
      }
    });

    store.addTurn(callId, { speaker: "system", text: "Call connected.", at_seconds: 0 });
    const max = call.max_duration_seconds;
    this.timers.push(
      setTimeout(() => {
        store.addTurn(callId, { speaker: "system", text: "Time limit approaching; agent asked to wrap up.", at_seconds: this.elapsed });
        this.sendOpenAI({
          type: "conversation.item.create",
          item: { type: "message", role: "system", content: [{ type: "input_text", text: WRAP_UP_MESSAGE }] },
        });
        this.sendOpenAI({ type: "response.create" });
      }, Math.max(5, max - WRAP_UP_LEAD_SECONDS) * 1000),
      setTimeout(() => {
        store.addTurn(callId, { speaker: "system", text: "Maximum call duration reached; call ended.", at_seconds: this.elapsed });
        store.update(callId, { end_reason: store.get(callId)?.end_reason ?? "max_duration" });
        this.hangUp();
      }, max * 1000),
    );
  }

  private onOpenAIMessage(raw: string) {
    const { store, log } = this.deps;
    const callId = this.callId!;
    let ev: Json;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    switch (ev.type) {
      case "response.output_audio.delta":
      case "response.audio.delta": {
        if (this.closing || this.pendingHangup) return;
        if (ev.item_id !== this.currentAgentItem) {
          this.currentAgentItem = ev.item_id;
          this.agentItemStartTs = this.latestMediaTs;
          if (!this.itemStart.has(ev.item_id)) this.itemStart.set(ev.item_id, this.elapsed);
        }
        this.sendTwilio({ event: "media", streamSid: this.streamSid, media: { payload: ev.delta } });
        this.sendTwilio({ event: "mark", streamSid: this.streamSid, mark: { name: ev.item_id } });
        this.markQueue.push(ev.item_id);
        break;
      }
      case "input_audio_buffer.speech_started": {
        if (ev.item_id) {
          this.itemStart.set(ev.item_id, typeof ev.audio_start_ms === "number" ? ev.audio_start_ms / 1000 : this.elapsed);
          this.pendingTranscriptions.add(ev.item_id);
        }
        this.bargeIn();
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        store.addTurn(callId, { speaker: "business", text: ev.transcript ?? "", at_seconds: this.itemStart.get(ev.item_id) ?? this.elapsed });
        this.pendingTranscriptions.delete(ev.item_id);
        break;
      case "conversation.item.input_audio_transcription.failed":
        this.pendingTranscriptions.delete(ev.item_id);
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        store.addTurn(callId, { speaker: "agent", text: ev.transcript ?? "", at_seconds: this.itemStart.get(ev.item_id) ?? this.elapsed });
        break;
      case "response.function_call_arguments.done":
        if (ev.name === "end_call") this.onEndCall(ev.call_id, ev.arguments);
        break;
      case "error":
        log.error({ call_id: callId, error: ev.error }, "openai realtime error");
        break;
    }
  }

  /** The other person started talking: stop agent audio that has not played yet. */
  private bargeIn() {
    if (!this.currentAgentItem || this.markQueue.length === 0 || this.pendingHangup) return;
    this.sendOpenAI({
      type: "conversation.item.truncate",
      item_id: this.currentAgentItem,
      content_index: 0,
      audio_end_ms: Math.max(0, this.latestMediaTs - this.agentItemStartTs),
    });
    this.sendTwilio({ event: "clear", streamSid: this.streamSid });
    this.markQueue = [];
    this.currentAgentItem = null;
  }

  private onEndCall(toolCallId: string, args: string) {
    const { store, log } = this.deps;
    const callId = this.callId!;
    let reason = "other";
    try {
      reason = JSON.parse(args).reason ?? "other";
    } catch {}
    log.info({ call_id: callId, reason }, "agent requested hang up");
    store.update(callId, { end_reason: reason });
    store.addTurn(callId, { speaker: "system", text: `Agent ended the call (${reason}).`, at_seconds: this.elapsed });
    this.sendOpenAI({ type: "conversation.item.create", item: { type: "function_call_output", call_id: toolCallId, output: '{"ok":true}' } });
    this.pendingHangup = true;
    if (reason === "voicemail") {
      this.sendTwilio({ event: "clear", streamSid: this.streamSid });
      this.markQueue = [];
    }
    if (this.markQueue.length === 0) this.hangUp();
    else this.timers.push(setTimeout(() => this.hangUp(), HANGUP_SAFETY_MS));
  }

  private hangUp() {
    if (this.hungUp) return;
    this.hungUp = true;
    const sid = this.callSid;
    if (sid) {
      this.deps.telephony.endCall(sid).catch((err) => this.deps.log.error({ call_id: this.callId, err: err.message }, "hang up failed"));
    }
  }

  close(reason: string) {
    if (this.closing) return;
    this.closing = true;
    this.timers.forEach(clearTimeout);
    this.deps.log.info({ call_id: this.callId, reason }, "media session closing");
    const finish = () => {
      this.openai?.close();
      if (this.twilioWs.readyState === WebSocket.OPEN) this.twilioWs.close();
      if (this.callId && this.deps.calls.sessions.get(this.callId) === this) this.deps.calls.sessions.delete(this.callId);
      this.resolveClosed();
    };
    if (!this.openaiReady || this.pendingTranscriptions.size === 0) return finish();
    // Let the last utterance's transcription arrive before closing the model connection.
    const started = Date.now();
    const poll = setInterval(() => {
      if (this.pendingTranscriptions.size === 0 || Date.now() - started > TRANSCRIPT_FLUSH_MS) {
        clearInterval(poll);
        finish();
      }
    }, 100);
  }
}
