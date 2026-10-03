// Boundaries for the yojana packages. The graph is one-way:
// yojana -> { core, store, sync, markdown, verify }; store, sync, markdown, verify, work -> core; cli -> { yojana, core }.
// Cross-package imports go through a package's public entry point (src/index.ts), never its internals.

/** package directory -> the only workspace packages it may import. */
const ALLOWED = {
  'yojana-core': [],
  'yojana-store': ['yojana-core'],
  'yojana-sync': ['yojana-core'],
  'yojana-markdown': ['yojana-core'],
  'yojana-verify': ['yojana-core'],
  'yojana-work': ['yojana-core'],
  // Engine facade: composes the ports into ingest / status / archive / check.
  yojana: [
    'yojana-core',
    'yojana-store',
    'yojana-sync',
    'yojana-markdown',
    'yojana-verify',
    'yojana-work',
  ],
  cli: ['yojana', 'yojana-core', 'yojana-verify', 'yojana-work'],
};

const names = Object.keys(ALLOWED);

const dependencyRules = names.map((pkg) => ({
  name: `${pkg}-allowed-deps`,
  severity: 'error',
  comment: `${pkg} may only depend on: ${ALLOWED[pkg].join(', ') || '(nothing)'}`,
  from: { path: `^${pkg}/src` },
  to: {
    path: `^(${names.filter((n) => n !== pkg && !ALLOWED[pkg].includes(n)).join('|')})/src`,
  },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...dependencyRules,
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'public-entry-only',
      severity: 'error',
      comment: 'Import another package through its index.ts, not its internals.',
      from: { path: `^(${names.join('|')})/src` },
      to: {
        path: String.raw`^(${names.join('|')})/src/(?!index\.ts$)`,
        pathNot: ['^$1/src'],
      },
    },
    {
      name: 'no-import-from-host-repo',
      severity: 'error',
      comment: 'Packages must stay extractable: nothing may reach above this directory.',
      from: { path: '^[^/]+/src' },
      to: { path: String.raw`^\.\./` },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
