# Releasing Bazframe to npm

A Bazframe **release is publication to npm**. Develop on `main`; use tagged-workflow validation and artifact assembly to prepare the reviewed package for publication.

Bazframe's CLI/runtime is distributed through npm. Skills, libraries, and packages retain their source ownership, and `~/.bazframe` remains local profile and configuration state.

## Release requirements

Do not publish a new version until all of these are true:

1. The owner has recorded the package rights decision: either a nonempty license field plus the corresponding root `LICENSE`, or an explicit `"license": "UNLICENSED"` choice. The owner has reviewed the public distribution rights of every packed byte.
2. `package.json` no longer has `"private": true`.
3. The npm account has a verified email, two-factor authentication, and authority to claim the unscoped `bazframe` name. An npm `E404` does not prove that the name can be claimed.
4. The release commit and worktree are clean, the intended version is unused, and the exact tarball has passed the release gate and manual content review.

## Windows native release admission

The tag-triggered workflow prepares a Windows x64 binary for npm publication in the same workflow run through the reusable native-foundation workflow. Its foundation receipts retain foundation-only semantics: both source-tree and packed-install receipts must pass while continuing to report `releaseAdmission: "not-authorized"` and `windowsSupportClaim: false`.

Qualification uses isolated Windows 2022 jobs, each with a 30-minute ceiling. The foundation producer builds/packs/installs once and runs source then packed foundation checks. Only the fully verified seven-file foundation bundle is transferred under `bazframe-win32-qualification-input-foundation-<source-sha>-<run-id>-<attempt>`; it is not a final success artifact or release admission. Separate source and packed product jobs authenticate that numeric artifact ID, REST provenance and whole archive digest, copy only its verified binary, rebuild from the same clean source with the producer npm version, and require **whole-tarball SHA-256 equality** before their one product workload. No qualification job uploads a tarball or creates an assembly admission record. PR transport checks bind the trusted PR head SHA/repository separately from the checked-out merge/source SHA.

Only after all three jobs succeed does promotion reauthenticate the exact inputs and verify both current foundation-v7 and product-v5 receipts for native contract 8, including exact pair parity and source/binary/tarball bindings. It copies the original verified bytes into the unchanged seven-file final foundation artifact and two-file product artifact. Reusable `artifact_id`/`artifact_digest` outputs refer exclusively to the **final** foundation upload; input and failure/cancellation diagnostic artifacts never authorize the downstream release consumer. Historically, this topology passed the foundation-v6/all-62 and product-v3/all-72 workloads at `70834d5` in run `34081175304`. Those receipts do not qualify the changed contract-8 semantics or the full installed-product matrix; they also do not establish the cause of earlier product refusals. Current qualification status and the delivery/local-testing checklist are recorded in [the Windows requirements](win32-filesystem-backend-requirements.md#10-delivery-roadmap-and-local-windows-testing).

Before the final pack, the unprivileged validation job retrieves the successful artifact by its numeric artifact ID, not by a historical name search. It normalizes the upload action's raw lowercase 64-hex `artifact-digest` output to the REST API's `sha256:<hex>` form, requires GitHub metadata to bind the artifact to the same repository, workflow run, and release commit, then verifies the downloaded ZIP bytes against the same digest. The admission script accepts only the exact seven-file artifact inventory; validates the commit, package version, Node 22.19.0, Rust 1.88.0, MSVC 14.44.35207, strict aggregate and external receipt schemas, closed boundary fields, and every binary digest link; and stages only the fixed physical `.node` plus an ignored assembly-only admission record.

`prepack` revalidates the admission record, release commit, package version, fixed target/path, and current binary digest. After the single `npm pack`, the workflow independently requires that the only `.node` member is one regular binary at `package/artifacts/native/win32-x64-msvc/bazframe-win32.node`, verifies its digest, and confirms that the ephemeral admission record is absent. The tarball, checksum, and admission record cross into the protected publish job, which binds the record's producer repository, numeric repository ID, and producer run ID to the trusted current GitHub context and repeats checksum and native-member verification without rebuilding or repacking.

This mechanism authenticates exact binary bytes for package assembly, not full CLI/Pi/TUI behavior. Ordinary checkout builds/tests omit native bytes; the tag-triggered assembly includes the admitted binary. The first future authorized tag still needs to exercise the same-run workflow wiring end to end, before its protected npm publication step.

Before npm publication, complete the [W9 installed-product matrix and candidate procedure](win32-filesystem-backend-requirements.md#w9-surfaceevidence-map) and W10 package guidance, trusted-publisher setup and final artifact review. W0–W8 source/host work and W9 procedure review are recorded; the full native/installed candidate matrix remains pending.

The candidate needs reviewed CLI **and actual default-Pi** routing, exact source/native/tarball/dependency/environment bindings and genuine local/global installed execution through both names. The product-v5 verifier covers the existing limited internal native/lifecycle slice plus public CLI smoke: independent fresh profile add/use/current, active forced-removal refusal with unchanged profile/selection, and absent-home read-only preservation through each source entrypoint or installed local npm CMD alias. It requires open routing but retains `releaseAdmission: "not-authorized"` and `windowsSupportClaim: false`; it is not the full W9 matrix. Current pack/real-Pi scripts repack and discard fixtures, so their supported-host passes are not exact-candidate or native failure-retention receipts. W9 requires real installed entrypoints, not internal factories or inferred receipt counts. Any later version/source change needs new bindings and affected validation before publication of the exact approved bytes.

Historical unreproduced native activation/selection/prompt refusals are owner-waived nonblocking launch follow-ups, not cured results. The independently harness-interrupted import remains frozen. Current safety or test failures are not waived. Public routing/source preparation does not establish changed-boundary Windows execution, clean-source same-run release admission, account configuration or publication authority; the already-published beta.3 is unchanged.

## Prepare and inspect the exact beta

npm versions are immutable. Use a new version for every correction. `npm run release:check` validates an ordinary binary-free source checkout; it neither manufactures nor release-admits a Windows binary and it does not publish.

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

To prepare a subsequent npm release, use a clean `v<package-version>` tag. `.github/workflows/npm-publish.yml` first runs the same-commit Windows foundation producer and validates without OIDC authority: it verifies the tag, refuses private or missing-license metadata, accepts either a root-license choice or explicit `UNLICENSED`, requires the package to exist, runs ordinary binary-free tests and the production audit, admits the exact same-run native artifact, then packs and verifies one root tarball before checksumming and uploading it. Only the protected `npm` publish job receives `id-token: write`; it re-verifies the downloaded checksum and admitted native member, then publishes that exact tarball with the default `latest` tag. Configure the trusted publisher before pushing a release tag.
