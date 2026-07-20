import { runOcr } from "./ppocr-engine.mjs";

const OPTIONS = Object.freeze({
  modelSize: "small",
  provider: "wasm",
  detLimitSideLen: 1280,
  detThresh: 0.15,
  detBoxThresh: 0.3,
  detUnclipRatio: 1.8,
  detMinSize: 2,
  recScoreThresh: 0.35,
  threadCount: 1
});

const KNOWN_SAMPLE_NAMES = [
  "血液透析器",
  "牙种植体系统",
  "一次性使用全血采集分离器",
  "骨绑带",
  "可吸收性外科倒刺缝线",
  "聚乙醇酸穴位埋线",
  "种植体系统-种植体",
  "一次性使用连发施夹钳(可带降解镁夹)",
  "连续性血液净化用滤过器及管路套包",
  "一次性使用连发施夹钳及结扎夹",
  "一次性使用透析用留置针",
  "氧化锆陶瓷样棒",
  "聚乙醇酸(PolyglycolicAcid)",
  "一次性使用血液灌流器",
  "注射用透明质酸钠和重组人源III型",
  "注射用羟基磷灰石微球填充剂",
  "一次性血液净化装置的体外循环血路",
  "可吸收性外科缝线",
  "缝线(病理)"
];

const FIELD_LABELS = /样品编号|样品名称|动物编(?:号)?|动物品种|动物性别|动物体重|负责人|联系电话|开始日期|结束日期|剂量组别|给药途径|实验动物笼卡|安全评价中心/;

export async function runCageCardOcr(file, onProgress = () => {}) {
  if (!(file instanceof Blob)) {
    throw new Error("请选择笼卡照片");
  }
  onProgress("解码照片");
  const canvas = await imageToCanvas(file, 1800);
  const result = await runOcr(canvas, OPTIONS, (stage, detail) => {
    onProgress(detail ? `${stage}：${detail}` : stage);
  });
  onProgress("整理识别结果");
  const fields = parseCageCardFields(result.lines);
  return {
    ...fields,
    lines: result.lines,
    rawText: result.formattedText,
    timing: result.timing,
    imageWidth: canvas.width,
    imageHeight: canvas.height
  };
}

export function parseCageCardFields(lines) {
  const normalized = lines
    .map((line) => ({ ...line, text: normalizeText(line.text) }))
    .filter((line) => line.text);
  return {
    sampleNumber: findSampleNumber(normalized),
    sampleName: findSampleName(normalized),
    animalNumber: findAnimalNumber(normalized)
  };
}

async function imageToCanvas(file, maximumSide) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (_) {
    source = await imageElementFromBlob(file);
  }
  const sourceWidth = source.width || source.naturalWidth;
  const sourceHeight = source.height || source.naturalHeight;
  const scale = Math.min(1, maximumSide / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  canvas.getContext("2d", { willReadFrequently: true })
    .drawImage(source, 0, 0, canvas.width, canvas.height);
  if (typeof source.close === "function") {
    source.close();
  }
  return canvas;
}

function imageElementFromBlob(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("照片解码失败"));
    };
    image.src = url;
  });
}

function findSampleNumber(lines) {
  const ranked = [];
  for (const line of lines) {
    const compact = line.text.replace(/\s+/g, "").replace(/[—–_]/g, "-");
    const match = compact.match(/[A-Z][0-9OQDILSB]{5,}-[0-9OQDILSB]{4,}/i);
    if (!match) continue;
    const corrected = match[0][0].toUpperCase()
      + match[0].slice(1).replace(/[OQD]/gi, "0").replace(/[IL]/gi, "1")
        .replace(/S/gi, "5").replace(/B/gi, "8");
    const score = line.score + (corrected.match(/^C\d{6}-\d{6}$/) ? 2 : 0);
    ranked.push({ value: corrected, score });
  }
  ranked.sort((left, right) => right.score - left.score);
  return ranked[0]?.value || "";
}

function findAnimalNumber(lines) {
  const label = lines.find((line) => /动物编(?:号)?|动物号/.test(line.text));
  const ranked = [];
  for (const line of lines) {
    const compact = line.text.replace(/\s+/g, "")
      .replace(/[OQD]/gi, "0").replace(/[IL]/gi, "1").replace(/S/gi, "5");
    const direct = compact.match(/(?:动物编(?:号)?|动物号)[:：]?([0-9]{4,5})/);
    if (direct) ranked.push({ value: direct[1], score: 1000 + line.score });
    const numberMatch = compact.match(/(?:^|\D)(\d{4,5})(?!\d)/);
    if (!numberMatch) continue;
    const value = numberMatch[1];
    let score = line.score * 10 + (value.length === 4 ? 8 : 2);
    if (/^20\d{2}$/.test(value)) score -= 20;
    if (compact === value) score += 5;
    if (label && line !== label) score += proximityScore(label, line);
    ranked.push({ value, score });
  }
  ranked.sort((left, right) => right.score - left.score);
  return ranked[0]?.value || "";
}

function findSampleName(lines) {
  const label = lines.find((line) => /样品名称|样本名称/.test(line.text));
  const candidates = [];
  for (const line of lines) {
    let text = line.text.replace(/^.*?(?:样品名称|样本名称)[:：]?/, "").trim();
    text = text.replace(/^(?:样品编号|样品名称|样本名称)[:：]?\s*/, "").trim();
    if (!text || FIELD_LABELS.test(text) || /^(?:新西兰兔|兰兔)$/.test(text)
        || !/[\u3400-\u9fff]/.test(text)) continue;
    text = text.replace(/[|丨]+/g, "").trim();
    let score = line.score * 10 + Math.min(20, text.length);
    if (label && line !== label) score += proximityScore(label, line);
    if (/透析|种植|缝线|绑带|血液|陶瓷|透明质酸|磷灰石|施夹钳|埋线|净化|灌流/.test(text)) {
      score += 30;
    }
    candidates.push({ value: text, score });
  }
  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0]?.value || "";
  if (!best) return "";
  const canonical = closestKnownName(best);
  return canonical || best;
}

function proximityScore(label, candidate) {
  const labelBounds = bounds(label.box);
  const candidateBounds = bounds(candidate.box);
  const labelY = (labelBounds.top + labelBounds.bottom) / 2;
  const candidateY = (candidateBounds.top + candidateBounds.bottom) / 2;
  const height = Math.max(12, labelBounds.bottom - labelBounds.top);
  const vertical = Math.abs(candidateY - labelY);
  if (candidateBounds.left >= labelBounds.left && vertical <= height * 1.3) {
    return 80 - Math.min(60, vertical);
  }
  const below = candidateBounds.top >= labelBounds.top
    && candidateBounds.top - labelBounds.bottom <= height * 2.5;
  return below ? 35 : -Math.min(30, vertical / 5);
}

function closestKnownName(value) {
  const normalizedValue = comparisonText(value);
  let best = null;
  for (const known of KNOWN_SAMPLE_NAMES) {
    const normalizedKnown = comparisonText(known);
    const distance = editDistance(normalizedValue, normalizedKnown);
    const similarity = 1 - distance / Math.max(normalizedValue.length, normalizedKnown.length, 1);
    const contains = normalizedValue.includes(normalizedKnown) || normalizedKnown.includes(normalizedValue);
    const score = contains ? Math.max(similarity, 0.78) : similarity;
    if (!best || score > best.score) best = { value: known, score };
  }
  return best && best.score >= 0.62 ? best.value : "";
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function bounds(box) {
  const xs = box.map((point) => point[0]);
  const ys = box.map((point) => point[1]);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

function comparisonText(value) {
  return normalizeText(value).replace(/[^0-9A-Za-z\u3400-\u9fff]/g, "").toLowerCase();
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}
