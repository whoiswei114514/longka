import {
  DEBUG_MODEL_SLOTS,
  buildChatCompletionUrl,
  clearDebugSettings,
  defaultDebugSettings,
  deleteAllDebugModels,
  deleteDebugModel,
  getDebugStorageInfo,
  listDebugModels,
  loadDebugSettings,
  normalizeDebugSettings,
  putDebugModel,
  saveDebugSettings
} from "../debug-store.mjs";

const elements = {
  startup: byId("debug-startup"),
  startupStatus: byId("startup-status"),
  app: byId("debug-app"),
  form: byId("debug-form"),
  saveState: byId("save-state"),
  baseUrl: byId("api-base-url"),
  apiKey: byId("api-key"),
  modelId: byId("api-model-id"),
  timeout: byId("api-timeout"),
  showApiKey: byId("show-api-key"),
  testApiButton: byId("test-api-button"),
  apiTestResult: byId("api-test-result"),
  useCustomModels: byId("use-custom-models"),
  provider: byId("ocr-provider"),
  detLimit: byId("det-limit"),
  detThresh: byId("det-thresh"),
  detBoxThresh: byId("det-box-thresh"),
  detUnclip: byId("det-unclip"),
  detMinSize: byId("det-min-size"),
  recThresh: byId("rec-thresh"),
  showRawText: byId("show-raw-text"),
  testFile: byId("ocr-test-file"),
  testFileName: byId("ocr-test-file-name"),
  testPreview: byId("ocr-test-preview"),
  runOcrTest: byId("run-ocr-test"),
  testProgress: byId("ocr-test-progress"),
  ocrTestResult: byId("ocr-test-result"),
  diagnostics: byId("diagnostics"),
  formError: byId("form-error"),
  resetButton: byId("reset-debug"),
  saveButton: byId("save-debug"),
  toast: byId("toast")
};

const state = {
  settings: defaultDebugSettings(),
  models: new Map(),
  testFile: null,
  previewUrl: "",
  deleteCandidate: "",
  deleteTimer: 0,
  resetArmed: false,
  resetTimer: 0,
  busy: false
};

let toastTimer = 0;

initialize();

async function initialize() {
  bindEvents();
  if (!window.isSecureContext || !window.crypto?.subtle || !window.indexedDB) {
    elements.startupStatus.textContent = "当前环境不支持本机加密 Debug 存储";
    return;
  }
  try {
    state.settings = await loadDebugSettings();
    fillSettings(state.settings);
    await refreshModels();
    await renderDiagnostics();
    elements.startup.classList.add("hidden");
    elements.app.classList.remove("hidden");
  } catch (error) {
    elements.startupStatus.textContent = errorMessage(error);
  }
}

function bindEvents() {
  elements.form.addEventListener("submit", saveForm);
  elements.showApiKey.addEventListener("change", () => {
    elements.apiKey.type = elements.showApiKey.checked ? "text" : "password";
  });
  elements.testApiButton.addEventListener("click", testApiConnection);
  document.querySelectorAll(".model-file").forEach((input) => {
    input.addEventListener("change", uploadModel);
  });
  document.querySelectorAll(".delete-model").forEach((button) => {
    button.addEventListener("click", deleteModel);
  });
  elements.testFile.addEventListener("change", selectTestPhoto);
  elements.runOcrTest.addEventListener("click", runOcrSelfTest);
  elements.resetButton.addEventListener("click", resetDebug);
}

function fillSettings(settings) {
  elements.baseUrl.value = settings.api.baseUrl;
  elements.apiKey.value = settings.api.apiKey;
  elements.modelId.value = settings.api.modelId;
  elements.timeout.value = String(settings.api.timeoutMs);
  elements.useCustomModels.checked = settings.ocr.useCustomModels;
  elements.provider.value = settings.ocr.provider;
  elements.detLimit.value = String(settings.ocr.detLimitSideLen);
  elements.detThresh.value = String(settings.ocr.detThresh);
  elements.detBoxThresh.value = String(settings.ocr.detBoxThresh);
  elements.detUnclip.value = String(settings.ocr.detUnclipRatio);
  elements.detMinSize.value = String(settings.ocr.detMinSize);
  elements.recThresh.value = String(settings.ocr.recScoreThresh);
  elements.showRawText.checked = settings.ocr.showRawText;
}

function readSettings() {
  const settings = normalizeDebugSettings({
    api: {
      baseUrl: elements.baseUrl.value,
      apiKey: elements.apiKey.value,
      modelId: elements.modelId.value,
      timeoutMs: elements.timeout.value
    },
    ocr: {
      useCustomModels: elements.useCustomModels.checked,
      provider: elements.provider.value,
      detLimitSideLen: elements.detLimit.value,
      detThresh: elements.detThresh.value,
      detBoxThresh: elements.detBoxThresh.value,
      detUnclipRatio: elements.detUnclip.value,
      detMinSize: elements.detMinSize.value,
      recScoreThresh: elements.recThresh.value,
      showRawText: elements.showRawText.checked
    }
  });
  buildChatCompletionUrl(settings.api.baseUrl);
  if (!settings.api.modelId) {
    throw new Error("模型 ID 不能为空");
  }
  if (settings.ocr.useCustomModels
      && !state.models.has("detector") && !state.models.has("recognizer")) {
    throw new Error("启用自定义模型前至少上传一个 ONNX");
  }
  return settings;
}

async function saveForm(event) {
  event.preventDefault();
  try {
    await persistCurrentSettings(true);
  } catch (error) {
    elements.formError.textContent = errorMessage(error);
  }
}

async function persistCurrentSettings(showFeedback) {
  const settings = readSettings();
  setBusy(true);
  elements.formError.textContent = "";
  try {
    state.settings = await saveDebugSettings(settings);
    fillSettings(state.settings);
    elements.saveState.textContent = `已加密保存 · ${formatTime(new Date())}`;
    await renderDiagnostics();
    if (showFeedback) {
      showToast("Debug 配置已保存");
    }
    return state.settings;
  } finally {
    setBusy(false);
  }
}

async function uploadModel(event) {
  const input = event.currentTarget;
  const slot = input.dataset.slot;
  const file = input.files?.[0];
  if (!file || state.busy) {
    return;
  }
  const row = document.querySelector(`.model-row[data-slot="${slot}"]`);
  const status = row.querySelector(".model-status");
  setBusy(true);
  status.textContent = "正在校验并保存...";
  try {
    const metadata = await putDebugModel(slot, file);
    state.models.set(slot, metadata);
    renderModelRow(slot);
    await renderDiagnostics();
    showToast(`${DEBUG_MODEL_SLOTS[slot].label}已保存`);
  } catch (error) {
    status.textContent = errorMessage(error);
    showToast("模型保存失败");
  } finally {
    input.value = "";
    setBusy(false);
  }
}

async function deleteModel(event) {
  const button = event.currentTarget;
  const slot = button.dataset.slot;
  if (!state.models.has(slot) || state.busy) {
    return;
  }
  if (state.deleteCandidate !== slot) {
    window.clearTimeout(state.deleteTimer);
    state.deleteCandidate = slot;
    button.textContent = "确认删除";
    state.deleteTimer = window.setTimeout(() => {
      state.deleteCandidate = "";
      renderModelRow(slot);
    }, 3500);
    return;
  }
  state.deleteCandidate = "";
  window.clearTimeout(state.deleteTimer);
  setBusy(true);
  try {
    await deleteDebugModel(slot);
    state.models.delete(slot);
    if (!state.models.has("detector") && !state.models.has("recognizer")) {
      elements.useCustomModels.checked = false;
    }
    renderModelRow(slot);
    await renderDiagnostics();
    showToast("自定义模型已删除");
  } catch (error) {
    showToast(errorMessage(error));
  } finally {
    setBusy(false);
  }
}

async function refreshModels() {
  const items = await listDebugModels();
  state.models = new Map(items.map((item) => [item.slot, item]));
  Object.keys(DEBUG_MODEL_SLOTS).forEach(renderModelRow);
}

function renderModelRow(slot) {
  const row = document.querySelector(`.model-row[data-slot="${slot}"]`);
  const status = row.querySelector(".model-status");
  const deleteButton = row.querySelector(".delete-model");
  const metadata = state.models.get(slot);
  if (metadata) {
    status.textContent = `${metadata.name} · ${formatBytes(metadata.size)} · ${metadata.sha256.slice(0, 12)}`;
  } else {
    status.textContent = slot === "dictionary" ? "内置字典" : "内置模型";
  }
  deleteButton.disabled = !metadata || state.busy;
  deleteButton.textContent = state.deleteCandidate === slot ? "确认删除" : "删除";
}

async function testApiConnection() {
  if (state.busy) {
    return;
  }
  let settings;
  try {
    settings = readSettings();
    if (!settings.api.apiKey) {
      throw new Error("请先填写 API Key");
    }
  } catch (error) {
    showOutput(elements.apiTestResult, errorMessage(error));
    return;
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), settings.api.timeoutMs);
  const startedAt = performance.now();
  setBusy(true);
  showOutput(elements.apiTestResult, "正在请求...");
  try {
    const response = await fetch(buildChatCompletionUrl(settings.api.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.api.apiKey}`
      },
      body: JSON.stringify({
        model: settings.api.modelId,
        messages: [{ role: "user", content: "只回复 OK" }],
        temperature: 0,
        max_tokens: 8
      }),
      signal: controller.signal
    });
    const body = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      parsed = null;
    }
    if (!response.ok) {
      const detail = parsed?.error?.message || body.slice(0, 500) || response.statusText;
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    const reply = parsed?.choices?.[0]?.message?.content || body.slice(0, 500) || "响应为空";
    showOutput(elements.apiTestResult,
      `连接成功 · ${Math.round(performance.now() - startedAt)} ms\n${reply}`);
  } catch (error) {
    showOutput(elements.apiTestResult,
      error?.name === "AbortError" ? "请求超时" : errorMessage(error));
  } finally {
    window.clearTimeout(timeout);
    setBusy(false);
  }
}

function selectTestPhoto() {
  const file = elements.testFile.files?.[0] || null;
  state.testFile = file;
  clearPreviewUrl();
  elements.runOcrTest.disabled = !file || state.busy;
  elements.testFileName.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : "未选择";
  elements.ocrTestResult.classList.add("hidden");
  elements.testProgress.classList.add("hidden");
  if (!file) {
    elements.testPreview.classList.add("hidden");
    elements.testPreview.removeAttribute("src");
    return;
  }
  state.previewUrl = URL.createObjectURL(file);
  elements.testPreview.src = state.previewUrl;
  elements.testPreview.classList.remove("hidden");
}

async function runOcrSelfTest() {
  if (!state.testFile || state.busy) {
    return;
  }
  try {
    await persistCurrentSettings(false);
  } catch (error) {
    elements.formError.textContent = errorMessage(error);
    return;
  }
  setBusy(true);
  elements.testProgress.classList.remove("hidden");
  elements.testProgress.removeAttribute("value");
  showOutput(elements.ocrTestResult, "加载 OCR...");
  try {
    const module = await import("../ocr/cage-card-ocr.mjs");
    const result = await module.runCageCardOcr(state.testFile, (message) => {
      showOutput(elements.ocrTestResult, message);
    });
    elements.testProgress.value = 1;
    const lines = [
      `${result.modelLabel} · ${(result.timing.total / 1000).toFixed(1)} 秒`,
      `样品编号：${result.sampleNumber || "-"}`,
      `样品名称：${result.sampleName || "-"}`,
      `动物编号：${result.animalNumber || "-"}`
    ];
    if (state.settings.ocr.showRawText) {
      lines.push("", result.rawText || "未识别到文字");
    }
    showOutput(elements.ocrTestResult, lines.join("\n"));
  } catch (error) {
    elements.testProgress.value = 0;
    showOutput(elements.ocrTestResult, `OCR 失败：${errorMessage(error)}`);
  } finally {
    setBusy(false);
  }
}

async function resetDebug() {
  if (state.busy) {
    return;
  }
  if (!state.resetArmed) {
    state.resetArmed = true;
    elements.resetButton.textContent = "确认重置";
    window.clearTimeout(state.resetTimer);
    state.resetTimer = window.setTimeout(() => {
      state.resetArmed = false;
      elements.resetButton.textContent = "重置 Debug";
    }, 4000);
    return;
  }
  state.resetArmed = false;
  window.clearTimeout(state.resetTimer);
  setBusy(true);
  try {
    clearDebugSettings();
    await deleteAllDebugModels();
    state.settings = defaultDebugSettings();
    state.models.clear();
    fillSettings(state.settings);
    Object.keys(DEBUG_MODEL_SLOTS).forEach(renderModelRow);
    elements.saveState.textContent = "本机配置";
    elements.resetButton.textContent = "重置 Debug";
    await renderDiagnostics();
    showToast("Debug 已重置");
  } catch (error) {
    showToast(errorMessage(error));
  } finally {
    setBusy(false);
  }
}

async function renderDiagnostics() {
  const storage = getDebugStorageInfo();
  let estimate = null;
  try {
    estimate = await navigator.storage?.estimate?.();
  } catch (_) {
  }
  const rows = [
    ["安全上下文", window.isSecureContext ? "是" : "否"],
    ["WebCrypto", window.crypto?.subtle ? "可用" : "不可用"],
    ["IndexedDB", window.indexedDB ? "可用" : "不可用"],
    ["WebGPU", navigator.gpu ? "可用" : "不可用"],
    ["自定义文件", `${state.models.size} 个`],
    ["配置密文", `${formatBytes(storage.encryptedBytes)} · ${storage.chunks} 个 Cookie`],
    ["站点存储", estimate
      ? `${formatBytes(estimate.usage || 0)} / ${formatBytes(estimate.quota || 0)}`
      : "不可读取"]
  ];
  elements.diagnostics.replaceChildren(...rows.flatMap(([label, value]) => [
    textElement("dt", label), textElement("dd", value)
  ]));
}

function setBusy(busy) {
  state.busy = busy;
  elements.saveButton.disabled = busy;
  elements.testApiButton.disabled = busy;
  elements.runOcrTest.disabled = busy || !state.testFile;
  document.querySelectorAll(".model-file").forEach((input) => {
    input.disabled = busy;
  });
  Object.keys(DEBUG_MODEL_SLOTS).forEach(renderModelRow);
}

function showOutput(element, value) {
  element.textContent = value;
  element.classList.remove("hidden");
}

function textElement(tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}

function clearPreviewUrl() {
  if (state.previewUrl) {
    URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = "";
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).format(date);
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error || "未知错误");
}

function byId(id) {
  return document.getElementById(id);
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 2200);
}
