import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { TokenVerifier, AuthenticatedUser } from "./auth.js";
import { ExtractionError, type ReceiptExtractor } from "./extract.js";
import type { ConcurrencyLimiter, RateLimiter } from "./rateLimit.js";
import { ParseRequestSchema } from "./schema.js";

type Deps = {
  verifyToken: TokenVerifier;
  extract: ReceiptExtractor;
  /** Short-term burst limit per user (e.g. per hour). */
  limiter: RateLimiter;
  /** Daily cap per user: bounds what one Google account can cost you. */
  dailyLimiter: RateLimiter;
  /** Global cap on simultaneous Claude calls. */
  concurrency: ConcurrencyLimiter;
};
type Env = { Variables: { user: AuthenticatedUser } };

export function createApp({ verifyToken, extract, limiter, dailyLimiter, concurrency }: Deps) {
  const app = new Hono<Env>();

  app.use(secureHeaders());

  // One log line per request: method, path, status, latency. Never logs bodies (receipt photos).
  app.use(async (c, next) => {
    const started = Date.now();
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.header("x-request-id", requestId);
    await next();
    console.log(
      JSON.stringify({ requestId, method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started }),
    );
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return c.json({ error: "unauthorized", message: "Sign in required." }, 401);
    try {
      c.set("user", await verifyToken(token));
    } catch {
      return c.json({ error: "unauthorized", message: "Your session expired. Please sign in again." }, 401);
    }
    const userId = c.get("user").userId;
    const dailyRetry = dailyLimiter.take(userId);
    if (dailyRetry > 0) {
      c.header("Retry-After", String(dailyRetry));
      return c.json({ error: "rate_limited", message: "You've reached today's scan limit. Please try again tomorrow." }, 429);
    }
    const retryAfter = limiter.take(userId);
    if (retryAfter > 0) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "rate_limited", message: "Too many scans in a short time. Please wait a few minutes." }, 429);
    }
    await next();
  });

  app.post(
    "/v1/receipts/parse",
    // 20 MB of images inflates to ~27 MB as base64, plus JSON overhead
    bodyLimit({
      maxSize: 28 * 1024 * 1024,
      onError: (c) => c.json({ error: "too_large", message: "Image is too large." }, 413),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "bad_request", message: "Body must be JSON." }, 400);
      }
      const parsed = ParseRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "Invalid request." }, 400);
      }
      const release = concurrency.tryAcquire();
      if (!release) {
        c.header("Retry-After", "10");
        return c.json({ error: "busy", message: "Lots of people are scanning right now. Please try again in a moment." }, 503);
      }
      try {
        const receipt = await extract(parsed.data, c.req.raw.signal);
        return c.json({ receipt });
      } catch (error) {
        if (error instanceof ExtractionError) {
          return c.json({ error: error.code, message: error.message }, error.status);
        }
        console.error("Unexpected extraction failure", error);
        return c.json({ error: "internal", message: "Something went wrong. Please try again." }, 500);
      } finally {
        release();
      }
    },
  );

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}
