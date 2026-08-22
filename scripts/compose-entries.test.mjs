/**
 * Offline simulation of the DSH boot entry composition for the web profile.
 * Uses the same public functions the boot include calls, so the printed
 * entry list is exactly what mounts on restart.
 *
 *   node scripts/compose-entries.test.mjs
 */
const ANCHOR_NODE_MODULES =
  process.env.DSH_ANCHOR_NODE_MODULES ??
  'C:/Users/Chen/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules';
const anchor = `${ANCHOR_NODE_MODULES}/@deepseek-ai/dsh/package.json`;

const { loadProfile, composeEntries } = await import(
  `file:///${ANCHOR_NODE_MODULES}/@deepseek-ai/dsh-app-boot/lib/index.js`
);

const profile = loadProfile('dsh', 'web', anchor);
console.log('profile:', profile.name, '@', profile.dir);
console.log('layers:');
for (const layer of profile.layers) {
  console.log(`  ${layer.packageName}  →  ${layer.patchPath}`);
}

const entries = composeEntries([
  ...profile.layers.map((layer) => layer.patches),
  profile.patches,
]);
console.log('\ncomposed entries:');
for (const entry of entries) {
  console.log(
    `  id=${JSON.stringify(entry.id)} name=${JSON.stringify(entry.name)}` +
      (entry.disabled ? ' DISABLED' : ''),
  );
}

const autoMode = entries.find((entry) => entry.id === 'auto-mode');
if (!autoMode) {
  console.error('\nFAIL: auto-mode entry missing from composed entries');
  process.exit(1);
}
if (autoMode.name !== 'dsh-auto-mode') {
  console.error(`\nFAIL: auto-mode entry has wrong name ${autoMode.name}`);
  process.exit(1);
}
console.log('\nPASS: auto-mode entry is composed and will mount on restart');

const permission = entries.find((entry) => entry.id === 'permission');
if (!permission) {
  console.error('\nFAIL: permission entry missing from composed entries');
  process.exit(1);
}
const autoPreset = permission.config?.presets?.['auto-mode'];
if (autoPreset?.approval !== 'ask') {
  console.error(
    `\nFAIL: auto-mode preset approval must stay the core-valid "ask", got ${JSON.stringify(autoPreset?.approval)}`,
  );
  process.exit(1);
}
if (autoPreset?.sandbox !== 'workspace-write') {
  console.error(
    `\nFAIL: auto-mode preset sandbox must be workspace-write, got ${JSON.stringify(autoPreset?.sandbox)}`,
  );
  process.exit(1);
}
console.log('\nPASS: auto-mode preset is declared with approval=ask and sandbox=workspace-write');
console.log('\npermission entry config:');
console.log(JSON.stringify(permission.config, null, 2));
