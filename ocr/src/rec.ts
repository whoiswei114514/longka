// CTC 文本识别：裁剪图 -> 文本 + 置信度

import type { OcrOptions } from "./types.ts";
import type { OrtModule, OrtSession } from "./ort-loader.ts";
import { cropQuad, preprocessRec } from "./image.ts";
import type { Quad } from "./types.ts";

export interface RecModel {
  session: OrtSession;
  ort: OrtModule;
  /** 字符表（不含 blank） */
  charDict: string[];
}

/** 加载识别字典 */
export async function loadCharDict(modelSize: string): Promise<string[]> {
  const url = new URL("./models/rec/char_dict.json", import.meta.url).href;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`字典加载失败: ${url} (${resp.status})`);
  return (await resp.json()) as string[];
}

/**
 * 依据模型输出类别数构造完整标签表。
 *
 * PP-OCRv6 small uses standard CTC output: class 0 is blank, dictionary
 * entry i maps to class i + 1, and the final class is a special token.
 */
function buildLabels(charDict: string[], numClasses: number): string[] {
  const labels: string[] = new Array(numClasses).fill("");
  // Small ONNX uses standard Paddle CTC layout: index 0 is blank and
  // dictionary entry i is model class i + 1. The final model class is a
  // special token and intentionally remains empty.
  for (let i = 0; i < charDict.length && 1 + i < numClasses; i++) {
    labels[1 + i] = charDict[i];
  }
  return labels;
}

interface RecOut {
  text: string;
  score: number;
}

/** CTC 贪心解码（去重、去 blank），并计算平均置信度 */
function ctcDecode(
  raw: Float32Array,
  T: number,
  C: number,
  labels: string[],
): RecOut {
  let lastIdx = -1;
  let chars = "";
  let scoreSum = 0;
  let count = 0;

  // 探测输出是否已经过 softmax（值是否在 [0,1] 范围内）
  let isSoftmax = true;
  const checkLen = Math.min(C, 1024);
  for (let i = 0; i < checkLen; i++) {
    const v = raw[i];
    if (v < -1e-4 || v > 1 + 1e-4) {
      isSoftmax = false;
      break;
    }
  }

  for (let t = 0; t < T; t++) {
    const off = t * C;
    // argmax
    let maxIdx = 0;
    let maxVal = raw[off];
    for (let c = 1; c < C; c++) {
      const v = raw[off + c];
      if (v > maxVal) {
        maxVal = v;
        maxIdx = c;
      }
    }
    if (maxIdx !== 0 && maxIdx !== lastIdx) {
      const prob = isSoftmax ? maxVal : (() => {
        let sum = 0;
        for (let c = 0; c < C; c++) sum += Math.exp(raw[off + c] - maxVal);
        return 1 / sum;
      })();
      chars += labels[maxIdx] ?? "";
      scoreSum += prob;
      count++;
    }
    lastIdx = maxIdx;
  }
  return { text: chars, score: count > 0 ? scoreSum / count : 0 };
}

/** 对单个文本框运行识别 */
export async function recognizeBox(
  model: RecModel,
  src: HTMLCanvasElement,
  box: Quad,
): Promise<RecOut> {
  const { ort, session, charDict } = model;
  const crop = cropQuad(src, box);
  const input = preprocessRec(crop);
  const tensor = new ort.Tensor("float32", input.data, [
    1,
    3,
    input.height,
    input.width,
  ]);
  const feeds: Record<string, typeof tensor> = {};
  feeds[session.inputNames[0]] = tensor;
  const out = await session.run(feeds);
  const o = out[session.outputNames[0]];
  const dims = o.dims;
  const T = dims[dims.length - 2];
  const C = dims[dims.length - 1];
  const labels = buildLabels(charDict, C);
  return ctcDecode(o.data as Float32Array, T, C, labels);
}

/** 批量识别多个文本框，按得分阈值过滤 */
export async function recognizeAll(
  model: RecModel,
  src: HTMLCanvasElement,
  boxes: Quad[],
  opts: OcrOptions,
): Promise<{ box: Quad; text: string; score: number }[]> {
  const results: { box: Quad; text: string; score: number }[] = [];
  for (const box of boxes) {
    const { text, score } = await recognizeBox(model, src, box);
    if (text && score >= opts.recScoreThresh) {
      results.push({ box, text, score });
    }
  }
  return results;
}
