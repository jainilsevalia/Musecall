import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { TwilioTelephony } from "./telephony.js";
import { openAiExtractor } from "./outcome.js";
import { buildApp } from "./app.js";

const cfg = loadConfig();
const store = new Store(cfg.DATABASE_PATH);
const { app } = await buildApp({
  cfg,
  store,
  telephony: new TwilioTelephony(cfg),
  extract: openAiExtractor({ apiKey: cfg.OPENAI_API_KEY, apiBase: cfg.OPENAI_API_BASE, model: cfg.OPENAI_EXTRACTION_MODEL }),
});

const purge = () => {
  const n = store.purgeOlderThan(cfg.RETENTION_DAYS);
  if (n) app.log.info({ deleted: n, retention_days: cfg.RETENTION_DAYS }, "purged old calls");
};
purge();
const purgeTimer = setInterval(purge, 3_600_000);

const shutdown = async () => {
  clearInterval(purgeTimer);
  await app.close();
  store.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: cfg.PORT, host: cfg.HOST });
