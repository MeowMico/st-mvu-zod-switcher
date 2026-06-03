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
export {
  DISPLAY_NAME,
  EXTENSIBLE_MARKER,
  INLINE_PRESET_PATTERNS,
  MAP_COMMENT_PATTERN,
  MODULE_NAME,
  PRESET_COMMENT_PATTERN,
  buildNextMvuData,
  buildSchemaNode,
  cleanMetadata,
  collectPresetEntriesFromWorld,
  createEmptyMvuData,
  deepClone,
  defaultSettings,
  getCurrentPresetId,
  getEntryComment,
  getPresetFingerprint,
  getPresetIdFromOpening,
  hasOwn,
  hashString,
  isPlainObject,
  isValueWithDescription,
  mergeDeep,
  normalizePresetData,
  parseData,
  parseFirstMap,
  stripCodeFence,
  stripInitvarWrapper
};
