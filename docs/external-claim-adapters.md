# External Claim Adapters Protocol

Yojana provides an extensible verification architecture based on the `VerifierPort` interface. External tools—such as domain-specific linters, coverage checkers, architecture rules engines, or indexers—can contribute claim kinds by implementing a lightweight JSON-over-stdio protocol.

Because running external adapters executes configured binaries, adapters are **opt-in** and explicitly declared in `yojana.config.json`.

---

## 1. Configuration (`yojana.config.json`)

External verifiers are registered under the `verifiers` (or `adapters`) array in `yojana.config.json`:

```json
{
  "verifiers": [
    {
      "name": "git-clean",
      "command": "./tools/git-verifier.sh",
      "args": ["--mode=strict"],
      "kinds": ["git.clean"],
      "env": {
        "DEBUG": "0"
      }
    }
  ]
}
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | No | Identifier for the verifier. Defaults to the base executable filename if omitted. |
| `command` | string | Yes | Path to executable or command name in PATH. Expands `${vars}`, environment variables, and `~`. |
| `args` | string[] | No | Additional command-line arguments prepended to each invocation. |
| `kinds` | string[] | No | Claim kinds supported by this verifier. If omitted, Yojana invokes `describe` at startup to discover them. |
| `env` | Record<string, string> | No | Extra environment variables supplied to the spawned process. |

---

## 2. Stdio Protocol

The adapter communicates via JSON over standard input (`stdin`) and standard output (`stdout`).

When invoked, the process receives:
- The protocol action as the last command-line argument: `[...args, "<action>"]`.
- A JSON request object on `stdin`.
- Responses must be written as valid JSON to `stdout`.

There are three actions:
1. `describe`
2. `verify`
3. `indexState`

---

### Action: `describe`

Returns the capabilities of the verifier, including registered claim kinds, schemas, and determinism properties.

#### Request (stdin)
```json
{
  "action": "describe"
}
```

#### Response (stdout)
```json
{
  "name": "git-clean",
  "version": "1.0.0",
  "kinds": [
    {
      "kind": "git.clean",
      "description": "Asserts git working tree has no uncommitted changes",
      "params": {
        "type": "object",
        "properties": {
          "untracked": { "type": "boolean" }
        }
      },
      "deterministic": false,
      "version": "1.0.0"
    }
  ]
}
```

#### Descriptor Fields
- `name`: Optional verifier name.
- `version`: Optional version string.
- `kinds`: Array of kind descriptor objects:
  - `kind` (string, required): Claim kind name (e.g. `anvesa.routes`, `medha.entity`, `custom.lint`).
  - `description` (string, optional): Human-readable description.
  - `params` (JSON schema object, optional): Schema for the claim parameters.
  - `deterministic` (boolean, optional): Whether the claim outcome is deterministic for a given codebase state. Defaults to `true`.
  - `version` (string, optional): Version of the check rule or algorithm.

---

### Action: `verify`

Executes verification of a single claim against the project.

#### Request (stdin)
```json
{
  "action": "verify",
  "requirement": {
    "id": "req-1",
    "title": "Clean repository state",
    "description": "Repo must have no uncommitted modifications"
  },
  "claim": {
    "kind": "git.clean",
    "untracked": true,
    "expect": {
      "count": 0
    }
  }
}
```

#### Response (stdout)
```json
{
  "outcome": "pass",
  "evidence": "Working tree is clean; 0 untracked files",
  "measurements": {
    "count": 0
  },
  "deterministic": false,
  "measuredAt": "2026-10-09T12:00:00.000Z"
}
```

#### Result Fields
- `evidence` (string, required): Human-readable summary of the verification outcome and observed state.
- `outcome` (`"pass"` | `"fail"` | `"inconclusive"` | `"error"`, optional):
  - If omitted by the external adapter, Yojana evaluates `claim.expect` against `measurements` (e.g. numeric count predicates, comparison operators).
- `measurements` (Record<string, number \| string \| boolean>, optional): Measured values extracted from the codebase (e.g. `count: 0`, `violations: 2`).
- `deterministic` (boolean, optional): Overrides the descriptor determinism for this result.
- `measuredAt` (string ISO timestamp, optional): Automatically populated by Yojana if omitted for non-deterministic checks.

---

### Action: `indexState`

Returns an opaque fingerprint or version token representing the index or dependency state (e.g., git commit hash, index revision, timestamp).

#### Request (stdin)
```json
{
  "action": "indexState"
}
```

#### Response (stdout)
A JSON string, null, or a JSON object:
```json
"a1b2c3d4e5f6"
```
or:
```json
{
  "indexState": "a1b2c3d4e5f6"
}
```

If the adapter has no indexing state, it may return `null` or exit with output `"null"`.

---

## 3. Determinism and Caching

Yojana caches claim verification outcomes across plan check runs to avoid redundant work:

1. **Deterministic claims (`deterministic: true`)**:
   - Cached when the claim string (canonical serialization), project revision, and index state match.
   - Deterministic claims do not stamp `measuredAt` in durable plan check records.
2. **Non-deterministic claims (`deterministic: false`)**:
   - Always bypass the cache.
   - Yojana records `measuredAt: <ISO timestamp>` with the verification result so users know when the claim was evaluated.

---

## 4. Minimal Example Script (Node.js / Bun)

```javascript
#!/usr/bin/env node
const fs = require('fs');

const input = JSON.parse(fs.readFileSync(0, 'utf-8'));
const action = process.argv[2] || input.action;

if (action === 'describe') {
  console.log(JSON.stringify({
    name: 'file-counter',
    kinds: [
      {
        kind: 'files.count',
        description: 'Checks number of files in a directory',
        deterministic: true
      }
    ]
  }));
} else if (action === 'verify') {
  const claim = input.claim;
  const count = fs.readdirSync(claim.dir || '.').length;
  console.log(JSON.stringify({
    measurements: { count },
    evidence: `Found ${count} files in ${claim.dir || '.'}`
  }));
} else if (action === 'indexState') {
  console.log(JSON.stringify({ indexState: 'v1' }));
} else {
  process.stderr.write(`Unknown action: ${action}\n`);
  process.exit(1);
}
```
