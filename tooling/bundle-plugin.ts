// Bundles the yojana CLI into claude-plugin/lib/, so an installed plugin (a copy of claude-plugin/
// alone) runs without a yojana checkout: one JavaScript file for Bun, plus the files patra reads at
// run time, which it finds next to the bundle (import.meta.dir): the review-document template and
// the default theme. htmx is imported as text, so it is in the bundle already.
//
//   bun tooling/bundle-plugin.ts           write claude-plugin/lib/
//   bun tooling/bundle-plugin.ts --check   exit 1 if claude-plugin/lib/ is not what the source makes
//
// Rerun after changing the CLI or taking a newer patra; CI runs --check.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const lib = join(root, 'claude-plugin', 'lib');
const check = process.argv.includes('--check');

/** A package's folder, resolved as the CLI resolves it (patra is a dependency of cli/ only). */
function packageDir(name: string): string {
  return dirname(Bun.resolveSync(name, join(root, 'cli')));
}

async function bundle(out: string): Promise<void> {
  rmSync(out, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [join(root, 'cli', 'src', 'main.ts')],
    target: 'bun',
    outdir: out,
    naming: 'yojana.js',
  });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
    process.exit(1);
  }
  cpSync(
    join(packageDir('@cntxt-labs/patra-templates'), 'review-document'),
    join(out, 'review-document'),
    {
      recursive: true,
    },
  );
  cpSync(join(packageDir('@cntxt-labs/patra-themes'), 'default'), join(out, 'default'), {
    recursive: true,
  });
}

/** Every file under `dir`, as paths relative to it with forward slashes, sorted. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/'))
    .sort();
}

if (check) {
  const fresh = mkdtempSync(join(tmpdir(), 'yojana-lib-'));
  try {
    await bundle(fresh);
    const want = files(fresh);
    const have = files(lib);
    const differ = [...new Set([...want, ...have])].filter(
      (f) =>
        !want.includes(f) ||
        !have.includes(f) ||
        !readFileSync(join(fresh, f)).equals(readFileSync(join(lib, f))),
    );
    if (differ.length > 0) {
      process.stderr.write(
        `claude-plugin/lib/ is out of date (${differ.join(', ')}); run bun tooling/bundle-plugin.ts\n`,
      );
      process.exit(1);
    }
    process.stdout.write('claude-plugin/lib/ is up to date\n');
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
} else {
  await bundle(lib);
  process.stdout.write(`bundled the CLI into claude-plugin/lib/ (${files(lib).length} files)\n`);
}
