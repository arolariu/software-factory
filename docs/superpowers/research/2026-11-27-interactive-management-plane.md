# Public-first interactive authentication for the management plane

Date: 2026-11-27 · Scope: Tauri/Fastify desktop and hosted container · Method: official docs only, read 2026-11-27. No provider account was contacted, configured, or tested; nothing installed.

Legend — **D** = stated in official docs. **I** = my inference from docs. **S** = not settled by docs; must be proven in staging.

## 1. Feasibility matrix (read this first)

| # | Path | Secretless public client? | Admin / owner action needed | Status | Verdict |
|---|------|---------------------------|-----------------------------|--------|---------|
| G1 | GitHub App device flow, identity only | Yes (`client_id` only) | None beyond registering the app | **D** | Feasible |
| G2 | GitHub App refresh of device-flow token | Yes: `client_secret` not required for device-flow tokens | None | **D** | Feasible |
| G3 | GitHub App user token → private repos / org resources | Token is secretless, but access needs **app installation** | Install on the owning account; org owner (or repo admin if app has no org permissions) | **D** | "No installation consent" holds **only** for identity/account-level calls |
| G4 | GitHub web-flow + loopback + PKCE on desktop | **No**: code exchange lists `client_secret` as required; PKCE is only "strongly recommended" | None | **D** | Not secretless. Use device flow instead |
| G5 | github.com **EMU** user authorizing the app | Candidate | Enterprise policy may restrict; EMU users cannot install apps on their user account (privileged apps excepted) | Install limits **D**; authorize path **S** | Prove in EMU staging |
| G6 | **ghe.com** (data residency) | Unverified | A separate registration per enterprise may be required | **S** | Verify before enabling |
| G7 | Optional Copilot authorization via `ghu_` token | Yes | Copilot Business/Enterprise seat for EMU/ghe.com users | Token types **D**; app-permission needs **S** | Feasible as separate opt-in capability |
| E1 | Entra desktop: auth code + PKCE, system browser, loopback redirect, public client | Yes | User consent, or admin consent if scopes are admin-restricted | **D** | Primary Entra path for desktop |
| E2 | Entra hosted: device code, public client | Yes (no redirect URI) | CA may **block** device code flow tenant-wide | Protocol **D**; per-tenant availability **S** | Fallback only; expect refusals |
| E3 | Entra hosted: auth code on a web redirect | **No**: confidential client (secret/cert) | Per-tenant consent | **D** (client-type definition) | Outside "public-first" |
| E4 | Conditional Access end-to-end | n/a | Tenant CA owner | Device-code block **D**; other signals **S** | Must be tested per policy type |

**Bottom line.** There are documented secretless desktop protocols on both providers: GitHub device flow and Entra loopback + PKCE. For the hosted deployment, device authorization is the candidate evaluated here; it is distinct from Factory's existing confidential HTTPS callback. Microsoft recommends blocking most Entra device-code use, so don't assume it is available in a particular tenant. For GitHub, protected resource access additionally requires an approved app installation. None of these flows has been proven against a Factory registration in staging.

## 2. GitHub

### 2.1 Device flow and refresh (no secret)
- Device flow is for "CLI tools, … desktop applications"; it must be enabled per app (**Enable Device Flow**) and uses RFC 8628 (**D**).
  [Generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) · [Modifying a registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)
- Request: `POST https://github.com/login/device/code` with `client_id`; optional `scope=offline_access`, the only supported scope. Response: 40-char `device_code`, 8-char `user_code`, `verification_uri` `https://github.com/login/device`, `expires_in` default 900, `interval` default 5 (**D**). No `verification_uri_complete` is documented (**I**).
- Poll `POST https://github.com/login/oauth/access_token` with `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Errors: `authorization_pending`, `slow_down` (+5s to interval), `expired_token`, `access_denied`, `device_flow_disabled`, `incorrect_device_code` (**D**). Optional `repository_id` narrows the token to one repo.
- Token result: `ghu_…` access token, `expires_in` 28800 (8h), `ghr_…` refresh token, `refresh_token_expires_in` 15897600 (6 months), `scope` always empty (**D**).
- Refresh: `POST …/oauth/access_token` with `client_id`, `grant_type=refresh_token`, `refresh_token`. `client_secret` is "**Required** unless the user access token was generated using the device flow" (**D**). [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- Refresh rotates: using a refresh token invalidates it and the old access token (**D**). Concurrent refreshes from two processes will lose (**I**) → single-writer refresh with atomic store.
- Expiring tokens: on by default for new apps; `offline_access` forces expiry even if the app opted out (**D**). Re-enabling later does not expire pre-existing tokens (**D**).
- Revocation: user can revoke; app gets `github_app_authorization` webhook; revoked token returns 401 (**D**). A device-only app with no webhook needs 401 → "re-authorize" handling (**I**).

### 2.2 Authorization vs installation (the "no consent" question)
- "An app does not need to be installed in order for a user to authorize the app" and the reverse (**D**). [On behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user) · [Authorizing GitHub Apps](https://docs.github.com/en/enterprise-cloud@latest/apps/using-github-apps/authorizing-github-apps)
- Authorization grants: verify identity, learn which resources the user can access that the app can also access, act as the user within account permissions (**D**).
- The token reaches only resources the **user and app both** can reach, and only in accounts **where the app is installed** (**D**). Private repo/org management therefore needs installation: org owner, or repo admin if the app asks for no org permissions and not "Repository administration" (**D**). [Installing from a third party](https://docs.github.com/en/enterprise-cloud@latest/apps/using-github-apps/installing-a-github-app-from-a-third-party)
- Orgs can restrict repo-admin installs, forcing owner request (**D**). Permission increases require per-installation / per-user re-approval (**D**).
- Design consequence: model "signed in" and "can manage repo X" as separate states; the second depends on an installation check (`GET /user/installations`, documented on the generate-token page) (**D**).

### 2.3 EMU on github.com
- Managed users authenticate only via IdP; contribute only inside the enterprise; all API requests are restricted likewise (**D**). [Abilities and restrictions](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/understanding-iam-for-enterprises/abilities-and-restrictions-of-managed-user-accounts)
- EMU users: cannot install apps on their own account except privileged GitHub-owned apps; can install on a repo if admin and no org permissions; can install on an org if org owner (**D**). [Privileged apps](https://docs.github.com/en/enterprise-cloud@latest/apps/using-github-apps/privileged-github-apps)
- Docs do not say that EMU users are barred from authorizing a third-party app; they do not confirm it either (**S**).
- SAML/SSO: the user needs an active SSO session **before** authorizing, or org resources are invisible; credential authorization is tied to that sign-in session, so a new device/session needs a new one (**D**). [SAML and GitHub Apps](https://docs.github.com/en/enterprise-cloud@latest/apps/using-github-apps/saml-and-github-apps) Whether refresh survives SSO-session expiry is unspecified (**S**).
- **Conditional Access (Entra OIDC EMU) — decisive for hosted.** For GitHub/OAuth apps acting for a user, "GitHub will send the IP address of the app's server to your IdP"; failure blocks the request. Admins can allow-list app IPs or exempt installed apps from the IdP allow list; app-as-itself/installation calls bypass CAP (**D**). [CAP support](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/configuring-authentication-for-enterprise-managed-users/about-support-for-your-idps-conditional-access-policy)
  - Desktop calling GitHub directly presents the user's IP (**I**). Hosted container presents its own IP, so hosted needs an allow-list or exemption (**D** mechanism, **I** application).
  - GitHub enforces IP conditions only, not device compliance; MFA only at IdP sign-in (**D**).

### 2.4 ghe.com (data residency)
- Dedicated `SUBDOMAIN.ghe.com`; EMU is the only identity model; API at `https://api.SUBDOMAIN.ghe.com`; hostnames `*.SUBDOMAIN.ghe.com`, `auth.ghe.com`; Marketplace unavailable; apps "may require modification to work on GHE.com" (**D**). [About data residency](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency) · [Feature overview](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/feature-overview-for-github-enterprise-cloud-with-data-residency) · [Network details](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/network-details-for-ghecom)
- Not documented in pages read (**S**): the exact device endpoints on ghe.com (GHES docs use `HOSTNAME/login/device/code`; ghe.com likely `https://SUBDOMAIN.ghe.com/login/device/code`); whether a GitHub App registered on github.com is usable there (assume **no** → per-enterprise app and `client_id`, host-parameterised config **I**).
- Third-party apps installed at enterprise level "must be public" (**D**, installing page).

### 2.5 Optional Copilot authorization
- Copilot SDK accepts `ghu_` (GitHub App user token), `gho_`, `github_pat_`; rejects classic `ghp_` (**D**). Each user needs their own Copilot subscription; usage bills to them; EMU enforcement is server-side. [SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate) · [GitHub OAuth setup](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth)
- EMU/ghe.com users cannot self-sign-up for Copilot; they need Business/Enterprise access granted (**D**). [Abilities](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/understanding-iam-for-enterprises/abilities-and-restrictions-of-managed-user-accounts) · [Copilot on GHE.com](https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-in-your-ide/set-up-copilot/authenticate-to-ghecom) (`copilot login --host SUBDOMAIN.ghe.com`)
- SDK does not manage OAuth lifecycle; the app stores/refreshes. Options: static `gitHubToken` with `useLoggedInUser: false`, or session `gitHubTokenProvider` (receives `host`, `reason` initial/refresh; must return `expiresIn`; refresh requested at ≤1 h left; no background timers) (**D**).
- Not documented (**S**): whether a **device-flow `ghu_` token with no installation** is accepted for Copilot, whether the app needs any specific permission, and whether org policy on third-party apps affects it. Treat Copilot as a separately-gated, failure-tolerant capability.

## 3. Microsoft Entra

### 3.1 Desktop: auth code + PKCE, system browser, loopback
- Auth code + PKCE is the documented flow for desktop and mobile; Microsoft says to use MSAL rather than raw HTTP (**D**). [Auth code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- Native redirect: `http://localhost` for system browsers (**D**). Loopback port is ignored when matching (RFC 8252 §7.3); prefer `127.0.0.1`, but the portal rejects http loopback entry so edit `replyUrlsWithType` in the manifest; `[::1]` unsupported; don't register URIs differing only by port (**D**). [Redirect URI best practices](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)
- Register under platform **Mobile and desktop applications** (**D**). The reply-url page says apps with redirect URIs "need to enable a public client flow configuration"; the MSAL page lists device code/ROPC/WIA as the cases for the toggle (**D**, mildly inconsistent → confirm the toggle in staging **S**). [Public vs confidential](https://learn.microsoft.com/en-us/entra/identity-platform/msal-client-applications)
- Refresh tokens: default 90 days (24 h for SPA redirect types); rotated on every use but the old token is **not** revoked, so delete the old one; store like credentials; not tied to a resource/tenant (**D**). [Refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)

### 3.2 Hosted: public device code
- `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode` with `client_id`, `scope`; poll `/token` with the device grant; user has 15 min; errors `authorization_pending`, `authorization_declined`, `bad_verification_code`, `expired_token`; `offline_access` yields a refresh token; **`verification_uri_complete` is not supported** (**D**). [Device code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
- No redirect URI needed; public-client toggle applies (**D**, reply-url + msal pages).
- **Tenant risk:** Microsoft recommends "as close as possible to a unilateral block on device code flow" via a Conditional Access Authentication Flows condition; allow only documented, secured cases (**D**). [Block authentication flows](https://learn.microsoft.com/en-us/entra/identity/conditional-access/policy-block-authentication-flows) Plan an explicit "blocked by tenant policy" outcome (**I**), plus an admin-facing request for an exclusion.
- Not documented in pages read (**S**): which client IP/device signals CA evaluates when the browser sign-in and the token redemption happen on different machines (user's browser vs hosted container), and how device-compliance or token-protection policies behave in device code flow.

### 3.3 Consent and admin consent
- Delegated permissions: user consents for own data; admin for all users; app-only permissions need admin (**D**). [Permissions and consent](https://learn.microsoft.com/en-us/entra/identity-platform/permissions-consent-overview)
- Default: users may consent to permissions that do not require admin consent; admin-restricted scopes (e.g. `Directory.ReadWrite.All`) fail for non-admins with "not authorized to consent" (**D**). Admins may restrict user consent (e.g. verified publishers only) or disable it; the admin-consent workflow lets users request approval (**D**). [Configure user consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent) · [Admin consent workflow](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/admin-consent-workflow-overview) Publisher verification is recommended (**D**).
- The management plane's target is delegated Azure DevOps Boards and Git read access, not Microsoft Graph or ARM. Confirm effective app permissions, consent and policy against the actual Azure DevOps resource in staging (**S**). [Azure DevOps Entra OAuth](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/entra-oauth?view=azure-devops) · [CA target resources](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-conditional-access-cloud-apps)

## 4. RFC 8628 limits to design around
Source: [RFC 8628 §5](https://www.rfc-editor.org/rfc/rfc8628).
- §5.4 remote phishing: attacker starts a flow and lures the victim to enter the code. Mitigate by telling the user they are authorizing *this* device/app, with the code visible in the product UI. Short code lifetime limits emailed codes.
- §5.5 session spying: don't leave the user code on a shared screen/log.
- §5.2–5.3: high-entropy `device_code`; approving device ≠ requesting device, so approver-side signals say little about the requester. Directly relevant to hosted: the container is the "device".
- §5.6: device clients are public clients and impersonable; the user holding the client can already mint their own grants. Applies to both providers' public client IDs; `client_id` is not a secret.
- Polling: honor `interval`, back off on `slow_down` (RFC §3.5; GitHub adds +5 s).
- PKCE does not apply to device flow (**D**/**I**); GitHub PKCE applies only to the web flow.

## 5. Storage notes (only as useful)
- Desktop: GitHub's own tutorial writes the token to a `chmod 0600` file; treat that as a floor, not a product design. Copilot CLI's documented default stores credentials in the system keychain (**D**, SDK auth page). Use the OS vault for both GitHub `ghr_` and Entra refresh tokens, with an atomic write-after-refresh because both providers rotate (**I**). MSAL docs recommend its cross-platform cache for desktop apps (**D**). [MSAL token cache](https://learn.microsoft.com/en-us/entra/msal/dotnet/how-to/token-cache-serialization)
- Hosted: per-user token storage is the app's job (**D**, SDK OAuth page); MSAL guidance for servers is a distributed cache plus encryption at rest (**D**). Refresh tokens are long-lived credentials: encrypt, scope per user, and never log.

## 6. Staging proofs required (do not run against real tenants yet)
1. GitHub App, device flow on, expiring tokens on, no client secret: login → refresh → refresh again; confirm the old refresh token dies and no secret is needed.
2. Same user, app **not installed**: `GET /user` works; `GET /user/installations` empty; private repo call fails. Then install → repo call succeeds.
3. github.com EMU user: can they authorize (not install) a third-party app; org-owner install path; behavior under an Entra OIDC CAP IP rule, from desktop IP vs hosted container IP.
4. SAML-enforced org: authorize without then with an active SSO session; refresh after SSO session expiry.
5. ghe.com tenant: app registration location, device endpoint URLs, and whether a github.com-registered app is rejected.
6. Copilot: `ghu_` device-flow token with no installation, via static token and via `gitHubTokenProvider`, for a seat-holder and a non-seat-holder, on github.com EMU and ghe.com.
7. Entra desktop: 127.0.0.1 loopback registered by manifest; public-client toggle on vs off; user consent vs admin-restricted scope; refresh after CA sign-in-frequency policy.
8. Entra hosted device code: tenant with the device-code block policy (expect failure) and without; CA location and compliance policies when approval happens on a different machine than the container.

## 7. Unresolved / not found
- No official page found stating the ghe.com device-flow URLs or whether a github.com GitHub App can be reused on ghe.com.
- No official statement found on Copilot acceptance of installation-less GitHub App user tokens beyond the SDK's token-type table.
- Entra CA behavior for device code redemption IP and device signals was not found in the pages read.
- RFC 8252 was cited through Microsoft's quotation of §7.3/§8.3, not read directly.
