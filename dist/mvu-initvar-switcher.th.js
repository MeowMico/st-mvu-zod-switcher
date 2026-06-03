// MVU InitVar Switcher - Tavern Helper character script

"use strict";
(() => {
  // src/tavern-helper/core.ts
  var MODULE_NAME = "mvu_initvar_switcher_th";
  var DISPLAY_NAME = "MVU InitVar Switcher";
  var PRESET_COMMENT_PATTERN = /\[MVU_INIT_PRESET\s*[:#]\s*([^\]\s]+)\s*\]/i;
  var MAP_COMMENT_PATTERN = /\[MVU_INIT_MAP\]/i;
  var INLINE_PRESET_PATTERNS = [
    /<mvu-init-preset>\s*([^<\s]+)\s*<\/mvu-init-preset>/i,
    /<!--\s*mvu-init-preset\s*[:#]\s*([^\s-]+)\s*-->/i
  ];
  var EXTENSIBLE_MARKER = "$__META_EXTENSIBLE__$";
  var defaultSettings = Object.freeze({
    enabled: true,
    autoApplyOnNewChat: true,
    applyMode: "replace",
    presetSource: "active",
    allowAfterChatStarted: false,
    showToasts: true
  });
  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function isValueWithDescription(value) {
    return Array.isArray(value) && value.length === 2 && typeof value[1] === "string" && value[1] !== EXTENSIBLE_MARKER;
  }
  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }
  function deepClone(value) {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  }
  function mergeDeep(target, source) {
    if (!isPlainObject(target) || !isPlainObject(source)) {
      return deepClone(source);
    }
    const result = deepClone(target);
    for (const [key, value] of Object.entries(source)) {
      if (isPlainObject(value) && isPlainObject(result[key])) {
        result[key] = mergeDeep(result[key], value);
      } else {
        result[key] = deepClone(value);
      }
    }
    return result;
  }
  function hashString(value) {
    let hash = 5381;
    const text = String(value ?? "");
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash << 5) + hash ^ text.charCodeAt(index);
    }
    return (hash >>> 0).toString(36);
  }
  function stripCodeFence(content) {
    const trimmed = String(content ?? "").trim();
    const codeblockMatch = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/m);
    return codeblockMatch ? codeblockMatch[1].trim() : trimmed;
  }
  function stripInitvarWrapper(content) {
    const trimmed = stripCodeFence(content);
    const initvarMatch = trimmed.match(/<initvar>\s*(?:```[^\n]*\n)?([\s\S]*?)(?:\n```)?\s*<\/initvar>/i);
    return initvarMatch ? initvarMatch[1].trim() : trimmed;
  }
  function parseData(content, parseYaml) {
    const body = stripInitvarWrapper(content);
    if (!body) {
      throw new Error("Preset content is empty.");
    }
    try {
      return JSON.parse(body);
    } catch (_jsonError) {
      if (!parseYaml) {
        throw new Error("Preset is not valid JSON, and no YAML parser is available.");
      }
      return parseYaml(body);
    }
  }
  function normalizePresetData(parsed) {
    if (!isPlainObject(parsed)) {
      throw new Error("Preset must parse to an object.");
    }
    if (isPlainObject(parsed.stat_data) || isPlainObject(parsed.schema)) {
      return deepClone(parsed);
    }
    return { stat_data: deepClone(parsed) };
  }
  function buildSchemaNode(value) {
    if (isValueWithDescription(value)) {
      return buildSchemaNode(value[0]);
    }
    if (Array.isArray(value)) {
      const dataItems = value.filter((item) => item !== EXTENSIBLE_MARKER);
      const metaItem = dataItems.find((item) => isPlainObject(item) && item.$arrayMeta === true && isPlainObject(item.$meta));
      const meta = isPlainObject(metaItem) && isPlainObject(metaItem.$meta) ? metaItem.$meta : {};
      const schemaItems = dataItems.filter((item) => !(isPlainObject(item) && item.$arrayMeta === true && hasOwn(item, "$meta")));
      return {
        type: "array",
        extensible: value.includes(EXTENSIBLE_MARKER) || meta.extensible === true || meta.recursiveExtensible === true,
        recursiveExtensible: meta.recursiveExtensible === true,
        elementType: schemaItems.length ? buildSchemaNode(schemaItems[0]) : { type: "any" }
      };
    }
    if (isPlainObject(value)) {
      const meta = isPlainObject(value.$meta) ? value.$meta : {};
      const extensible = meta.extensible === true || meta.recursiveExtensible === true;
      const recursiveExtensible = meta.recursiveExtensible === true;
      const schema = {
        type: "object",
        properties: {},
        extensible,
        recursiveExtensible
      };
      const properties = schema.properties;
      for (const [key, childValue] of Object.entries(value)) {
        if (key === "$meta") {
          continue;
        }
        properties[key] = {
          ...buildSchemaNode(childValue),
          required: !extensible || Array.isArray(meta.required) && meta.required.includes(key)
        };
      }
      return schema;
    }
    const valueType = typeof value;
    if (valueType === "string" || valueType === "number" || valueType === "boolean") {
      return { type: valueType };
    }
    return { type: "any" };
  }
  function cleanMetadata(value) {
    if (isValueWithDescription(value)) {
      return [cleanMetadata(value[0]), value[1]];
    }
    if (Array.isArray(value)) {
      return value.filter((item) => item !== EXTENSIBLE_MARKER).filter((item) => !(isPlainObject(item) && item.$arrayMeta === true && hasOwn(item, "$meta"))).map(cleanMetadata);
    }
    if (isPlainObject(value)) {
      const result = {};
      for (const [key, childValue] of Object.entries(value)) {
        if (key !== "$meta") {
          result[key] = cleanMetadata(childValue);
        }
      }
      return result;
    }
    return value;
  }
  function createEmptyMvuData() {
    return {
      display_data: {},
      initialized_lorebooks: {},
      stat_data: {},
      delta_data: {},
      schema: {
        type: "object",
        properties: {}
      }
    };
  }
  function buildNextMvuData(currentData, presetData, applyMode) {
    const base = isPlainObject(currentData) ? deepClone(currentData) : createEmptyMvuData();
    const normalizedPreset = normalizePresetData(presetData);
    const rawPresetStatData = normalizedPreset.stat_data ?? {};
    const presetStatData = cleanMetadata(rawPresetStatData);
    if (applyMode === "merge") {
      base.stat_data = mergeDeep(base.stat_data ?? {}, presetStatData);
      if (isPlainObject(normalizedPreset.schema)) {
        base.schema = mergeDeep(base.schema ?? {}, normalizedPreset.schema);
      }
    } else {
      base.stat_data = deepClone(presetStatData);
      base.display_data = isPlainObject(normalizedPreset.display_data) ? deepClone(normalizedPreset.display_data) : {};
      base.delta_data = isPlainObject(normalizedPreset.delta_data) ? deepClone(normalizedPreset.delta_data) : {};
      if (isPlainObject(normalizedPreset.schema)) {
        base.schema = deepClone(normalizedPreset.schema);
      } else {
        base.schema = buildSchemaNode(rawPresetStatData);
        if (isPlainObject(rawPresetStatData) && isPlainObject(rawPresetStatData.$meta)) {
          for (const key of ["strictTemplate", "strictSet", "concatTemplateArray"]) {
            if (hasOwn(rawPresetStatData.$meta, key)) {
              base.schema[key] = rawPresetStatData.$meta[key];
            }
          }
        }
      }
    }
    if (!isPlainObject(base.initialized_lorebooks)) {
      base.initialized_lorebooks = {};
    }
    if (!isPlainObject(base.display_data)) {
      base.display_data = {};
    }
    if (!isPlainObject(base.delta_data)) {
      base.delta_data = {};
    }
    if (!isPlainObject(base.schema)) {
      base.schema = { type: "object", properties: {} };
    }
    return base;
  }
  function getPresetIdFromOpening(text) {
    const openingText = String(text ?? "");
    for (const pattern of INLINE_PRESET_PATTERNS) {
      const match = openingText.match(pattern);
      if (match?.[1]?.trim()) {
        return match[1].trim();
      }
    }
    return null;
  }
  function getCurrentPresetId(opening, mapData = null) {
    const inlineId = getPresetIdFromOpening(opening.text);
    if (inlineId) {
      return inlineId;
    }
    if (isPlainObject(mapData)) {
      const mapped = mapData[String(opening.swipeIndex)] ?? mapData[opening.swipeIndex];
      if (typeof mapped === "string" || typeof mapped === "number") {
        return String(mapped);
      }
    }
    return String(opening.swipeIndex);
  }
  function getEntryComment(entry) {
    if (!isPlainObject(entry)) {
      return "";
    }
    const key = entry.key;
    if (Array.isArray(key)) {
      return String(key.join(", "));
    }
    return String(entry.comment ?? entry.name ?? "");
  }
  function collectPresetEntriesFromWorld(worldName, entries, presets, maps) {
    for (const entry of entries) {
      if (!isPlainObject(entry)) {
        continue;
      }
      const comment = getEntryComment(entry);
      const presetMatch = comment.match(PRESET_COMMENT_PATTERN);
      if (presetMatch) {
        presets.push({
          id: presetMatch[1].trim(),
          worldName,
          comment,
          content: String(entry.content ?? "")
        });
        continue;
      }
      if (MAP_COMMENT_PATTERN.test(comment)) {
        maps.push({
          worldName,
          comment,
          content: String(entry.content ?? "")
        });
      }
    }
  }
  function parseFirstMap(maps, parseYaml) {
    for (const mapEntry of maps) {
      try {
        const parsed = parseData(mapEntry.content, parseYaml);
        if (isPlainObject(parsed)) {
          return parsed;
        }
      } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Failed to parse init map '${mapEntry.comment}'`, error);
      }
    }
    return null;
  }
  function getPresetFingerprint(preset, applyMode) {
    return hashString(JSON.stringify({
      content: preset.content ?? "",
      applyMode
    }));
  }

  // src/tavern-helper/index.ts
  var root = globalThis;
  var BUTTONS = [
    { name: "\u626B\u63CF\u5F53\u524D\u9884\u8BBE", visible: true },
    { name: "\u624B\u52A8\u5E94\u7528\u5F53\u524D\u9884\u8BBE", visible: true },
    { name: "\u6E05\u9664\u5DF2\u5E94\u7528\u8BB0\u5F55", visible: true }
  ];
  var didInit = false;
  var lastAutoApplyTimer;
  function getContext() {
    return root.SillyTavern?.getContext?.() ?? {};
  }
  function getScriptData() {
    if (!isPlainObject(root[MODULE_NAME])) {
      root[MODULE_NAME] = {};
    }
    return root[MODULE_NAME];
  }
  function getSettings() {
    const data = getScriptData();
    if (!isPlainObject(data.settings)) {
      data.settings = {};
    }
    const settings = data.settings;
    for (const [key, value] of Object.entries(defaultSettings)) {
      if (!hasOwn(settings, key)) {
        settings[key] = value;
      }
    }
    settings.applyMode = settings.applyMode === "merge" ? "merge" : "replace";
    settings.presetSource = settings.presetSource === "all" ? "all" : "active";
    return settings;
  }
  function showToast(type, message) {
    if (!getSettings().showToasts) {
      return;
    }
    const toastrApi = root.toastr;
    const toast = toastrApi?.[type];
    if (typeof toast === "function") {
      toast(message, DISPLAY_NAME);
    }
  }
  function updateStatus(message, type = "info") {
    console.info(`[${DISPLAY_NAME}] ${message}`);
    const state = getChatState();
    if (state) {
      state.lastStatus = {
        message,
        type,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      void saveChatState();
    }
  }
  function logError(message, error) {
    console.error(`[${DISPLAY_NAME}] ${message}`, error);
    showToast("error", `${message}: ${error instanceof Error ? error.message : String(error)}`);
  }
  function getCurrentOpeningMessage() {
    if (typeof getChatMessages === "function") {
      const messages = getChatMessages(0, { include_swipes: true });
      return Array.isArray(messages) ? messages[0] ?? null : null;
    }
    const chat = getContext().chat ?? root.SillyTavern?.chat;
    if (!Array.isArray(chat) || chat.length === 0) {
      return null;
    }
    return chat[0] ?? null;
  }
  function getCurrentSwipeIndex() {
    const opening = getCurrentOpeningMessage();
    const swipeId = Number(opening?.swipe_id ?? 0);
    return Number.isSafeInteger(swipeId) && swipeId >= 0 ? swipeId : 0;
  }
  function getCurrentOpeningText() {
    const opening = getCurrentOpeningMessage();
    const swipeIndex = getCurrentSwipeIndex();
    if (Array.isArray(opening?.swipes) && opening.swipes[swipeIndex]) {
      return String(opening.swipes[swipeIndex]);
    }
    return String(opening?.message ?? opening?.mes ?? "");
  }
  function getCurrentChatKey() {
    const context = getContext();
    return context.getCurrentChatId?.() ?? context.chatId ?? "unknown-chat";
  }
  function getChatMetadata() {
    const context = getContext();
    if (isPlainObject(context.chatMetadata)) {
      return context.chatMetadata;
    }
    return null;
  }
  function getChatState() {
    const metadata = getChatMetadata();
    if (!metadata) {
      return null;
    }
    if (!isPlainObject(metadata[MODULE_NAME])) {
      metadata[MODULE_NAME] = {};
    }
    return metadata[MODULE_NAME];
  }
  async function saveChatState() {
    const context = getContext();
    if (typeof context.saveMetadata === "function") {
      await context.saveMetadata();
    } else if (typeof context.saveMetadataDebounced === "function") {
      context.saveMetadataDebounced();
    }
  }
  function hasChatStarted() {
    const contextChat = getContext().chat ?? root.SillyTavern?.chat;
    if (Array.isArray(contextChat)) {
      return contextChat.length > 1;
    }
    try {
      return typeof getChatMessages === "function" && getChatMessages("0-{{lastMessageId}}").length > 1;
    } catch (_error) {
      return false;
    }
  }
  function getYamlParser() {
    const contextYaml = getContext().libs?.yaml;
    if (typeof contextYaml?.parse === "function") {
      return contextYaml.parse.bind(contextYaml);
    }
    const yaml = root.SillyTavern?.libs?.yaml;
    if (typeof yaml?.parse === "function") {
      return yaml.parse.bind(yaml);
    }
    return void 0;
  }
  async function waitForMvuApi(timeoutMs = 15e3) {
    if (root.Mvu?.getMvuData && root.Mvu?.replaceMvuData) {
      return true;
    }
    if (typeof waitGlobalInitialized === "function") {
      try {
        await Promise.race([
          waitGlobalInitialized("Mvu"),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))
        ]);
      } catch (_error) {
      }
    }
    if (root.Mvu?.getMvuData && root.Mvu?.replaceMvuData) {
      return true;
    }
    await new Promise((resolve) => {
      const startedAt = Date.now();
      const interval = setInterval(() => {
        const isReady = root.Mvu?.getMvuData && root.Mvu?.replaceMvuData;
        if (isReady || Date.now() - startedAt >= timeoutMs) {
          clearInterval(interval);
          resolve(void 0);
        }
      }, 100);
    });
    return !!(root.Mvu?.getMvuData && root.Mvu?.replaceMvuData);
  }
  function getOpeningMvuData() {
    return root.Mvu?.getMvuData?.({ type: "message", message_id: 0 }) ?? createEmptyMvuData();
  }
  async function replaceOpeningMvuData(nextData) {
    if (!root.Mvu?.replaceMvuData) {
      throw new Error("MVU global API was not found. Make sure MVU is installed and enabled.");
    }
    await root.Mvu.replaceMvuData(nextData, { type: "message", message_id: 0 });
    const opening = getCurrentOpeningMessage();
    const swipeIndex = getCurrentSwipeIndex();
    if (opening && Array.isArray(opening.swipes_data)) {
      opening.swipes_data[swipeIndex] = deepClone(nextData);
      if (typeof setChatMessages === "function") {
        await setChatMessages([{ message_id: 0, swipes_data: opening.swipes_data }], { refresh: "none" });
      }
    }
    const context = getContext();
    if (typeof context.saveChat === "function") {
      await context.saveChat();
    }
    const eventType = root.Mvu?.events?.VARIABLE_INITIALIZED;
    if (eventType && typeof eventEmit === "function") {
      await eventEmit(eventType, nextData, swipeIndex);
    }
  }
  async function getWorldbookEntries(worldName) {
    if (typeof getWorldbook !== "function") {
      return [];
    }
    const entries = await getWorldbook(worldName);
    return Array.isArray(entries) ? entries : [];
  }
  function addWorldName(names, value) {
    if (!value) {
      return;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        names.add(trimmed);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        addWorldName(names, item);
      }
    }
  }
  function getActiveWorldNames() {
    const settings = getSettings();
    const names = /* @__PURE__ */ new Set();
    if (typeof getCharWorldbookNames === "function") {
      try {
        const charWorlds = getCharWorldbookNames("current");
        addWorldName(names, charWorlds?.primary);
        addWorldName(names, charWorlds?.additional);
      } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Failed to read character worldbooks`, error);
      }
    }
    if (typeof getGlobalWorldbookNames === "function") {
      try {
        addWorldName(names, getGlobalWorldbookNames());
      } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Failed to read global worldbooks`, error);
      }
    }
    if (settings.presetSource === "all" && typeof getWorldbookNames === "function") {
      try {
        addWorldName(names, getWorldbookNames());
      } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Failed to read all worldbook names`, error);
      }
    }
    return [...names];
  }
  async function loadPresetEntries() {
    const worldNames = getActiveWorldNames();
    const presets = [];
    const maps = [];
    if (!worldNames.length) {
      return { presets, maps, worldNames };
    }
    for (const worldName of worldNames) {
      try {
        const entries = await getWorldbookEntries(worldName);
        collectPresetEntriesFromWorld(worldName, entries, presets, maps);
      } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Failed to load worldbook '${worldName}'`, error);
      }
    }
    return { presets, maps, worldNames };
  }
  async function resolveCurrentPreset() {
    const { presets, maps, worldNames } = await loadPresetEntries();
    const opening = {
      swipeIndex: getCurrentSwipeIndex(),
      text: getCurrentOpeningText()
    };
    const mapData = parseFirstMap(maps, getYamlParser());
    const presetId = getCurrentPresetId(opening, mapData);
    const preset = presets.find((entry) => entry.id === presetId);
    return {
      presetId,
      preset,
      presets,
      maps,
      worldNames,
      swipeIndex: opening.swipeIndex,
      inlineId: getPresetIdFromOpening(opening.text)
    };
  }
  function isPresetAlreadyApplied(presetId, fingerprint) {
    const state = getChatState();
    const swipeIndex = getCurrentSwipeIndex();
    const applied = state?.applied?.[String(swipeIndex)];
    return applied?.presetId === presetId && applied?.fingerprint === fingerprint;
  }
  async function markApplied(presetId, preset, applyMode, fingerprint) {
    const state = getChatState();
    if (!state) {
      return;
    }
    if (!isPlainObject(state.applied)) {
      state.applied = {};
    }
    state.applied[String(getCurrentSwipeIndex())] = {
      presetId,
      worldName: preset.worldName,
      comment: preset.comment,
      applyMode,
      fingerprint,
      chatKey: getCurrentChatKey(),
      appliedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await saveChatState();
  }
  async function applyCurrentPreset({ force = false } = {}) {
    const settings = getSettings();
    if (!settings.enabled && !force) {
      return { ok: false, reason: "disabled" };
    }
    if (hasChatStarted() && !settings.allowAfterChatStarted && !force) {
      const message2 = "\u804A\u5929\u5DF2\u7ECF\u5F00\u59CB\uFF0C\u81EA\u52A8\u5E94\u7528\u5DF2\u8DF3\u8FC7\uFF1B\u9700\u8981\u8986\u76D6\u7B2C 0 \u697C\u53D8\u91CF\u65F6\u8BF7\u70B9\u201C\u624B\u52A8\u5E94\u7528\u5F53\u524D\u9884\u8BBE\u201D\u3002";
      updateStatus(message2, "warn");
      return { ok: false, reason: "chat-started" };
    }
    if (!await waitForMvuApi()) {
      const message2 = "\u672A\u627E\u5230 MVU/MagVarUpdate\u3002\u8BF7\u5148\u542F\u7528 MVU \u53D8\u91CF\u6846\u67B6\u811A\u672C\u3002";
      updateStatus(message2, "warn");
      showToast("warning", message2);
      return { ok: false, reason: "mvu-not-ready" };
    }
    const resolved = await resolveCurrentPreset();
    if (!resolved.preset) {
      const message2 = `\u672A\u627E\u5230\u9884\u8BBE '${resolved.presetId}'\u3002\u5DF2\u8BFB\u53D6\u4E16\u754C\u4E66\uFF1A${resolved.worldNames.join(", ") || "\u65E0"}\u3002`;
      updateStatus(message2, "warn");
      return { ok: false, reason: "not-found", resolved };
    }
    const fingerprint = getPresetFingerprint(resolved.preset, settings.applyMode);
    if (!force && isPresetAlreadyApplied(resolved.presetId, fingerprint)) {
      const message2 = `\u9884\u8BBE '${resolved.presetId}' \u5DF2\u5E94\u7528\u5230\u5F00\u573A #${resolved.swipeIndex}\u3002`;
      updateStatus(message2, "ok");
      return { ok: true, skipped: true, resolved };
    }
    const parsed = parseData(resolved.preset.content, getYamlParser());
    const currentData = getOpeningMvuData();
    const nextData = buildNextMvuData(currentData, parsed, settings.applyMode);
    await replaceOpeningMvuData(nextData);
    await markApplied(resolved.presetId, resolved.preset, settings.applyMode, fingerprint);
    const message = `\u5DF2\u5E94\u7528 '${resolved.presetId}'\uFF08${resolved.preset.worldName}\uFF0C${settings.applyMode}\uFF09\u3002`;
    updateStatus(message, "ok");
    showToast("success", message);
    return { ok: true, resolved };
  }
  async function autoApplyCurrentPreset() {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoApplyOnNewChat) {
      return;
    }
    try {
      await applyCurrentPreset({ force: false });
    } catch (error) {
      logError("Auto apply failed", error);
      updateStatus(`\u81EA\u52A8\u5E94\u7528\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
  function queueAutoApply(delayMs = 300) {
    if (lastAutoApplyTimer) {
      clearTimeout(lastAutoApplyTimer);
    }
    lastAutoApplyTimer = setTimeout(() => {
      void autoApplyCurrentPreset();
    }, delayMs);
  }
  async function scanCurrentPreset() {
    try {
      const resolved = await resolveCurrentPreset();
      if (resolved.preset) {
        const source = resolved.inlineId ? "\u5F00\u573A\u6807\u8BB0" : resolved.maps.length ? "\u6620\u5C04/\u5E8F\u53F7" : "swipe \u5E8F\u53F7";
        const message = `\u5F00\u573A #${resolved.swipeIndex} -> '${resolved.presetId}'\uFF0C\u6765\u6E90\uFF1A${resolved.preset.worldName}\uFF08${source}\uFF09\u3002`;
        updateStatus(message, "ok");
        showToast("info", message);
      } else {
        const message = `\u5F00\u573A #${resolved.swipeIndex} -> '${resolved.presetId}'\uFF0C\u4F46\u6CA1\u6709\u627E\u5230\u5BF9\u5E94 [MVU_INIT_PRESET:${resolved.presetId}]\u3002\u5DF2\u8BFB\u53D6\u4E16\u754C\u4E66\uFF1A${resolved.worldNames.join(", ") || "\u65E0"}\u3002`;
        updateStatus(message, "warn");
        showToast("warning", message);
      }
    } catch (error) {
      logError("Preset scan failed", error);
      updateStatus(`\u626B\u63CF\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
  async function clearAppliedRecords() {
    const state = getChatState();
    if (state?.applied) {
      state.applied = {};
      await saveChatState();
    }
    const message = "\u5DF2\u6E05\u9664\u5F53\u524D\u804A\u5929\u7684 initvar \u5E94\u7528\u8BB0\u5F55\u3002";
    updateStatus(message, "ok");
    showToast("success", message);
  }
  function registerButtons() {
    if (typeof appendInexistentScriptButtons === "function") {
      appendInexistentScriptButtons(BUTTONS);
    }
    if (typeof getButtonEvent !== "function" || typeof eventOn !== "function") {
      return;
    }
    eventOn(getButtonEvent("\u626B\u63CF\u5F53\u524D\u9884\u8BBE"), () => {
      void scanCurrentPreset();
    });
    eventOn(getButtonEvent("\u624B\u52A8\u5E94\u7528\u5F53\u524D\u9884\u8BBE"), () => {
      void applyCurrentPreset({ force: true }).catch((error) => logError("Manual apply failed", error));
    });
    eventOn(getButtonEvent("\u6E05\u9664\u5DF2\u5E94\u7528\u8BB0\u5F55"), () => {
      void clearAppliedRecords();
    });
  }
  function registerEvents() {
    if (typeof eventOn === "function" && typeof tavern_events === "object" && tavern_events) {
      for (const eventType of [
        tavern_events.CHAT_CHANGED,
        tavern_events.CHAT_CREATED,
        tavern_events.MESSAGE_SWIPED,
        tavern_events.MESSAGE_UPDATED,
        tavern_events.WORLDINFO_UPDATED
      ]) {
        if (eventType) {
          eventOn(eventType, () => queueAutoApply());
        }
      }
      return;
    }
    const context = getContext();
    const eventSource = context.eventSource;
    const eventTypes = context.eventTypes ?? context.event_types ?? {};
    if (!eventSource?.on) {
      updateStatus("SillyTavern event API is unavailable.", "warn");
      return;
    }
    for (const eventType of [eventTypes.CHAT_CHANGED, eventTypes.CHAT_CREATED, eventTypes.MESSAGE_SWIPED, eventTypes.MESSAGE_UPDATED, eventTypes.WORLDINFO_UPDATED]) {
      if (eventType) {
        eventSource.on(eventType, () => queueAutoApply());
      }
    }
  }
  function renderScriptInfo() {
    if (typeof replaceScriptInfo !== "function") {
      return;
    }
    replaceScriptInfo([
      "MVU InitVar Switcher",
      "",
      "\u542F\u7528\u540E\u4F1A\u6839\u636E\u5F53\u524D\u5F00\u573A\u767D swipe \u81EA\u52A8\u5E94\u7528 [MVU_INIT_PRESET:*] \u521D\u59CB\u53D8\u91CF\u3002",
      "\u9700\u8981\u5148\u542F\u7528 MVU/MagVarUpdate\uFF1B\u672C\u811A\u672C\u4E0D\u4F1A\u81EA\u52A8\u8054\u7F51\u52A0\u8F7D MVU\u3002",
      "",
      "\u6309\u94AE\uFF1A",
      "- \u626B\u63CF\u5F53\u524D\u9884\u8BBE\uFF1A\u68C0\u67E5\u5F53\u524D\u5F00\u573A\u4F1A\u5339\u914D\u54EA\u4E2A\u9884\u8BBE\u3002",
      "- \u624B\u52A8\u5E94\u7528\u5F53\u524D\u9884\u8BBE\uFF1A\u5FFD\u7565\u201C\u804A\u5929\u5DF2\u5F00\u59CB\u201D\u4FDD\u62A4\u5E76\u8986\u76D6\u7B2C 0 \u697C\u53D8\u91CF\u3002",
      "- \u6E05\u9664\u5DF2\u5E94\u7528\u8BB0\u5F55\uFF1A\u8BA9\u540C\u4E00\u804A\u5929\u53EF\u4EE5\u91CD\u65B0\u81EA\u52A8\u5E94\u7528\u76F8\u540C\u9884\u8BBE\u3002"
    ].join("\n"));
  }
  function init() {
    if (didInit) {
      return;
    }
    didInit = true;
    getSettings();
    renderScriptInfo();
    registerButtons();
    registerEvents();
    queueAutoApply(500);
  }
  if (typeof root.$ === "function") {
    root.$(() => init());
  } else {
    init();
  }
  root.MvuInitVarSwitcherTH = {
    applyCurrentPreset,
    scanCurrentPreset,
    clearAppliedRecords,
    resolveCurrentPreset
  };
})();
