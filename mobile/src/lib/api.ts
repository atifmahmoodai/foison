import { withGoogleTokens } from "./auth";
import { config } from "./config";
import { isUnauthorized, readError, request } from "./http";
import type { ExtractedReceipt } from "./types";

/** Sends every part of the receipt (top to bottom) in one request. */
export async function parseReceiptParts(parts: { base64: string }[], signal?: AbortSignal): Promise<ExtractedReceipt> {
  const images = parts.map((p) => ({ imageBase64: p.base64, mediaType: "image/jpeg" as const }));
  return withGoogleTokens(async ({ idToken }) => {
    const response = await request(`${config.apiUrl}/v1/receipts/parse`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ images }),
      timeoutMs: 240_000, // a long, multi-part receipt can take a couple of minutes
      signal,
    });
    if (!response.ok) throw await readError(response, "We couldn't read this receipt. Please try again.");
    const body = (await response.json()) as { receipt: ExtractedReceipt };
    return body.receipt;
  }, isUnauthorized);
}
