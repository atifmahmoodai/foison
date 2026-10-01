import { Directory, File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat, type ImageManipulatorContext, type ImageRef } from "expo-image-manipulator";
import { planPages, type Size } from "./tiling";

export type Page = { uri: string };
export type PreparedReceipt = {
  /** Images to send, top to bottom (tiles of tall pages included). */
  parts: { base64: string }[];
  /** One resized JPEG per original page, kept as the receipt's photos. */
  pageUris: string[];
};

const JPEG = { compress: 0.85, format: SaveFormat.JPEG } as const;

/** Decodes one image, runs `fn`, and always frees the native bitmap (12 MP photos are ~48 MB each). */
async function withImage<T>(context: ImageManipulatorContext, fn: (ref: ImageRef) => Promise<T>): Promise<T> {
  const ref = await context.renderAsync();
  try {
    return await fn(ref);
  } finally {
    ref.release();
    context.release();
  }
}

/**
 * Resizes each page and slices tall ones into overlapping tiles (see tiling.ts).
 * Pages are processed one at a time so only one full-size photo is in memory at once.
 */
export async function prepareReceiptPages(pages: Page[]): Promise<PreparedReceipt> {
  // Pass 1: measure. Rendering applies EXIF orientation, so these are the real upright sizes.
  const sizes: Size[] = [];
  for (const page of pages) {
    sizes.push(await withImage(ImageManipulator.manipulate(page.uri), async (r) => ({ width: r.width, height: r.height })));
  }
  const plans = planPages(sizes);

  // Pass 2: scale each page once, then cut tiles from the scaled file.
  const parts: PreparedReceipt["parts"] = [];
  const pageUris: string[] = [];
  for (const [index, plan] of plans.entries()) {
    const single = plan.tiles.length === 1;
    const scaled = await withImage(ImageManipulator.manipulate(pages[index]!.uri).resize(plan.scaled), (r) =>
      r.saveAsync({ ...JPEG, base64: single }),
    );
    pageUris.push(scaled.uri);
    if (single) {
      parts.push({ base64: scaled.base64! });
      continue;
    }
    for (const tile of plan.tiles) {
      const crop = { originX: 0, originY: tile.originY, width: plan.scaled.width, height: tile.height };
      const saved = await withImage(ImageManipulator.manipulate(scaled.uri).crop(crop), (r) =>
        r.saveAsync({ ...JPEG, base64: true }),
      );
      parts.push({ base64: saved.base64! });
      deleteCacheFiles([saved.uri]); // only the base64 is needed
    }
  }
  return { parts, pageUris };
}

/**
 * Deletes temporary images (camera captures, picker copies, resized pages). Only touches files inside the
 * app's cache directory, so it can never remove a user's original photo or a saved receipt image.
 */
export function deleteCacheFiles(uris: string[]) {
  const cacheRoot = Paths.cache.uri;
  for (const uri of uris) {
    if (!uri.startsWith(cacheRoot)) continue;
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch (error) {
      console.warn("Failed to delete temp image", error);
    }
  }
}

function receiptsDir(): Directory {
  const dir = new Directory(Paths.document, "receipts");
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Copies a (cache) page image into permanent app storage and returns the new URI. */
export function persistReceiptImage(cacheUri: string, receiptId: string, page = 0): string {
  const target = new File(receiptsDir(), page === 0 ? `${receiptId}.jpg` : `${receiptId}-${page + 1}.jpg`);
  if (target.exists) target.delete();
  new File(cacheUri).copySync(target);
  return target.uri;
}

export function deleteReceiptImage(uri: string | null) {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (error) {
    console.warn("Failed to delete receipt image", error);
  }
}

export function deleteAllReceiptImages() {
  try {
    const dir = new Directory(Paths.document, "receipts");
    if (dir.exists) dir.delete();
  } catch (error) {
    console.warn("Failed to delete receipt images", error);
  }
}
