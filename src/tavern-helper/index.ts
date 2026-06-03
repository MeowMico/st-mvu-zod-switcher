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
declare const getScriptId: (() => string) | undefined;
declare const getVariables: ((option?: Record<string, any>) => Record<string, any>) | undefined;
declare const updateVariablesWith: ((
  updater: (variables: Record<string, any>) => Record<string, any> | Promise<Record<string, any>>,
  option?: Record<string, any>,
) => Promise<Record<string, any>>) | undefined;
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

type OpeningRow = {
  index: number;
  text: string;
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

function getScriptVariableOption(): Record<string, any> | null {
  if (typeof getScriptId !== 'function') {
    return null;
  }

  return { type: 'script', script_id: getScriptId() };
}

function hydrateSettingsFromScriptVariables(): void {
  if (typeof getVariables !== 'function') {
    return;
  }

  const option = getScriptVariableOption();
  if (!option) {
    return;
  }

  try {
    const variables = getVariables(option);
    const savedSettings = isPlainObject(variables?.[MODULE_NAME]) ? variables[MODULE_NAME].settings : null;
    if (isPlainObject(savedSettings)) {
      const data = getScriptData();
      data.settings = {
        ...(isPlainObject(data.settings) ? data.settings : {}),
        ...savedSettings,
      };
    }
  } catch (error) {
    console.warn(`[${DISPLAY_NAME}] Failed to load script settings`, error);
  }
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
  if (!isPlainObject(settings.openingPresetMap)) {
    settings.openingPresetMap = {};
  }
  return settings as Settings;
}

async function saveSettings(): Promise<void> {
  renderSettingsValues();

  if (typeof updateVariablesWith !== 'function') {
    return;
  }

  const option = getScriptVariableOption();
  if (!option) {
    return;
  }

  const settings = deepClone(getSettings());
  try {
    await updateVariablesWith((variables) => ({
      ...variables,
      [MODULE_NAME]: {
        ...(isPlainObject(variables?.[MODULE_NAME]) ? variables[MODULE_NAME] : {}),
        settings,
      },
    }), option);
  } catch (error) {
    console.warn(`[${DISPLAY_NAME}] Failed to save script settings`, error);
  }
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
  const status = document.getElementById(`${MODULE_NAME}_status`);
  if (status) {
    status.textContent = message;
    status.dataset.type = type;
  }

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

function renderSettingsValues(): void {
  const settings = getSettings();
  const enabled = document.getElementById(`${MODULE_NAME}_enabled`) as HTMLInputElement | null;
  const auto = document.getElementById(`${MODULE_NAME}_auto`) as HTMLInputElement | null;
  const afterStarted = document.getElementById(`${MODULE_NAME}_after_started`) as HTMLInputElement | null;
  const toasts = document.getElementById(`${MODULE_NAME}_toasts`) as HTMLInputElement | null;
  const mode = document.getElementById(`${MODULE_NAME}_mode`) as HTMLSelectElement | null;
  const source = document.getElementById(`${MODULE_NAME}_source`) as HTMLSelectElement | null;

  if (enabled) enabled.checked = !!settings.enabled;
  if (auto) auto.checked = !!settings.autoApplyOnNewChat;
  if (afterStarted) afterStarted.checked = !!settings.allowAfterChatStarted;
  if (toasts) toasts.checked = !!settings.showToasts;
  if (mode) mode.value = settings.applyMode;
  if (source) source.value = settings.presetSource;
}

function getOpeningRows(): OpeningRow[] {
  const opening = getCurrentOpeningMessage();
  if (Array.isArray(opening?.swipes) && opening.swipes.length) {
    return opening.swipes.map((text: unknown, index: number) => ({
      index,
      text: String(text ?? ''),
    }));
  }

  return [{
    index: getCurrentSwipeIndex(),
    text: getCurrentOpeningText(),
  }];
}

function getOpeningPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '(empty opening)';
  }

  return normalized.length > 96 ? `${normalized.slice(0, 96)}...` : normalized;
}

function getStoredOpeningPresetMap(): Record<string, string> {
  const settings = getSettings();
  return isPlainObject(settings.openingPresetMap) ? settings.openingPresetMap : {};
}

function setStoredOpeningPreset(index: number, presetId: string): void {
  const settings = getSettings();
  const map = { ...getStoredOpeningPresetMap() };
  const key = String(index);
  if (presetId) {
    map[key] = presetId;
  } else {
    delete map[key];
  }
  settings.openingPresetMap = map;
}

async function copyOpeningPresetMap(): Promise<void> {
  const map = getStoredOpeningPresetMap();
  const text = JSON.stringify(map, null, 2);
  if (!isPlainObject(map) || Object.keys(map).length === 0) {
    updateStatus('当前还没有保存任何开场映射。', 'warn');
    return;
  }

  if (!navigator.clipboard?.writeText) {
    updateStatus(`当前浏览器不支持自动复制，请手动复制：\n${text}`, 'warn');
    return;
  }

  await navigator.clipboard.writeText(text);
  updateStatus('已复制 [MVU_INIT_MAP] JSON。', 'ok');
  showToast('success', '已复制 [MVU_INIT_MAP] JSON。');
}

async function renderMappingEditor(): Promise<void> {
  const mount = document.getElementById(`${MODULE_NAME}_mapper`);
  if (!mount) {
    return;
  }

  mount.textContent = 'Loading openings and presets...';
  let presets: PresetEntry[] = [];
  let maps: MapEntry[] = [];
  let worldNames: string[] = [];
  try {
    const loaded = await loadPresetEntries();
    presets = loaded.presets;
    maps = loaded.maps;
    worldNames = loaded.worldNames;
  } catch (error) {
    mount.textContent = `Failed to load presets: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }

  const rows = getOpeningRows();
  const storedMap = getStoredOpeningPresetMap();
  const uniquePresetIds = [...new Map(presets.map(preset => [preset.id, preset])).values()];

  const controls = document.createElement('div');
  controls.className = 'mvu-initvar-switcher-th-mapper';

  if (!rows.length) {
    controls.textContent = 'No opening message was found.';
    mount.replaceChildren(controls);
    return;
  }

  for (const row of rows) {
    const rowElement = document.createElement('div');
    rowElement.className = 'mvu-initvar-switcher-th-map-row';

    const label = document.createElement('label');
    label.htmlFor = `${MODULE_NAME}_map_${row.index}`;
    label.className = 'mvu-initvar-switcher-th-map-label';
    label.textContent = `Opening #${row.index}: ${getOpeningPreview(row.text)}`;

    const select = document.createElement('select');
    select.id = `${MODULE_NAME}_map_${row.index}`;
    select.className = 'text_pole';
    select.dataset.swipeIndex = String(row.index);
    select.setAttribute('aria-label', `Preset for opening ${row.index}`);

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = `Use default [MVU_INIT_PRESET:${row.index}]`;
    select.append(defaultOption);

    for (const preset of uniquePresetIds) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = `${preset.id} (${preset.worldName})`;
      select.append(option);
    }

    select.value = typeof storedMap[String(row.index)] === 'string' ? storedMap[String(row.index)] : '';
    select.addEventListener('change', () => {
      setStoredOpeningPreset(row.index, select.value);
      void saveSettings();
      void renderMappingSummary(presets, maps, worldNames);
      updateStatus(`Opening #${row.index} is mapped to '${select.value || row.index}'.`, 'ok');
    });

    rowElement.append(label, select);
    controls.append(rowElement);
  }

  mount.replaceChildren(controls);
  await renderMappingSummary(presets, maps, worldNames);
}

async function renderMappingSummary(presets: PresetEntry[], maps: MapEntry[], worldNames: string[]): Promise<void> {
  const summary = document.getElementById(`${MODULE_NAME}_mapper_summary`);
  if (!summary) {
    return;
  }

  const storedMap = getStoredOpeningPresetMap();
  const missingPresetIds = Object.values(storedMap).filter(id => id && !presets.some(preset => preset.id === id));
  const mapLines = Object.entries(storedMap).map(([opening, presetId]) => `#${opening} -> ${presetId}`);

  summary.textContent = [
    `Found ${presets.length} preset entr${presets.length === 1 ? 'y' : 'ies'} in ${worldNames.length} worldbook${worldNames.length === 1 ? '' : 's'}.`,
    maps.length ? `Worldbook map entries: ${maps.length}. Frontend mappings override worldbook maps.` : 'No [MVU_INIT_MAP] entry found. Frontend mappings can replace it.',
    mapLines.length ? `Saved frontend mappings: ${mapLines.join(', ')}` : 'Saved frontend mappings: none.',
    missingPresetIds.length ? `Missing preset ids: ${[...new Set(missingPresetIds)].join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function renderSettingsPanel(): void {
  if (document.getElementById(`${MODULE_NAME}_settings`)) {
    renderSettingsValues();
    return;
  }

  const settingsTarget = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings') ?? document.body;
  if (!settingsTarget) {
    return;
  }

  const container = document.createElement('div');
  container.id = `${MODULE_NAME}_settings`;
  container.className = 'mvu-initvar-switcher-th-settings';
  container.innerHTML = `
    <style>
      .mvu-initvar-switcher-th-settings .inline-drawer-content {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .mvu-initvar-switcher-th-settings .mvu-initvar-switcher-th-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-top: 0.25rem;
      }
      .mvu-initvar-switcher-th-status {
        border: 1px solid var(--SmartThemeBorderColor);
        border-radius: 6px;
        padding: 0.5rem;
        white-space: pre-wrap;
      }
      .mvu-initvar-switcher-th-status[data-type='ok'] {
        border-color: #4caf50;
      }
      .mvu-initvar-switcher-th-status[data-type='warn'] {
        border-color: #ff9800;
      }
      .mvu-initvar-switcher-th-status[data-type='error'] {
        border-color: #f44336;
      }
      .mvu-initvar-switcher-th-map-tools {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
      }
      .mvu-initvar-switcher-th-mapper {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .mvu-initvar-switcher-th-map-row {
        display: grid;
        grid-template-columns: minmax(14rem, 1fr) minmax(12rem, 18rem);
        gap: 0.5rem;
        align-items: center;
      }
      .mvu-initvar-switcher-th-map-label {
        overflow-wrap: anywhere;
      }
      .mvu-initvar-switcher-th-map-summary {
        border: 1px solid var(--SmartThemeBorderColor);
        border-radius: 6px;
        padding: 0.5rem;
        white-space: pre-wrap;
      }
      @media (max-width: 640px) {
        .mvu-initvar-switcher-th-map-row {
          grid-template-columns: 1fr;
        }
      }
    </style>
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>MVU InitVar Switcher (Tavern Helper)</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <label class="checkbox_label" for="${MODULE_NAME}_enabled">
          <input id="${MODULE_NAME}_enabled" type="checkbox">
          Enable switcher
        </label>
        <label class="checkbox_label" for="${MODULE_NAME}_auto">
          <input id="${MODULE_NAME}_auto" type="checkbox">
          Auto-apply on new chat / opening swipe
        </label>
        <label class="checkbox_label" for="${MODULE_NAME}_after_started">
          <input id="${MODULE_NAME}_after_started" type="checkbox">
          Allow auto overwrite after chat has started
        </label>
        <label class="checkbox_label" for="${MODULE_NAME}_toasts">
          <input id="${MODULE_NAME}_toasts" type="checkbox">
          Show toast notifications
        </label>
        <label for="${MODULE_NAME}_mode">Apply mode</label>
        <select id="${MODULE_NAME}_mode" class="text_pole">
          <option value="replace">Replace stat_data with preset</option>
          <option value="merge">Merge preset into current stat_data</option>
        </select>
        <label for="${MODULE_NAME}_source">Preset search scope</label>
        <select id="${MODULE_NAME}_source" class="text_pole">
          <option value="active">Character/global worldbooks</option>
          <option value="all">All worldbooks</option>
        </select>
        <div class="mvu-initvar-switcher-th-actions">
          <button id="${MODULE_NAME}_scan" class="menu_button" type="button">扫描当前预设</button>
          <button id="${MODULE_NAME}_apply" class="menu_button" type="button">手动应用当前预设</button>
          <button id="${MODULE_NAME}_clear" class="menu_button" type="button">清除已应用记录</button>
        </div>
        <fieldset>
          <legend>Opening to initvar preset map</legend>
          <div class="mvu-initvar-switcher-th-map-tools">
            <button id="${MODULE_NAME}_refresh_map" class="menu_button" type="button">刷新开场/预设列表</button>
            <button id="${MODULE_NAME}_copy_map" class="menu_button" type="button">复制 [MVU_INIT_MAP] JSON</button>
            <button id="${MODULE_NAME}_clear_map" class="menu_button" type="button">清空前端映射</button>
          </div>
          <p>
            Use the selects below to bind each opening swipe to an initvar preset. Inline opening markers still have the highest priority.
          </p>
          <div id="${MODULE_NAME}_mapper" aria-live="polite"></div>
          <div id="${MODULE_NAME}_mapper_summary" class="mvu-initvar-switcher-th-map-summary" aria-live="polite"></div>
        </fieldset>
        <div id="${MODULE_NAME}_status" class="mvu-initvar-switcher-th-status" data-type="info">
          Ready. Current opening defaults to [MVU_INIT_PRESET:swipeIndex].
        </div>
      </div>
    </div>
  `;

  settingsTarget.append(container);
  renderSettingsValues();

  const settings = getSettings();
  const enabled = document.getElementById(`${MODULE_NAME}_enabled`) as HTMLInputElement | null;
  const auto = document.getElementById(`${MODULE_NAME}_auto`) as HTMLInputElement | null;
  const afterStarted = document.getElementById(`${MODULE_NAME}_after_started`) as HTMLInputElement | null;
  const toasts = document.getElementById(`${MODULE_NAME}_toasts`) as HTMLInputElement | null;
  const mode = document.getElementById(`${MODULE_NAME}_mode`) as HTMLSelectElement | null;
  const source = document.getElementById(`${MODULE_NAME}_source`) as HTMLSelectElement | null;

  enabled?.addEventListener('change', () => {
    settings.enabled = !!enabled.checked;
    void saveSettings();
  });
  auto?.addEventListener('change', () => {
    settings.autoApplyOnNewChat = !!auto.checked;
    void saveSettings();
  });
  afterStarted?.addEventListener('change', () => {
    settings.allowAfterChatStarted = !!afterStarted.checked;
    void saveSettings();
  });
  toasts?.addEventListener('change', () => {
    settings.showToasts = !!toasts.checked;
    void saveSettings();
  });
  mode?.addEventListener('change', () => {
    settings.applyMode = mode.value === 'merge' ? 'merge' : 'replace';
    void saveSettings();
  });
  source?.addEventListener('change', () => {
    settings.presetSource = source.value === 'all' ? 'all' : 'active';
    void saveSettings();
  });

  document.getElementById(`${MODULE_NAME}_scan`)?.addEventListener('click', () => {
    void scanCurrentPreset();
  });
  document.getElementById(`${MODULE_NAME}_apply`)?.addEventListener('click', () => {
    void applyCurrentPreset({ force: true }).catch(error => logError('Manual apply failed', error));
  });
  document.getElementById(`${MODULE_NAME}_clear`)?.addEventListener('click', () => {
    void clearAppliedRecords();
  });
  document.getElementById(`${MODULE_NAME}_refresh_map`)?.addEventListener('click', () => {
    void renderMappingEditor();
  });
  document.getElementById(`${MODULE_NAME}_copy_map`)?.addEventListener('click', () => {
    void copyOpeningPresetMap().catch(error => logError('Copy map failed', error));
  });
  document.getElementById(`${MODULE_NAME}_clear_map`)?.addEventListener('click', () => {
    getSettings().openingPresetMap = {};
    void saveSettings();
    void renderMappingEditor();
    updateStatus('已清空前端开场映射。', 'ok');
  });

  void renderMappingEditor();
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
  const worldMapData = parseFirstMap(maps, getYamlParser());
  const mapData = {
    ...(isPlainObject(worldMapData) ? worldMapData : {}),
    ...getStoredOpeningPresetMap(),
  };
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
  hydrateSettingsFromScriptVariables();
  getSettings();
  renderSettingsPanel();
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
