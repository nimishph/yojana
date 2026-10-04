#!/usr/bin/env sh
# Packs patra's packages into vendor/patra/ as tarballs that bun install takes through file:
# dependencies, so yojana installs without a patra checkout (CI, the plugin). patra is TypeScript
# that Bun runs as is, so a package is its committed files minus tests. Packs the commit checked
# out in the patra repository (default ../patra); rerun after patra changes, then bun install --force.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
patra="${1:-$root/../patra}"
out="$root/vendor/patra"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

commit="$(git -C "$patra" rev-parse HEAD)"
git -C "$patra" archive HEAD patra-core patra-serve templates themes | tar -x -C "$stage"
find "$stage" -name __tests__ -type d -prune -exec rm -rf {} +

# A packed package.json: workspace:* means nothing outside patra's workspace (yojana's overrides
# point it at the tarball), and as the package ships source, its @types are what consumers need.
for p in patra-core patra-serve templates themes; do
  bun -e '
    const path = process.argv[1];
    const pkg = await Bun.file(path).json();
    const deps = { ...pkg.dependencies };
    for (const [name, range] of Object.entries(deps)) if (range === "workspace:*") deps[name] = pkg.version;
    for (const [name, range] of Object.entries(pkg.devDependencies ?? {}))
      if (name.startsWith("@types/")) deps[name] = range;
    delete pkg.devDependencies;
    if (Object.keys(deps).length > 0) pkg.dependencies = deps;
    await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`);
  ' "$stage/$p/package.json"
done

rm -rf "$out"
mkdir -p "$out"
for p in patra-core patra-serve templates themes; do
  (cd "$stage/$p" && bun pm pack --quiet --destination "$out" >/dev/null)
done
echo "$commit" >"$out/COMMIT"

# The tarballs keep their names across commits, and bun install trusts the lockfile's entry for a
# name; dropping the entries makes it read the tarballs again.
sed -i '/^    "@cntxt-labs\/patra-[a-z]*": \["/d' "$root/bun.lock"

ls "$out"
echo "packed patra $commit; now run bun install --force (the names do not change, so a plain install keeps the cached copy)"
