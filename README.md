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
- Scans the current character's first message and alternate greetings when SillyTavern exposes them in the browser context.
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

After it loads, open the magic wand menu and choose `MVU InitVar Switcher` to open the same settings panel in a dialog. The panel is still also available in SillyTavern's extension settings area.

### GitHub Extension Install

In SillyTavern's third-party extension installer, use:

```text
https://github.com/MeowMico/st-mvu-zod-switcher
```

For this workbench version, install tag:

```text
v0.2.6
```

After installation, refresh SillyTavern and open the magic wand menu. Choose `MVU InitVar Switcher`.

### Extension Opening Workbench

The extension dialog now includes an `Opening Workbench` section for card authors:

- `Refresh Openings/Presets` scans the current card openings and the currently discoverable character/chat/global worldbooks.
- `Target worldbook` decides where newly saved preset entries and the synced `[initvar]` entry are written.
- `Synced [initvar] entry name` defaults to `[initvar]变量初始化勿开`.
- `Auto-sync the selected preset into one disabled [initvar] entry when applying` keeps a single native MVU initvar slot updated as the player changes openings.
- Each `Opening #N` row shows a preview of that opening and a labeled preset dropdown.
- Leaving a row blank uses the normal fallback: inline marker, then `[MVU_INIT_MAP]`, then `[MVU_INIT_PRESET:N]`.
- Choosing a preset in the dropdown saves a per-current-character workbench map in extension settings. That map overrides `[MVU_INIT_MAP]` for that card while you are testing.
- Expand `Create preset for opening #N` or `Edit preset 'id'` to paste the opening's initvar YAML/JSON directly in the workbench.
- `Save Preset Entry` creates or updates a disabled `[MVU_INIT_PRESET:id]` entry in the target worldbook.
- `Save and Sync [initvar]` also copies that content into the single disabled `[initvar]变量初始化勿开` entry.
- `Sync Current Preset to [initvar]` copies the currently selected opening preset into that same native initvar slot.
- `Copy [MVU_INIT_MAP] JSON` copies the saved workbench map so authors can paste it into a disabled `[MVU_INIT_MAP]` worldbook entry for publishing.
- `Clear Workbench Map` removes the saved frontend bindings for the current character only.

This workbench does not read SillyTavern files from disk. It only uses the current browser-side SillyTavern context and loaded worldbook APIs.

Recommended authoring pattern:

1. Keep many opening-specific presets as disabled `[MVU_INIT_PRESET:*]` entries. MVU's native initvar loader should not treat these as `[initvar]` entries.
2. Keep only one native disabled `[initvar]变量初始化勿开` entry.
3. Let the switcher copy the selected preset into that one native initvar entry and also write the selected variables directly to MVU message 0.

This avoids the old copy/paste cycle where you had to replace the current initvar body by hand whenever you changed openings.

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

It also renders a small settings panel in SillyTavern's extension settings area:

- Enable/disable auto-apply.
- Choose `replace` or `merge` mode.
- Pick whether automatic overwrites after chat start are allowed.
- Map each opening swipe to a discovered `[MVU_INIT_PRESET:*]` entry with accessible labeled selects.
- Copy the saved frontend map as `[MVU_INIT_MAP]` JSON if you want to store the mapping in a worldbook entry instead.

Frontend mappings are saved in the Tavern Helper script variables when that API is available. They override `[MVU_INIT_MAP]`, while inline opening markers such as `<!-- mvu-init-preset:church -->` still have the highest priority.

The same panel is also available from the magic wand menu: open the wand menu and choose `MVU InitVar Switcher`.

If the magic wand menu is rebuilt by another extension and the entry is not visible yet, reload the page after updating the import URL. As a fallback, run this in the browser console:

```js
MvuInitVarSwitcherTH.openSettingsDialog()
```

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
- Opening Workbench: scan current openings, bind each opening to discovered initvar presets, copy a `[MVU_INIT_MAP]` JSON body, and clear saved per-card bindings.
- Authoring controls: create/update disabled `[MVU_INIT_PRESET:*]` entries and sync the selected preset into one disabled native `[initvar]` entry.
- Scan Current Preset.
- Apply Current Preset.

## Current Compatibility Layer

The extension expects MVU to expose this global API:

```js
Mvu.getMvuData({ type: 'message', message_id: 0 })
Mvu.replaceMvuData(data, { type: 'message', message_id: 0 })
```

If MVU is not installed, disabled, or has not initialized yet, the switcher shows an error and does not write variables.
