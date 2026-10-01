import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createClaudeExtractor, ExtractionError } from "./extract.js";

/** Builds a Server-Sent Events body like the Messages streaming API returns. */
function sse(text: string, stopReason: string): string {
  const events: [string, object][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function fakeClient(reply: { text: string; stop_reason?: string }) {
  const requests: any[] = [];
  const client = new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(sse(reply.text, reply.stop_reason ?? "end_turn"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return { client, requests };
}

const valid = {
  is_receipt: true,
  merchant: "Shop",
  purchase_date: "2026-09-01",
  currency: "USD",
  items: [{ name: "Milk", quantity: 1, unit_price: 2.5, total_price: 2.5, category: "dairy" }],
  subtotal: 2.5,
  tax: null,
  total: 2.5,
  payment_method: "Cash",
  notes: null,
};

const one = { images: [{ imageBase64: "AAAA", mediaType: "image/jpeg" as const }] };

describe("createClaudeExtractor", () => {
  it("streams the request with a JSON schema and returns the parsed receipt", async () => {
    const { client, requests } = fakeClient({ text: JSON.stringify(valid) });
    expect(await createClaudeExtractor(client)(one)).toEqual(valid);

    const body = requests[0];
    expect(body.stream).toBe(true);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.max_tokens).toBe(64000);
    expect(body.fallbacks).toBe("default");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
    });
  });

  it("labels each part of a multi-image receipt in order", async () => {
    const { client, requests } = fakeClient({ text: JSON.stringify(valid) });
    await createClaudeExtractor(client)({
      images: [
        { imageBase64: "AAAA", mediaType: "image/jpeg" },
        { imageBase64: "BBBB", mediaType: "image/jpeg" },
      ],
    });
    const content = requests[0].messages[0].content;
    expect(content.map((b: any) => b.text ?? b.source.data)).toEqual([
      "Part 1 of 2:",
      "AAAA",
      "Part 2 of 2:",
      "BBBB",
      "Extract this receipt (2 parts, top to bottom).",
    ]);
  });

  it("rejects non-receipts", async () => {
    const { client } = fakeClient({ text: JSON.stringify({ ...valid, is_receipt: false, items: [] }) });
    await expect(createClaudeExtractor(client)(one)).rejects.toMatchObject({ code: "not_a_receipt" });
  });

  it("surfaces refusals as ExtractionError", async () => {
    const { client } = fakeClient({ text: "", stop_reason: "refusal" });
    await expect(createClaudeExtractor(client)(one)).rejects.toBeInstanceOf(ExtractionError);
  });

  it("treats truncated output as unreadable", async () => {
    const { client } = fakeClient({ text: '{"is_receipt": true, "items": [', stop_reason: "max_tokens" });
    await expect(createClaudeExtractor(client)(one)).rejects.toMatchObject({ code: "unparseable" });
  });

  it("maps API errors to a retryable upstream error", async () => {
    const client = new Anthropic({
      apiKey: "test",
      maxRetries: 0,
      fetch: async () =>
        new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }), {
          status: 529,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(createClaudeExtractor(client)(one)).rejects.toMatchObject({ code: "upstream", status: 502 });
  });

  it("stops the Claude call when the request is aborted", async () => {
    let seenSignal: AbortSignal | undefined;
    const client = new Anthropic({
      apiKey: "test",
      maxRetries: 0,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          seenSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    const controller = new AbortController();
    const pending = createClaudeExtractor(client)(one, controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(seenSignal?.aborted).toBe(true);
  });
});
