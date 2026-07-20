(() => {
  "use strict";

  const META_COOKIE = "longka_meta";
  const DATA_COOKIE_PREFIX = "longka_data_";
  const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 3;
  const COOKIE_CHUNK_SIZE = 2800;
  const MAX_COOKIE_CHUNKS = 24;
  const PBKDF2_ITERATIONS = 210000;
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const state = {
    key: null,
    salt: null,
    records: [],
    editingId: null,
    photoUrl: "",
    ocrRunning: false,
    queryLocation: readQueryLocation(),
    deleteCandidate: "",
    deleteTimer: 0
  };

  const elements = {
    lockView: byId("lock-view"),
    appView: byId("app-view"),
    lockCopy: byId("lock-copy"),
    password: byId("password"),
    confirmPassword: byId("confirm-password"),
    confirmPasswordField: byId("confirm-password-field"),
    lockError: byId("lock-error"),
    unlockButton: byId("unlock-button"),
    lockButton: byId("lock-button"),
    headerLocation: byId("header-location"),
    entryTitle: byId("entry-title"),
    form: byId("entry-form"),
    room: byId("room"),
    rack: byId("rack"),
    cage: byId("cage"),
    sampleNumber: byId("sample-number"),
    sampleName: byId("sample-name"),
    animalNumber: byId("animal-number"),
    photoInput: byId("photo-input"),
    ocrButton: byId("ocr-button"),
    ocrPanel: byId("ocr-panel"),
    ocrStatus: byId("ocr-status"),
    ocrProgress: byId("ocr-progress"),
    ocrDetails: byId("ocr-details"),
    ocrRawText: byId("ocr-raw-text"),
    photoPreviewWrap: byId("photo-preview-wrap"),
    photoPreview: byId("photo-preview"),
    removePhotoButton: byId("remove-photo-button"),
    clearFormButton: byId("clear-form-button"),
    saveButton: byId("save-button"),
    formError: byId("form-error"),
    recordCount: byId("record-count"),
    recordSearch: byId("record-search"),
    emptyRecords: byId("empty-records"),
    recordList: byId("record-list"),
    newRecordButton: byId("new-record-button"),
    storageSize: byId("storage-size"),
    toast: byId("toast")
  };

  let toastTimer = 0;

  initialize();

  function initialize() {
    if (!window.crypto || !window.crypto.subtle) {
      elements.lockError.textContent = "当前浏览器不支持加密存储";
      elements.unlockButton.disabled = true;
      return;
    }
    configureLockView();
    bindEvents();
    applyLocation(state.queryLocation);
    elements.password.focus();
  }

  function configureLockView() {
    const setup = !readMeta();
    elements.confirmPasswordField.classList.toggle("hidden", !setup);
    elements.lockCopy.textContent = setup ? "首次使用，请设置存储密码" : "输入存储密码";
    elements.unlockButton.textContent = setup ? "创建加密存储" : "解锁";
    elements.password.autocomplete = setup ? "new-password" : "current-password";
  }

  function bindEvents() {
    elements.unlockButton.addEventListener("click", unlock);
    elements.password.addEventListener("keydown", submitOnEnter);
    elements.confirmPassword.addEventListener("keydown", submitOnEnter);
    elements.lockButton.addEventListener("click", lock);
    elements.form.addEventListener("submit", saveRecord);
    elements.clearFormButton.addEventListener("click", () => resetForm(true));
    elements.newRecordButton.addEventListener("click", () => {
      resetForm(true);
      showView("entry");
    });
    elements.photoInput.addEventListener("change", previewPhoto);
    elements.ocrButton.addEventListener("click", runLocalOcr);
    elements.removePhotoButton.addEventListener("click", clearPhoto);
    elements.recordSearch.addEventListener("input", renderRecords);
    elements.recordList.addEventListener("click", handleRecordAction);
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => showView(tab.dataset.view));
    });
    [elements.room, elements.rack, elements.cage].forEach((input) => {
      input.addEventListener("input", updateHeaderLocation);
    });
  }

  function submitOnEnter(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      unlock();
    }
  }

  async function unlock() {
    const password = elements.password.value;
    const meta = readMeta();
    elements.lockError.textContent = "";
    elements.unlockButton.disabled = true;
    try {
      if (!meta) {
        if (password.length < 4) {
          throw new Error("存储密码至少需要 4 个字符");
        }
        if (password !== elements.confirmPassword.value) {
          throw new Error("两次输入的密码不一致");
        }
        state.salt = crypto.getRandomValues(new Uint8Array(16));
        state.key = await deriveKey(password, state.salt);
        state.records = [];
        await persistRecords();
      } else {
        state.salt = base64ToBytes(meta.salt);
        state.key = await deriveKey(password, state.salt);
        state.records = await decryptRecords(meta);
      }
      elements.password.value = "";
      elements.confirmPassword.value = "";
      elements.lockView.classList.add("hidden");
      elements.appView.classList.remove("hidden");
      resetForm(true);
      renderRecords();
    } catch (error) {
      state.key = null;
      state.records = [];
      elements.lockError.textContent = meta ? "密码错误或存储数据已损坏" : error.message;
    } finally {
      elements.unlockButton.disabled = false;
    }
  }

  function lock() {
    state.key = null;
    state.salt = null;
    state.records = [];
    state.editingId = null;
    clearPhoto();
    elements.appView.classList.add("hidden");
    elements.lockView.classList.remove("hidden");
    elements.password.value = "";
    elements.lockError.textContent = "";
    configureLockView();
    elements.password.focus();
  }

  async function saveRecord(event) {
    event.preventDefault();
    const values = readForm();
    const missing = Object.entries(values).filter(([, value]) => !value).map(([key]) => key);
    markInvalidFields(missing);
    if (missing.length) {
      elements.formError.textContent = "请完整填写笼位和笼卡内容";
      return;
    }
    elements.formError.textContent = "";
    const now = new Date().toISOString();
    const existing = state.editingId
      ? state.records.find((record) => record.id === state.editingId)
      : null;
    const record = {
      id: existing ? existing.id : createId(),
      ...values,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };
    const nextRecords = existing
      ? state.records.map((item) => item.id === existing.id ? record : item)
      : [record, ...state.records];
    const previous = state.records;
    state.records = nextRecords;
    try {
      await persistRecords();
      renderRecords();
      resetForm(false);
      showView("records");
      showToast(existing ? "笼卡已更新" : "笼卡已保存");
    } catch (error) {
      state.records = previous;
      elements.formError.textContent = error.message;
    }
  }

  function readForm() {
    return {
      room: clean(elements.room.value),
      rack: clean(elements.rack.value),
      cage: clean(elements.cage.value),
      sampleNumber: clean(elements.sampleNumber.value),
      sampleName: clean(elements.sampleName.value),
      animalNumber: clean(elements.animalNumber.value)
    };
  }

  function markInvalidFields(missing) {
    const mapping = {
      room: elements.room,
      rack: elements.rack,
      cage: elements.cage,
      sampleNumber: elements.sampleNumber,
      sampleName: elements.sampleName,
      animalNumber: elements.animalNumber
    };
    Object.entries(mapping).forEach(([key, field]) => {
      field.classList.toggle("invalid", missing.includes(key));
      if (!field.dataset.validationBound) {
        field.dataset.validationBound = "1";
        field.addEventListener("input", () => field.classList.remove("invalid"));
      }
    });
  }

  function resetForm(useQueryLocation) {
    state.editingId = null;
    elements.entryTitle.textContent = "新建笼卡";
    elements.saveButton.textContent = "保存笼卡";
    elements.sampleNumber.value = "";
    elements.sampleName.value = "";
    elements.animalNumber.value = "";
    const location = useQueryLocation ? state.queryLocation : readCurrentLocation();
    applyLocation(location);
    elements.formError.textContent = "";
    document.querySelectorAll("#entry-form .invalid").forEach((field) => field.classList.remove("invalid"));
    clearPhoto();
  }

  function editRecord(id) {
    const record = state.records.find((item) => item.id === id);
    if (!record) {
      return;
    }
    state.editingId = id;
    elements.entryTitle.textContent = "修改笼卡";
    elements.saveButton.textContent = "保存修改";
    elements.room.value = record.room;
    elements.rack.value = record.rack;
    elements.cage.value = record.cage;
    elements.sampleNumber.value = record.sampleNumber;
    elements.sampleName.value = record.sampleName;
    elements.animalNumber.value = record.animalNumber;
    elements.formError.textContent = "";
    updateHeaderLocation();
    showView("entry");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function deleteRecord(id) {
    const previous = state.records;
    state.records = state.records.filter((record) => record.id !== id);
    try {
      await persistRecords();
      renderRecords();
      showToast("笼卡已删除");
    } catch (error) {
      state.records = previous;
      showToast(error.message);
    }
  }

  function handleRecordAction(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const id = button.dataset.id;
    if (button.dataset.action === "edit") {
      editRecord(id);
      return;
    }
    if (state.deleteCandidate !== id) {
      window.clearTimeout(state.deleteTimer);
      state.deleteCandidate = id;
      button.textContent = "确认删除";
      button.classList.add("confirming");
      state.deleteTimer = window.setTimeout(() => {
        state.deleteCandidate = "";
        renderRecords();
      }, 3500);
      return;
    }
    state.deleteCandidate = "";
    window.clearTimeout(state.deleteTimer);
    deleteRecord(id);
  }

  function renderRecords() {
    const query = clean(elements.recordSearch.value).toLowerCase();
    const records = state.records
      .filter((record) => !query || searchableRecord(record).includes(query))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    elements.recordCount.textContent = String(state.records.length);
    elements.emptyRecords.classList.toggle("hidden", records.length > 0);
    elements.emptyRecords.textContent = state.records.length && !records.length ? "没有匹配的笼卡" : "暂无笼卡";
    elements.recordList.replaceChildren(...records.map(recordElement));
  }

  function recordElement(record) {
    const article = document.createElement("article");
    article.className = "record-card";
    const head = document.createElement("div");
    head.className = "record-card-head";
    head.append(textElement("div", record.animalNumber, "animal-number"));
    head.append(textElement("span", locationText(record), "location-code"));

    const detail = document.createElement("dl");
    detail.className = "record-detail";
    appendDetail(detail, "样品编号", record.sampleNumber);
    appendDetail(detail, "样品名称", record.sampleName);
    appendDetail(detail, "更新时间", formatTime(record.updatedAt));

    const actions = document.createElement("div");
    actions.className = "record-actions";
    actions.append(actionButton("修改", "edit", record.id));
    const deleting = state.deleteCandidate === record.id;
    const deleteButton = actionButton(deleting ? "确认删除" : "删除", "delete", record.id);
    deleteButton.classList.add("delete");
    deleteButton.classList.toggle("confirming", deleting);
    actions.append(deleteButton);
    article.append(head, detail, actions);
    return article;
  }

  function actionButton(label, action, id) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.action = action;
    button.dataset.id = id;
    return button;
  }

  function appendDetail(list, label, value) {
    list.append(textElement("dt", label), textElement("dd", value));
  }

  function textElement(tag, value, className) {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) {
      element.className = className;
    }
    return element;
  }

  function searchableRecord(record) {
    return [record.animalNumber, record.sampleNumber, record.sampleName,
      record.room, record.rack, record.cage].join(" ").toLowerCase();
  }

  function showView(name) {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.view === name);
    });
    byId("entry-view").classList.toggle("active", name === "entry");
    byId("records-view").classList.toggle("active", name === "records");
    if (name === "records") {
      renderRecords();
    }
  }

  function previewPhoto() {
    const file = elements.photoInput.files && elements.photoInput.files[0];
    if (!file) {
      clearPhoto();
      return;
    }
    clearPhotoUrl();
    state.photoUrl = URL.createObjectURL(file);
    elements.photoPreview.src = state.photoUrl;
    elements.photoPreviewWrap.classList.remove("hidden");
    elements.removePhotoButton.classList.remove("hidden");
    elements.ocrButton.disabled = false;
    resetOcrPanel();
  }

  function clearPhoto() {
    clearPhotoUrl();
    elements.photoInput.value = "";
    elements.photoPreview.removeAttribute("src");
    elements.photoPreviewWrap.classList.add("hidden");
    elements.removePhotoButton.classList.add("hidden");
    elements.ocrButton.disabled = true;
    resetOcrPanel();
  }

  async function runLocalOcr() {
    const file = elements.photoInput.files && elements.photoInput.files[0];
    if (!file || state.ocrRunning) {
      return;
    }
    state.ocrRunning = true;
    elements.ocrButton.disabled = true;
    elements.ocrButton.textContent = "识别中...";
    elements.ocrPanel.classList.remove("hidden");
    elements.ocrDetails.classList.add("hidden");
    elements.ocrProgress.removeAttribute("value");
    elements.ocrStatus.textContent = "加载模型";
    try {
      const module = await import("./ocr/cage-card-ocr.mjs");
      const result = await module.runCageCardOcr(file, (message) => {
        elements.ocrStatus.textContent = message;
      });
      applyOcrValue(elements.sampleNumber, result.sampleNumber,
        (value) => /^[A-Za-z]\d{5,}-\d{4,}$/.test(value));
      applyOcrValue(elements.sampleName, result.sampleName,
        (value) => (value.match(/[\u3400-\u9fff]/g) || []).length >= 2);
      applyOcrValue(elements.animalNumber, result.animalNumber,
        (value) => /^\d{4,5}$/.test(value));
      const filled = [result.sampleNumber, result.sampleName, result.animalNumber]
        .filter(Boolean).length;
      elements.ocrStatus.textContent = `${filled}/3 项 · ${(result.timing.total / 1000).toFixed(1)} 秒`;
      elements.ocrProgress.value = 1;
      elements.ocrRawText.textContent = result.rawText || "未识别到文字";
      elements.ocrDetails.classList.remove("hidden");
      showToast(filled ? "本地 OCR 已回填" : "未识别到笼卡字段");
    } catch (error) {
      elements.ocrProgress.value = 0;
      elements.ocrStatus.textContent = "识别失败";
      elements.ocrRawText.textContent = error && error.message ? error.message : String(error);
      elements.ocrDetails.classList.remove("hidden");
      showToast("本地 OCR 失败");
    } finally {
      state.ocrRunning = false;
      elements.ocrButton.disabled = false;
      elements.ocrButton.textContent = "再次 OCR";
    }
  }

  function applyOcrValue(field, value, isValid) {
    if (!value) {
      return;
    }
    const current = clean(field.value);
    if (!current || !isValid(current)) {
      field.value = value;
      field.classList.remove("invalid");
    }
  }

  function resetOcrPanel() {
    state.ocrRunning = false;
    elements.ocrButton.textContent = "本地 OCR";
    elements.ocrPanel.classList.add("hidden");
    elements.ocrProgress.value = 0;
    elements.ocrStatus.textContent = "等待识别";
    elements.ocrRawText.textContent = "";
    elements.ocrDetails.classList.add("hidden");
  }

  function clearPhotoUrl() {
    if (state.photoUrl) {
      URL.revokeObjectURL(state.photoUrl);
      state.photoUrl = "";
    }
  }

  function applyLocation(location) {
    elements.room.value = location.room || "";
    elements.rack.value = location.rack || "";
    elements.cage.value = location.cage || "";
    updateHeaderLocation();
  }

  function readCurrentLocation() {
    return {
      room: clean(elements.room.value),
      rack: clean(elements.rack.value),
      cage: clean(elements.cage.value)
    };
  }

  function updateHeaderLocation() {
    const location = readCurrentLocation();
    elements.headerLocation.textContent = location.room && location.rack && location.cage
      ? locationText(location)
      : "未选择笼位";
  }

  function locationText(value) {
    return `${value.room || "-"} - ${value.rack || "-"} - ${value.cage || "-"}`;
  }

  function readQueryLocation() {
    const query = new URLSearchParams(window.location.search);
    return {
      room: clean(query.get("room") || query.get("r") || ""),
      rack: clean(query.get("rack") || query.get("k") || ""),
      cage: clean(query.get("cage") || query.get("c") || "")
    };
  }

  async function deriveKey(password, salt) {
    const material = await crypto.subtle.importKey(
      "raw", textEncoder.encode(password), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey({
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async function persistRecords() {
    if (!state.key || !state.salt) {
      throw new Error("加密存储尚未解锁");
    }
    const payload = JSON.stringify({ version: 1, records: state.records });
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, state.key, textEncoder.encode(payload)
    ));
    const envelope = `${bytesToBase64(iv)}.${bytesToBase64(encrypted)}`;
    const chunks = chunkString(envelope, COOKIE_CHUNK_SIZE);
    if (chunks.length > MAX_COOKIE_CHUNKS) {
      throw new Error("笼卡数据已超过 Cookie 容量，请删除部分记录");
    }
    const previousMeta = readMeta();
    chunks.forEach((chunk, index) => setCookie(`${DATA_COOKIE_PREFIX}${index}`, chunk));
    const previousCount = previousMeta ? previousMeta.count : 0;
    for (let index = chunks.length; index < previousCount; index += 1) {
      deleteCookie(`${DATA_COOKIE_PREFIX}${index}`);
    }
    const meta = { version: 1, salt: bytesToBase64(state.salt), count: chunks.length };
    setCookie(META_COOKIE, encodeURIComponent(JSON.stringify(meta)));
    const storedMeta = readMeta();
    if (!storedMeta || storedMeta.count !== chunks.length || readEnvelope(storedMeta) !== envelope) {
      throw new Error("浏览器拒绝了 Cookie 存储");
    }
    elements.storageSize.textContent = formatBytes(envelope.length);
  }

  async function decryptRecords(meta) {
    const envelope = readEnvelope(meta);
    const separator = envelope.indexOf(".");
    if (separator < 1) {
      throw new Error("加密数据格式错误");
    }
    const iv = base64ToBytes(envelope.slice(0, separator));
    const encrypted = base64ToBytes(envelope.slice(separator + 1));
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, state.key, encrypted);
    const parsed = JSON.parse(textDecoder.decode(decrypted));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
      throw new Error("存储数据版本不受支持");
    }
    elements.storageSize.textContent = formatBytes(envelope.length);
    return parsed.records.map(normalizeRecord).filter(Boolean);
  }

  function normalizeRecord(record) {
    if (!record || typeof record !== "object" || !record.id) {
      return null;
    }
    return {
      id: String(record.id),
      room: clean(record.room),
      rack: clean(record.rack),
      cage: clean(record.cage),
      sampleNumber: clean(record.sampleNumber),
      sampleName: clean(record.sampleName),
      animalNumber: clean(record.animalNumber),
      createdAt: clean(record.createdAt) || new Date().toISOString(),
      updatedAt: clean(record.updatedAt) || new Date().toISOString()
    };
  }

  function readMeta() {
    const value = readCookie(META_COOKIE);
    if (!value) {
      return null;
    }
    try {
      const meta = JSON.parse(decodeURIComponent(value));
      if (meta.version !== 1 || !meta.salt || !Number.isInteger(meta.count)
          || meta.count < 1 || meta.count > MAX_COOKIE_CHUNKS) {
        return null;
      }
      return meta;
    } catch (_) {
      return null;
    }
  }

  function readEnvelope(meta) {
    let value = "";
    for (let index = 0; index < meta.count; index += 1) {
      const chunk = readCookie(`${DATA_COOKIE_PREFIX}${index}`);
      if (!chunk) {
        throw new Error("加密数据不完整");
      }
      value += chunk;
    }
    return value;
  }

  function setCookie(name, value) {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${name}=${value}; Path=${cookiePath()}; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
  }

  function deleteCookie(name) {
    document.cookie = `${name}=; Path=${cookiePath()}; Max-Age=0; SameSite=Lax`;
  }

  function readCookie(name) {
    const prefix = `${name}=`;
    const item = document.cookie.split("; ").find((part) => part.startsWith(prefix));
    return item ? item.slice(prefix.length) : "";
  }

  function cookiePath() {
    const path = location.pathname.endsWith("/")
      ? location.pathname
      : location.pathname.slice(0, location.pathname.lastIndexOf("/") + 1);
    return path || "/";
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

  function chunkString(value, size) {
    const chunks = [];
    for (let offset = 0; offset < value.length; offset += size) {
      chunks.push(value.slice(offset, offset + size));
    }
    return chunks;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  function formatTime(value) {
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"
      }).format(new Date(value));
    } catch (_) {
      return value;
    }
  }

  function createId() {
    if (crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${bytesToBase64(crypto.getRandomValues(new Uint8Array(12)))}`;
  }

  function clean(value) {
    return value == null ? "" : String(value).trim();
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
})();
