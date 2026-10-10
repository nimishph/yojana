---
id: plan/feature-showcase
title: Complete Yojana Feature Showcase
status: realized
---

# Complete Yojana Feature Showcase

Demonstrating extensible claims, composite logic, action items under requirements, and medha rule proposal.

## Requirement: Core modularity and composite claims {#req-modular}

The yojana architecture separates pure domain ports from adapters and supports composite claim validation.

### Actions
- Verify pure domain core package {#act-core-pure bead=yoj-core}
  ```yojana:claim
  kind: path
  expression: yojana-core/package.json
  ```
- Establish external verifier JSON stdio protocol {#act-ext-bridge}
  ```yojana:claim
  kind: path
  expression: yojana-verify/src/external.ts
  ```

```yojana:claim
all:
  - kind: path
    expression: yojana-core/src/predicate.ts
  - kind: path
    expression: yojana-core/src/rule-sink-port.ts
  - not:
      kind: path
      expression: nonexistent-deprecated-module.ts
```

## Requirement: Extensible adapters and verification {#req-adapters}

Verifier adapters describe their capabilities and verify structured claims.

### Actions
- Implement medha rule sink integration {#act-medha-sink bead=yoj-sink}
  ```yojana:claim
  kind: path
  expression: yojana-verify/src/medha.ts
  ```

```yojana:claim
kind: path
expression: yojana-verify/src/medha.ts
expect: true
```
