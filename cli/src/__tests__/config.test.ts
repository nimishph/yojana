import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, themeStylesheet } from '../config.ts';
import { run } from '../main.ts';

const root = mkdtempSync(join(tmpdir(), 'yojana-config-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;

/** A config file in a fresh folder, and the environment that names it. */
function configWith(content: unknown): { path: string; env: NodeJS.ProcessEnv } {
  const dir = join(root, `case-${++counter}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'yojana.config.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return { path, env: { YOJANA_CONFIG: path } };
}

const themeFile = (css: string) => {
  const path = join(root, `theme-${++counter}.css`);
  writeFileSync(path, css);
  return path;
};

describe('loadConfig', () => {
  test('without YOJANA_CONFIG, or without the file, every setting is its default', () => {
    expect(loadConfig({})).toMatchObject({ path: undefined, found: false, home: undefined });
    const missing = join(root, 'none.json');
    expect(loadConfig({ YOJANA_CONFIG: missing })).toMatchObject({ found: false, home: undefined });
  });

  test('paths take vars, the environment and ~, and are relative to the file', () => {
    const { path, env } = configWith({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a config file spells a variable ${name}
      vars: { base: '${WORK}/sutras', checkout: '${base}/yojana' },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a config file spells a variable ${name}
      home: '${checkout}',
      theme: { css: './mine.css' },
    });
    writeFileSync(join(path, '..', 'mine.css'), ':root {}');
    const config = loadConfig({ ...env, WORK: join(root, 'work') });
    expect(config.home).toBe(join(root, 'work', 'sutras', 'yojana'));
    expect(config.theme.css).toBe(join(path, '..', 'mine.css'));
    const tilde = loadConfig(configWith({ home: '~/yojana' }).env);
    expect(tilde.home).toBe(join(homedir(), 'yojana'));
  });

  test('a mistake is reported, not ignored', () => {
    const cases: [unknown, RegExp][] = [
      ['{ not json', /is not JSON/],
      [{ theme: { colour: {} } }, /unknown setting "colour"/],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a config file spells a variable ${name}
      [{ home: '${NOPE}/x' }, /\$\{NOPE\}.*neither a var nor set/],
      [{ theme: { tokens: { 'Not A Token': 'red' } } }, /not a token name/],
      [{ theme: { tokens: { text: 'red; } body { display: none' } } }, /not a CSS value/],
      [{ theme: { fonts: { serif: 'Georgia' } } }, /unknown setting "serif"/],
      [{ theme: { css: './missing.css' } }, /no file at/],
    ];
    for (const [content, message] of cases) {
      expect(() => loadConfig(configWith(content).env)).toThrow(message);
    }
  });
});

describe('themeStylesheet', () => {
  const base = themeFile(':root { --text: black; }');

  test('with no settings it is the theme as it is', () => {
    expect(themeStylesheet(loadConfig({}), base, {})).toBe(':root { --text: black; }\n');
  });

  test('fonts and tokens follow the theme; dark values repeat its two dark selectors', () => {
    const config = loadConfig(
      configWith({
        theme: {
          fonts: { ui: 'Inter, sans-serif' },
          tokens: { '--intent-primary': '#5b3cc4', 'radius-md': '6px' },
          dark: { 'intent-primary': '#b7a6f5' },
        },
      }).env,
    );
    const css = themeStylesheet(config, base, {});
    expect(css.startsWith(':root { --text: black; }')).toBe(true);
    expect(css).toContain(
      ':root {\n  --font-ui: Inter, sans-serif;\n  --intent-primary: #5b3cc4;\n  --radius-md: 6px;\n}',
    );
    expect(css).toContain(
      '@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n    --intent-primary: #b7a6f5;\n  }\n}',
    );
    expect(css).toContain(':root[data-theme="dark"] {\n  --intent-primary: #b7a6f5;\n}');
  });

  test('theme.css replaces the default theme; YOJANA_THEME_CSS comes first', () => {
    const { path, env } = configWith({ theme: { css: './mine.css' } });
    writeFileSync(join(path, '..', 'mine.css'), ':root { --text: navy; }');
    const extra = themeFile('@import url("fonts.css");');
    const css = themeStylesheet(loadConfig(env), base, { YOJANA_THEME_CSS: extra });
    expect(css).toBe('@import url("fonts.css");\n:root { --text: navy; }\n');
  });
});

describe('yojana config', () => {
  test('shows the settings in effect, and a broken file as CONFIG_INVALID', async () => {
    const saved = process.env.YOJANA_CONFIG;
    try {
      let out = '';
      process.env.YOJANA_CONFIG = configWith({ theme: { tokens: { mark: '#ffe' } } }).path;
      expect(await run(['config'], (t) => (out += t))).toBe(0);
      expect(out).toContain('tokens 1 light, 0 dark');

      out = '';
      process.env.YOJANA_CONFIG = configWith({ them: {} }).path;
      expect(await run(['config'], (t) => (out += t))).toBe(1);
      expect(out).toContain('CONFIG_INVALID');
    } finally {
      if (saved === undefined) delete process.env.YOJANA_CONFIG;
      else process.env.YOJANA_CONFIG = saved;
    }
  });
});
