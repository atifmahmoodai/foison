import { syncAllPending, syncReceipt } from "../sync";
import type { Receipt } from "../types";

const mockSettings = new Map<string, string>();
const mockStatus = new Map<string, string>();
const mockReceipt = (id: string): Receipt => ({
  id,
  merchant: "Shop",
  purchaseDate: "2026-09-28",
  currency: "USD",
  subtotal: 1,
  tax: null,
  total: 1,
  paymentMethod: null,
  notes: null,
  imageUris: [],
  items: [],
  createdAt: "2026-09-28T10:00:00.000Z",
  syncStatus: "pending",
  syncError: null,
});

jest.mock("../db", () => ({
  getSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => void mockSettings.set(k, v)),
  getReceipt: jest.fn(async (id: string) => (mockStatus.get(id) === "synced" ? null : mockReceipt(id))),
  setSyncStatus: jest.fn(async (id: string, status: string) => void mockStatus.set(id, status)),
  listUnsyncedIds: jest.fn(async () => {
    throw new Error("database locked");
  }),
}));
jest.mock("../auth", () => ({
  AuthError: class extends Error {},
  withGoogleTokens: (fn: (t: { idToken: string; accessToken: string }) => Promise<unknown>) =>
    fn({ idToken: "id", accessToken: "access" }),
}));

let creates = 0;
beforeEach(() => {
  mockSettings.clear();
  mockStatus.clear();
  creates = 0;
  globalThis.fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    await new Promise((r) => setTimeout(r, 5)); // let concurrent calls interleave
    if (init.method === "POST" && url.endsWith("/spreadsheets")) {
      creates++;
      return new Response(JSON.stringify({ spreadsheetId: `S${creates}` }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
});

it("creates only one spreadsheet when two receipts sync at the same time", async () => {
  const results = await Promise.all([syncReceipt("a"), syncReceipt("b"), syncReceipt("c")]);
  expect(results).toEqual([true, true, true]);
  expect(creates).toBe(1);
  expect(mockSettings.get("spreadsheetId")).toBe("S1");
});

it("never rejects, even if the database fails", async () => {
  await expect(syncAllPending()).resolves.toEqual({ synced: 0, failed: 0 });
});
