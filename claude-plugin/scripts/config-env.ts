// The checkout named by yojana.config.json's "home", for session-start.sh, which exports it as
// YOJANA_HOME so bin/yojana can find the CLI. It runs before any checkout is known, so it cannot
// use the CLI's config reader; it expands a path the same way (cli/src/config.ts): ${name} from
// vars then the environment, a leading ~, relative to the config file. Prints nothing when the
// file has no home; a problem goes to stderr and exit 1, and `yojana config` explains it fully.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const file = process.argv[2] ?? '';
const vars: Record<string, string> = {};
const unset: string[] = [];

function expand(value: string): string {
  const named = value
    .replace(/^~(?=$|[/\\])/, homedir())
    .replace(/\$\{([^}]*)\}/g, (_, name: string) => {
      const found = vars[name] ?? process.env[name];
      if (found === undefined) unset.push(name);
      return found ?? '';
    });
  return resolve(dirname(file), named);
}

let config: { vars?: Record<string, unknown>; home?: unknown };
try {
  config = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  process.stderr.write(`yojana: cannot read ${file}: ${(error as Error).message}\n`);
  process.exit(1);
}
for (const [name, value] of Object.entries(config.vars ?? {})) vars[name] = expand(String(value));
const home = typeof config.home === 'string' ? expand(config.home) : undefined;
if (unset.length > 0) {
  process.stderr.write(`yojana: ${file} uses \${${unset.join('}, ${')}}, which is not set\n`);
  process.exit(1);
}
if (home !== undefined) process.stdout.write(home);
