import { VERSION } from '@cntxt-labs/yojana';

const USAGE = `yojana ${VERSION}: plans as checkable contracts

Usage:
  yojana --version
  yojana ingest            record revisions for edited plan files       (v0)
  yojana status            plans, open changes, stale work, drift       (v0)
  yojana archive <change>  apply a change if its bases are still current (v0)
  yojana check [plan]      verify plan claims against the code           (v0)
`;

export function run(argv: readonly string[], write: (text: string) => void): number {
  const [command] = argv;
  if (command === '--version' || command === '-v') {
    write(`${VERSION}\n`);
    return 0;
  }
  write(USAGE);
  return command === undefined || command === '--help' || command === '-h' ? 0 : 2;
}

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), (text) => process.stdout.write(text));
}
