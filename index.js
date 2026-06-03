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
let wandMenuInterval = null;
let wandMenuObserver = null;
let didInit = false;

const defaultSettings = Object.freeze({
    enabled: true,
    autoApplyOnNewChat: true,
    applyMode: 'replace',
    presetSource: 'active',
    allowAfterChatStarted: false,
    showToasts: true,
    openingPresetMaps: {},
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
            extensionSettings[MODULE_NAME][key] = isPlainObject(value) || Array.isArray(value) ? deepClone(value) : value;
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

function getCurrentCharacter() {
    const context = getContext();
    return Array.isArray(context.characters) ? context.characters[context.characterId] ?? null : null;
}

function getCurrentCharacterKey() {
    const context = getContext();
    const character = getCurrentCharacter();
    const candidates = [
        character?.avatar ? `avatar:${character.avatar}` : null,
        character?.data?.avatar ? `avatar:${character.data.avatar}` : null,
        character?.name ? `name:${character.name}` : null,
        character?.data?.name ? `name:${character.data.name}` : null,
        context.characterId !== undefined && context.characterId !== null ? `id:${context.characterId}` : null,
    ];

    return candidates.find(Boolean) ?? 'current-character';
}

function getOpeningPresetMaps() {
    const settings = getSettings();
    if (!isPlainObject(settings.openingPresetMaps)) {
        settings.openingPresetMaps = {};
    }

    return settings.openingPresetMaps;
}

function getStoredOpeningPresetMap() {
    const maps = getOpeningPresetMaps();
    const characterKey = getCurrentCharacterKey();
    return isPlainObject(maps[characterKey]) ? maps[characterKey] : {};
}

function getMapValue(mapData, swipeIndex) {
    if (!isPlainObject(mapData)) {
        return null;
    }

    const mapped = mapData[String(swipeIndex)] ?? mapData[swipeIndex];
    if (typeof mapped === 'string' || typeof mapped === 'number') {
        const value = String(mapped).trim();
        return value || null;
    }

    return null;
}

function mergePresetMaps(worldMapData, storedMap = getStoredOpeningPresetMap()) {
    const result = {};
    if (isPlainObject(worldMapData)) {
        for (const [key, value] of Object.entries(worldMapData)) {
            const normalized = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
            if (normalized) {
                result[key] = normalized;
            }
        }
    }

    if (isPlainObject(storedMap)) {
        for (const [key, value] of Object.entries(storedMap)) {
            const normalized = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
            if (normalized) {
                result[key] = normalized;
            }
        }
    }

    return Object.keys(result).length > 0 ? result : null;
}

function setStoredOpeningPreset(swipeIndex, presetId) {
    const maps = getOpeningPresetMaps();
    const characterKey = getCurrentCharacterKey();
    const key = String(swipeIndex);
    const normalizedPresetId = String(presetId ?? '').trim();
    const characterMap = isPlainObject(maps[characterKey]) ? maps[characterKey] : (maps[characterKey] = {});

    if (normalizedPresetId) {
        characterMap[key] = normalizedPresetId;
    } else {
        delete characterMap[key];
    }

    if (Object.keys(characterMap).length === 0) {
        delete maps[characterKey];
    }

    saveSettings();
}

function clearStoredOpeningPresetMap() {
    const maps = getOpeningPresetMaps();
    delete maps[getCurrentCharacterKey()];
    saveSettings();
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

function normalizeOpeningText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function getOpeningPreview(value, maxLength = 120) {
    const text = normalizeOpeningText(value);
    if (!text) {
        return '(empty opening)';
    }

    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function getStringValue(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value;
        }
    }

    return '';
}

function getArrayValue(...values) {
    for (const value of values) {
        if (Array.isArray(value)) {
            return value;
        }
    }

    return [];
}

function getChatOpeningRows() {
    const opening = getCurrentOpeningMessage();
    if (Array.isArray(opening?.swipes) && opening.swipes.length > 0) {
        return opening.swipes.map((text, index) => ({
            index,
            text: String(text ?? ''),
            source: 'current chat swipes',
        }));
    }

    if (opening?.mes) {
        return [{
            index: getCurrentSwipeIndex(),
            text: String(opening.mes),
            source: 'current chat opening',
        }];
    }

    return [];
}

function getCardOpeningRows() {
    const character = getCurrentCharacter();
    if (!character) {
        return [];
    }

    const firstMessage = getStringValue(
        character.first_mes,
        character.mes,
        character.data?.first_mes,
        character.data?.mes
    );
    const alternateGreetings = getArrayValue(
        character.alternate_greetings,
        character.alternateGreetings,
        character.data?.alternate_greetings,
        character.data?.alternateGreetings,
        character.data?.extensions?.alternate_greetings,
        character.data?.extensions?.alternateGreetings
    );
    const rows = [];

    if (firstMessage) {
        rows.push({
            index: 0,
            text: firstMessage,
            source: 'current character card',
        });
    }

    alternateGreetings.forEach((text, index) => {
        if (typeof text === 'string') {
            rows.push({
                index: index + 1,
                text,
                source: 'current character card',
            });
        }
    });

    return rows;
}

function getOpeningRows() {
    const cardRows = getCardOpeningRows();
    const chatRows = getChatOpeningRows();
    return cardRows.length >= chatRows.length ? cardRows : chatRows;
}

function getPresetIdFromText(text) {
    for (const pattern of INLINE_PRESET_PATTERNS) {
        const match = String(text ?? '').match(pattern);
        if (match?.[1]?.trim()) {
            return match[1].trim();
        }
    }

    return null;
}

function getCurrentPresetIdFromOpening() {
    return getPresetIdFromText(getCurrentOpeningText());
}

function getCurrentPresetId(mapData = null) {
    const inlineId = getCurrentPresetIdFromOpening();
    if (inlineId) {
        return inlineId;
    }

    const swipeIndex = getCurrentSwipeIndex();
    if (mapData) {
        const mapped = getMapValue(mapData, swipeIndex);
        if (mapped) {
            return mapped;
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
    const worldMapData = parseFirstMap(maps);
    const storedMap = getStoredOpeningPresetMap();
    const mapData = mergePresetMaps(worldMapData, storedMap);
    const swipeIndex = getCurrentSwipeIndex();
    const presetId = getCurrentPresetId(mapData);
    const preset = presets.find(entry => entry.id === presetId);
    const inlineId = getCurrentPresetIdFromOpening();
    const storedId = getMapValue(storedMap, swipeIndex);
    const worldMapId = getMapValue(worldMapData, swipeIndex);
    const mapSource = inlineId ? 'inline tag' : storedId ? 'workbench map' : worldMapId ? 'worldbook map' : 'swipe index';

    return {
        presetId,
        preset,
        presets,
        maps,
        worldMapData,
        storedMap,
        mapData,
        mapSource,
        worldNames,
        swipeIndex,
        inlineId,
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
            updateStatus(
                `Opening #${resolved.swipeIndex} resolves to preset '${resolved.presetId}' from '${resolved.preset.worldName}' (${resolved.mapSource}).`,
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

let mappingRenderToken = 0;

function getPresetOptions(presets) {
    const groups = new Map();
    for (const preset of presets) {
        const id = String(preset.id ?? '').trim();
        if (!id) {
            continue;
        }

        if (!groups.has(id)) {
            groups.set(id, {
                id,
                count: 0,
                worldNames: new Set(),
            });
        }

        const group = groups.get(id);
        group.count += 1;
        if (preset.worldName) {
            group.worldNames.add(preset.worldName);
        }
    }

    return [...groups.values()].sort((left, right) => left.id.localeCompare(right.id, undefined, {
        numeric: true,
        sensitivity: 'base',
    }));
}

function getPresetOptionLabel(option) {
    const worldNames = [...option.worldNames].join(', ') || 'unknown worldbook';
    const duplicateText = option.count > 1 ? `, ${option.count} entries` : '';
    return `${option.id} (${worldNames}${duplicateText})`;
}

function getSortedMapEntries(mapData) {
    if (!isPlainObject(mapData)) {
        return [];
    }

    return Object.entries(mapData)
        .map(([key, value]) => [String(key), String(value ?? '').trim()])
        .filter(([, value]) => value)
        .sort(([leftKey], [rightKey]) => {
            const leftNumber = Number(leftKey);
            const rightNumber = Number(rightKey);
            if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
                return leftNumber - rightNumber;
            }

            return leftKey.localeCompare(rightKey, undefined, { numeric: true });
        });
}

function formatMapEntries(entries, limit = 8) {
    if (entries.length === 0) {
        return 'none';
    }

    const visibleEntries = entries.slice(0, limit).map(([key, value]) => `#${key} -> ${value}`);
    return entries.length > limit ? `${visibleEntries.join(', ')}, ...` : visibleEntries.join(', ');
}

function getOpeningPresetResolutionForRow(row, worldMapData, storedMap) {
    const inlineId = getPresetIdFromText(row.text);
    if (inlineId) {
        return { presetId: inlineId, source: 'inline marker' };
    }

    const storedId = getMapValue(storedMap, row.index);
    if (storedId) {
        return { presetId: storedId, source: 'workbench map' };
    }

    const worldMapId = getMapValue(worldMapData, row.index);
    if (worldMapId) {
        return { presetId: worldMapId, source: 'worldbook map' };
    }

    return { presetId: String(row.index), source: 'swipe index' };
}

function renderMappingSummary({ presets, maps, worldNames, rows, worldMapData, storedMap }) {
    const summary = document.getElementById(`${MODULE_NAME}_mapper_summary`);
    if (!summary) {
        return;
    }

    const presetIds = new Set(presets.map(preset => String(preset.id)));
    const missingIds = new Set();
    for (const row of rows) {
        const resolution = getOpeningPresetResolutionForRow(row, worldMapData, storedMap);
        if (!presetIds.has(resolution.presetId)) {
            missingIds.add(resolution.presetId);
        }
    }

    const currentResolution = getOpeningPresetResolutionForRow({
        index: getCurrentSwipeIndex(),
        text: getCurrentOpeningText(),
    }, worldMapData, storedMap);
    const storedEntries = getSortedMapEntries(storedMap);
    const worldMapEntries = getSortedMapEntries(worldMapData);
    const lines = [
        `${rows.length} opening(s), ${presets.length} preset entry/entries, ${worldNames.length} loaded worldbook(s).`,
        `Current opening #${getCurrentSwipeIndex()} -> ${currentResolution.presetId} (${currentResolution.source}).`,
        `Workbench map: ${formatMapEntries(storedEntries)}.`,
    ];

    if (worldMapEntries.length > 0) {
        lines.push(`[MVU_INIT_MAP]: ${formatMapEntries(worldMapEntries)}.`);
    }
    if (maps.length > 1) {
        lines.push(`${maps.length} [MVU_INIT_MAP] entries were found; the first valid one is used before workbench overrides.`);
    }
    if (missingIds.size > 0) {
        lines.push(`Missing preset id(s): ${[...missingIds].join(', ')}.`);
    }

    summary.textContent = lines.join('\n');
    summary.dataset.type = missingIds.size > 0 || presets.length === 0 ? 'warn' : 'ok';
}

async function copyOpeningPresetMap() {
    const storedMap = getStoredOpeningPresetMap();
    const entries = getSortedMapEntries(storedMap);
    if (entries.length === 0) {
        updateStatus('No workbench mappings to copy yet.', 'warn');
        return;
    }

    const text = JSON.stringify(Object.fromEntries(entries), null, 2);
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            updateStatus('Copied workbench map JSON. Put it in a disabled [MVU_INIT_MAP] worldbook entry if you want to ship it that way.', 'ok');
            return;
        }
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Clipboard copy failed`, error);
    }

    globalThis.prompt?.('Copy this [MVU_INIT_MAP] JSON:', text);
    updateStatus('Clipboard API was unavailable. A copy dialog was opened instead.', 'warn');
}

async function renderMappingEditor() {
    const mapper = document.getElementById(`${MODULE_NAME}_mapper`);
    if (!mapper) {
        return;
    }

    const token = ++mappingRenderToken;
    mapper.setAttribute('aria-busy', 'true');
    mapper.textContent = 'Scanning current openings and preset worldbook entries...';

    try {
        const rows = getOpeningRows();
        const { presets, maps, worldNames } = await loadPresetEntries();
        if (token !== mappingRenderToken) {
            return;
        }

        const worldMapData = parseFirstMap(maps);
        const storedMap = getStoredOpeningPresetMap();
        const presetOptions = getPresetOptions(presets);
        const presetIds = new Set(presetOptions.map(option => option.id));
        const currentSwipeIndex = getCurrentSwipeIndex();
        const fragment = document.createDocumentFragment();

        mapper.textContent = '';
        mapper.removeAttribute('aria-busy');

        if (rows.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'mvu-initvar-switcher-empty';
            empty.textContent = 'No current opening was found for this character/chat.';
            fragment.append(empty);
        }

        for (const row of rows) {
            const savedId = getMapValue(storedMap, row.index);
            const inheritedId = getMapValue(worldMapData, row.index);
            const inlineId = getPresetIdFromText(row.text);
            const resolution = getOpeningPresetResolutionForRow(row, worldMapData, storedMap);
            const rowElement = document.createElement('div');
            const selectId = `${MODULE_NAME}_opening_${row.index}`;
            rowElement.className = 'mvu-initvar-switcher-mapping-row';
            if (row.index === currentSwipeIndex) {
                rowElement.dataset.current = 'true';
            }

            const label = document.createElement('label');
            label.className = 'mvu-initvar-switcher-mapping-label';
            label.htmlFor = selectId;

            const title = document.createElement('span');
            title.className = 'mvu-initvar-switcher-mapping-title';
            title.textContent = `Opening #${row.index}${row.index === currentSwipeIndex ? ' (current)' : ''}`;

            const preview = document.createElement('span');
            preview.className = 'mvu-initvar-switcher-mapping-preview';
            preview.textContent = getOpeningPreview(row.text);

            label.append(title, preview);

            const select = document.createElement('select');
            select.id = selectId;
            select.className = 'text_pole mvu-initvar-switcher-mapping-select';

            const defaultOption = document.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent = inlineId
                ? `Use inline marker: ${inlineId}`
                : inheritedId
                    ? `Use [MVU_INIT_MAP]: ${inheritedId}`
                    : `Use default [MVU_INIT_PRESET:${row.index}]`;
            select.append(defaultOption);

            for (const optionData of presetOptions) {
                const option = document.createElement('option');
                option.value = optionData.id;
                option.textContent = getPresetOptionLabel(optionData);
                select.append(option);
            }

            if (savedId && !presetIds.has(savedId)) {
                const missingOption = document.createElement('option');
                missingOption.value = savedId;
                missingOption.textContent = `${savedId} (saved, not found)`;
                select.append(missingOption);
            }

            select.value = savedId ?? '';
            select.addEventListener('change', () => {
                setStoredOpeningPreset(row.index, select.value);
                updateStatus(select.value
                    ? `Opening #${row.index} now maps to preset '${select.value}'.`
                    : `Opening #${row.index} now uses its inline/worldbook/default mapping.`,
                'ok');
                void renderMappingEditor();
            });

            const meta = document.createElement('div');
            meta.className = 'mvu-initvar-switcher-mapping-meta';
            meta.textContent = `Effective: ${resolution.presetId} (${resolution.source})${presetIds.has(resolution.presetId) ? '' : ' - preset not found'}; source: ${row.source}.`;

            rowElement.append(label, select, meta);
            fragment.append(rowElement);
        }

        mapper.append(fragment);
        renderMappingSummary({ presets, maps, worldNames, rows, worldMapData, storedMap });
    } catch (error) {
        mapper.removeAttribute('aria-busy');
        mapper.textContent = `Workbench scan failed: ${error.message}`;
        const summary = document.getElementById(`${MODULE_NAME}_mapper_summary`);
        if (summary) {
            summary.textContent = '';
            summary.dataset.type = 'error';
        }
        logError('Workbench scan failed', error);
    }
}

function getDefaultSettingsTarget() {
    return document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings') ?? document.body;
}

function renderSettings(target = getDefaultSettingsTarget()) {
    const existing = document.getElementById(`${MODULE_NAME}_settings`);
    if (existing) {
        if (existing.parentElement !== target) {
            target.append(existing);
        }
        void renderMappingEditor();
        return existing;
    }

    if (!target) {
        console.warn(`[${DISPLAY_NAME}] Extension settings panel was not found.`);
        return null;
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
                <fieldset class="mvu-initvar-switcher-fieldset">
                    <legend>Switcher</legend>
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
                </fieldset>
                <fieldset class="mvu-initvar-switcher-fieldset">
                    <legend>Opening Workbench</legend>
                    <div class="mvu-initvar-switcher-actions">
                        <button id="${MODULE_NAME}_refresh_map" class="menu_button" type="button">Refresh Openings/Presets</button>
                        <button id="${MODULE_NAME}_copy_map" class="menu_button" type="button">Copy [MVU_INIT_MAP] JSON</button>
                        <button id="${MODULE_NAME}_clear_map" class="menu_button" type="button">Clear Workbench Map</button>
                    </div>
                    <div id="${MODULE_NAME}_mapper_summary" class="mvu-initvar-switcher-summary" role="status" aria-live="polite"></div>
                    <div id="${MODULE_NAME}_mapper" class="mvu-initvar-switcher-mapper" role="region" aria-label="Opening to initvar preset mapping" aria-live="polite"></div>
                </fieldset>
                <div id="${MODULE_NAME}_status" class="mvu-initvar-switcher-status" data-type="info">
                    Ready. Current opening defaults to [MVU_INIT_PRESET:swipeIndex].
                </div>
            </div>
        </div>
    `;

    target.append(container);

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
        void renderMappingEditor();
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
    document.getElementById(`${MODULE_NAME}_refresh_map`)?.addEventListener('click', () => {
        void renderMappingEditor();
    });
    document.getElementById(`${MODULE_NAME}_copy_map`)?.addEventListener('click', () => {
        void copyOpeningPresetMap();
    });
    document.getElementById(`${MODULE_NAME}_clear_map`)?.addEventListener('click', () => {
        const hasMap = getSortedMapEntries(getStoredOpeningPresetMap()).length > 0;
        if (!hasMap || globalThis.confirm?.('Clear workbench mappings for the current character?') !== false) {
            clearStoredOpeningPresetMap();
            updateStatus('Workbench mappings cleared for the current character.', 'ok');
            void renderMappingEditor();
        }
    });

    void renderMappingEditor();

    return container;
}

function closeSettingsDialog() {
    const modal = document.getElementById(`${MODULE_NAME}_modal`);
    if (modal) {
        modal.hidden = true;
    }
    renderSettings();
}

function openSettingsDialog() {
    let modal = document.getElementById(`${MODULE_NAME}_modal`);
    if (!modal) {
        modal = document.createElement('div');
        modal.id = `${MODULE_NAME}_modal`;
        modal.className = 'mvu-initvar-switcher-modal';
        modal.innerHTML = `
            <div class="mvu-initvar-switcher-dialog" role="dialog" aria-modal="true" aria-labelledby="${MODULE_NAME}_modal_title">
                <div class="mvu-initvar-switcher-dialog-header">
                    <h3 id="${MODULE_NAME}_modal_title">MVU InitVar Switcher</h3>
                    <button id="${MODULE_NAME}_modal_close" class="menu_button" type="button" aria-label="Close MVU InitVar Switcher">Close</button>
                </div>
                <div id="${MODULE_NAME}_modal_body" class="mvu-initvar-switcher-dialog-body"></div>
            </div>
        `;

        document.body.append(modal);
        modal.addEventListener('click', event => {
            if (event.target === modal) {
                closeSettingsDialog();
            }
        });
        document.getElementById(`${MODULE_NAME}_modal_close`)?.addEventListener('click', closeSettingsDialog);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !modal?.hidden) {
                closeSettingsDialog();
            }
        });
    }

    modal.hidden = false;
    const body = document.getElementById(`${MODULE_NAME}_modal_body`);
    if (body) {
        renderSettings(body);
    }
    document.getElementById(`${MODULE_NAME}_modal_close`)?.focus();
}

function getWandMenuContainer() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        return null;
    }

    let container = document.getElementById(`${MODULE_NAME}_wand_container`);
    if (!container) {
        container = document.createElement('div');
        container.id = `${MODULE_NAME}_wand_container`;
        container.className = 'extension_container';
        menu.prepend(container);
    } else if (container.parentElement !== menu) {
        menu.prepend(container);
    }

    return container;
}

function buildWandMenuItem() {
    const item = document.createElement('div');
    item.id = `${MODULE_NAME}_wand_item`;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('title', 'Open MVU InitVar Switcher');
    item.innerHTML = `
        <div class="fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton" title="Open MVU InitVar Switcher"></div>
        <span>MVU InitVar Switcher</span>
    `;

    const activate = () => openSettingsDialog();
    item.addEventListener('click', activate);
    item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate();
        }
    });

    return item;
}

function registerWandMenu() {
    const container = getWandMenuContainer();
    if (!container) {
        return;
    }

    if (!document.getElementById(`${MODULE_NAME}_wand_item`)) {
        container.prepend(buildWandMenuItem());
    }

    const button = document.getElementById('extensionsMenuButton');
    if (button) {
        button.style.display = 'flex';
    }
}

function keepWandMenuRegistered() {
    registerWandMenu();

    if (!wandMenuInterval) {
        wandMenuInterval = setInterval(registerWandMenu, 1500);
    }

    const menu = document.getElementById('extensionsMenu');
    if (menu && !wandMenuObserver) {
        wandMenuObserver = new MutationObserver(() => registerWandMenu());
        wandMenuObserver.observe(menu, { childList: true, subtree: false });
    }
}

function registerEvents() {
    const context = getContext();
    const eventSource = context.eventSource;
    const eventTypes = context.eventTypes ?? context.event_types ?? {};
    if (!eventSource?.on) {
        updateStatus('SillyTavern event API is unavailable.', 'warn');
        return;
    }

    const delayedAutoApply = () => setTimeout(() => {
        void autoApplyCurrentPreset();
        void renderMappingEditor();
    }, 300);
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
    keepWandMenuRegistered();
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
    openSettingsDialog,
    registerWandMenu,
    resolveCurrentPreset,
};
