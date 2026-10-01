import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ExtractedReceiptSchema, type ExtractedReceipt, type ParseRequest } from "./schema.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";

// Only the JSON schema is sent. The helper's auto-parse is dropped because it throws a generic error on
// refusals and truncated output; parseReceipt() below handles those cases explicitly.
const { type: formatType, schema: receiptJsonSchema } = betaZodOutputFormat(ExtractedReceiptSchema);
const OUTPUT_FORMAT = { type: formatType, schema: receiptJsonSchema };

const SYSTEM_PROMPT = `You read photos of shopping receipts (groceries, pharmacies, restaurants, fuel, retail) and return their contents as structured data.

Rules:
- List every purchased line item in the order printed. Do not merge or skip lines.
- Expand obvious abbreviations into readable names ("ORG BNNA" -> "Organic Bananas"), but never invent items that are not on the receipt.
- For weighed items, quantity is the weight and unit_price is the price per weight unit.
- Discounts, coupons and savings printed as their own lines become items with a negative total_price.
- Deposits, bag fees and service charges are items too. Tax is reported in "tax", not as an item.
- Copy subtotal, tax and total exactly as printed; do not "fix" them if they disagree with the item sum.
- Dates: convert to YYYY-MM-DD. If the day/month order is ambiguous, use the store's country convention.
- If a value is not printed or unreadable, use null rather than guessing, and mention it briefly in notes.
- If the image is not a receipt, set is_receipt to false and return an empty items list.

Long receipts arrive as several images in top-to-bottom order (separate photos, or slices of one tall photo).
They are parts of ONE receipt:
- Consecutive images usually overlap. A line that appears at the bottom of one image and again at the top
  of the next is the same line: include it once. Use neighbouring lines and prices to line up the overlap.
- Genuinely repeated purchases (the same item printed on two separate lines) must still be listed twice;
  only remove duplicates caused by the overlap between images.
- Take the header (store, date) from the first image and the totals/payment from the last.`;

function parseReceipt(content: Anthropic.Beta.BetaContentBlock[]): ExtractedReceipt | null {
  const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  try {
    const result = ExtractedReceiptSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** `signal` aborts the Claude call, e.g. when the phone cancels or disconnects. */
export type ReceiptExtractor = (input: ParseRequest, signal?: AbortSignal) => Promise<ExtractedReceipt>;

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly code: "refused" | "unparseable" | "not_a_receipt" | "upstream" | "cancelled",
    readonly status: 400 | 422 | 502 | 503,
  ) {
    super(message);
  }
}

export function createClaudeExtractor(client = new Anthropic()): ReceiptExtractor {
  return async ({ images }, signal) => {
    const imageBlocks = images.flatMap((image, index): Anthropic.Beta.BetaContentBlockParam[] => [
      ...(images.length > 1 ? [{ type: "text" as const, text: `Part ${index + 1} of ${images.length}:` }] : []),
      { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.imageBase64 } },
    ]);
    let response;
    try {
      // Streamed so a very long receipt (hundreds of lines) has room to finish without an HTTP timeout.
      response = await client.beta.messages
        .stream({
        model: MODEL,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          effort: "high",
          format: OUTPUT_FORMAT,
        },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              ...imageBlocks,
              {
                type: "text",
                text: images.length > 1 ? `Extract this receipt (${images.length} parts, top to bottom).` : "Extract this receipt.",
              },
            ],
          },
        ],
      }, { signal })
        .finalMessage();
    } catch (error) {
      if (signal?.aborted || error instanceof Anthropic.APIUserAbortError) {
        throw new ExtractionError("Cancelled.", "cancelled", 400); // the client is already gone
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new ExtractionError("The receipt reader is busy. Please try again in a moment.", "upstream", 503);
      }
      if (error instanceof Anthropic.APIError) {
        console.error(`Anthropic API error ${error.status}: ${error.message}`);
        throw new ExtractionError("The receipt reader is unavailable right now.", "upstream", 502);
      }
      throw error;
    }

    if (response.stop_reason === "refusal") {
      throw new ExtractionError("This image could not be processed.", "refused", 422);
    }
    const receipt = response.stop_reason === "end_turn" ? parseReceipt(response.content) : null;
    if (!receipt) {
      throw new ExtractionError("The receipt could not be read. Try a clearer photo.", "unparseable", 422);
    }
    if (!receipt.is_receipt) {
      throw new ExtractionError("That doesn't look like a receipt. Try again with the whole receipt in frame.", "not_a_receipt", 422);
    }
    return receipt;
  };
}
