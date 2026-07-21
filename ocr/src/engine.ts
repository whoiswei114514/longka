// OCR 引擎：加载模型会话、编排 检测 -> 识别 全流程

import type { OcrOptions, OcrResult } from "./types.ts";
import {
  loadOrt,
  type OrtModule,
  type OrtSession,
  toExecutionProviders,
} from "./ort-loader.ts";
import { runDetection } from "./det.ts";
import { loadCharDict, recognizeAll } from "./rec.ts";
import { formatOcrText } from "./format.ts";

interface LoadedModels {
  ort: OrtModule;
  det: OrtSession;
  rec: OrtSession;
  charDict: string[];
}

export type ProgressFn = (stage: string, detail?: string) => void;

const cache = new Map<string, Promise<LoadedModels>>();
const MODEL_CACHE_NAME = "longka-ocr-models-v1";

function cacheKey(opts: OcrOptions): string {
  const models = opts.modelOverrides?.cacheKey ?? "builtin";
  return `${opts.modelSize}:${opts.provider}:${opts.threadCount}:${models}`;
}

/** 加载（并缓存）指定规格与后端的检测/识别模型 */
async function getModels(opts: OcrOptions, onProgress?: ProgressFn): Promise<LoadedModels> {
  const key = cacheKey(opts);
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      // 传递 threadCount 参数
      const ort = await loadOrt({ threadCount: opts.threadCount });
      const eps = toExecutionProviders(opts.provider);
      const sessOpts = {
        executionProviders: eps,
        graphOptimizationLevel: "all",
      };
      const overrides = opts.modelOverrides;
      const detSource = overrides?.detModel ?? loadBuiltinModel(
        new URL("./models/det/inference.onnx", import.meta.url).href,
        "检测模型",
        onProgress,
      );
      const recSource = overrides?.recModel ?? loadBuiltinModel(
        new URL("./models/rec/inference.onnx", import.meta.url).href,
        "识别模型",
        onProgress,
      );
      const [det, rec, charDict] = await Promise.all([
        Promise.resolve(detSource).then((source) => ort.InferenceSession.create(source, sessOpts)),
        Promise.resolve(recSource).then((source) => ort.InferenceSession.create(source, sessOpts)),
        overrides?.charDict
          ? Promise.resolve(overrides.charDict)
          : loadCharDict(opts.modelSize),
      ]);
      return { ort, det, rec, charDict };
    })();
    cache.set(key, p);
  }
  try {
    return await p;
  } catch (e) {
    cache.delete(key); // 失败不缓存，便于重试
    throw e;
  }
}

async function loadBuiltinModel(
  url: string,
  label: string,
  onProgress?: ProgressFn,
): Promise<ArrayBuffer> {
  let modelCache: Cache | null = null;
  if (typeof caches !== "undefined") {
    try {
      modelCache = await caches.open(MODEL_CACHE_NAME);
    } catch (_) {
      modelCache = null;
    }
  }
  if (modelCache) {
    const cached = await modelCache.match(url);
    if (cached) {
      const bytes = await cached.arrayBuffer();
      if (bytes.byteLength >= 1024) {
        onProgress?.("加载模型", `${label} · 本机缓存 ${formatModelBytes(bytes.byteLength)}`);
        return bytes;
      }
      await modelCache.delete(url);
    }
  }
  onProgress?.("下载模型", `${label} · 连接中`);
  let response: Response;
  try {
    response = await fetch(url, { cache: "force-cache" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}下载失败，请检查网络: ${detail}`);
  }
  if (!response.ok) {
    throw new Error(`${label}下载失败: HTTP ${response.status}`);
  }
  const bytes = await readModelResponse(response, label, onProgress);
  if (bytes.byteLength < 1024) {
    throw new Error(`${label}文件无效或不完整`);
  }
  if (modelCache) {
    try {
      await modelCache.put(url, new Response(bytes, {
        headers: { "Content-Type": "application/octet-stream" },
      }));
    } catch (_) {
      // Quota failures must not prevent the current OCR run.
    }
  }
  return bytes;
}

async function readModelResponse(
  response: Response,
  label: string,
  onProgress?: ProgressFn,
): Promise<ArrayBuffer> {
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    onProgress?.("下载模型", `${label} · ${formatModelBytes(bytes.byteLength)}`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let reportedAt = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    if (loaded - reportedAt >= 256 * 1024) {
      reportedAt = loaded;
      onProgress?.("下载模型", `${label} · ${formatModelBytes(loaded)}`);
    }
  }
  const combined = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress?.("下载模型", `${label} · ${formatModelBytes(loaded)}`);
  return combined.buffer as ArrayBuffer;
}

function formatModelBytes(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 执行完整 OCR 流程 */
export async function runOcr(
  src: HTMLCanvasElement,
  opts: OcrOptions,
  onProgress?: ProgressFn,
): Promise<OcrResult> {
  const t0 = performance.now();
  onProgress?.("加载模型", `${opts.modelSize} / ${opts.provider}`);
  const models = await getModels(opts, onProgress);

  onProgress?.("文本检测");
  const tDet0 = performance.now();
  const boxes = await runDetection(
    { session: models.det, ort: models.ort },
    src,
    opts,
  );
  const detMs = performance.now() - tDet0;

  onProgress?.("文本识别", `${boxes.length} 个候选框`);
  const tRec0 = performance.now();
  const lines = await recognizeAll(
    { session: models.rec, ort: models.ort, charDict: models.charDict },
    src,
    boxes,
    opts,
  );
  const recMs = performance.now() - tRec0;

  const totalMs = performance.now() - t0;
  return {
    lines,
    formattedText: formatOcrText(lines),
    width: src.width,
    height: src.height,
    timing: { detect: detMs, recognize: recMs, total: totalMs },
  };
}

/** 预热（可选）：提前加载模型 */
export async function warmup(opts: OcrOptions): Promise<void> {
  await getModels(opts);
}
