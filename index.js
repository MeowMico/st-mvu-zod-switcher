const MODULE_NAME = 'mvu_initvar_switcher';
const DISPLAY_NAME = 'MVU InitVar Switcher';
const PRESET_COMMENT_PATTERN = /\[MVU_INIT_PRESET\s*[:#]\s*([^\]\s]+)\s*\]/i;
const MAP_COMMENT_PATTERN = /\[MVU_INIT_MAP\]/i;
const INLINE_PRESET_PATTERNS = [
    /<mvu-init-preset>\s*([^<\s]+)\s*<\/mvu-init-preset>/i,
    /<!--\s*mvu-init-preset\s*[:#]\s*([^\s-]+)\s*-->/i,
];
const EXTENSIBLE_MARKER = '$__META_EXTENSIBLE__$';
const registeredEventTypes = new Set();
let didInit = false;

const defaultSettings = Object.freeze({
    enabled: true,
    autoApplyOnNewChat: true,
    applyMode: 'replace',
    presetSource: 'active',
    allowAfterChatStarted: false,
    showToasts: true,
});

function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? {};
}

function getSettings() {
    const context = getContext();
    const extensionSettings = context.extensionSettings ?? (context.extensionSettings = {});
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = deepClone(defaultSettings);
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = value;
        }
    }

    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    getContext().saveSettingsDebounced?.();
}

function showToast(type, message) {
    if (!getSettings().showToasts) {
        return;
    }

    const toastrApi = globalThis.toastr;
    if (toastrApi?.[type]) {
        toastrApi[type](message, DISPLAY_NAME);
    }
}

function logError(message, error) {
    console.error(`[${DISPLAY_NAME}] ${message}`, error);
    showToast('error', `${message}: ${error?.message ?? error}`);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValueWithDescription(value) {
    return Array.isArray(value) && value.length === 2 && typeof value[1] === 'string';
}

function deepClone(value) {
    if (typeof structuredClone === 'function') {
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
    const text = String(value ?? '');
    for (let index = 0; index < text.length; index++) {
        hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
    }

    return (hash >>> 0).toString(36);
}

function getEntryComment(entry) {
    return String(entry?.comment ?? entry?.name ?? entry?.key?.join?.(', ') ?? '');
}

function stripCodeFence(content) {
    const trimmed = String(content ?? '').trim();
    const codeblockMatch = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/m);
    return codeblockMatch ? codeblockMatch[1].trim() : trimmed;
}

function stripInitvarWrapper(content) {
    const trimmed = stripCodeFence(content);
    const initvarMatch = trimmed.match(/<initvar>\s*(?:```[^\n]*\n)?([\s\S]*?)(?:\n```)?\s*<\/initvar>/i);
    return initvarMatch ? initvarMatch[1].trim() : trimmed;
}

function parseData(content) {
    const body = stripInitvarWrapper(content);
    if (!body) {
        throw new Error('Preset content is empty.');
    }

    try {
        return JSON.parse(body);
    } catch (_jsonError) {
        const yaml = globalThis.SillyTavern?.libs?.yaml;
        if (!yaml?.parse) {
            throw new Error('Preset is not valid JSON, and SillyTavern YAML parser is unavailable.');
        }

        return yaml.parse(body);
    }
}

function normalizePresetData(parsed) {
    if (!isPlainObject(parsed)) {
        throw new Error('Preset must parse to an object.');
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
        const dataItems = value.filter(item => item !== EXTENSIBLE_MARKER);
        const metaItem = dataItems.find(item => isPlainObject(item) && item.$arrayMeta === true && isPlainObject(item.$meta));
        const meta = metaItem?.$meta ?? {};
        const schemaItems = dataItems.filter(item => !(isPlainObject(item) && item.$arrayMeta === true && Object.hasOwn(item, '$meta')));
        return {
            type: 'array',
            extensible: value.includes(EXTENSIBLE_MARKER) || meta.extensible === true || meta.recursiveExtensible === true,
            recursiveExtensible: meta.recursiveExtensible === true,
            elementType: schemaItems.length ? buildSchemaNode(schemaItems[0]) : { type: 'any' },
        };
    }

    if (isPlainObject(value)) {
        const meta = isPlainObject(value.$meta) ? value.$meta : {};
        const extensible = meta.extensible === true || meta.recursiveExtensible === true;
        const recursiveExtensible = meta.recursiveExtensible === true;
        const schema = {
            type: 'object',
            properties: {},
            extensible,
            recursiveExtensible,
        };

        for (const [key, childValue] of Object.entries(value)) {
            if (key === '$meta') {
                continue;
            }

            schema.properties[key] = {
                ...buildSchemaNode(childValue),
                required: !extensible || Array.isArray(meta.required) && meta.required.includes(key),
            };
        }

        return schema;
    }

    const valueType = typeof value;
    if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
        return { type: valueType };
    }

    return { type: 'any' };
}

function cleanMetadata(value) {
    if (isValueWithDescription(value)) {
        return [cleanMetadata(value[0]), value[1]];
    }

    if (Array.isArray(value)) {
        return value
            .filter(item => item !== EXTENSIBLE_MARKER)
            .filter(item => !(isPlainObject(item) && item.$arrayMeta === true && Object.hasOwn(item, '$meta')))
            .map(cleanMetadata);
    }

    if (isPlainObject(value)) {
        const result = {};
        for (const [key, childValue] of Object.entries(value)) {
            if (key !== '$meta') {
                result[key] = cleanMetadata(childValue);
            }
        }
        return result;
    }

    return value;
}

function getCurrentOpeningMessage() {
    const chat = getContext().chat;
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

    return String(opening?.mes ?? '');
}

function getCurrentPresetIdFromOpening() {
    const text = getCurrentOpeningText();
    for (const pattern of INLINE_PRESET_PATTERNS) {
        const match = text.match(pattern);
        if (match?.[1]?.trim()) {
            return match[1].trim();
        }
    }

    return null;
}

function getCurrentPresetId(mapData = null) {
    const inlineId = getCurrentPresetIdFromOpening();
    if (inlineId) {
        return inlineId;
    }

    const swipeIndex = getCurrentSwipeIndex();
    if (mapData) {
        const mapped = mapData[String(swipeIndex)] ?? mapData[swipeIndex];
        if (typeof mapped === 'string' || typeof mapped === 'number') {
            return String(mapped);
        }
    }

    return String(swipeIndex);
}

function getCurrentChatKey() {
    const context = getContext();
    return context.getCurrentChatId?.() ?? context.chatId ?? 'unknown-chat';
}

function getChatState() {
    const context = getContext();
    if (!context.chatMetadata) {
        return null;
    }

    if (!isPlainObject(context.chatMetadata[MODULE_NAME])) {
        context.chatMetadata[MODULE_NAME] = {};
    }

    return context.chatMetadata[MODULE_NAME];
}

async function saveChatState() {
    const context = getContext();
    if (context.saveMetadata) {
        await context.saveMetadata();
    } else {
        context.saveMetadataDebounced?.();
    }
}

function getOpeningMvuData() {
    const Mvu = globalThis.Mvu;
    if (!Mvu?.getMvuData) {
        return null;
    }

    return Mvu.getMvuData({ type: 'message', message_id: 0 });
}

function createEmptyMvuData() {
    return {
        display_data: {},
        initialized_lorebooks: {},
        stat_data: {},
        delta_data: {},
        schema: {
            type: 'object',
            properties: {},
        },
    };
}

function buildNextMvuData(currentData, presetData, applyMode) {
    const base = isPlainObject(currentData) ? deepClone(currentData) : createEmptyMvuData();
    const normalizedPreset = normalizePresetData(presetData);
    const rawPresetStatData = normalizedPreset.stat_data ?? {};
    const presetStatData = cleanMetadata(rawPresetStatData);

    if (applyMode === 'merge') {
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
            if (isPlainObject(rawPresetStatData.$meta)) {
                for (const key of ['strictTemplate', 'strictSet', 'concatTemplateArray']) {
                    if (Object.hasOwn(rawPresetStatData.$meta, key)) {
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
        base.schema = { type: 'object', properties: {} };
    }

    return base;
}

async function replaceOpeningMvuData(nextData) {
    const Mvu = globalThis.Mvu;
    if (!Mvu?.replaceMvuData) {
        throw new Error('MVU global API was not found. Make sure MVU is installed and enabled.');
    }

    await Mvu.replaceMvuData(nextData, { type: 'message', message_id: 0 });

    const opening = getCurrentOpeningMessage();
    const swipeIndex = getCurrentSwipeIndex();
    if (opening && Array.isArray(opening.swipes_data)) {
        opening.swipes_data[swipeIndex] = deepClone(nextData);
    }

    await getContext().saveChat?.();

    if (globalThis.eventEmit && globalThis.Mvu?.events?.VARIABLE_INITIALIZED) {
        await globalThis.eventEmit(globalThis.Mvu.events.VARIABLE_INITIALIZED, nextData, swipeIndex);
    }
}

async function waitForMvuApi(timeoutMs = 15000) {
    if (globalThis.Mvu?.getMvuData && globalThis.Mvu?.replaceMvuData) {
        return true;
    }

    await new Promise(resolve => {
        const startedAt = Date.now();
        const interval = setInterval(() => {
            const isReady = globalThis.Mvu?.getMvuData && globalThis.Mvu?.replaceMvuData;
            if (isReady || Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve();
            }
        }, 100);
    });

    return !!(globalThis.Mvu?.getMvuData && globalThis.Mvu?.replaceMvuData);
}

function addWorldInfoName(names, value) {
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
            addWorldInfoName(names, item);
        }
        return;
    }

    if (isPlainObject(value)) {
        if (typeof value.name === 'string' && isPlainObject(value.entries)) {
            return;
        }

        for (const key of [
            'world',
            'world_info',
            'worldInfo',
            'world_name',
            'worldName',
            'selected_world_info',
            'selectedWorldInfo',
            'world_info_names',
            'worldInfoNames',
            'primary_world',
            'primaryWorld',
            'additional_worlds',
            'additionalWorlds',
            'additional_world_info',
            'additionalWorldInfo',
            'extra_books',
            'extraBooks',
            'lorebook',
            'lorebooks',
            'persona_lorebook',
            'personaLorebook',
            'persona_world',
            'personaWorld',
        ]) {
            if (Object.hasOwn(value, key)) {
                addWorldInfoName(names, value[key]);
            }
        }
    }
}

function getWorldInfoEntries(worldData) {
    if (Array.isArray(worldData?.entries)) {
        return worldData.entries;
    }

    if (isPlainObject(worldData?.entries)) {
        return Object.values(worldData.entries);
    }

    return [];
}

function addDirectWorldInfoSource(sources, label, value) {
    if (!isPlainObject(value) || getWorldInfoEntries(value).length === 0) {
        return;
    }

    sources.push({
        worldName: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : label,
        worldData: value,
    });
}

function getActiveWorldInfoNames() {
    const context = getContext();
    const names = new Set();
    const character = Array.isArray(context.characters) ? context.characters[context.characterId] : null;

    const globalNames = context.getWorldInfoNames?.();
    if (Array.isArray(globalNames) && getSettings().presetSource === 'all') {
        for (const name of globalNames) {
            names.add(name);
        }
    }

    if (typeof globalThis.$ === 'function') {
        const selectedWorldInfo = globalThis.$('#world_info option:selected')
            .map((_index, option) => option.textContent || option.label || option.value)
            .get()
            .filter(Boolean);
        for (const name of selectedWorldInfo) {
            addWorldInfoName(names, name);
        }
    }

    addWorldInfoName(names, context.selected_world_info);
    addWorldInfoName(names, context.selectedWorldInfo);
    addWorldInfoName(names, context.world_info);
    addWorldInfoName(names, context.worldInfo);
    addWorldInfoName(names, context.chatMetadata);

    addWorldInfoName(names, character?.data?.extensions);
    addWorldInfoName(names, character?.data?.character_book);
    addWorldInfoName(names, character?.data?.characterBook);
    addWorldInfoName(names, context.power_user);
    addWorldInfoName(names, context.persona);

    return [...names];
}

function getDirectWorldInfoSources() {
    const context = getContext();
    const character = Array.isArray(context.characters) ? context.characters[context.characterId] : null;
    const sources = [];

    addDirectWorldInfoSource(sources, 'current character book', character?.data?.character_book);
    addDirectWorldInfoSource(sources, 'current character book', character?.data?.characterBook);
    addDirectWorldInfoSource(sources, 'chat world info', context.chatMetadata?.world_info);
    addDirectWorldInfoSource(sources, 'selected world info', context.world_info);
    addDirectWorldInfoSource(sources, 'selected world info', context.worldInfo);

    return sources;
}

function collectPresetEntriesFromWorld(worldName, worldData, presets, maps) {
    for (const entry of getWorldInfoEntries(worldData)) {
        const comment = getEntryComment(entry);
        const presetMatch = comment.match(PRESET_COMMENT_PATTERN);
        if (presetMatch) {
            presets.push({
                id: presetMatch[1].trim(),
                worldName,
                comment,
                content: entry.content ?? '',
            });
            continue;
        }

        if (MAP_COMMENT_PATTERN.test(comment)) {
            maps.push({
                worldName,
                comment,
                content: entry.content ?? '',
            });
        }
    }
}

async function loadPresetEntries() {
    const context = getContext();
    const worldNames = getActiveWorldInfoNames();
    const presets = [];
    const maps = [];
    const directSources = getDirectWorldInfoSources();

    if (!context.loadWorldInfo && directSources.length === 0) {
        throw new Error('SillyTavern loadWorldInfo API is unavailable.');
    }

    for (const source of directSources) {
        collectPresetEntriesFromWorld(source.worldName, source.worldData, presets, maps);
    }

    if (context.loadWorldInfo) {
        for (const worldName of worldNames) {
            try {
                const worldData = await context.loadWorldInfo(worldName);
                collectPresetEntriesFromWorld(worldName, worldData, presets, maps);
            } catch (error) {
                console.warn(`[${DISPLAY_NAME}] Failed to load world info '${worldName}'`, error);
            }
        }
    }

    return {
        presets,
        maps,
        worldNames: [...new Set([...directSources.map(source => source.worldName), ...worldNames])],
    };
}

function parseFirstMap(maps) {
    for (const mapEntry of maps) {
        try {
            const parsed = parseData(mapEntry.content);
            if (isPlainObject(parsed)) {
                return parsed;
            }
        } catch (error) {
            console.warn(`[${DISPLAY_NAME}] Failed to parse init map '${mapEntry.comment}'`, error);
        }
    }

    return null;
}

async function resolveCurrentPreset() {
    const { presets, maps, worldNames } = await loadPresetEntries();
    const mapData = parseFirstMap(maps);
    const presetId = getCurrentPresetId(mapData);
    const preset = presets.find(entry => entry.id === presetId);

    return {
        presetId,
        preset,
        presets,
        maps,
        worldNames,
        swipeIndex: getCurrentSwipeIndex(),
        inlineId: getCurrentPresetIdFromOpening(),
    };
}

function hasChatStarted() {
    const chat = getContext().chat;
    return Array.isArray(chat) && chat.length > 1;
}

function getPresetFingerprint(preset, applyMode) {
    return hashString(JSON.stringify({
        content: preset?.content ?? '',
        applyMode,
    }));
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
        appliedAt: new Date().toISOString(),
    };

    await saveChatState();
}

async function applyCurrentPreset({ force = false } = {}) {
    const settings = getSettings();
    if (!settings.enabled && !force) {
        return { ok: false, reason: 'disabled' };
    }

    if (hasChatStarted() && !settings.allowAfterChatStarted && !force) {
        const message = 'Chat has already started. Use the manual Apply button if you really want to overwrite opening variables.';
        updateStatus(message, 'warn');
        return { ok: false, reason: 'chat-started' };
    }

    if (!await waitForMvuApi()) {
        const message = 'MVU global API is not ready. Make sure MVU is installed and enabled.';
        updateStatus(message, 'warn');
        return { ok: false, reason: 'mvu-not-ready' };
    }

    const resolved = await resolveCurrentPreset();
    if (!resolved.preset) {
        const message = `No preset found for id '${resolved.presetId}'.`;
        updateStatus(message, 'warn');
        return { ok: false, reason: 'not-found', resolved };
    }

    const fingerprint = getPresetFingerprint(resolved.preset, settings.applyMode);
    if (!force && isPresetAlreadyApplied(resolved.presetId, fingerprint)) {
        const message = `Preset '${resolved.presetId}' is already applied for opening #${resolved.swipeIndex}.`;
        updateStatus(message, 'ok');
        return { ok: true, skipped: true, resolved };
    }

    const parsed = parseData(resolved.preset.content);
    const currentData = getOpeningMvuData() ?? createEmptyMvuData();
    const nextData = buildNextMvuData(currentData, parsed, settings.applyMode);
    await replaceOpeningMvuData(nextData);
    await markApplied(resolved.presetId, resolved.preset, settings.applyMode, fingerprint);

    const message = `Applied preset '${resolved.presetId}' from '${resolved.preset.worldName}' using ${settings.applyMode} mode.`;
    updateStatus(message, 'ok');
    showToast('success', message);
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
        logError('Auto apply failed', error);
        updateStatus(`Auto apply failed: ${error.message}`, 'error');
    }
}

async function scanCurrentPreset() {
    try {
        const resolved = await resolveCurrentPreset();
        if (resolved.preset) {
            const source = resolved.inlineId ? 'inline tag' : resolved.maps.length ? 'map/index' : 'swipe index';
            updateStatus(
                `Opening #${resolved.swipeIndex} resolves to preset '${resolved.presetId}' from '${resolved.preset.worldName}' (${source}).`,
                'ok'
            );
        } else {
            updateStatus(
                `Opening #${resolved.swipeIndex} resolves to '${resolved.presetId}', but no matching [MVU_INIT_PRESET:${resolved.presetId}] entry was found. Loaded books: ${resolved.worldNames.join(', ') || 'none'}.`,
                'warn'
            );
        }
    } catch (error) {
        logError('Preset scan failed', error);
        updateStatus(`Preset scan failed: ${error.message}`, 'error');
    }
}

function updateStatus(message, type = 'info') {
    const status = document.getElementById(`${MODULE_NAME}_status`);
    if (!status) {
        return;
    }

    status.textContent = message;
    status.dataset.type = type;
}

function renderSettings() {
    if (document.getElementById(`${MODULE_NAME}_settings`)) {
        return;
    }

    const settingsTarget = document.querySelector('#extensions_settings2');
    if (!settingsTarget) {
        console.warn(`[${DISPLAY_NAME}] Extension settings panel was not found.`);
        return;
    }

    const settings = getSettings();
    const container = document.createElement('div');
    container.id = `${MODULE_NAME}_settings`;
    container.className = 'mvu-initvar-switcher-settings';
    container.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>MVU InitVar Switcher</b>
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
                    <option value="active">Active character/chat/global books</option>
                    <option value="all">All loaded world info books</option>
                </select>
                <div class="mvu-initvar-switcher-actions">
                    <button id="${MODULE_NAME}_scan" class="menu_button" type="button">Scan Current Preset</button>
                    <button id="${MODULE_NAME}_apply" class="menu_button" type="button">Apply Current Preset</button>
                </div>
                <div id="${MODULE_NAME}_status" class="mvu-initvar-switcher-status" data-type="info">
                    Ready. Current opening defaults to [MVU_INIT_PRESET:swipeIndex].
                </div>
            </div>
        </div>
    `;

    settingsTarget.append(container);

    const enabled = document.getElementById(`${MODULE_NAME}_enabled`);
    const auto = document.getElementById(`${MODULE_NAME}_auto`);
    const afterStarted = document.getElementById(`${MODULE_NAME}_after_started`);
    const toasts = document.getElementById(`${MODULE_NAME}_toasts`);
    const mode = document.getElementById(`${MODULE_NAME}_mode`);
    const source = document.getElementById(`${MODULE_NAME}_source`);

    enabled.checked = !!settings.enabled;
    auto.checked = !!settings.autoApplyOnNewChat;
    afterStarted.checked = !!settings.allowAfterChatStarted;
    toasts.checked = !!settings.showToasts;
    mode.value = settings.applyMode;
    source.value = settings.presetSource;

    enabled.addEventListener('change', () => {
        settings.enabled = enabled.checked;
        saveSettings();
    });
    auto.addEventListener('change', () => {
        settings.autoApplyOnNewChat = auto.checked;
        saveSettings();
    });
    afterStarted.addEventListener('change', () => {
        settings.allowAfterChatStarted = afterStarted.checked;
        saveSettings();
    });
    toasts.addEventListener('change', () => {
        settings.showToasts = toasts.checked;
        saveSettings();
    });
    mode.addEventListener('change', () => {
        settings.applyMode = mode.value === 'merge' ? 'merge' : 'replace';
        saveSettings();
    });
    source.addEventListener('change', () => {
        settings.presetSource = source.value === 'all' ? 'all' : 'active';
        saveSettings();
    });

    document.getElementById(`${MODULE_NAME}_scan`)?.addEventListener('click', scanCurrentPreset);
    document.getElementById(`${MODULE_NAME}_apply`)?.addEventListener('click', async () => {
        try {
            await applyCurrentPreset({ force: true });
        } catch (error) {
            logError('Manual apply failed', error);
            updateStatus(`Manual apply failed: ${error.message}`, 'error');
        }
    });
}

function registerEvents() {
    const context = getContext();
    const eventSource = context.eventSource;
    const eventTypes = context.eventTypes ?? context.event_types ?? {};
    if (!eventSource?.on) {
        updateStatus('SillyTavern event API is unavailable.', 'warn');
        return;
    }

    const delayedAutoApply = () => setTimeout(autoApplyCurrentPreset, 300);
    for (const eventType of [eventTypes.CHAT_CHANGED, eventTypes.CHAT_CREATED, eventTypes.MESSAGE_SWIPED, eventTypes.WORLDINFO_UPDATED]) {
        if (eventType && !registeredEventTypes.has(eventType)) {
            registeredEventTypes.add(eventType);
            eventSource.on(eventType, delayedAutoApply);
        }
    }
}

function init() {
    if (didInit) {
        return;
    }

    didInit = true;
    getSettings();
    renderSettings();
    registerEvents();
    setTimeout(autoApplyCurrentPreset, 500);
}

const context = getContext();
const eventTypes = context.eventTypes ?? context.event_types ?? {};
if (context.eventSource?.on && eventTypes.APP_READY) {
    context.eventSource.on(eventTypes.APP_READY, init);
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

globalThis.MvuInitVarSwitcher = {
    applyCurrentPreset,
    scanCurrentPreset,
    resolveCurrentPreset,
};
