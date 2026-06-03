import * as esbuild from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(rootDir, 'dist');
const outFile = resolve(distDir, 'mvu-initvar-switcher.th.js');
const coreOutFile = resolve(distDir, 'mvu-initvar-switcher.core.mjs');
const installOutFile = resolve(distDir, 'install-character-script.js');

await mkdir(distDir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(rootDir, 'src/tavern-helper/index.ts')],
  outfile: outFile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  legalComments: 'none',
  banner: {
    js: '// MVU InitVar Switcher - Tavern Helper character script\n',
  },
});

await esbuild.build({
  entryPoints: [resolve(rootDir, 'src/tavern-helper/core.ts')],
  outfile: coreOutFile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  legalComments: 'none',
});

const scriptContent = await readFile(outFile, 'utf8');
const installSnippet = `// Install MVU InitVar Switcher into the current character's Tavern Helper script library.\n` +
  `// Run this once inside a Tavern Helper script context, then export the character card.\n` +
  `(() => {\n` +
  `  const SCRIPT_NAME = 'MVU InitVar Switcher';\n` +
  `  const SCRIPT_ID = 'mvu_initvar_switcher_th';\n` +
  `  const SCRIPT_CONTENT = ${JSON.stringify(scriptContent)};\n` +
  `  const BUTTONS = [\n` +
  `    { name: '扫描当前预设', visible: true },\n` +
  `    { name: '手动应用当前预设', visible: true },\n` +
  `    { name: '清除已应用记录', visible: true },\n` +
  `  ];\n` +
  `\n` +
  `  if (typeof updateScriptTreesWith !== 'function') {\n` +
  `    throw new Error('Tavern Helper updateScriptTreesWith API was not found.');\n` +
  `  }\n` +
  `\n` +
  `  updateScriptTreesWith((trees) => {\n` +
  `    const nextTrees = Array.isArray(trees) ? [...trees] : [];\n` +
  `    const nextScript = {\n` +
  `      type: 'script',\n` +
  `      id: SCRIPT_ID,\n` +
  `      name: SCRIPT_NAME,\n` +
  `      enabled: true,\n` +
  `      content: SCRIPT_CONTENT,\n` +
  `      info: 'Switches MVU initvar presets based on the current opening swipe.',\n` +
  `      button: { enabled: true, buttons: BUTTONS },\n` +
  `      data: {},\n` +
  `      export_with: { data: false, button: true },\n` +
  `    };\n` +
  `\n` +
  `    const upsert = (items) => {\n` +
  `      const index = items.findIndex((item) => item?.type === 'script' && (item.id === SCRIPT_ID || item.name === SCRIPT_NAME));\n` +
  `      if (index >= 0) {\n` +
  `        items[index] = { ...items[index], ...nextScript };\n` +
  `      } else {\n` +
  `        items.push(nextScript);\n` +
  `      }\n` +
  `    };\n` +
  `\n` +
  `    const folder = nextTrees.find((item) => item?.type === 'folder' && item.name === 'MVU InitVar Switcher');\n` +
  `    if (folder) {\n` +
  `      folder.enabled = true;\n` +
  `      folder.scripts = Array.isArray(folder.scripts) ? [...folder.scripts] : [];\n` +
  `      upsert(folder.scripts);\n` +
  `    } else {\n` +
  `      upsert(nextTrees);\n` +
  `    }\n` +
  `\n` +
  `    return nextTrees;\n` +
  `  }, { type: 'character' });\n` +
  `\n` +
  `  console.info('[MVU InitVar Switcher] Installed into the current character script library.');\n` +
  `})();\n`;

await writeFile(installOutFile, installSnippet);

console.log(`Built ${outFile}`);
console.log(`Built ${installOutFile}`);
