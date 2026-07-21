import { buildChatCompletionUrl, loadDebugSettings } from "./debug-store.mjs";

export async function isMimoConfigured() {
  try {
    const settings = await loadDebugSettings();
    return Boolean(settings.api.baseUrl && settings.api.apiKey && settings.api.modelId);
  } catch (_) {
    return false;
  }
}

export async function reviewCageCardWithMimo(file, localResult = {}, onProgress = () => {}) {
  if (!(file instanceof Blob)) {
    throw new Error("请选择笼卡照片");
  }
  const settings = await loadDebugSettings();
  const { baseUrl, apiKey, modelId, timeoutMs } = settings.api;
  if (!baseUrl || !apiKey || !modelId) {
    throw new Error("Mimo API 尚未配置");
  }
  const endpoint = buildChatCompletionUrl(baseUrl);
  if (location.protocol === "https:" && endpoint.startsWith("http:")) {
    throw new Error("HTTPS 页面不能调用 HTTP API");
  }
  onProgress("压缩图片");
  const imageUrl = await imageToDataUrl(file, 1024, 0.72);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  onProgress("请求 Mimo");
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0,
        top_p: 0.95,
        stream: false,
        max_completion_tokens: 300,
        thinking: { type: "disabled" },
        messages: [
          {
            role: "system",
            content: "你是笼卡OCR纠错器。只输出JSON，不要解释。字段为sampleNumber、sampleName、animalNumber、confidence、reason。不要读取或输出笼号、笼架号、房号。不要混用不同笼卡的字段。多张笼卡时选画面中最完整、最居中的笼卡。"
          },
          {
            role: "user",
            content: [
              { type: "text", text: imagePrompt(localResult) },
              { type: "image_url", image_url: { url: imageUrl, detail: "high" } }
            ]
          }
        ]
      }),
      signal: controller.signal
    });
    const body = await response.text();
    let root;
    try {
      root = JSON.parse(body);
    } catch (_) {
      root = null;
    }
    if (!response.ok) {
      const detail = root?.error?.message || body.slice(0, 500) || response.statusText;
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    const content = responseContent(root);
    const parsed = JSON.parse(extractJson(content));
    const result = {
      sampleNumber: sanitizeSampleNumber(firstValue(parsed, "sampleNumber", "sample_number", "样品编号")),
      sampleName: sanitizeSampleName(firstValue(parsed, "sampleName", "sample_name", "样品名称")),
      animalNumber: sanitizeAnimalNumber(firstValue(parsed, "animalNumber", "animal_number", "动物编号")),
      confidence: Number(parsed.confidence) || 0,
      reason: clean(parsed.reason).slice(0, 500),
      timing: performance.now() - startedAt
    };
    if (!result.sampleNumber && !result.sampleName && !result.animalNumber) {
      throw new Error("Mimo 未返回有效笼卡字段");
    }
    return result;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Mimo 请求超过 ${Math.round(timeoutMs / 1000)} 秒`);
    }
    if (error instanceof TypeError && /fetch/i.test(error.message)) {
      throw new Error("Mimo 请求失败，请检查网络、Base URL 或跨域设置");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function imagePrompt(local) {
  const fields = [
    `样品编号=${clean(local.sampleNumber)}`,
    `样品名称=${clean(local.sampleName)}`,
    `动物编号=${clean(local.animalNumber)}`
  ].join("\n");
  const raw = clean(local.rawText).slice(0, 6000);
  return "请直接读取图片中的目标笼卡字段。目标笼卡是画面中最完整、最居中的笼卡；不要把相邻笼卡字段混合。"
    + "返回JSON：sampleNumber、sampleName、animalNumber、confidence、reason。动物编号是笼卡表格中的动物编号，不是笼号。"
    + "不要输出笼号、笼架号、房号。必须独立读取图片并尽量填全三项；本地OCR可能错误，不要直接照抄。"
    + "样品编号通常类似C260403-014001。\n\n本地OCR字段：\n"
    + fields + (raw ? `\n\n本地OCR原文：\n${raw}` : "");
}

async function imageToDataUrl(file, maximumSide, quality) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (_) {
    source = await imageElementFromBlob(file);
  }
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  const scale = Math.min(1, maximumSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  if (typeof source.close === "function") {
    source.close();
  }
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("图片压缩失败")), "image/jpeg", quality);
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
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

function responseContent(root) {
  const content = root?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content.map((item) => typeof item === "string" ? item : item?.text || "").join("\n").trim();
    if (text) return text;
  }
  throw new Error("Mimo 响应内容为空");
}

function extractJson(content) {
  const cleaned = clean(content).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Mimo 响应中没有 JSON");
  }
  return cleaned.slice(start, end + 1);
}

function firstValue(object, ...keys) {
  for (const key of keys) {
    const value = clean(object?.[key]);
    if (value) return value;
  }
  return "";
}

function sanitizeSampleNumber(value) {
  const compact = clean(value).normalize("NFKC").replace(/[^0-9A-Za-z-]/g, "");
  const match = compact.match(/[A-Za-z]\d{4,}-\d{4,}/);
  return match ? match[0][0].toUpperCase() + match[0].slice(1) : "";
}

function sanitizeSampleName(value) {
  const cleaned = clean(value).normalize("NFKC")
    .replace(/^(?:样品名称|样本名称)[:：]?/, "")
    .replace(/[^\u3400-\u9fffA-Za-z0-9()（）\-]/g, "")
    .slice(0, 80);
  return (cleaned.match(/[\u3400-\u9fff]/g) || []).length >= 2 ? cleaned : "";
}

function sanitizeAnimalNumber(value) {
  const match = clean(value).normalize("NFKC").match(/(?:^|\D)(\d{4,5})(?!\d)/);
  return match ? match[1] : "";
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function clean(value) {
  return value == null ? "" : String(value).trim();
}
