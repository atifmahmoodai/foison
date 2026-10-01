import { insertReceipt } from "../db";
import { deleteReceiptImage } from "../image";
import { draftFromExtraction, effectiveTotal, saveDraft, totalsMismatch, validateDraft } from "../receipts";
import { syncReceipt } from "../sync";
import type { ExtractedReceipt } from "../types";

jest.mock("../db", () => ({ insertReceipt: jest.fn(), deleteReceipt: jest.fn(), getReceipt: jest.fn() }));
jest.mock("../image", () => ({
  persistReceiptImage: jest.fn((_uri: string, id: string, page: number) => `file:///doc/${id}-${page}.jpg`),
  deleteReceiptImage: jest.fn(),
}));
jest.mock("../sync", () => ({ syncReceipt: jest.fn(() => Promise.resolve(true)) }));
jest.mock("expo-localization", () => ({ getLocales: () => [{ currencyCode: "PKR" }] }));
jest.mock("expo-crypto", () => {
  let n = 0;
  return { randomUUID: () => `id-${++n}` };
});


const extracted: ExtractedReceipt = {
  is_receipt: true,
  merchant: "  Fresh Market ",
  purchase_date: "2026-09-28",
  currency: "usd",
  items: [
    { name: "Milk", quantity: 2, unit_price: 1.5, total_price: 3, category: "dairy" },
    { name: "Coupon", quantity: 1, unit_price: null, total_price: -0.5, category: "other" },
    { name: "Mystery", quantity: 0, unit_price: null, total_price: 1, category: "unknown" as never },
  ],
  subtotal: 3.5,
  tax: 0.28,
  total: 3.78,
  payment_method: null,
  notes: null,
};

describe("draftFromExtraction", () => {
  it("normalises the server response", () => {
    const draft = draftFromExtraction(extracted);
    expect(draft.merchant).toBe("Fresh Market");
    expect(draft.currency).toBe("USD");
    expect(draft.items[2]).toMatchObject({ quantity: 1, category: "other" });
  });

  it("uses the phone's currency when the receipt doesn't show one", () => {
    expect(draftFromExtraction({ ...extracted, currency: null }).currency).toBe("PKR");
    expect(draftFromExtraction({ ...extracted, currency: "Rs" }).currency).toBe("PKR");
  });

  it("falls back to today for missing/invalid dates", () => {
    const draft = draftFromExtraction({ ...extracted, purchase_date: "2026-13-45" });
    expect(draft.purchaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(draft.purchaseDate).not.toBe("2026-13-45");
  });
});

describe("totals", () => {
  const draft = draftFromExtraction(extracted);

  it("accepts total = items + tax", () => {
    expect(totalsMismatch(draft)).toBe(false);
  });

  it("accepts tax-inclusive receipts (total = items)", () => {
    expect(totalsMismatch({ ...draft, total: 3.5 })).toBe(false);
  });

  it("flags a misread line", () => {
    expect(totalsMismatch({ ...draft, total: 9.99 })).toBe(true);
  });

  it("uses items + tax when no total was printed", () => {
    expect(effectiveTotal({ ...draft, total: null })).toBe(3.78);
  });
});

describe("validateDraft", () => {
  it("reports the first problem", () => {
    const draft = draftFromExtraction(extracted);
    expect(validateDraft(draft)).toBeNull();
    expect(validateDraft({ ...draft, merchant: " " })).toMatch(/store/);
    expect(validateDraft({ ...draft, purchaseDate: "yesterday" })).toMatch(/date/);
    expect(validateDraft({ ...draft, currency: "US" })).toMatch(/Currency/);
  });
});

describe("saveDraft", () => {
  it("stores the receipt locally then syncs it", async () => {
    const id = await saveDraft(draftFromExtraction(extracted), ["file:///cache/a.jpg", "file:///cache/b.jpg"]);
    const saved = (insertReceipt as jest.Mock).mock.calls[0][0];
    expect(saved).toMatchObject({ id, subtotal: 3.5, total: 3.78, syncStatus: "pending" });
    expect(saved.imageUris).toEqual([`file:///doc/${id}-0.jpg`, `file:///doc/${id}-1.jpg`]);
    expect(syncReceipt).toHaveBeenCalledWith(id);
  });

  it("removes the copied photos if the database write fails", async () => {
    (insertReceipt as jest.Mock).mockRejectedValueOnce(new Error("disk full"));
    await expect(saveDraft(draftFromExtraction(extracted), ["file:///cache/a.jpg", "file:///cache/b.jpg"])).rejects.toThrow("disk full");
    expect(deleteReceiptImage).toHaveBeenCalledTimes(2);
  });
});
