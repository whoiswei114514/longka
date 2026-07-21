const KEY_DB_NAME = "longka_device_keys";
const KEY_DB_VERSION = 1;
const KEY_STORE_NAME = "keys";
const ROOT_KEY_ID = "hkdf_root_v2";
const DEBUG_META_COOKIE = "longka_debug_meta";
const DEBUG_DATA_PREFIX = "longka_debug_data_";
const DEBUG_STORAGE_VERSION = 1;
const DEBUG_KEY_CONTEXT = "longka/debug-settings/v1";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 3;
const COOKIE_CHUNK_SIZE = 2800;
const MAX_COOKIE_CHUNKS = 8;
const MODEL_DB_NAME = "longka_debug_models";
const MODEL_DB_VERSION = 1;
const MODEL_BLOB_STORE = "model_blobs";
const MODEL_META_STORE = "model_meta";
const MAX_MODEL_BYTES = 250 * 1024 * 1024;
const COOKIE_PATH = new URL("./", import.meta.url).pathname;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const DEBUG_MODEL_SLOTS = Object.freeze({
  detector: Object.freeze({ label: "文本检测 ONNX", extensions: [".onnx"] }),
  recognizer: Object.freeze({ label: "文本识别 ONNX", extensions: [".onnx"] }),
  dictionary: Object.freeze({ label: "识别字典", extensions: [".json", ".txt"] })
});

export function defaultDebugSettings() {
  return {
    version: DEBUG_STORAGE_VERSION,
    api: {
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKey: "",
      modelId: "mimo-v2.5",
      timeoutMs: 45000
    },
    ocr: {
      useCustomModels: false,
      provider: "wasm",
      detLimitSideLen: 1280,
      detThresh: 0.15,
      detBoxThresh: 0.3,
      detUnclipRatio: 1.8,
      detMinSize: 2,
      recScoreThresh: 0.35,
      showRawText: true
    }
  };
}

export async function loadDebugSettings() {
  const root = await getOrCreateRootKey();
  const meta = readDebugMeta();
  if (!meta) {
    return defaultDebugSettings();
  }
  if (root.created) {
    clearDebugCookies();
    return defaultDebugSettings();
  }
  const salt = base64ToBytes(meta.salt);
  const key = await deriveDebugKey(root.key, salt);
  const envelope = readDebugEnvelope(meta);
  const separator = envelope.indexOf(".");
  if (separator < 1) {
    throw new Error("Debug 配置密文格式错误");
  }
  const iv = base64ToBytes(envelope.slice(0, separator));
  const encrypted = base64ToBytes(envelope.slice(separator + 1));
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
  const parsed = JSON.parse(textDecoder.decode(decrypted));
  if (!parsed || parsed.version !== DEBUG_STORAGE_VERSION) {
    throw new Error("Debug 配置版本不受支持");
  }
  return normalizeDebugSettings(parsed.settings);
}

export async function saveDebugSettings(value) {
  const settings = normalizeDebugSettings(value);
  const root = await getOrCreateRootKey();
  let meta = readDebugMeta();
  if (meta && root.created) {
    clearDebugCookies();
    meta = null;
  }
  const salt = meta ? base64ToBytes(meta.salt) : crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveDebugKey(root.key, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = textEncoder.encode(JSON.stringify({
    version: DEBUG_STORAGE_VERSION,
    settings
  }));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, plain
  ));
  const envelope = `${bytesToBase64(iv)}.${bytesToBase64(encrypted)}`;
  const chunks = chunkString(envelope, COOKIE_CHUNK_SIZE);
  if (chunks.length > MAX_COOKIE_CHUNKS) {
    throw new Error("Debug 配置超过 Cookie 容量");
  }
  const previousCount = meta ? meta.count : 0;
  chunks.forEach((chunk, index) => setCookie(`${DEBUG_DATA_PREFIX}${index}`, chunk));
  for (let index = chunks.length; index < previousCount; index += 1) {
    deleteCookie(`${DEBUG_DATA_PREFIX}${index}`);
  }
  setCookie(DEBUG_META_COOKIE, encodeURIComponent(JSON.stringify({
    version: DEBUG_STORAGE_VERSION,
    salt: bytesToBase64(salt),
    count: chunks.length
  })));
  const storedMeta = readDebugMeta();
  if (!storedMeta || readDebugEnvelope(storedMeta) !== envelope) {
    throw new Error("浏览器拒绝了 Debug Cookie 存储");
  }
  return settings;
}

export function clearDebugSettings() {
  clearDebugCookies();
}

export function getDebugStorageInfo() {
  const meta = readDebugMeta();
  if (!meta) {
    return { encryptedBytes: 0, chunks: 0 };
  }
  try {
    return { encryptedBytes: readDebugEnvelope(meta).length, chunks: meta.count };
  } catch (_) {
    return { encryptedBytes: 0, chunks: meta.count };
  }
}

export async function putDebugModel(slot, file) {
  assertModelSlot(slot);
  if (!(file instanceof Blob) || file.size < 1024) {
    throw new Error("模型文件无效或过小");
  }
  if (file.size > MAX_MODEL_BYTES) {
    throw new Error("单个模型不能超过 250 MB");
  }
  const extension = fileExtension(file.name || "");
  if (!DEBUG_MODEL_SLOTS[slot].extensions.includes(extension)) {
    throw new Error(`${DEBUG_MODEL_SLOTS[slot].label} 文件类型不正确`);
  }
  const bytes = await file.arrayBuffer();
  const hash = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const metadata = {
    slot,
    name: clean(file.name).slice(0, 180) || `${slot}${extension}`,
    type: clean(file.type) || "application/octet-stream",
    size: file.size,
    sha256: hash,
    savedAt: new Date().toISOString()
  };
  const database = await openModelDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [MODEL_BLOB_STORE, MODEL_META_STORE], "readwrite"
      );
      transaction.objectStore(MODEL_BLOB_STORE).put(file.slice(0, file.size, metadata.type), slot);
      transaction.objectStore(MODEL_META_STORE).put(metadata, slot);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("模型保存失败"));
      transaction.onabort = () => reject(transaction.error || new Error("模型保存失败"));
    });
    return metadata;
  } finally {
    database.close();
  }
}

export async function listDebugModels() {
  const database = await openModelDatabase();
  try {
    const items = await readAllDatabaseValues(database, MODEL_META_STORE);
    return items
      .filter((item) => item && DEBUG_MODEL_SLOTS[item.slot])
      .sort((left, right) => left.slot.localeCompare(right.slot));
  } finally {
    database.close();
  }
}

export async function getDebugModelBuffer(slot) {
  assertModelSlot(slot);
  const database = await openModelDatabase();
  try {
    const value = await readDatabaseValue(database, MODEL_BLOB_STORE, slot);
    if (!value) {
      return null;
    }
    if (value instanceof Blob) {
      return value.arrayBuffer();
    }
    if (value instanceof ArrayBuffer) {
      return value;
    }
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    throw new Error("模型数据格式不受支持");
  } finally {
    database.close();
  }
}

export async function deleteDebugModel(slot) {
  assertModelSlot(slot);
  const database = await openModelDatabase();
  try {
    await deleteDatabaseKeys(database, slot);
  } finally {
    database.close();
  }
}

export async function deleteAllDebugModels() {
  const database = await openModelDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [MODEL_BLOB_STORE, MODEL_META_STORE], "readwrite"
      );
      transaction.objectStore(MODEL_BLOB_STORE).clear();
      transaction.objectStore(MODEL_META_STORE).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("模型清理失败"));
      transaction.onabort = () => reject(transaction.error || new Error("模型清理失败"));
    });
  } finally {
    database.close();
  }
}

export function buildChatCompletionUrl(baseUrl) {
  const url = new URL(clean(baseUrl));
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Base URL 格式无效");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/chat/completions")
    ? path
    : `${path}/chat/completions`;
  return url.href;
}

export function normalizeDebugSettings(value) {
  const defaults = defaultDebugSettings();
  const api = value && typeof value.api === "object" ? value.api : {};
  const ocr = value && typeof value.ocr === "object" ? value.ocr : {};
  return {
    version: DEBUG_STORAGE_VERSION,
    api: {
      baseUrl: clean(api.baseUrl || defaults.api.baseUrl).slice(0, 512),
      apiKey: clean(api.apiKey).slice(0, 4096),
      modelId: clean(api.modelId || defaults.api.modelId).slice(0, 160),
      timeoutMs: clampInteger(api.timeoutMs, 5000, 120000, defaults.api.timeoutMs)
    },
    ocr: {
      useCustomModels: Boolean(ocr.useCustomModels),
      provider: ocr.provider === "webgpu" ? "webgpu" : "wasm",
      detLimitSideLen: clampInteger(ocr.detLimitSideLen, 320, 2560, defaults.ocr.detLimitSideLen),
      detThresh: clampNumber(ocr.detThresh, 0.01, 0.99, defaults.ocr.detThresh),
      detBoxThresh: clampNumber(ocr.detBoxThresh, 0.01, 0.99, defaults.ocr.detBoxThresh),
      detUnclipRatio: clampNumber(ocr.detUnclipRatio, 1, 3, defaults.ocr.detUnclipRatio),
      detMinSize: clampInteger(ocr.detMinSize, 1, 32, defaults.ocr.detMinSize),
      recScoreThresh: clampNumber(ocr.recScoreThresh, 0.01, 0.99, defaults.ocr.recScoreThresh),
      showRawText: ocr.showRawText !== false
    }
  };
}

async function deriveDebugKey(rootKey, salt) {
  return crypto.subtle.deriveKey({
    name: "HKDF",
    salt,
    info: textEncoder.encode(DEBUG_KEY_CONTEXT),
    hash: "SHA-256"
  }, rootKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function getOrCreateRootKey() {
  const database = await openKeyDatabase();
  try {
    const existing = await readDatabaseValue(database, KEY_STORE_NAME, ROOT_KEY_ID);
    if (isValidRootKey(existing)) {
      return { key: existing, created: false };
    }
    const rootBytes = crypto.getRandomValues(new Uint8Array(32));
    let rootKey;
    try {
      rootKey = await crypto.subtle.importKey("raw", rootBytes, "HKDF", false, ["deriveKey"]);
    } finally {
      rootBytes.fill(0);
    }
    if (existing) {
      await writeDatabaseValue(database, KEY_STORE_NAME, ROOT_KEY_ID, rootKey, false);
      return { key: rootKey, created: true };
    }
    try {
      await writeDatabaseValue(database, KEY_STORE_NAME, ROOT_KEY_ID, rootKey, true);
      return { key: rootKey, created: true };
    } catch (error) {
      if (!error || error.name !== "ConstraintError") {
        throw error;
      }
      const concurrentKey = await readDatabaseValue(database, KEY_STORE_NAME, ROOT_KEY_ID);
      if (!isValidRootKey(concurrentKey)) {
        throw new Error("本机密钥初始化冲突");
      }
      return { key: concurrentKey, created: true };
    }
  } finally {
    database.close();
  }
}

function isValidRootKey(value) {
  return value instanceof CryptoKey
    && value.type === "secret"
    && value.extractable === false
    && value.algorithm.name === "HKDF"
    && value.usages.length === 1
    && value.usages[0] === "deriveKey";
}

function openKeyDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_DB_NAME, KEY_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEY_STORE_NAME)) {
        request.result.createObjectStore(KEY_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开密钥数据库"));
    request.onblocked = () => reject(new Error("密钥数据库被其他页面占用"));
  });
}

function openModelDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MODEL_DB_NAME, MODEL_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MODEL_BLOB_STORE)) {
        database.createObjectStore(MODEL_BLOB_STORE);
      }
      if (!database.objectStoreNames.contains(MODEL_META_STORE)) {
        database.createObjectStore(MODEL_META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开模型数据库"));
    request.onblocked = () => reject(new Error("模型数据库被其他页面占用"));
  });
}

function readDatabaseValue(database, storeName, id) {
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本机数据读取失败"));
  });
}

function readAllDatabaseValues(database, storeName) {
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error("本机数据读取失败"));
  });
}

function writeDatabaseValue(database, storeName, id, value, addOnly) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const request = addOnly
      ? transaction.objectStore(storeName).add(value, id)
      : transaction.objectStore(storeName).put(value, id);
    transaction.oncomplete = () => resolve();
    request.onerror = () => reject(request.error || new Error("本机数据保存失败"));
    transaction.onerror = () => reject(transaction.error || new Error("本机数据保存失败"));
    transaction.onabort = () => reject(transaction.error || request.error || new Error("本机数据保存失败"));
  });
}

function deleteDatabaseKeys(database, id) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([MODEL_BLOB_STORE, MODEL_META_STORE], "readwrite");
    transaction.objectStore(MODEL_BLOB_STORE).delete(id);
    transaction.objectStore(MODEL_META_STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("模型删除失败"));
    transaction.onabort = () => reject(transaction.error || new Error("模型删除失败"));
  });
}

function readDebugMeta() {
  const value = readCookie(DEBUG_META_COOKIE);
  if (!value) {
    return null;
  }
  try {
    const meta = JSON.parse(decodeURIComponent(value));
    if (meta.version !== DEBUG_STORAGE_VERSION || !meta.salt
        || !Number.isInteger(meta.count) || meta.count < 1 || meta.count > MAX_COOKIE_CHUNKS) {
      return null;
    }
    return meta;
  } catch (_) {
    return null;
  }
}

function readDebugEnvelope(meta) {
  let value = "";
  for (let index = 0; index < meta.count; index += 1) {
    const chunk = readCookie(`${DEBUG_DATA_PREFIX}${index}`);
    if (!chunk) {
      throw new Error("Debug 配置密文不完整");
    }
    value += chunk;
  }
  return value;
}

function clearDebugCookies() {
  deleteCookie(DEBUG_META_COOKIE);
  for (let index = 0; index < MAX_COOKIE_CHUNKS; index += 1) {
    deleteCookie(`${DEBUG_DATA_PREFIX}${index}`);
  }
}

function setCookie(name, value) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${value}; Path=${COOKIE_PATH}; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

function deleteCookie(name) {
  document.cookie = `${name}=; Path=${COOKIE_PATH}; Max-Age=0; SameSite=Lax`;
}

function readCookie(name) {
  const prefix = `${name}=`;
  const item = document.cookie.split("; ").find((part) => part.startsWith(prefix));
  return item ? item.slice(prefix.length) : "";
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64ToBytes(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function chunkString(value, size) {
  const chunks = [];
  for (let offset = 0; offset < value.length; offset += size) {
    chunks.push(value.slice(offset, offset + size));
  }
  return chunks;
}

function assertModelSlot(slot) {
  if (!DEBUG_MODEL_SLOTS[slot]) {
    throw new Error("未知模型槽位");
  }
}

function fileExtension(name) {
  const match = clean(name).toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : "";
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function clampInteger(value, minimum, maximum, fallback) {
  return Math.round(clampNumber(value, minimum, maximum, fallback));
}

function clean(value) {
  return value == null ? "" : String(value).trim();
}
