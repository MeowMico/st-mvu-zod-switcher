# Example World Info Entries

These are fake sample entries for card authors. They are not real SillyTavern data.

## Entry Comment

```text
[MVU_INIT_PRESET:0] Church opening variables
```

## Entry Content

```yaml
location:
  id: church
  name: Old Chapel
time:
  day: 1
  hour: 8
player:
  hp: 100
  inventory:
    - candle
    - old key
    - copper coin
npcs:
  priestess:
    trust: 10
    met: true
```

## Entry Comment

```text
[MVU_INIT_PRESET:1] Forest opening variables
```

## Entry Content

```yaml
location:
  id: forest
  name: Moonlit Forest
time:
  day: 1
  hour: 23
player:
  hp: 72
  inventory:
    - broken lantern
npcs:
  wolf:
    hostility: 35
    met: true
```

## Optional Map Entry Comment

```text
[MVU_INIT_MAP]
```

## Optional Map Entry Content

```json
{
  "0": "church",
  "1": "forest"
}
```

With the map above, rename the preset comments to:

```text
[MVU_INIT_PRESET:church] Church opening variables
[MVU_INIT_PRESET:forest] Forest opening variables
```

## MVU Two-Item Array Note

MVU treats a two-item array whose second item is a string as a value plus description, for example:

```yaml
hp:
  - 100
  - Current hit points.
```

Use three or more items, object entries, or an explicit schema when you want an ordinary array that happens to contain exactly two strings.
