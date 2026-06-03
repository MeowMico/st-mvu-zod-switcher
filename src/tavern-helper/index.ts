import {
  DISPLAY_NAME,
  MAP_COMMENT_PATTERN,
  MODULE_NAME,
  type MapEntry,
  type MvuData,
  type PresetEntry,
  type Settings,
  buildNextMvuData,
  collectPresetEntriesFromWorld,
  createEmptyMvuData,
  deepClone,
  defaultSettings,
  getCurrentPresetId,
  getPresetFingerprint,
  getPresetIdFromOpening,
  hasOwn,
  isPlainObject,
  parseData,
  parseFirstMap,
} from './core';

declare const SillyTavern: {
  getContext?: () => Record<string, any>;
  chat?: unknown[];
  [key: string]: any;
} | undefined;

declare const Mvu: {
  getMvuData?: (options: { type: string; message_id: number | string }) => MvuData;
  replaceMvuData?: (data: MvuData, options: { type: string; message_id: number | string }) => Promise<void> | void;
  events?: { VARIABLE_INITIALIZED?: string };
} | undefined;

declare const waitGlobalInitialized: ((name: string) => Promise<void>) | undefined;
declare const getChatMessages: ((range: string | number, option?: Record<string, any>) => any[]) | undefined;
declare const setChatMessages: ((messages: any[], option?: Record<string, any>) => Promise<void>) | undefined;
declare const getCharWorldbookNames: ((characterName: 'current' | string) => { primary: string | null; additional: string[] }) | undefined;
declare const getGlobalWorldbookNames: (() => string[]) | undefined;
declare const getWorldbook: ((worldbookName: string) => Promise<any[]>) | undefined;
declare const getWorldbookNames: (() => string[]) | undefined;
declare const eventOn: ((eventType: string, listener: (...args: any[]) => void) => void) | undefined;
declare const getButtonEvent: ((buttonName: string) => string) | undefined;
declare const appendInexistentScriptButtons: ((buttons: { name: string; visible: boolean }[]) => void) | undefined;
declare const replaceScriptInfo: ((info: string) => void) | undefined;
declare const eventEmit: ((eventType: string, ...args: any[]) => Promise<void>) | undefined;
declare const tavern_events: Record<string, string> | undefined;
declare const toastr: Record<string, ((message: string, title?: string) => void) | undefined> | undefined;

const root = globalThis as any;

type AppliedState = {
  presetId: string;
  worldName: string;
  comment: string;
  applyMode: Settings['applyMode'];
  fingerprint: string;
  chatKey: string;
  appliedAt: string;
};

type ChatState = {
  applied?: Record<string, AppliedState>;
  lastStatus?: {
    message: string;
    type: string;
    updatedAt: string;
  };
};

type PresetResolution = {
  presetId: string;
  preset: PresetEntry | undefined;
  presets: PresetEntry[];
  maps: MapEntry[];
  worldNames: string[];
  swipeIndex: number;
  inlineId: string | null;
};

const BUTTONS = [
  { name: '扫描当前预设', visible: true },
  { name: '手动应用当前预设', visible: true },
  { name: '清除已应用记录', visible: true },
];

let didInit = false;
let lastAutoApplyTimer: ReturnType<typeof setTimeout> | undefined;

function getContext(): Record<string, any> {
  return root.SillyTavern?.getContext?.() ?? {};
}

function getScriptData(): Record<string, any> {
  if (!isPlainObject(root[MODULE_NAME])) {
    root[MODULE_NAME] = {};
  }
  return root[MODULE_NAME];
}

function getSettings(): Settings {
  const data = getScriptData();
  if (!isPlainObject(data.settings)) {
    data.settings = {};
  }

  const settings = data.settings as Partial<Settings>;
  for (const [key, value] of Object.entries(defaultSettings)) {
    if (!hasOwn(settings, key)) {
      (settings as Record<string, unknown>)[key] = value;
    }
  }

  settings.applyMode = settings.applyMode === 'merge' ? 'merge' : 'replace';
  settings.presetSource = settings.presetSource === 'all' ? 'all' : 'active';
  return settings as Settings;
}

function showToast(type: 'success' | 'info' | 'warning' | 'error', message: string): void {
  if (!getSettings().showToasts) {
    return;
  }

  const toastrApi = root.toastr;
  const toast = toastrApi?.[type];
  if (typeof toast === 'function') {
    toast(message, DISPLAY_NAME);
  }
}

function updateStatus(message: string, type = 'info'): void {
  console.info(`[${DISPLAY_NAME}] ${message}`);
  const state = getChatState();
  if (state) {
    state.lastStatus = {
      message,
      type,
      updatedAt: new Date().toISOString(),
    };
    void saveChatState();
  }
}

function logError(message: string, error: unknown): void {
  console.error(`[${DISPLAY_NAME}] ${message}`, error);
  showToast('error', `${message}: ${error instanceof Error ? error.message : String(error)}`);
}

function getCurrentOpeningMessage(): any | null {
  if (typeof getChatMessages === 'function') {
    const messages = getChatMessages(0, { include_swipes: true });
    return Array.isArray(messages) ? messages[0] ?? null : null;
  }

  const chat = getContext().chat ?? root.SillyTavern?.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    return null;
  }

  return chat[0] ?? null;
}

function getCurrentSwipeIndex(): number {
  const opening = getCurrentOpeningMessage();
  const swipeId = Number(opening?.swipe_id ?? 0);
  return Number.isSafeInteger(swipeId) && swipeId >= 0 ? swipeId : 0;
}

function getCurrentOpeningText(): string {
  const opening = getCurrentOpeningMessage();
  const swipeIndex = getCurrentSwipeIndex();
  if (Array.isArray(opening?.swipes) && opening.swipes[swipeIndex]) {
    return String(opening.swipes[swipeIndex]);
  }

  return String(opening?.message ?? opening?.mes ?? '');
}

function getCurrentChatKey(): string {
  const context = getContext();
  return context.getCurrentChatId?.() ?? context.chatId ?? 'unknown-chat';
}

function getChatMetadata(): Record<string, any> | null {
  const context = getContext();
  if (isPlainObject(context.chatMetadata)) {
    return context.chatMetadata;
  }

  return null;
}

function getChatState(): ChatState | null {
  const metadata = getChatMetadata();
  if (!metadata) {
    return null;
  }

  if (!isPlainObject(metadata[MODULE_NAME])) {
    metadata[MODULE_NAME] = {};
  }

  return metadata[MODULE_NAME] as ChatState;
}

async function saveChatState(): Promise<void> {
  const context = getContext();
  if (typeof context.saveMetadata === 'function') {
    await context.saveMetadata();
  } else if (typeof context.saveMetadataDebounced === 'function') {
    context.saveMetadataDebounced();
  }
}

function hasChatStarted(): boolean {
  const contextChat = getContext().chat ?? root.SillyTavern?.chat;
  if (Array.isArray(contextChat)) {
    return contextChat.length > 1;
  }

  try {
    return typeof getChatMessages === 'function' && getChatMessages('0-{{lastMessageId}}').length > 1;
  } catch (_error) {
    return false;
  }
}

function getYamlParser(): ((body: string) => unknown) | undefined {
  const contextYaml = getContext().libs?.yaml;
  if (typeof contextYaml?.parse === 'function') {
    return contextYaml.parse.bind(contextYaml);
  }

  const yaml = root.SillyTavern?.libs?.yaml;
  if (typeof yaml?.parse === 'function') {
    return yaml.parse.bind(yaml);
  }

  return undefined;
}

async function waitForMvuApi(timeoutMs = 15000): Promise<boolean> {
  if (root.Mvu?.getMvuData && root.Mvu?.replaceMvuData) {
    return true;
  }

  if (typeof waitGlobalInitialized === 'function') {
    try {
      await Promise.race([
        waitGlobalInitialized('Mvu'),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
      ]);
    } catch (_error) {
      // Fall through to the polling check below.
    }
  }

  if (root.Mvu?.getMvuData && root.Mvu?.replaceMvuData) {
    return true;
  }

  await new Promise(resolve => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      const isReady = root.Mvu?.getMvuData && root.Mvu?.replaceMvuData;
      if (isReady || Date.now() - startedAt >= timeoutMs) {
        clearInterval(interval);
        resolve(undefined);
      }
    }, 100);
  });

  return !!(root.Mvu?.getMvuData && root.Mvu?.replaceMvuData);
}

function getOpeningMvuData(): MvuData {
  return root.Mvu?.getMvuData?.({ type: 'message', message_id: 0 }) ?? createEmptyMvuData();
}

async function replaceOpeningMvuData(nextData: MvuData): Promise<void> {
  if (!root.Mvu?.replaceMvuData) {
    throw new Error('MVU global API was not found. Make sure MVU is installed and enabled.');
  }

  await root.Mvu.replaceMvuData(nextData, { type: 'message', message_id: 0 });

  const opening = getCurrentOpeningMessage();
  const swipeIndex = getCurrentSwipeIndex();
  if (opening && Array.isArray(opening.swipes_data)) {
    opening.swipes_data[swipeIndex] = deepClone(nextData);
    if (typeof setChatMessages === 'function') {
      await setChatMessages([{ message_id: 0, swipes_data: opening.swipes_data }], { refresh: 'none' });
    }
  }

  const context = getContext();
  if (typeof context.saveChat === 'function') {
    await context.saveChat();
  }

  const eventType = root.Mvu?.events?.VARIABLE_INITIALIZED;
  if (eventType && typeof eventEmit === 'function') {
    await eventEmit(eventType, nextData, swipeIndex);
  }
}

async function getWorldbookEntries(worldName: string): Promise<unknown[]> {
  if (typeof getWorldbook !== 'function') {
    return [];
  }

  const entries = await getWorldbook(worldName);
  return Array.isArray(entries) ? entries : [];
}

function addWorldName(names: Set<string>, value: unknown): void {
  if (!value) {
    return;
  }

  if (typeof value === 'string') {
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

function getActiveWorldNames(): string[] {
  const settings = getSettings();
  const names = new Set<string>();

  if (typeof getCharWorldbookNames === 'function') {
    try {
      const charWorlds = getCharWorldbookNames('current');
      addWorldName(names, charWorlds?.primary);
      addWorldName(names, charWorlds?.additional);
    } catch (error) {
      console.warn(`[${DISPLAY_NAME}] Failed to read character worldbooks`, error);
    }
  }

  if (typeof getGlobalWorldbookNames === 'function') {
    try {
      addWorldName(names, getGlobalWorldbookNames());
    } catch (error) {
      console.warn(`[${DISPLAY_NAME}] Failed to read global worldbooks`, error);
    }
  }

  if (settings.presetSource === 'all' && typeof getWorldbookNames === 'function') {
    try {
      addWorldName(names, getWorldbookNames());
    } catch (error) {
      console.warn(`[${DISPLAY_NAME}] Failed to read all worldbook names`, error);
    }
  }

  return [...names];
}

async function loadPresetEntries(): Promise<{ presets: PresetEntry[]; maps: MapEntry[]; worldNames: string[] }> {
  const worldNames = getActiveWorldNames();
  const presets: PresetEntry[] = [];
  const maps: MapEntry[] = [];

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

async function resolveCurrentPreset(): Promise<PresetResolution> {
  const { presets, maps, worldNames } = await loadPresetEntries();
  const opening = {
    swipeIndex: getCurrentSwipeIndex(),
    text: getCurrentOpeningText(),
  };
  const mapData = parseFirstMap(maps, getYamlParser());
  const presetId = getCurrentPresetId(opening, mapData);
  const preset = presets.find(entry => entry.id === presetId);

  return {
    presetId,
    preset,
    presets,
    maps,
    worldNames,
    swipeIndex: opening.swipeIndex,
    inlineId: getPresetIdFromOpening(opening.text),
  };
}

function isPresetAlreadyApplied(presetId: string, fingerprint: string): boolean {
  const state = getChatState();
  const swipeIndex = getCurrentSwipeIndex();
  const applied = state?.applied?.[String(swipeIndex)];
  return applied?.presetId === presetId && applied?.fingerprint === fingerprint;
}

async function markApplied(presetId: string, preset: PresetEntry, applyMode: Settings['applyMode'], fingerprint: string): Promise<void> {
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
    appliedAt: new Date().toISOString(),
  };

  await saveChatState();
}

async function applyCurrentPreset({ force = false } = {}): Promise<Record<string, unknown>> {
  const settings = getSettings();
  if (!settings.enabled && !force) {
    return { ok: false, reason: 'disabled' };
  }

  if (hasChatStarted() && !settings.allowAfterChatStarted && !force) {
    const message = '聊天已经开始，自动应用已跳过；需要覆盖第 0 楼变量时请点“手动应用当前预设”。';
    updateStatus(message, 'warn');
    return { ok: false, reason: 'chat-started' };
  }

  if (!await waitForMvuApi()) {
    const message = '未找到 MVU/MagVarUpdate。请先启用 MVU 变量框架脚本。';
    updateStatus(message, 'warn');
    showToast('warning', message);
    return { ok: false, reason: 'mvu-not-ready' };
  }

  const resolved = await resolveCurrentPreset();
  if (!resolved.preset) {
    const message = `未找到预设 '${resolved.presetId}'。已读取世界书：${resolved.worldNames.join(', ') || '无'}。`;
    updateStatus(message, 'warn');
    return { ok: false, reason: 'not-found', resolved };
  }

  const fingerprint = getPresetFingerprint(resolved.preset, settings.applyMode);
  if (!force && isPresetAlreadyApplied(resolved.presetId, fingerprint)) {
    const message = `预设 '${resolved.presetId}' 已应用到开场 #${resolved.swipeIndex}。`;
    updateStatus(message, 'ok');
    return { ok: true, skipped: true, resolved };
  }

  const parsed = parseData(resolved.preset.content, getYamlParser());
  const currentData = getOpeningMvuData();
  const nextData = buildNextMvuData(currentData, parsed, settings.applyMode);
  await replaceOpeningMvuData(nextData);
  await markApplied(resolved.presetId, resolved.preset, settings.applyMode, fingerprint);

  const message = `已应用 '${resolved.presetId}'（${resolved.preset.worldName}，${settings.applyMode}）。`;
  updateStatus(message, 'ok');
  showToast('success', message);
  return { ok: true, resolved };
}

async function autoApplyCurrentPreset(): Promise<void> {
  const settings = getSettings();
  if (!settings.enabled || !settings.autoApplyOnNewChat) {
    return;
  }

  try {
    await applyCurrentPreset({ force: false });
  } catch (error) {
    logError('Auto apply failed', error);
    updateStatus(`自动应用失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function queueAutoApply(delayMs = 300): void {
  if (lastAutoApplyTimer) {
    clearTimeout(lastAutoApplyTimer);
  }
  lastAutoApplyTimer = setTimeout(() => {
    void autoApplyCurrentPreset();
  }, delayMs);
}

async function scanCurrentPreset(): Promise<void> {
  try {
    const resolved = await resolveCurrentPreset();
    if (resolved.preset) {
      const source = resolved.inlineId ? '开场标记' : resolved.maps.length ? '映射/序号' : 'swipe 序号';
      const message = `开场 #${resolved.swipeIndex} -> '${resolved.presetId}'，来源：${resolved.preset.worldName}（${source}）。`;
      updateStatus(message, 'ok');
      showToast('info', message);
    } else {
      const message = `开场 #${resolved.swipeIndex} -> '${resolved.presetId}'，但没有找到对应 [MVU_INIT_PRESET:${resolved.presetId}]。已读取世界书：${resolved.worldNames.join(', ') || '无'}。`;
      updateStatus(message, 'warn');
      showToast('warning', message);
    }
  } catch (error) {
    logError('Preset scan failed', error);
    updateStatus(`扫描失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

async function clearAppliedRecords(): Promise<void> {
  const state = getChatState();
  if (state?.applied) {
    state.applied = {};
    await saveChatState();
  }
  const message = '已清除当前聊天的 initvar 应用记录。';
  updateStatus(message, 'ok');
  showToast('success', message);
}

function registerButtons(): void {
  if (typeof appendInexistentScriptButtons === 'function') {
    appendInexistentScriptButtons(BUTTONS);
  }

  if (typeof getButtonEvent !== 'function' || typeof eventOn !== 'function') {
    return;
  }

  eventOn(getButtonEvent('扫描当前预设'), () => {
    void scanCurrentPreset();
  });
  eventOn(getButtonEvent('手动应用当前预设'), () => {
    void applyCurrentPreset({ force: true }).catch(error => logError('Manual apply failed', error));
  });
  eventOn(getButtonEvent('清除已应用记录'), () => {
    void clearAppliedRecords();
  });
}

function registerEvents(): void {
  if (typeof eventOn === 'function' && typeof tavern_events === 'object' && tavern_events) {
    for (const eventType of [
      tavern_events.CHAT_CHANGED,
      tavern_events.CHAT_CREATED,
      tavern_events.MESSAGE_SWIPED,
      tavern_events.MESSAGE_UPDATED,
      tavern_events.WORLDINFO_UPDATED,
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
    updateStatus('SillyTavern event API is unavailable.', 'warn');
    return;
  }

  for (const eventType of [eventTypes.CHAT_CHANGED, eventTypes.CHAT_CREATED, eventTypes.MESSAGE_SWIPED, eventTypes.MESSAGE_UPDATED, eventTypes.WORLDINFO_UPDATED]) {
    if (eventType) {
      eventSource.on(eventType, () => queueAutoApply());
    }
  }
}

function renderScriptInfo(): void {
  if (typeof replaceScriptInfo !== 'function') {
    return;
  }

  replaceScriptInfo([
    'MVU InitVar Switcher',
    '',
    '启用后会根据当前开场白 swipe 自动应用 [MVU_INIT_PRESET:*] 初始变量。',
    '需要先启用 MVU/MagVarUpdate；本脚本不会自动联网加载 MVU。',
    '',
    '按钮：',
    '- 扫描当前预设：检查当前开场会匹配哪个预设。',
    '- 手动应用当前预设：忽略“聊天已开始”保护并覆盖第 0 楼变量。',
    '- 清除已应用记录：让同一聊天可以重新自动应用相同预设。',
  ].join('\n'));
}

function init(): void {
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

if (typeof root.$ === 'function') {
  root.$(() => init());
} else {
  init();
}

root.MvuInitVarSwitcherTH = {
  applyCurrentPreset,
  scanCurrentPreset,
  clearAppliedRecords,
  resolveCurrentPreset,
};
