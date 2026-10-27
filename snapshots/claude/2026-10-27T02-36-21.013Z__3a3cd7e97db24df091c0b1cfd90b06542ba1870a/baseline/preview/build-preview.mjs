// Bundle the client and the rules engine into one self-contained page: the single-device
// preview, where you play one seat and bots play the rest. No dependencies: a small
// ES-module flattener that knows the shapes this codebase uses.
//   node preview/build-preview.mjs  ->  dist/handshake-preview.html

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'public/app/main.js');
const SPEC_HASH = (readFileSync(join(ROOT, 'src/spec.js'), 'utf8').match(/'([0-9a-f]{64})'/) || [])[1] || 'unknown';

const modules = new Map(); // path -> { id, deps: [{ names, path }], body, exports }
const order = [];

function parse(path, stack = []) {
  if (modules.has(path)) return modules.get(path);
  if (stack.includes(path)) throw new Error('Import cycle: ' + [...stack, path].map((p) => relative(ROOT, p)).join(' -> '));
  let src = readFileSync(path, 'utf8');
  const deps = [];
  src = src.replace(/import\s*\{([\s\S]*?)\}\s*from\s*'([^']+)';?/g, (_, names, spec) => {
    deps.push({ names: names.split(',').map((s) => s.trim()).filter(Boolean), path: resolve(dirname(path), spec) });
    return '';
  });
  if (/^\s*import\s/m.test(src)) throw new Error(`Unsupported import form in ${relative(ROOT, path)}`);
  const exports = [];
  src = src.replace(/^export\s*\{([^}]*)\};?\s*$/gm, (_, names) => {
    for (const n of names.split(',').map((s) => s.trim()).filter(Boolean)) exports.push(n);
    return '';
  });
  src = src.replace(/^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => {
    exports.push(name);
    return `${kind} ${name}`;
  });
  if (/^\s*export\s/m.test(src)) throw new Error(`Unsupported export form in ${relative(ROOT, path)}`);
  const mod = { id: `m${modules.size}`, path, deps, body: src, exports };
  modules.set(path, mod);
  for (const d of deps) parse(d.path, [...stack, path]);
  order.push(mod);
  return mod;
}

parse(ENTRY);

const pieces = order.map((m) => {
  const head = m.deps.map((d) => {
    const dep = modules.get(d.path);
    const fields = d.names.map((n) => {
      const [orig, alias] = n.split(/\s+as\s+/);
      return alias ? `${orig}: ${alias}` : orig;
    });
    return `const { ${fields.join(', ')} } = ${dep.id};`;
  }).join('\n');
  const ret = m.exports.map((n) => {
    const [orig, alias] = n.split(/\s+as\s+/);
    return alias ? `${alias}: ${orig}` : orig;
  });
  return `// ---- ${relative(ROOT, m.path)}\nconst ${m.id} = (() => {\n${head}\n${m.body}\nreturn { ${ret.join(', ')} };\n})();`;
});

const bundle = `(() => {\n'use strict';\nglobalThis.HANDSHAKE_PREVIEW = true;\nglobalThis.HANDSHAKE_SPEC = '${SPEC_HASH}';\n${pieces.join('\n\n')}\n})();`;
const css = readFileSync(join(ROOT, 'public/app/style.css'), 'utf8');
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');

const html = `<title>Handshake</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="Anonymous social deduction on the westward trail. Single-device preview with bots.">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=IM+Fell+English:ital@0;1&display=swap">
<style>
${css}
</style>
<div id="app"></div>
<script>
${safe(bundle)}
</script>
`;

mkdirSync(join(ROOT, 'dist'), { recursive: true });
const out = join(ROOT, 'dist/handshake-preview.html');
writeFileSync(out, html);
console.log(`${relative(ROOT, out)}: ${order.length} modules, ${(html.length / 1024).toFixed(1)} KB, spec ${SPEC_HASH.slice(0, 12)}`);
