# Naga Vendors

A Business Central vendor directory running as a Microsoft Teams tab. Live at **https://naga-vendors.azurewebsites.net**, hosted on Azure App Service in the Naga tenant. See [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) for the full architecture, security model, and history of fixes — this file only covers running and deploying it.

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

No CI/CD yet — manual deploy from a dev machine:

```powershell
npm run build

# Stage a clean production-only copy (fresh folder, avoids shipping devDependencies)
$staging = "$env:TEMP\naga-deploy"
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $staging | Out-Null
Copy-Item server.js, package.json, package-lock.json -Destination $staging
Copy-Item dist -Destination $staging -Recurse
New-Item -ItemType Directory -Path "$staging\src" | Out-Null
Copy-Item src\services -Destination "$staging\src\services" -Recurse   # server.js imports this at runtime — don't skip it
cd $staging
npm install --omit=dev
cd -

$zip = "$env:TEMP\naga-deploy.zip"
Compress-Archive -Path "$staging\*" -DestinationPath $zip -Force
az webapp deploy --resource-group NagaVendors-RG --name naga-vendors --src-path $zip --type zip
```

If only `server.js` changed (no frontend rebuild needed), skip the `npm run build` and just re-copy `server.js` into the staging folder before re-zipping — no need to reinstall `node_modules` again either.

Azure resources: resource group `NagaVendors-RG`, App Service Plan `asp-naga-vendors` (Linux, F1 free tier — upgrade before real load), Web App `naga-vendors`, all in the Naga tenant's "Business Apps" subscription, West Europe.

## Teams app package

`teams-app/naga-vendors-teams-app.zip` (manifest + icons) — sideload via Teams → Apps → Manage your apps → Upload a custom app. Currently personal-scope only, not published to the org catalog. Rebuild the zip after any manifest change:

```powershell
Compress-Archive -Path teams-app\manifest.json, teams-app\color.png, teams-app\outline.png -DestinationPath teams-app\naga-vendors-teams-app.zip -Force
```

## Security note

Read [PROJECT_DOCUMENTATION.md §8](PROJECT_DOCUMENTATION.md#8-security-model--read-this-before-adding-more-users) before giving more people access — Business Central access is app-wide, not per-user, so every Teams user who can open this tab has the same read/write access to vendor data everywhere `BC_ENVIRONMENTS` points to.
