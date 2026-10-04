/**
 * yojana for opencode. It runs in place from a yojana checkout (opencode loads a plugin from a
 * path) and shares the Claude Code plugin's parts rather than copying them:
 *
 * - the `yojana` skill (claude-plugin/skills/yojana), registered through `skills.paths`;
 * - `/yojana-plan` and `/yojana-review`, commands whose templates are the Claude plugin's plan and
 *   review skills;
 * - the `yojana` launchers (claude-plugin/bin) on the PATH of opencode's shell, acting as the
 *   agent `opencode`, with YOJANA_HOME and YOJANA_CONFIG set;
 * - at the start of a session in a repository that keeps plans, the same note the Claude plugin's
 *   SessionStart hook gives: open changes and decisions waiting on a person.
 *
 * Options (opencode.json: "plugin": [["<checkout>/opencode-plugin", { ... }]]):
 *   config  path of yojana.config.json (default ~/.config/opencode/yojana.config.json)
 *   agent   the name the log records for this agent (default opencode)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The parts of opencode's plugin API this plugin uses (@opencode-ai/plugin). */
interface PluginInput {
  readonly directory: string;
}
interface OpencodeConfig {
  skills?: { paths?: string[]; urls?: string[] };
  command?: Record<string, { template: string; description?: string }>;
}
interface Hooks {
  config?: (config: OpencodeConfig) => Promise<void>;
  'shell.env'?: (input: { cwd: string }, output: { env: Record<string, string> }) => Promise<void>;
  'experimental.chat.system.transform'?: (
    input: { sessionID?: string },
    output: { system: string[] },
  ) => Promise<void>;
}

const home = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const claudePlugin = join(home, 'claude-plugin');

export const YojanaPlugin = async (
  input: PluginInput,
  options: Record<string, unknown> = {},
): Promise<Hooks> => {
  const agent = typeof options.agent === 'string' ? options.agent : 'opencode';
  const config =
    typeof options.config === 'string'
      ? resolve(options.config.replace(/^~(?=$|[/\\])/, homedir()))
      : join(homedir(), '.config', 'opencode', 'yojana.config.json');
  const env: Record<string, string> = {
    YOJANA_AGENT: process.env.YOJANA_AGENT ?? agent,
    YOJANA_HOME: process.env.YOJANA_HOME ?? home,
    YOJANA_CONFIG: process.env.YOJANA_CONFIG ?? config,
  };
  const notes = new Map<string, string | undefined>();

  return {
    async config(cfg) {
      cfg.skills = {
        ...cfg.skills,
        paths: [...(cfg.skills?.paths ?? []), join(claudePlugin, 'skills', 'yojana')],
      };
      cfg.command = {
        ...cfg.command,
        'yojana-plan': command('plan'),
        'yojana-review': command('review'),
      };
    },

    async 'shell.env'(_input, output) {
      Object.assign(output.env, env, {
        PATH: [join(claudePlugin, 'bin'), process.env.PATH ?? ''].join(delimiter),
      });
    },

    // Once per session, like the Claude plugin's SessionStart hook; the note then stays.
    async 'experimental.chat.system.transform'(hook, output) {
      const key = hook.sessionID ?? '';
      if (!notes.has(key)) notes.set(key, sessionNote(input.directory, env));
      const note = notes.get(key);
      if (note !== undefined) output.system.push(note);
    },
  };
};

/** An opencode command from one of the Claude plugin's user-invoked skills. */
function command(name: 'plan' | 'review'): { template: string; description: string } {
  const text = readFileSync(join(claudePlugin, 'skills', name, 'SKILL.md'), 'utf8');
  const [, front = '', body = text] = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text) ?? [];
  const description = /^description:\s*(.*)$/m.exec(front)?.[1] ?? `yojana ${name}`;
  return { description, template: body.replaceAll('/yojana:', '/yojana-').trim() };
}

/** What the Claude plugin's session-start.sh says, for a repository that keeps yojana plans. */
function sessionNote(root: string, env: Record<string, string>): string | undefined {
  if (!existsSync(join(root, '.yojana', 'log.jsonl'))) return undefined;
  const run = (...args: string[]) => {
    const result = spawnSync(
      'bun',
      [join(home, 'cli', 'src', 'main.ts'), ...args, '--root', root],
      {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      },
    );
    return result.status === 0 ? result.stdout.trim() : '';
  };
  const lines = [
    'This repository keeps yojana plans (log in .yojana/). Use the yojana skill before planning, or before changing a plan or a bead it links.',
  ];
  const changes = run('changes');
  if (changes !== '' && changes !== 'no open changes') {
    lines.push(`Open changes waiting for review:\n${changes}`);
  }
  const decisions = run('decisions');
  if (decisions !== '' && decisions !== 'no pending decisions') {
    lines.push(`Decisions on beads not yet applied:\n${decisions}`);
  }
  return lines.join('\n');
}

export default YojanaPlugin;
