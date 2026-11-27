# Software Factory npm dependency baseline

**Snapshot:** 2026-11-26. Direct versions were checked against the Microsoft npm feed. Select the newest stable release compatible with the approved stack, not a prerelease or an incompatible version just because it has the `latest` tag. These are proposed starter pins, not an installed application or a committed lockfile.

## Decision

Keep one npm project and one lockfile. Vite builds static Svelte assets; Fastify serves those assets and the same-origin API from one non-root Debian/glibc container. Start with the read release and add the Copilot SDK only when implementing and verifying the live runtime. This follows the [backend system plan](../plans/2026-11-26-backend-system.md), [internal API plan](../plans/2026-11-26-internal-api.md), and [Active Sessions design](2026-11-26-active-sessions-attention-design.md).

The alternative is to install the latest tags indiscriminately or add framework wrappers and provider clients up front. That adds packages without enabling new v1 capabilities, and the current Vite and TypeScript tags are not a compatible pair of choices for this baseline.

## Exact pins

**Build toolchain:** Node.js **24.22.3** LTS, the latest patch on the planned Node 24 line in the [official release index](https://nodejs.org/dist/index.json). A newer Node 26 LTS is available, but this baseline keeps the approved Node 24 line. npm **12.2.3** is the latest stable CLI observed; its engine range accepts Node `^24.15.0`. Pin the CLI in development and Docker build provisioning, not in application dependencies. Confirm the exact Node/npm pair in the Linux image before adopting the pins.

### Server runtime (`dependencies`)

| Package | Pin | Why and when |
| --- | --- | --- |
| [`fastify`](https://www.npmjs.com/package/fastify/v/5.12.8) | `5.12.8` | Foundation: HTTP routing, request/response schemas, hooks, structured logs, and injection for tests. Stay on Fastify 5; the Fastify 6 tag observed was alpha. |
| [`@fastify/static`](https://www.npmjs.com/package/@fastify/static/v/10.1.12) | `10.1.12` | Foundation: serve the Vite build. Restrict the SPA fallback to frontend navigation; missing static assets and API routes stay errors. The [plugin compatibility table](https://github.com/fastify/fastify-static#compatibility) covers Fastify 5. |
| [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3/v/13.2.0) | `13.2.0` | Foundation: migrations, short transactions, WAL, and online backup. Native addon: verify install, import, backup/restore, and persisted data on the target Linux image. |
| [`typebox`](https://www.npmjs.com/package/typebox/v/1.4.7) | `1.4.7` | API contract: derive TypeScript DTOs from ordinary JSON Schema objects. Use `typebox`, not both it and `@sinclair/typebox`. Start with Fastify's standard validation and serialization; explicitly reject unexpected request fields. |
| [`@fastify/cookie`](https://www.npmjs.com/package/@fastify/cookie/v/11.1.5) | `11.1.5` | Auth: parse/set the opaque portal session cookie; the [compatibility table](https://github.com/fastify/fastify-cookie#compatibility) covers Fastify 5. The plugin is not a session or CSRF policy. Provider tokens stay encrypted server-side. |
| [`@azure/msal-node`](https://www.npmjs.com/package/@azure/msal-node/v/7.2.3) | `7.2.3` | Auth: delegated Microsoft Entra flow for Azure DevOps Services. Use the server's grant lifecycle and protected cache; no browser MSAL is needed. |

### Build and test (`devDependencies`)

| Package | Pin | Why |
| --- | --- | --- |
| [`svelte`](https://www.npmjs.com/package/svelte/v/5.58.0) | `5.58.0` | Compiles the portal into a static browser bundle; the final Fastify image does not need the Svelte compiler. |
| [`vite`](https://www.npmjs.com/package/vite/v/8.3.8) | `8.3.8` | Static build and development server. `latest` returned `8.4.0-beta.1`; pin the stable release. |
| [`@sveltejs/vite-plugin-svelte`](https://www.npmjs.com/package/@sveltejs/vite-plugin-svelte/v/7.3.1) | `7.3.1` | Svelte/Vite integration. Its published peers accept the chosen Svelte 5 and Vite 8 pins. |
| [`typescript`](https://www.npmjs.com/package/typescript/v/6.0.3) | `6.0.3` | Shared types and server build. `latest` was `7.0.2`, outside the chosen `svelte-check` release's `^5.0.0 \|\| ^6.0.0` peer range. Upgrade together, without overriding peer checks. |
| [`svelte-check`](https://www.npmjs.com/package/svelte-check/v/4.7.8) | `4.7.8` | CI diagnostics for Svelte components and frontend types. |
| [`@types/node`](https://www.npmjs.com/package/@types/node/v/24.19.2) | `24.19.2` | Match the deployed Node 24 APIs, not the Node 26 type line. |
| [`@types/better-sqlite3`](https://www.npmjs.com/package/@types/better-sqlite3/v/9.6.0) | `9.6.0` | External driver declarations. Its version does not track the driver major; verify the SQLite methods used by this project in `npm run check`. |
| [`vitest`](https://www.npmjs.com/package/vitest/v/5.1.1) | `5.1.1` | Node unit and Fastify injection tests. Published engines include Node 24 and its Vite peer includes 8. |
| [`@playwright/test`](https://www.npmjs.com/package/@playwright/test/v/1.65.1) | `1.65.1` | Fixture browser tests at 1080 × 720. Chromium and test dependencies stay out of the deployment image. |
| [`marked`](https://www.npmjs.com/package/marked/v/18.2.1) + [`dompurify`](https://www.npmjs.com/package/dompurify/v/3.4.18) | `18.2.1` / `3.4.18` | Add together when rendering issue detail. Markdown becomes HTML and then is sanitized before injection; provider HTML is sanitized directly, and plain text stays text. [Marked does not sanitize its output.](https://marked.js.org/) Bundle them into the client; do not add a server DOM or leave provider HTML unsanitized. |

### Gated, optional, and intentionally absent

- **Live Copilot only:** [`@github/copilot-sdk@1.0.34`](https://www.npmjs.com/package/@github/copilot-sdk/v/1.0.34) is the stable candidate for the SDK surface documented in the design. Both package names point to the same upstream SDK, but [`@microsoft/copilot-sdk`](https://www.npmjs.com/package/@microsoft/copilot-sdk) is on the 2.x line (`2.0.2-preview.1` under `latest`, `2.0.1` stable). Do not assume 1.x and 2.x are interchangeable. Pick **one** only after a pinned adapter smoke test, including the bundled runtime on Debian and the intended GitHub/EMU host and identity. Do not add a separate CLI package or omit the SDK's platform optional dependencies. See [bundled CLI setup](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/bundled-cli).
- **No extra Fastify type provider initially:** TypeBox-derived types and Fastify's JSON Schema path are enough. If adding [`@fastify/type-provider-typebox@6.3.0`](https://www.npmjs.com/package/@fastify/type-provider-typebox/v/6.3.0), verify its `typebox` and `ajv-formats` peers and decide how validation errors are mapped before enabling a custom compiler.
- **Use what is already present:** Fastify's Pino integration, Node `fetch`, `crypto`, `URL` and `child_process`, browser navigation APIs, native form controls, and CSS. Git is an OS dependency where needed. No duplicate HTTP client, Octokit, Azure DevOps client, JWT session library, SvelteKit/SSR runtime, component framework, Redis, or queue package in the baseline.

## Microsoft feed and portable lockfile

Use the Microsoft npm feed as **environment or CI configuration**, not as a checked-in tarball source. A tracked project `.npmrc` may contain just the portable policy, with no hostname or credential:

```ini
save-exact=true
omit-lockfile-registry-resolved=true
```

Configure the registry separately, via the approved developer npm config or `NPM_CONFIG_REGISTRY` in controlled CI. Supply a scoped npm config to Podman using a [build secret mount](https://docs.podman.io/en/latest/markdown/podman-build.1.html#secret-id-id-src-env-env-type-file-env). Do not use build `ARG`/`ENV` for secrets, copy the credential file into an image, or commit it. Do not add an automatic fallback that routes company installs outside the approved feed.

Generate `package-lock.json` through npm with `--omit-lockfile-registry-resolved`; do not hand-edit tarball URLs. [npm documents](https://docs.npmjs.com/cli/v11/using-npm/config/#omit-lockfile-registry-resolved) that registry dependencies then omit `resolved`; [`npm ci`](https://docs.npmjs.com/cli/v11/commands/npm-ci/) uses the configured registry to locate artifacts. Exact versions and integrity remain locked; there can be extra registry lookups. The option does **not** sanitize Git, explicit tarball, or file dependencies, so keep those out of the initial manifest.

### Verification

- **Done for this document:** a throwaway manifest resolved these 17 direct pins using Microsoft feed metadata, `--package-lock-only --ignore-scripts --strict-peer-deps --omit-lockfile-registry-resolved`, and the available local Node 26/npm 11.20 toolchain. All 192 registry entries retained integrity hashes, none contained `resolved`, and the feed hostname did not appear in the lockfile. `npm ci --dry-run` accepted it without creating `node_modules`. No project manifest, lockfile, or installation was created.
- **Before committing an application lockfile:** repeat on the pinned Node 24/npm pair and run `npm ci` and the build/check/test scripts in the Linux image. Verify that Fastify starts with its plugins registered (installation alone does not check their Fastify version constraints) and that the native SQLite addon loads. Assert the real lockfile contains no feed hostname or registry `resolved` fields and retains registry-package integrity. Do not ship the SDK until its separate runtime checks pass.
