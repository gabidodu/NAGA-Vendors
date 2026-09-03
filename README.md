# Naga Vendors

A Business Central vendor directory running as a Microsoft Teams tab. Live at **https://naga-vendors-ca.braveground-e06101b4.westeurope.azurecontainerapps.io**, hosted on Azure Container Apps (Consumption plan) in the Naga tenant. See [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) for the full architecture, security model, and history of fixes — this file only covers running and deploying it.

## What it does

Browse and search Business Central vendors across multiple environments (Romania/W1, Germany) and their companies, pick one to see its detail panel, and edit its real writable fields (phone, email, website, city, country, address, tax no.) — changes save straight back to Business Central via PATCH. Runs as a Teams personal tab with silent Teams SSO; no separate login for users already signed into Teams.

## Local development

```bash
npm install
npm run dev        # Vite dev server (port 5173), proxies /api to :4000
node server.js     # Express backend (port 4000), in a second terminal
```

`.env` needs `SKIP_TEAMS_AUTH=true` for local dev — the real Teams SSO token flow only works when the app is actually running inside a Teams tab. Never set this in Azure.

To test the production build (backend serving the built frontend, same as Azure):
```bash
npm run build
node server.js     # now serves dist/ directly at http://localhost:4000
```

## Business Central connection

Real data only — there is no mock mode toggle worth using anymore (`BC_USE_REAL=true` is required for anything meaningful). Configure in `.env`:

```env
BC_USE_REAL=true
BC_TENANT_ID=a0428cb6-fed4-4ff3-b12f-0dc16e3cdfe8
BC_CLIENT_ID=85bca5eb-7bf7-4dbc-b65a-87d32db793e1
BC_ENVIRONMENT_NAME=W1
BC_ENVIRONMENTS=W1|Romania (W1),German|Germany
BC_COMPANY_ID=<a real company GUID from /api/companies, not a company code>
BC_CERT_PATH=C:\path\to\bc-app-key.pem      # local dev
BC_CERT_PEM=<raw PEM content>                # used instead of BC_CERT_PATH in Azure
BC_CERT_THUMBPRINT=<thumbprint>
```

`BC_COMPANY_ID` **must be the company's internal GUID**, not its short code (e.g. `AE-KWM`) — get it from `GET /api/companies?environmentName=W1`.

### Authentication to Business Central

Certificate-based Application permissions (client-credentials flow) — the backend authenticates as itself, not as any individual user. Requires, in the target BC environment (each environment has its own copy of this):

1. Azure AD app registration with `Dynamics 365 Business Central` → `API.ReadWrite.All` (Application permission), admin-consented
2. Inside Business Central itself: **Microsoft Entra ID Applications** page → add the app's Client ID → assign a permission set (e.g. `D365 BUS FULL ACCESS`)

Both steps are required, independently, per environment — an app authorized in one environment (e.g. W1) has no access in another (e.g. German) until repeated there too. Changes can take several minutes to propagate.

## Authentication to the app itself (Teams SSO)

Users don't log in separately — Teams silently gets them a token, which the backend validates on every `/api/*` call. See [PROJECT_DOCUMENTATION.md §9](PROJECT_DOCUMENTATION.md#9-why-teams-sso-and-not-a-simpler-redirect-login) for why this had to be Teams SSO specifically and not a redirect-based login (redirect-based auth breaks inside the Teams tab iframe).

## Deploying to Azure

Push to `master` (touching app code) → GitHub Actions builds the Docker image and pushes it to `ghcr.io/gabidodu/naga-vendors` — see `.github/workflows/docker-publish.yml`. That alone does **not** update the running app; promote it explicitly once the build finishes:

```powershell
git push origin master
# wait for the "Build and publish container image" run to go green on GitHub, then note its commit SHA

az containerapp update `
  --name naga-vendors-ca --resource-group Assetmanagement-RG `
  --image ghcr.io/gabidodu/naga-vendors:<commit-sha>
```

Pin to the exact commit SHA tag, not `:latest` — makes it obvious which commit is live and avoids silently picking up an in-flight build. No local Docker install is required for this flow; the build happens entirely on GitHub's runners.

Azure resources: resource group `Assetmanagement-RG`, Container Apps environment `cae-naga-vendors`, Container App `naga-vendors-ca` (Consumption plan, scales to zero), all in the Naga tenant's "Business Apps" subscription, West Europe. See [PROJECT_DOCUMENTATION.md §7](PROJECT_DOCUMENTATION.md#7-azure-hosting) for the full picture, including the still-running legacy App Service kept as a rollback path.

## Teams app package

`teams-app/naga-vendors-teams-app.zip` (manifest + icons) — published to the tenant's Teams app catalog via Teams Admin Center → Teams apps → Manage apps → find "Naga Vendors" → Update. Bump `version` in `manifest.json` on every change that goes through this path, or Teams may not treat it as an update. Rebuild the zip after any manifest change:

```powershell
Compress-Archive -Path teams-app\manifest.json, teams-app\color.png, teams-app\outline.png -DestinationPath teams-app\naga-vendors-teams-app.zip -Force
```

## Security note

Read [PROJECT_DOCUMENTATION.md §8](PROJECT_DOCUMENTATION.md#8-security-model--read-this-before-adding-more-users) before giving more people access — Business Central access is app-wide, not per-user, so every Teams user who can open this tab has the same read/write access to vendor data everywhere `BC_ENVIRONMENTS` points to.
