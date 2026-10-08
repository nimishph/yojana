// Builds the npm package into dist/npm/: the bundled CLI (with the files patra reads next to it)
// under lib/, led by a Bun shebang so it is the package's `yojana` bin, plus README and LICENSE.
// The version is the engine's VERSION, so there is one number to change.
//
//   bun tooling/pack-npm.ts            write dist/npm/
//   cd dist/npm && npm publish         (after bun run check)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '@cntxt-labs/yojana';

const root = join(import.meta.dir, '..');
const out = join(root, 'dist', 'npm');
const lib = join(root, 'claude-plugin', 'lib');

const check = Bun.spawnSync(['bun', join(root, 'tooling', 'bundle-plugin.ts'), '--check'], {
  stderr: 'inherit',
});
if (check.exitCode !== 0) process.exit(1);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(lib, join(out, 'lib'), { recursive: true });
const bin = join(out, 'lib', 'yojana.js');
writeFileSync(bin, `#!/usr/bin/env bun\n${readFileSync(bin, 'utf8')}`);
cpSync(join(root, 'README.md'), join(out, 'README.md'));
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));

const manifest = {
  name: '@cntxt-labs/yojana',
  version: VERSION,
  description:
    'Plans as checkable contracts: requirement-level revision log, claims checked against code.',
  keywords: ['plans', 'requirements', 'specs', 'ai-agents', 'claude-code', 'beads'],
  license: 'MIT',
  author: { name: 'nimishph', url: 'https://github.com/nimishph' },
  homepage: 'https://github.com/nimishph/yojana#readme',
  repository: { type: 'git', url: 'git+https://github.com/nimishph/yojana.git' },
  bugs: { url: 'https://github.com/nimishph/yojana/issues' },
  type: 'module',
  bin: { yojana: 'lib/yojana.js' },
  files: ['lib', 'README.md', 'LICENSE'],
  engines: { bun: '>=1.3.0' },
  publishConfig: { access: 'public' },
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`wrote dist/npm/ for @cntxt-labs/yojana ${VERSION}\n`);
