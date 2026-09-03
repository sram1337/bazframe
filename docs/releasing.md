# Releasing Bazframe to npm

Bazframe's CLI/runtime is distributed through npm. Skills, libraries, and packages retain their source ownership, and `~/.bazframe` remains local profile and configuration state.

## Release requirements

Do not publish a new version until all of these are true:

1. The owner has recorded the package rights decision: either a nonempty license field plus the corresponding root `LICENSE`, or an explicit `"license": "UNLICENSED"` choice. The owner has reviewed the public distribution rights of every packed byte.
2. `package.json` no longer has `"private": true`.
3. The npm account has a verified email, two-factor authentication, and authority to claim the unscoped `bazframe` name. An npm `E404` does not prove that the name can be claimed.
4. The release commit and worktree are clean, the intended version is unused, and the exact tarball has passed the release gate and manual content review.

## Prepare and inspect the exact beta

npm versions are immutable. Use a new version for every correction.

```bash
npm whoami
npm view bazframe versions --json
git status --short          # must print nothing
npm ci
npm run release:check
npm audit --omit=dev
npm pack --json > npm-pack.json
TARBALL="$(node --input-type=module -e "import{readFileSync}from'node:fs';const value=JSON.parse(readFileSync('npm-pack.json','utf8'));if(value.length!==1)throw new Error('Expected one tarball.');process.stdout.write(value[0].filename)")"
shasum -a 256 "$TARBALL" > "$TARBALL.sha256"
```

Inspect the resulting `bazframe-<version>.tgz`, including its `package.json`, executable, generated Skills, documentation, and examples. Record and verify its checksum. Install that same file in a disposable directory and exercise it before publication:

```bash
TEMP_ROOT="$(mktemp -d)"
shasum -a 256 --check "$TARBALL.sha256"
npm install --prefix "$TEMP_ROOT" --ignore-scripts --no-audit --no-fund "./$TARBALL"
"$TEMP_ROOT/node_modules/.bin/bazframe" --version
"$TEMP_ROOT/node_modules/.bin/bazframe" --help
```

Use disposable `BAZFRAME_HOME` and `PI_CODING_AGENT_DIR` directories for adapter and status checks. Release validation must not touch a user's real Bazframe or Pi state.

## Initial interactive publication (completed)

The package did not exist before `0.1.0-beta.1`, so its first publication required the account's interactive 2FA flow. The exact reviewed tarball was published with:

```bash
shasum -a 256 --check "$TARBALL.sha256"
npm publish "./$TARBALL" --access public --tag next
```

Passing the tarball path published the inspected bytes rather than repacking the working tree. The explicit tag selected the `next` channel, but npm also assigned `latest` during the first publication; both tags initially resolved to `0.1.0-beta.1`. Verify registry bytes and tags rather than assuming `next` is exclusive:

```bash
npm view bazframe@0.1.0-beta.1 name version dist-tags repository --json
npm dist-tag ls bazframe
npm install --global bazframe
bazframe --version
```

Future releases use the trusted-publishing path below. If a published version is wrong, publish a corrected new version. Deprecate a bad version when guidance is needed; do not attempt to overwrite it.

## Configure trusted publishing after the first release

After the package exists, configure its npm trusted publisher for:

- provider: GitHub Actions
- repository: `sram1337/bazframe`
- workflow: `npm-publish.yml`
- environment: `npm`
- permission: publish

Protect the GitHub `npm` environment with the desired reviewer gate. The workflow uses a GitHub-hosted runner, `id-token: write`, and npm 11 or newer. It carries no npm token; npm exchanges the workflow's OIDC identity for short-lived publishing authority and generates provenance.

Subsequent releases use a clean `v<package-version>` tag. `.github/workflows/npm-publish.yml` first validates without OIDC authority: it verifies the tag, refuses private or missing-license metadata, accepts either a root-license choice or explicit `UNLICENSED`, requires the package to exist, runs tests and the production audit, then packs, checksums, and uploads one tarball. Only the protected `npm` publish job receives `id-token: write`; it verifies the downloaded checksum and publishes that exact tarball with the default `latest` tag. Configure the trusted publisher before pushing a release tag.
