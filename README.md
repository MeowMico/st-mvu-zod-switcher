# MVU InitVar Switcher

MVU InitVar Switcher is a local SillyTavern extension that applies different MVU/Zod initialization presets based on the selected opening swipe.

It is designed for cards where each opening needs a very different MVU `stat_data` setup.

## Two Versions

This repository now contains two ways to use the switcher:

- **SillyTavern extension version**: install this folder as a third-party extension.
- **Tavern Helper character script version**: build or copy `dist/mvu-initvar-switcher.th.js` into a Tavern Helper character script so it can be exported with a character card.

The Tavern Helper version is the recommended publishing path for card authors who already ship Tavern Helper scripts with their cards. Players still need Tavern Helper and MVU/MagVarUpdate enabled; this script does not auto-import MVU from the network.

## What It Does

- Reads the current opening swipe index.
- Finds a matching world info entry named `[MVU_INIT_PRESET:N]`.
- Parses that entry as JSON or YAML.
- Writes the result into MVU data for message 0's current swipe.
- Records which preset was applied in chat metadata to avoid repeat overwrites.

The preset entries are not normal MVU `[initvar]` entries. They are a preset pool for this switcher to read.

## Installation

Install this folder as a third-party SillyTavern extension.

Typical all-user development path:

```text
SillyTavern/public/scripts/extensions/third-party/st-mvu-zod-switcher
```

Then enable `MVU InitVar Switcher` in SillyTavern's extension manager.

## Tavern Helper Character Script Version

Build the release files:

```bash
npm install
npm run build
```

Outputs:

```text
dist/mvu-initvar-switcher.th.js
dist/install-character-script.js
```

Author workflow:

1. Enable Tavern Helper and MVU/MagVarUpdate in SillyTavern.
2. Put your `[MVU_INIT_PRESET:*]` entries in the character/global worldbook, disabled/off.
3. Copy `dist/mvu-initvar-switcher.th.js` into the current character's Tavern Helper script library, or run `dist/install-character-script.js` once from a Tavern Helper script context to install/update it for the current character.
4. Keep the script enabled before exporting the character card. Tavern Helper character scripts are exported with the character card.

The script adds three optional troubleshooting buttons:

- `扫描当前预设`: checks which preset the current opening resolves to.
- `手动应用当前预设`: force-applies the current preset even after chat has started.
- `清除已应用记录`: clears this chat's applied-preset record so the same preset can auto-apply again.

## Basic Author Workflow

Create one world info entry for each opening:

```text
[MVU_INIT_PRESET:0] Church opening variables
[MVU_INIT_PRESET:1] Forest opening variables
[MVU_INIT_PRESET:2] Academy opening variables
```

Keep these preset entries disabled/off, the same way you usually keep MVU `[initvar]` entries disabled. The switcher can still read them through SillyTavern's loaded world info data, and disabling them prevents the YAML from being injected into the model prompt.

The default binding is:

```text
opening swipe 0 -> [MVU_INIT_PRESET:0]
opening swipe 1 -> [MVU_INIT_PRESET:1]
opening swipe 2 -> [MVU_INIT_PRESET:2]
```

No tag is required inside the opening text.

## Preset Content

A preset can contain plain MVU initvar YAML:

```yaml
location: church
time:
  day: 1
  hour: 8
hero:
  hp: 100
  inventory:
    - candle
    - old key
    - copper coin
```

Or full MVU data:

```yaml
stat_data:
  location: church
  time:
    day: 1
    hour: 8
schema:
  type: object
  properties: {}
```

Code fences and `<initvar>...</initvar>` wrappers are accepted, so existing initvar content can usually be copied without rewriting the body.

## Optional Mapping Entry

If you want readable preset IDs without editing opening text, add one entry named:

```text
[MVU_INIT_MAP]
```

Content:

```json
{
  "0": "church",
  "1": "forest",
  "2": "academy"
}
```

Then create:

```text
[MVU_INIT_PRESET:church]
[MVU_INIT_PRESET:forest]
[MVU_INIT_PRESET:academy]
```

## Optional Inline Override

For maximum stability after opening reorder, an opening can include:

```html
<mvu-init-preset>church</mvu-init-preset>
```

Or the less visible HTML comment form:

```html
<!-- mvu-init-preset:church -->
```

This is optional. If present, it overrides the map and swipe index. The map entry is still the cleanest option when you do not want control markers in the opening message text at all.

## MVU Value Descriptions

MVU treats any two-item array whose second item is a string as a `ValueWithDescription`:

```yaml
hp:
  - 100
  - Current hit points.
```

The switcher mirrors that behavior when it generates a schema, so the example above becomes a number variable with a preserved description, not a normal array variable.

Because this is MVU's native rule, avoid writing a real two-item string list like `["candle", "old key"]` unless you also provide an explicit schema. Add another item or use object-shaped inventory entries if you want an ordinary array.

## Apply Modes

- `replace`: replaces `stat_data` with the preset. This is the recommended default when openings differ heavily.
- `merge`: recursively overlays the preset onto existing `stat_data`.

If the preset contains a `schema` object, the extension also applies it. In `replace` mode, plain YAML/JSON presets get a generated basic schema so the previous opening's schema is not accidentally reused. In `merge` mode, the extension keeps the current schema unless the preset provides one.

## Why Not Use Multiple `[initvar]` Entries?

MVU's native `[initvar]` loader treats matching entries as initialization sources. Multiple opening-specific `[initvar]` entries can be merged together instead of selected one-by-one.

This extension intentionally uses `[MVU_INIT_PRESET:N]` so MVU does not auto-load those entries. The switcher reads the selected preset and writes it to MVU data directly.

## Safety Notes

- This extension does not read files from disk.
- It only uses SillyTavern's in-browser context and loaded world info APIs.
- It does not inject preset text into the model prompt.
- It refuses automatic overwrite after the chat has started unless you enable that setting.
- Manual apply can overwrite message 0 variables, so use it carefully after a chat has progressed.
- If a preset entry changes, the switcher detects the content change and can auto-apply it again for the same opening.

## UI

The extension settings panel provides:

- Enable switcher.
- Auto-apply on new chat / opening swipe.
- Allow auto overwrite after chat has started.
- Apply mode: `replace` or `merge`.
- Preset search scope.
- Scan Current Preset.
- Apply Current Preset.

## Current Compatibility Layer

The extension expects MVU to expose this global API:

```js
Mvu.getMvuData({ type: 'message', message_id: 0 })
Mvu.replaceMvuData(data, { type: 'message', message_id: 0 })
```

If MVU is not installed, disabled, or has not initialized yet, the switcher shows an error and does not write variables.
