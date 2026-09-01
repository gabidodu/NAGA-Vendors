# Naga Vendors – Project Documentation

_Last updated: 2026-09-01_

## 1. Overview

Teams-ready vendor directory built on top of the standard Business Central `Vendor` table. Users browse/search vendors across multiple BC environments and companies, view a detail panel, edit a handful of real contact fields, and save changes back to BC. Runs live in Microsoft Teams as a personal tab, hosted on Azure App Service, with Business Central access via certificate-based Application permissions and user access via Teams SSO.

## 2. Current status — fully working end to end

- React (Vite) frontend + Express backend, deployed as a single Azure App Service
- Real Business Central data (not mock) across two environments (Romania/W1, Germany) and all their companies
- Environment + Company selectors, live-fetched from BC (no hardcoded lists)
- Corrected field mappings (country, tax no., status, payment terms, contact person — see §6)
- Inline editing of the vendor's real writable fields, saved back to BC via PATCH with optimistic-concurrency (`If-Match`)
- Teams SSO: the tab loads with no login prompt for users already signed into Teams; the API rejects anything without a valid token for the Naga tenant
- Live at **https://naga-vendors.azurewebsites.net**, sideloaded in Teams as "Naga Vendors" (personal scope)

## 3. Application architecture

### Frontend ([src/App.jsx](src/App.jsx), [src/App.css](src/App.css), [src/teamsAuth.js](src/teamsAuth.js))
- React + Vite, single page, full-width layout (fills whatever space the Teams tab gives it)
- Environment selector → Company selector → Vendor list → Detail panel, in that dependency order
- `teamsAuth.js` acquires a Teams SSO token silently via `@microsoft/teams-js` (`app.initialize()` + `authentication.getAuthToken()`, both timeout-guarded) and attaches it as `Authorization: Bearer <token>` to every `/api/*` call via the `apiFetch()` helper
- Visible diagnostic banners (SSO status, API errors) render directly in the page when something goes wrong — no DevTools required to debug a broken deploy

### Backend ([server.js](server.js))
- Express server; in production it also serves the built frontend (`dist/`) as static files, with a SPA catch-all route — one deployable unit, one Azure resource
- `requireTeamsAuth` middleware gates every `/api/*` route: validates the bearer token's signature (via BC tenant's JWKS), audience, and issuer before anything else runs. `SKIP_TEAMS_AUTH=true` (local `.env` only, never set in Azure) bypasses this for local development
- `getBcAccessToken()` authenticates to Business Central using the app's X.509 certificate (client-credentials / Application permissions) — two methods tried in order: MSAL against the Windows cert store (works locally, always fails on Linux Azure), falling back to manually signing a JWT client assertion with the PEM key (works everywhere, including Azure)
- Endpoints:
  - `GET /api/environments` — configured environment list (`BC_ENVIRONMENTS`)
  - `GET /api/companies?environmentName=` — live company list fetched from BC for that environment
  - `GET /api/vendors?environmentName=&companyId=&q=&sort=&direction=` — live vendor list, with search/sort applied server-side
  - `PATCH /api/vendors/:id?environmentName=&companyId=` — updates the real writable fields (see §5), re-fetches the current `@odata.etag` first and sends it as `If-Match`
  - `GET /health` — liveness check
  - `GET /api/auth/config` — non-secret config/status introspection

### Data flow / auth model
```
Teams client (signed-in user)
   │  silent SSO token (no login prompt, no redirect)
   ▼
Azure App Service (naga-vendors.azurewebsites.net)
   │  validates the Teams token per request (tenant-restricted)
   ▼
Express backend
   │  separate certificate-based app-only token (Application permissions)
   ▼
Business Central API v2.0
```
Two independent identities are in play: the **signed-in Teams user** (gates who can reach the app at all) and the **app's own certificate** (what BC sees — same access level for every user, since BC access isn't per-user delegated). See §8 for the implication of that.

## 4. Business Central API reality (v2.0) — what's actually there

Confirmed directly against BC's `$metadata` and live data, not assumed:

| Field | Real BC property | Writable? |
|---|---|---|
| Vendor No. / Name | `number` / `displayName` | name is writable, not exposed as editable in this app |
| City / Country | `city` / `country` | yes |
| Address | `addressLine1` (+ `addressLine2`, concatenated for display) | yes (edits go to `addressLine1` only) |
| Phone / Email / Website | `phoneNumber` / `email` / `website` | yes |
| Tax No. | `taxRegistrationNumber` | yes |
| Balance | `balance` | no (calculated) |
| Status | derived from `blocked` (an OData-encoded option: `_x0020_` = Active, `Payment` = blocked for payment, `All` = fully blocked) | **yes** — 3-value enum, edited as a dropdown |
| Payment Terms | `paymentTermsId` (a GUID) → resolved to a human code via a separate `/paymentTerms` lookup, cached 10 min | no |
| Contact Person | `contactsInformation` (`$expand`ed navigation property, links to the BC Contact table) | **no — read-only, see below** |
| Vendor Posting Group, Type | — | **don't exist in this API at all** |

**Contact Person is read-only by BC's own design**, not a limitation we introduced: the `contactsInformation` entity set's metadata explicitly marks it `Insertable: false`, `Updatable: false`, `Deletable: false`. There is no standard-API path to change which BC Contact is linked to a vendor — only a custom AL extension in BC could expose that. The app shows it as a styled read-only textbox (see §5), populated correctly from live data, with no false promise of editability.

## 5. Editable fields & the save flow

Editable in the detail panel: **Phone, Email, Website, City, Country, Address, Tax No., Status** — chosen because these are the only detail-panel fields that map to genuinely writable BC properties. Status is a 3-option dropdown (Active / Blocked (Payment) / Blocked (All)), not free text — BC's `blocked` field is a fixed enum, confirmed against `$metadata`, so the UI only offers valid values.

- Each renders as a pre-filled text input; a single **"Save changes"** button in the panel header enables once anything differs from the loaded value
- On save, only the changed fields are sent in one `PATCH` request
- Backend re-fetches the vendor's current `@odata.etag` immediately before patching and sends it as `If-Match` — if someone else changed the record in the meantime, BC rejects the write instead of silently overwriting it
- BC's response (the authoritative saved values) replaces the local copy after a successful save

Contact Person, Vendor Posting Group, Payment Terms, Last Modified, Type, and Notes remain plain read-only display — either because BC doesn't expose them as writable, or (Vendor Posting Group / Type / Notes) because they don't exist in this API at all.

## 6. Fixes made to the original prototype

The prototype (see git history / earlier version of this doc) had several bugs that silently produced empty or wrong fields. Fixed:

- **JWT client-assertion signing bug**: the manual certificate-auth JWT used the wrong header claim (`kid` with a hex string) instead of the Entra ID–required `x5t` (base64url of the raw thumbprint bytes) — this alone caused every certificate auth attempt to fail with `AADSTS700027`
- **Country**: was reading a non-existent `countryRegionCode` field; the real property is `country`
- **Tax Registration No.**: was reading `taxRegistrationNo`; the real property is `taxRegistrationNumber`
- **Status**: was reading `state` (which is actually the address state/province field, not vendor status) and always fell back to "Active"; now correctly derived from the `blocked` option field
- **Payment Terms**: was reading a non-existent `paymentTermsCode`; the real property is a GUID (`paymentTermsId`) requiring a lookup against the separate `/paymentTerms` endpoint
- **Contact Person**: wasn't populated at all — needed `$expand=contactsInformation` on the vendors query, which isn't included by default

## 7. Azure hosting

- **Tenant**: Naga (`a0428cb6-fed4-4ff3-b12f-0dc16e3cdfe8`) — note this is a *different* tenant from the one this workstation's Azure CLI originally logged into (itassist.eu); a separate device-code/interactive login was required to reach the "Business Apps" subscription that lives in Naga's tenant
- **Subscription**: Business Apps (`f378dcfa-4494-47eb-91bb-e8546bfe040a`)
- **Resource group**: `NagaVendors-RG` (West Europe)
- **App Service Plan**: `asp-naga-vendors`, Linux, **F1 (Free tier)** — deliberately chosen for zero cost during development; upgrade to B1 (~13 EUR/month) before real production load (F1 has a 60 CPU-minute/day cap and no "Always On")
- **Web App**: `naga-vendors` → https://naga-vendors.azurewebsites.net, Node 22-lts
- **Deploy method**: local build (`npm run build`) + `npm install --omit=dev` in a clean staging folder + zip deploy (`az webapp deploy --type zip`) — `SCM_DO_BUILD_DURING_DEPLOYMENT=false`, since Oryx build on the free tier is unreliable/slow. No CI/CD pipeline yet; every deploy so far has been run manually from this workstation
- **Secrets**: the certificate private key is stored as the `BC_CERT_PEM` app setting (raw PEM content), not as a file — the code checks `BC_CERT_PEM` first and only falls back to a local `BC_CERT_PATH` file for local dev. App settings are visible to anyone with Contributor+ access to the resource; a Key Vault reference would be the next hardening step if that's a concern
- SCM/Kudu basic-auth publishing credentials are disabled by default on this app (Azure default); they were only turned on briefly, twice, to inspect deployed files, then turned back off immediately both times

## 8. Security model — read this before adding more users

- **Business Central access is app-only, not per-user.** The backend authenticates to BC with its own certificate (`D365 BUS FULL ACCESS` permission set, granted to the app's Entra identity, not to individual people). Every Teams user who can open the tab gets the *same* BC access level — there's no way, today, for BC's own user permissions to restrict what a specific person can see or edit through this app.
- **Teams SSO controls who can open the tab at all**, not what they can do once inside. Any user in the Naga Entra tenant who can sideload/is given the Teams app can read *and write* vendor data across every environment/company configured in `BC_ENVIRONMENTS`.
- Practical implication: before rolling this out beyond a small pilot group, decide whether "any Naga Teams user can edit vendor contact/address data everywhere" is acceptable, or whether a narrower distribution (specific security group) or an app-level allow-list is needed.
- The static frontend shell (HTML/JS/CSS) is intentionally public/unauthenticated — that's required for the Teams iframe to render at all (see §9). No vendor data is ever in that shell; it only ever appears in API responses, which are gated.

## 9. Why Teams SSO (and not a simpler redirect login)

First attempt used Azure App Service "Easy Auth" (classic redirect-to-login). It **broke the Teams tab outright** — Teams renders tabs in an iframe, and the Microsoft login page refuses to render inside one (`X-Frame-Options`), so the tab showed a permanent 🚫 blocked icon. Rolled back immediately, then replaced with proper Teams SSO:

- Entra ID app (`85bca5eb-7bf7-4dbc-b65a-87d32db793e1`) exposes an API (`api://naga-vendors.azurewebsites.net/85bca5eb-7bf7-4dbc-b65a-87d32db793e1`) with an `access_as_user` delegated scope, pre-authorized for the official Teams desktop/web client IDs (no user consent prompt needed)
- Teams manifest declares `webApplicationInfo` pointing at that same app + resource
- Frontend acquires a token silently via `authentication.getAuthToken()` — no page navigation, so the iframe restriction never comes into play
- **Gotcha that cost real debugging time**: Teams' `getAuthToken()` actually issues a **v1.0**-shaped token (bare client-ID audience, issuer without `/v2.0`) even though the app registration requests v2 tokens. The backend validates against both v1 and v2 audience/issuer shapes to handle this.

## 10. Teams app package

- Location: [teams-app/manifest.json](teams-app/manifest.json), [teams-app/color.png](teams-app/color.png), [teams-app/outline.png](teams-app/outline.png), zipped as `teams-app/naga-vendors-teams-app.zip`
- Currently sideloaded for personal use only (`scopes: ["personal"]`) — not published to the org catalog
- To share with a colleague: send them the same zip; they sideload it themselves via Teams → Apps → Manage your apps → Upload a custom app. Works only if their account's Teams app-setup policy allows custom app uploads (same as any tenant's sideloading policy — not guaranteed identical for every user)
- To make it available org-wide without manual zip-sharing: a Teams admin uploads the same package to the tenant's app catalog (Teams Admin Center → Teams apps → Manage apps)

## 11. Known limitations / things not built

- No automated tests
- No CI/CD — deploys are manual (`npm run build` → zip → `az webapp deploy`); version control exists (GitHub: [gabidodu/NAGA-Vendors](https://github.com/gabidodu/NAGA-Vendors), added 2026-09-01) but pushing does not trigger a deploy
- No Key Vault — certificate and secrets live in App Service settings
- Editable field set is deliberately narrow (§5); anything not listed either doesn't exist in the BC API or isn't writable
- Contact Person cannot be reassigned through this app or any standard BC API call — would require a custom BC AL extension
- Only two environments configured (Romania/W1, Germany); their Sandbox counterparts exist in BC but aren't wired into the app

## 12. Next steps (not yet done, ordered by likely priority)

1. Decide on and enforce a distribution boundary for the Teams app (see §8)
2. Move `BC_CERT_PEM` and other secrets to Azure Key Vault with a managed identity
3. Upgrade the App Service plan from F1 to B1+ before any real usage load
4. Set up CI/CD (GitHub Actions or Azure DevOps) instead of manual zip deploys
5. If per-user BC permissions ever matter, revisit the auth model — app-only access can't express that today

## 13. Session log — 2026-09-01

**Goal for the session:** add OCR-based field pre-fill after a vendor document upload — recognize text, propose matching values for the editable fields, let the user accept/reject per field, never overwrite existing data automatically. Ended in a revert; logged here so the attempt (and why it didn't work) isn't lost.

**Version control introduced.** The project had no git history before this session. Initialized a local repo, committed the pre-session state as a baseline (`6b56610`), then pushed to a new GitHub repo: [gabidodu/NAGA-Vendors](https://github.com/gabidodu/NAGA-Vendors). All work below is on `master` as a linear commit history.

**OCR feature built, then reverted.**
- Approach (chosen for zero ongoing cost, no cloud OCR service): `pdf-parse` reads the text layer of digital PDFs; `tesseract.js` OCRs plain images (jpg/png/webp); a scanned PDF with no text layer was an accepted v1 gap (rasterizing it would need a native-binary dependency — see the deploy bug below for exactly why that's risky here). A generic regex library over RO/EN labels (CUI/Cod fiscal, Tel, Adresă, Oraș, Țara, email, website) mapped recognized text onto the app's editable vendor fields. Recognition was scoped to only run on a vendor's *first* uploaded file (checked server-side against the actual SharePoint folder contents).
- **Deploy-breaking bug found and fixed:** `pdf-parse`'s `pdfjs-dist` dependency needs a global `DOMMatrix` (used internally even for plain text extraction) and tries to get one from an optional native binding, `@napi-rs/canvas`. This project builds on Windows and zip-deploys straight to Linux Azure with no server-side `npm install` (see §7) — so the Linux-native binary for that package is never present, and the app **crashed at import time** on every deploy (`ReferenceError: DOMMatrix is not defined`), even though it worked fine locally (where the Windows-native binary was available, masking the issue). Fixed with a pure-JS `DOMMatrix` polyfill (the `dommatrix` package, zero dependencies) loaded before `pdf-parse` — verified by disabling the native binding locally to reproduce the Linux failure, and by a smoke-test run from the actual staged deploy folder before shipping. Also hit and fixed an unrelated `pdf-parse` v2 API surprise: the package switched from a default export function (older docs/examples) to a `PDFParse` class (`new PDFParse({ data }).getText()`).
- **Security audit performed** (prompted by "does using public OCR libraries introduce risk, and can this app be reached from outside"): `npm audit` clean for the new dependencies; only one install-time script across all of them (`tesseract.js`'s standard, harmless funding-message postinstall — verified by reading it). Added a 15s timeout around extraction so a crafted upload can't hang a request. Vendored the OCR language data (`eng`/`ron` `.traineddata`) into the repo instead of fetching it from a public CDN at runtime. Checked live Azure config directly (not just assumed from docs): confirmed Easy Auth is fully off (no leftover from the abandoned attempt in §9), and found `httpsOnly` was `false` — fixed to `true` (kept after the revert, since it's an unrelated hardening fix). Conclusion on "no external access": not achievable while this stays a Teams personal tab — Teams clients connect from each user's own network, not a lockable Microsoft IP range — so the real access boundary is, and remains, the per-request Entra ID bearer-token check (§3), not network isolation.
- **Reverted:** tested against real vendor documents in production — the generic v1 regex patterns didn't recognize their actual labels/layout, so the feature wasn't adding value as built. Reverted to the pre-session baseline via a new commit (`08f2631`) rather than force-rewriting history — the full implementation and both fixes above are still in the git log (`cb3468d`..`793b1f2`) if this is revisited with real sample documents to design the patterns against.

**Incidental fix, unrelated to OCR:** the deploy steps in [README.md](README.md#deploying-to-azure) never copied `src/services/` into the staging folder — but `server.js` has always imported `./src/services/sharepoint.js` (the SharePoint file-storage integration), so a deploy following the README literally would have been missing that module. Not previously hit because past manual deploys apparently included it by hand without updating the doc. Fixed in this session (see README).

**Net effect on production:** functionally unchanged from before the session, except `httpsOnly` is now enforced and the project has git history + a GitHub remote going forward.
