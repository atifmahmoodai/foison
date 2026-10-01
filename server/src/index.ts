import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createGoogleVerifier } from "./auth.js";
import { createClaudeExtractor } from "./extract.js";
import { ConcurrencyLimiter, RateLimiter } from "./rateLimit.js";

const HOUR = 60 * 60 * 1000;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

const audiences = (process.env.GOOGLE_CLIENT_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const app = createApp({
  verifyToken: createGoogleVerifier(audiences),
  extract: createClaudeExtractor(),
  limiter: new RateLimiter(intEnv("SCANS_PER_HOUR", 30), HOUR),
  dailyLimiter: new RateLimiter(intEnv("SCANS_PER_DAY", 100), 24 * HOUR),
  concurrency: new ConcurrencyLimiter(intEnv("MAX_CONCURRENT_SCANS", 20)),
});

const port = intEnv("PORT", 8787);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Receipt server listening on :${info.port}`);
});

// Let in-flight scans (which can take a minute or two) finish when the platform stops the container.
function shutdown(signal: string) {
  console.log(`${signal} received, draining connections`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 150_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
