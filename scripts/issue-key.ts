// Generates a new API key for Genie. Prints the key ONCE to this terminal and the SHA-256
// digest to put in BRIDGE_API_KEY_SHA256. Never save the plaintext key to a file.
import { randomBytes, createHash } from "node:crypto";

const key = `gcb_${randomBytes(32).toString("base64url")}`;
const digest = createHash("sha256").update(key, "utf8").digest("hex");
process.stdout.write(
  `API key (paste into the Muse secure page, then clear your terminal):\n  ${key}\n\n` +
    `Set this on the bridge:\n  BRIDGE_API_KEY_SHA256=${digest}\n`,
);
