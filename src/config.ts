import { z } from "zod";

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +19025550199");

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),

  // Public HTTPS origin Twilio and Genie use to reach this bridge, no trailing slash.
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .transform((s) => s.replace(/\/+$/, "")),

  // SHA-256 hex digest of the API key issued to Genie. The plaintext key is never stored here.
  BRIDGE_API_KEY_SHA256: z.string().regex(/^[0-9a-f]{64}$/i, "must be a 64 char hex SHA-256 digest"),

  // Secret used to sign per-call media stream tokens.
  STREAM_TOKEN_SECRET: z.string().min(32, "use at least 32 random characters"),

  TWILIO_ACCOUNT_SID: z.string().startsWith("AC"),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_DEFAULT_FROM: e164,
  // Set to "false" only for local testing behind a tunnel that rewrites URLs.
  TWILIO_VALIDATE_SIGNATURES: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // "sync" waits for answering machine detection before connecting audio (safest, adds a pause).
  // "async" connects immediately and hangs up if a machine is detected. "off" disables it.
  AMD_MODE: z.enum(["sync", "async", "off"]).default("sync"),
  RING_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(120).default(30),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_REALTIME_URL: z.string().url().default("wss://api.openai.com/v1/realtime"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime"),
  OPENAI_REALTIME_VOICE: z.string().default("marin"),
  OPENAI_TRANSCRIBE_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  OPENAI_API_BASE: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_EXTRACTION_MODEL: z.string().default("gpt-4o-mini"),

  // Whose behalf calls are placed on. Used in the system prompt.
  PRINCIPAL_NAME: z.string().min(1),

  DATABASE_PATH: z.string().default("./data/bridge.db"),
  RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  MAX_CONCURRENT_CALLS: z.coerce.number().int().min(1).default(1),
  MAX_DURATION_CAP_SECONDS: z.coerce.number().int().min(30).default(900),
  // Comma separated E.164 prefixes the bridge may dial, e.g. "+1". Empty allows any.
  ALLOWED_TO_PREFIXES: z
    .string()
    .default("+1")
    .transform((s) =>
      s
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    ),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
