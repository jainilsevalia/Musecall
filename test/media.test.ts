import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { AUTH, FORM_HEADERS, createBody, form, makeApp } from "./helpers.js";
import { streamToken } from "../src/auth.js";

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(cfgOverrides: Record<string, string> = {}) {
  // Fake OpenAI Realtime endpoint.
  const fakeOpenAI = new WebSocketServer({ port: 0 });
  const fromBridge: any[] = [];
  let toBridge!: WebSocket;
  let authHeader = "";
  fakeOpenAI.on("connection", (ws, req) => {
    toBridge = ws;
    authHeader = req.headers.authorization ?? "";
    ws.on("message", (d) => fromBridge.push(JSON.parse(d.toString())));
  });
  const oaPort = (fakeOpenAI.address() as AddressInfo).port;

  const ctx = await makeApp({ cfg: { OPENAI_REALTIME_URL: `ws://127.0.0.1:${oaPort}/v1/realtime`, ...cfgOverrides } });
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => new Promise<void>((r) => fakeOpenAI.close(() => r())), () => ctx.app.close());

  const create = await ctx.app.inject({ method: "POST", url: "/v1/calls", headers: AUTH, payload: createBody({ max_duration_seconds: 60 }) });
  await ctx.calls.settle();
  const callId = create.json().call_id as string;
  await ctx.app.inject({ method: "POST", url: `/twilio/status?call_id=${callId}`, headers: FORM_HEADERS, payload: form({ CallStatus: "in-progress" }) });

  const port = (ctx.app.server.address() as AddressInfo).port;
  const twilio = new WebSocket(`ws://127.0.0.1:${port}/twilio/media`);
  const toTwilio: any[] = [];
  twilio.on("message", (d) => toTwilio.push(JSON.parse(d.toString())));
  await new Promise((r) => twilio.on("open", r));

  const sid = ctx.store.get(callId)!.twilio_call_sid!;
  const start = (token = streamToken(callId, ctx.cfg.STREAM_TOKEN_SECRET)) =>
    twilio.send(JSON.stringify({ event: "start", start: { streamSid: "MZ1", callSid: sid, customParameters: { call_id: callId, token } } }));
  // Waits briefly so the bridge sees this frame before events sent on the other socket.
  const media = async (ts: number, payload = "AAAA") => {
    twilio.send(JSON.stringify({ event: "media", media: { timestamp: String(ts), payload } }));
    await new Promise((r) => setTimeout(r, 30));
  };
  const oa = (ev: object) => toBridge.send(JSON.stringify(ev));

  return { ctx, callId, sid, twilio, toTwilio, fromBridge, start, media, oa, getAuth: () => authHeader, hasOpenAI: () => !!toBridge };
}

describe("media bridge", () => {
  it("rejects a stream with a bad token", async () => {
    const s = await setup();
    s.start("deadbeef");
    await new Promise((r) => s.twilio.on("close", r));
    expect(s.hasOpenAI()).toBe(false);
  });

  it("relays audio both ways, records the transcript and hangs up after the goodbye plays", async () => {
    const s = await setup();
    s.start();
    await s.media(0); // arrives before the model connects: must be queued, not dropped
    await until(() => s.fromBridge.some((m) => m.type === "response.create"));

    expect(s.getAuth()).toBe("Bearer sk-test");
    const update = s.fromBridge.find((m) => m.type === "session.update").session;
    expect(update.audio.input.format.type).toBe("audio/pcmu");
    expect(update.audio.output.format.type).toBe("audio/pcmu");
    expect(update.audio.input.turn_detection.type).toBe("server_vad");
    expect(update.audio.input.transcription.model).toBeTruthy();
    expect(update.instructions).toContain("Hi, I am an AI assistant calling on behalf of Jainil Sevalia.");
    expect(update.instructions).toContain("Do not accept a time that is not in acceptable_times.");
    expect(update.tools[0].name).toBe("end_call");
    expect(s.fromBridge.filter((m) => m.type === "input_audio_buffer.append")).toHaveLength(1);

    // Agent speaks: audio goes to Twilio with marks.
    await s.media(1000);
    s.oa({ type: "response.output_audio.delta", item_id: "item_a1", delta: "UUUU" });
    await until(() => s.toTwilio.some((m) => m.event === "media"));
    expect(s.toTwilio.find((m) => m.event === "media")).toEqual({ event: "media", streamSid: "MZ1", media: { payload: "UUUU" } });
    expect(s.toTwilio.some((m) => m.event === "mark")).toBe(true);
    s.oa({ type: "response.output_audio_transcript.done", item_id: "item_a1", transcript: "Hi, I am an AI assistant calling on behalf of Jainil Sevalia." });

    // Business barges in before the agent audio finished playing.
    await s.media(1600);
    s.oa({ type: "input_audio_buffer.speech_started", item_id: "item_b1", audio_start_ms: 1500 });
    await until(() => s.toTwilio.some((m) => m.event === "clear"));
    const trunc = await (async () => {
      await until(() => s.fromBridge.some((m) => m.type === "conversation.item.truncate"));
      return s.fromBridge.find((m) => m.type === "conversation.item.truncate");
    })();
    expect(trunc).toMatchObject({ item_id: "item_a1", content_index: 0, audio_end_ms: 600 });
    s.oa({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_b1", transcript: "Sure, how many people?" });

    // Agent says goodbye and asks to hang up; hang up waits for the audio to play.
    await s.media(5000);
    s.oa({ type: "response.output_audio.delta", item_id: "item_a2", delta: "VVVV" });
    s.oa({ type: "response.function_call_arguments.done", name: "end_call", call_id: "fc_1", arguments: '{"reason":"goal_reached"}' });
    await until(() => s.ctx.store.get(s.callId)!.end_reason === "goal_reached");
    expect(s.ctx.telephony.ended).toHaveLength(0);
    s.twilio.send(JSON.stringify({ event: "mark", mark: { name: "item_a2" } }));
    await until(() => s.ctx.telephony.ended.length === 1);
    expect(s.ctx.telephony.ended[0]).toBe(s.sid);

    // Twilio ends the stream, then reports completion.
    s.twilio.send(JSON.stringify({ event: "stop" }));
    await s.ctx.app.inject({ method: "POST", url: `/twilio/status?call_id=${s.callId}`, headers: FORM_HEADERS, payload: form({ CallStatus: "completed", CallDuration: "6" }) });
    await s.ctx.calls.settle();

    const call = (await s.ctx.app.inject({ url: `/v1/calls/${s.callId}`, headers: AUTH })).json();
    expect(call.status).toBe("completed");
    expect(call.end_reason).toBe("goal_reached");
    const turns = (await s.ctx.app.inject({ url: `/v1/calls/${s.callId}/transcript`, headers: AUTH })).json().turns;
    expect(turns.map((t: any) => [t.speaker, t.at_seconds])).toEqual([
      ["system", 0],
      ["agent", 1],
      ["business", 1.5],
      ["system", 5],
    ]);
  });

  it("hangs up immediately and reports voicemail when the agent detects a machine", async () => {
    const s = await setup({ AMD_MODE: "async" });
    s.start();
    await until(() => s.fromBridge.some((m) => m.type === "session.update"));
    // async AMD: the agent waits for the callee instead of speaking first
    expect(s.fromBridge.some((m) => m.type === "response.create")).toBe(false);
    s.oa({ type: "response.function_call_arguments.done", name: "end_call", call_id: "fc_1", arguments: '{"reason":"voicemail"}' });
    await until(() => s.ctx.telephony.ended.length === 1);
    await s.ctx.app.inject({ method: "POST", url: `/twilio/status?call_id=${s.callId}`, headers: FORM_HEADERS, payload: form({ CallStatus: "completed" }) });
    await s.ctx.calls.settle();
    expect(s.ctx.store.get(s.callId)!.status).toBe("voicemail");
  });
});
