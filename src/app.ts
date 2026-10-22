import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import type { Config } from "./config.js";
import type { CallRecord, Store } from "./db.js";
import type { Telephony } from "./telephony.js";
import type { Extractor } from "./outcome.js";
import { ApiError, CallService } from "./calls.js";
import { MediaSession } from "./media.js";
import { checkBearer, streamToken } from "./auth.js";
import { CreateCallSchema } from "./schemas.js";
import { isMachine } from "./telephony.js";

export interface AppDeps {
  cfg: Config;
  store: Store;
  telephony: Telephony;
  extract: Extractor;
  logger?: boolean | object;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function callView(call: CallRecord, store: Store) {
  return {
    call_id: call.id,
    client_request_id: call.client_request_id,
    status: call.status,
    to: call.to,
    from: call.from,
    task_type: call.task_type,
    created_at: call.created_at,
    started_at: call.started_at,
    ended_at: call.ended_at,
    duration_seconds: call.duration_seconds,
    twilio_call_sid: call.twilio_call_sid,
    result: call.status === "completed" ? call.result : null,
    recording_url: null,
    end_reason: call.end_reason,
    error: call.failure_code ? { code: call.failure_code, message: call.failure_message } : null,
    status_history: store.statusHistory(call.id),
  };
}

const xmlEscape = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; calls: CallService }> {
  const { cfg, store, telephony } = deps;
  const app = Fastify({
    logger: deps.logger ?? { level: cfg.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers['x-twilio-signature']"] },
    trustProxy: true,
  });
  await app.register(formbody);
  await app.register(websocket);

  const calls = new CallService(cfg, store, telephony, deps.extract, app.log);

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.httpStatus).send(errorBody(err.code, err.message));
    if (err.validation || err.statusCode === 400) return reply.code(400).send(errorBody("invalid_request", err.message));
    if (err.statusCode === 415) return reply.code(415).send(errorBody("unsupported_media_type", "Send JSON with content-type application/json"));
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send(errorBody("internal_error", "Internal error"));
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(errorBody("not_found", "Not found")));

  // Unauthenticated liveness probe for the hosting platform; reveals nothing.
  app.get("/healthz", async () => ({ status: "ok" }));

  // ---- Genie-facing API (spec section 6) ----
  await app.register(async (api) => {
    api.addHook("onRequest", async (req, reply) => {
      if (!checkBearer(req.headers.authorization, cfg.BRIDGE_API_KEY_SHA256)) {
        return reply.code(401).send(errorBody("unauthorized", "Missing or invalid API key"));
      }
    });

    api.get("/v1/health", async () => ({ status: "ok" }));

    api.post("/v1/calls", async (req, reply) => {
      const parsed = CreateCallSchema.safeParse(req.body);
      if (!parsed.success) {
        const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
        return reply.code(400).send(errorBody("invalid_request", msg));
      }
      const { call, created } = calls.create(parsed.data);
      req.log.info({ call_id: call.id, client_request_id: call.client_request_id, created }, created ? "call created" : "duplicate create, returning existing call");
      return reply.code(created ? 202 : 200).send({ call_id: call.id, status: call.status });
    });

    api.get<{ Params: { id: string } }>("/v1/calls/:id", async (req, reply) => {
      const call = store.get(req.params.id);
      if (!call) return reply.code(404).send(errorBody("not_found", "No call with that call_id"));
      return callView(call, store);
    });

    api.get<{ Params: { id: string } }>("/v1/calls/:id/transcript", async (req, reply) => {
      const call = store.get(req.params.id);
      if (!call) return reply.code(404).send(errorBody("not_found", "No call with that call_id"));
      return { call_id: call.id, status: call.status, turns: store.transcript(call.id), recording_url: null };
    });

    api.post<{ Params: { id: string } }>("/v1/calls/:id/cancel", async (req) => {
      const call = await calls.cancel(req.params.id);
      return { call_id: call.id, status: call.status };
    });
  });

  // ---- Twilio webhooks ----
  await app.register(async (tw) => {
    tw.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
      const params = (req.body ?? {}) as Record<string, string>;
      const url = `${cfg.PUBLIC_BASE_URL}${req.url}`;
      if (!telephony.validateWebhook(req.headers["x-twilio-signature"] as string | undefined, url, params)) {
        req.log.warn({ url: req.url }, "rejected twilio webhook with bad signature");
        return reply.code(403).send("forbidden");
      }
    });

    tw.post<{ Querystring: { call_id?: string } }>("/twilio/voice", async (req, reply) => {
      const callId = req.query.call_id ?? "";
      const params = (req.body ?? {}) as Record<string, string>;
      const call = store.get(callId);
      reply.type("text/xml");
      const hangup = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
      if (!call || call.cancel_requested) return hangup;
      if (params.AnsweredBy) store.update(callId, { answered_by: params.AnsweredBy });
      if (isMachine(params.AnsweredBy)) {
        req.log.info({ call_id: callId, answered_by: params.AnsweredBy }, "machine answered, hanging up");
        store.update(callId, { end_reason: "voicemail" });
        return hangup;
      }
      const wsUrl = `${cfg.PUBLIC_BASE_URL.replace(/^http/, "ws")}/twilio/media`;
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEscape(wsUrl)}"><Parameter name="call_id" value="${xmlEscape(callId)}"/><Parameter name="token" value="${streamToken(callId, cfg.STREAM_TOKEN_SECRET)}"/></Stream></Connect></Response>`;
    });

    tw.post<{ Querystring: { call_id?: string } }>("/twilio/status", async (req, reply) => {
      calls.onStatus(req.query.call_id ?? "", (req.body ?? {}) as Record<string, string>);
      return reply.code(204).send();
    });

    tw.post<{ Querystring: { call_id?: string } }>("/twilio/amd", async (req, reply) => {
      await calls.onAmd(req.query.call_id ?? "", ((req.body ?? {}) as Record<string, string>).AnsweredBy);
      return reply.code(204).send();
    });
  });

  // Media stream: authenticated by the per-call token in the Stream <Parameter>.
  app.get("/twilio/media", { websocket: true }, (socket) => {
    new MediaSession(socket, { cfg, store, telephony, calls, log: app.log });
  });

  return { app, calls };
}
