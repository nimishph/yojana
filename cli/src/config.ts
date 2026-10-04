import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { YojanaError } from '@cntxt-labs/yojana-core';

/**
 * yojana.config.json: settings for one installation of yojana, at the path YOJANA_CONFIG names
 * (the Claude Code plugin points it into its data folder, which survives plugin updates). The
 * file is optional; without it every setting has its default.
 *
 *   {
 *     "vars":  { "sutras": "~/code/sutras" },           path variables, for ${sutras} below
 *     "home":  "${sutras}/yojana",                        the checkout the plugin runs
 *     "theme": {
 *       "css":    "./my-theme.css",                       replaces patra's default theme
 *       "fonts":  { "ui": "Inter, sans-serif" },          reading, ui, mono
 *       "tokens": { "intent-primary": "#5b3cc4" },        theme tokens, light (and every mode
 *       "dark":   { "intent-primary": "#b7a6f5" }         for tokens the theme sets once), dark
 *     }
 *   }
 *
 * A path takes ${name} from vars, then from the environment, a leading ~ for the home folder, and
 * is relative to the config file. A var may use the vars before it.
 */
export interface YojanaConfig {
  /** The file read, or undefined when YOJANA_CONFIG is not set. */
  readonly path: string | undefined;
  readonly found: boolean;
  readonly vars: Readonly<Record<string, string>>;
  readonly home: string | undefined;
  readonly theme: ThemeConfig;
}

export interface ThemeConfig {
  readonly css: string | undefined;
  readonly fonts: Readonly<Partial<Record<FontRole, string>>>;
  readonly tokens: Readonly<Record<string, string>>;
  readonly dark: Readonly<Record<string, string>>;
}

type FontRole = 'reading' | 'ui' | 'mono';
const FONT_ROLES: readonly FontRole[] = ['reading', 'ui', 'mono'];

const EMPTY: YojanaConfig = {
  path: undefined,
  found: false,
  vars: {},
  home: undefined,
  theme: { css: undefined, fonts: {}, tokens: {}, dark: {} },
};

/** A token name as patra's themes spell it, without the leading dashes. */
const TOKEN_NAME = /^[a-z][a-z0-9-]*$/;
/** A var name, as written inside ${...}. */
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** What a CSS value must not contain, so it cannot end its declaration, rule or <style>. */
const UNSAFE_VALUE = /[;{}<>\\]/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): YojanaConfig {
  const named = env.YOJANA_CONFIG;
  if (named === undefined || named === '') return EMPTY;
  const path = resolve(named);
  if (!existsSync(path)) return { ...EMPTY, path };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw invalid(path, `is not JSON: ${(cause as Error).message}`);
  }
  const top = record(path, raw, 'the file', ['vars', 'home', 'theme']);

  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(record(path, top.vars ?? {}, 'vars'))) {
    if (!VAR_NAME.test(name)) throw invalid(path, `vars: ${name} is not a name usable as \${name}`);
    vars[name] = expandPath(path, text(path, value, `vars.${name}`), vars, env);
  }
  const home =
    top.home === undefined ? undefined : expandPath(path, text(path, top.home, 'home'), vars, env);

  const theme = record(path, top.theme ?? {}, 'theme', ['css', 'fonts', 'tokens', 'dark']);
  const css =
    theme.css === undefined
      ? undefined
      : expandPath(path, text(path, theme.css, 'theme.css'), vars, env);
  if (css !== undefined && !existsSync(css)) throw invalid(path, `theme.css: no file at ${css}`);
  const fonts: Partial<Record<FontRole, string>> = {};
  for (const [role, value] of Object.entries(
    record(path, theme.fonts ?? {}, 'theme.fonts', FONT_ROLES),
  )) {
    fonts[role as FontRole] = cssValue(path, value, `theme.fonts.${role}`);
  }

  return {
    path,
    found: true,
    vars,
    home,
    theme: {
      css,
      fonts,
      tokens: tokens(path, theme.tokens, 'theme.tokens'),
      dark: tokens(path, theme.dark, 'theme.dark'),
    },
  };
}

/**
 * The stylesheet a review page uses: the configured theme file or patra's default, its fonts and
 * tokens after it, and YOJANA_THEME_CSS (a stylesheet given for one run) before it, so its @import
 * lines stay first. Overrides repeat the default theme's three selectors (light; dark by
 * preference; dark by choice), so a light value never leaks into dark mode.
 */
export function themeStylesheet(
  config: YojanaConfig,
  defaultThemeFile: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const parts: string[] = [];
  const extra = env.YOJANA_THEME_CSS;
  if (extra) parts.push(readFileSync(extra, 'utf8'));
  parts.push(readFileSync(config.theme.css ?? defaultThemeFile, 'utf8'));

  const light = {
    ...Object.fromEntries(Object.entries(config.theme.fonts).map(([r, v]) => [`font-${r}`, v])),
    ...config.theme.tokens,
  };
  if (Object.keys(light).length > 0) parts.push(`:root {\n${declarations(light, '  ')}}`);
  const { dark } = config.theme;
  if (Object.keys(dark).length > 0) {
    parts.push(
      `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${declarations(dark, '    ')}  }\n}`,
      `:root[data-theme="dark"] {\n${declarations(dark, '  ')}}`,
    );
  }
  return `${parts.join('\n')}\n`;
}

function declarations(values: Readonly<Record<string, string>>, indent: string): string {
  return Object.entries(values)
    .map(([name, value]) => `${indent}--${name}: ${value};\n`)
    .join('');
}

function expandPath(
  file: string,
  value: string,
  vars: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv,
): string {
  const expanded = value
    .replace(/^~(?=$|[/\\])/, homedir())
    .replace(/\$\{([^}]*)\}/g, (_, name: string) => {
      const found = vars[name] ?? env[name];
      if (found === undefined) {
        throw invalid(
          file,
          `\${${name}} in "${value}" is neither a var nor set in the environment`,
        );
      }
      return found;
    });
  return resolve(dirname(file), expanded);
}

function tokens(file: string, value: unknown, at: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(record(file, value ?? {}, at))) {
    const name = key.replace(/^--/, '');
    if (!TOKEN_NAME.test(name)) throw invalid(file, `${at}: ${key} is not a token name`);
    out[name] = cssValue(file, v, `${at}.${key}`);
  }
  return out;
}

function cssValue(file: string, value: unknown, at: string): string {
  const v = text(file, value, at).trim();
  if (v === '' || UNSAFE_VALUE.test(v)) {
    throw invalid(file, `${at}: "${v}" is not a CSS value (no ; { } < > or \\)`);
  }
  return v;
}

function record(
  file: string,
  value: unknown,
  at: string,
  known?: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(file, `${at} must be an object`);
  }
  const out = value as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    if (known !== undefined && !known.includes(key)) {
      throw invalid(file, `${at}: unknown setting "${key}" (known: ${known.join(', ')})`);
    }
  }
  return out;
}

function text(file: string, value: unknown, at: string): string {
  if (typeof value !== 'string') throw invalid(file, `${at} must be a string`);
  return value;
}

function invalid(file: string, message: string): YojanaError {
  return new YojanaError('CONFIG_INVALID', `${file}: ${message}`, {
    hint: 'fix the file, or unset YOJANA_CONFIG to use the defaults',
  });
}
