import { withGoogleTokens } from "./auth";
import { getSetting, setSetting } from "./db";
import { categoryLabel } from "./format";
import { isUnauthorized, readError, request } from "./http";
import type { Receipt } from "./types";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const SPREADSHEET_KEY = "spreadsheetId";

// Fixed sheet IDs so appends keep working even if the user renames the tabs.
const RECEIPTS_SHEET_ID = 1;
const ITEMS_SHEET_ID = 2;

const RECEIPT_HEADERS = ["Receipt ID", "Date", "Merchant", "Items", "Subtotal", "Tax", "Total", "Currency", "Payment", "Notes", "Scanned At"];
const ITEM_HEADERS = ["Receipt ID", "Date", "Merchant", "Item", "Category", "Quantity", "Unit Price", "Line Total", "Currency"];

type Cell = { userEnteredValue?: { stringValue: string } | { numberValue: number }; userEnteredFormat?: object };

const DATE_FORMAT = { numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" } };
const MONEY_FORMAT = { numberFormat: { type: "NUMBER", pattern: "#,##0.00" } };
const DATETIME_FORMAT = { numberFormat: { type: "DATE_TIME", pattern: "yyyy-mm-dd hh:mm" } };

// stringValue is always stored literally, so item names like "=HYPERLINK(...)" can't become formulas.
const text = (value: string | null | undefined): Cell => (value ? { userEnteredValue: { stringValue: value } } : {});
const num = (value: number | null | undefined, format?: object): Cell =>
  value === null || value === undefined ? {} : { userEnteredValue: { numberValue: value }, userEnteredFormat: format };

/** Google Sheets date serial: days since 1899-12-30. */
function dateCell(iso: string): Cell {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const serial = (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;
  return Number.isFinite(serial) ? num(serial, DATE_FORMAT) : text(iso);
}

/** Local date and time as a Sheets serial, so the column sorts and filters as real dates. */
function dateTimeCell(isoTimestamp: string): Cell {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return text(isoTimestamp);
  const localMs = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  return num((localMs - Date.UTC(1899, 11, 30)) / 86_400_000, DATETIME_FORMAT);
}

async function sheetsFetch(accessToken: string, path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
  const response = await request(`${SHEETS_API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  });
  if (!response.ok) throw await readError(response, "Google Sheets request failed.");
  return response;
}

function headerRow(values: string[]) {
  return {
    values: values.map((value) => ({
      userEnteredValue: { stringValue: value },
      userEnteredFormat: { textFormat: { bold: true } },
    })),
  };
}

async function createSpreadsheet(accessToken: string): Promise<string> {
  const response = await sheetsFetch(accessToken, "", {
    method: "POST",
    body: JSON.stringify({
      properties: { title: "Foison Receipts" },
      sheets: [
        {
          properties: { sheetId: RECEIPTS_SHEET_ID, title: "Receipts", gridProperties: { frozenRowCount: 1 } },
          data: [{ startRow: 0, startColumn: 0, rowData: [headerRow(RECEIPT_HEADERS)] }],
        },
        {
          properties: { sheetId: ITEMS_SHEET_ID, title: "Items", gridProperties: { frozenRowCount: 1 } },
          data: [{ startRow: 0, startColumn: 0, rowData: [headerRow(ITEM_HEADERS)] }],
        },
      ],
    }),
  });
  const body = (await response.json()) as { spreadsheetId: string };
  return body.spreadsheetId;
}

/**
 * True if the saved spreadsheet still exists and is not in the trash. Deleting a file in Drive only moves
 * it to the trash, where the Sheets API still accepts writes, so we ask the Drive API (allowed by the
 * drive.file scope for files the app created).
 */
async function spreadsheetUsable(accessToken: string, id: string): Promise<boolean> {
  const response = await request(`${DRIVE_API}/${id}?fields=trashed`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 404) return false;
  if (!response.ok) throw await readError(response, "Google Drive request failed.");
  const body = (await response.json()) as { trashed?: boolean };
  return body.trashed !== true;
}

/** Returns the app's spreadsheet, creating it (again) if it was deleted or moved to the trash. */
async function ensureSpreadsheet(accessToken: string): Promise<string> {
  const saved = await getSetting(SPREADSHEET_KEY);
  if (saved && (await spreadsheetUsable(accessToken, saved))) return saved;
  const id = await createSpreadsheet(accessToken);
  await setSetting(SPREADSHEET_KEY, id);
  return id;
}

/** Guards against duplicates when a previous append succeeded but its response was lost. */
async function receiptAlreadyInSheet(accessToken: string, spreadsheetId: string, receiptId: string): Promise<boolean> {
  const range = encodeURIComponent("Receipts!A:A");
  const response = await sheetsFetch(accessToken, `/${spreadsheetId}/values/${range}?majorDimension=COLUMNS`);
  const body = (await response.json()) as { values?: string[][] };
  return body.values?.[0]?.includes(receiptId) ?? false;
}

function receiptRow(r: Receipt) {
  return {
    values: [
      text(r.id),
      dateCell(r.purchaseDate),
      text(r.merchant),
      num(r.items.length),
      num(r.subtotal, MONEY_FORMAT),
      num(r.tax, MONEY_FORMAT),
      num(r.total, MONEY_FORMAT),
      text(r.currency),
      text(r.paymentMethod),
      text(r.notes),
      dateTimeCell(r.createdAt),
    ],
  };
}

function itemRows(r: Receipt) {
  return r.items.map((item) => ({
    values: [
      text(r.id),
      dateCell(r.purchaseDate),
      text(r.merchant),
      text(item.name),
      text(categoryLabel(item.category)),
      num(item.quantity),
      num(item.unitPrice, MONEY_FORMAT),
      num(item.totalPrice, MONEY_FORMAT),
      text(r.currency),
    ],
  }));
}

/** Appends one receipt (summary row + item rows) in a single atomic batchUpdate. */
export async function appendReceiptToSheet(receipt: Receipt): Promise<void> {
  await withGoogleTokens(async ({ accessToken }) => {
    const spreadsheetId = await ensureSpreadsheet(accessToken);
    if (await receiptAlreadyInSheet(accessToken, spreadsheetId, receipt.id)) return;
    const requests: object[] = [
      { appendCells: { sheetId: RECEIPTS_SHEET_ID, rows: [receiptRow(receipt)], fields: "userEnteredValue,userEnteredFormat" } },
    ];
    if (receipt.items.length > 0) {
      requests.push({
        appendCells: { sheetId: ITEMS_SHEET_ID, rows: itemRows(receipt), fields: "userEnteredValue,userEnteredFormat" },
      });
    }
    await sheetsFetch(accessToken, `/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests }),
    });
  }, isUnauthorized);
}

export async function getSpreadsheetUrl(): Promise<string | null> {
  const id = await getSetting(SPREADSHEET_KEY);
  return id ? `https://docs.google.com/spreadsheets/d/${id}` : null;
}
