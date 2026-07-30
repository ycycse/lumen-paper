import type { PageText } from "./paper";

const DB_NAME = "lumen-pdf-cache";
const DB_VERSION = 1;
const STORE_NAME = "documents";
const MAX_ENTRIES = 4;
const MAX_FILE_BYTES = 96 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface PdfCacheRecord {
  url: string;
  bytes: ArrayBuffer;
  pages: PageText[] | null;
  savedAt: number;
  size: number;
}

export interface CachedPdf {
  bytes: ArrayBuffer;
  pages: PageText[] | null;
}

export async function getCachedPdf(url: string): Promise<CachedPdf | null> {
  if (!canUseCache(url)) return null;
  const database = await openDatabase();
  const record = await requestResult<PdfCacheRecord | undefined>(
    database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(url),
  );
  if (!record) return null;
  if (Date.now() - record.savedAt > MAX_AGE_MS) {
    await deleteCachedPdf(url).catch(() => undefined);
    return null;
  }
  return {
    bytes: record.bytes.slice(0),
    pages: record.pages ? record.pages.map((page) => ({ ...page })) : null,
  };
}

export async function putCachedPdf(url: string, bytes: ArrayBuffer): Promise<void> {
  if (!canUseCache(url) || bytes.byteLength > MAX_FILE_BYTES) return;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).put({
    url,
    bytes: bytes.slice(0),
    pages: null,
    savedAt: Date.now(),
    size: bytes.byteLength,
  } satisfies PdfCacheRecord);
  await transactionDone(transaction);
  await pruneCache(database);
}

export async function putCachedPdfIndex(url: string, pages: PageText[]): Promise<void> {
  if (!canUseCache(url)) return;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const request = store.get(url);
  request.onsuccess = () => {
    const record = request.result as PdfCacheRecord | undefined;
    if (record) store.put({ ...record, pages, savedAt: Date.now() } satisfies PdfCacheRecord);
  };
  await transactionDone(transaction);
}

async function deleteCachedPdf(url: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).delete(url);
  await transactionDone(transaction);
}

function canUseCache(url: string): boolean {
  return typeof indexedDB !== "undefined" && /^(https?|file):/i.test(url);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "url" });
        store.createIndex("savedAt", "savedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开 PDF 缓存"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("PDF 缓存读取失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("PDF 缓存写入失败"));
    transaction.onabort = () => reject(transaction.error || new Error("PDF 缓存写入已取消"));
  });
}

function pruneCache(database: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const index = transaction.objectStore(STORE_NAME).index("savedAt");
    let seen = 0;
    const request = index.openCursor(null, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      seen += 1;
      if (seen > MAX_ENTRIES) cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("PDF 缓存清理失败"));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("PDF 缓存清理失败"));
  });
}
