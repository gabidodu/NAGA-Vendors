import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'
import { ConfidentialClientApplication } from '@azure/msal-node'
import {
  MAX_UPLOAD_BYTES,
  buildVendorFolderPath,
  listVendorFiles,
  uploadVendorFile,
  deleteVendorFile,
  getVendorFileDownloadUrl,
} from './src/services/sharepoint.js'
import { extractVendorFieldsFromDocument } from './src/services/documentExtraction.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.join(__dirname, 'dist')

const app = express()
const port = Number(process.env.PORT || 4000)

// No CORS middleware: the frontend is always same-origin (served by this same Express app in
// production, proxied through Vite in local dev) — opening CORS here would only widen the
// attack surface for the bearer-token-protected /api/* routes with no functional benefit.
app.use(express.json())

// Teams SSO token validation — gates /api/* so data is never reachable without a valid
// Entra ID token for this tenant, without relying on a redirect-based login (which breaks
// inside the Teams tab iframe).
// Teams SSO (authentication.getAuthToken()) issues a v1.0 token, where aud is the bare
// client ID and the issuer has no /v2.0 suffix — accept both v1 and v2 shapes since that
// depends on Teams client internals we don't control.
const teamsSsoAudiences = [
  process.env.BC_CLIENT_ID,
  `api://naga-vendors.azurewebsites.net/${process.env.BC_CLIENT_ID}`,
]
const teamsSsoIssuers = [
  `https://login.microsoftonline.com/${process.env.BC_TENANT_ID}/`,
  `https://login.microsoftonline.com/${process.env.BC_TENANT_ID}/v2.0`,
  `https://sts.windows.net/${process.env.BC_TENANT_ID}/`,
]
const jwks = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${process.env.BC_TENANT_ID}/discovery/v2.0/keys`,
})

function getSigningKey(header, callback) {
  jwks.getSigningKey(header.kid, (error, key) => {
    if (error) return callback(error)
    callback(null, key.getPublicKey())
  })
}

function requireTeamsAuth(req, res, next) {
  if (process.env.SKIP_TEAMS_AUTH === 'true') return next()

  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) {
    return res.status(401).json({ success: false, message: 'Missing bearer token' })
  }

  jwt.verify(
    token,
    getSigningKey,
    { audience: teamsSsoAudiences, issuer: teamsSsoIssuers, algorithms: ['RS256'] },
    (error, decoded) => {
      if (error) {
        return res.status(401).json({ success: false, message: `Invalid token: ${error.message}` })
      }
      if (decoded.tid !== process.env.BC_TENANT_ID) {
        return res.status(403).json({ success: false, message: 'Token is from an unexpected tenant' })
      }
      req.user = decoded
      next()
    },
  )
}

app.use('/api', requireTeamsAuth)

const normalizeEnvironmentList = () => {
  const envList = process.env.BC_ENVIRONMENTS || process.env.BC_ENVIRONMENT_NAME
  if (!envList) return []

  return String(envList)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((value) => {
      const [id, name] = value.includes('|') ? value.split('|') : [value, value]
      return { id, name }
    })
}

const certificateAuthConfig = {
  mode: 'certificate-based',
  authType: 'Application permissions',
  securityNote:
    'Use an X.509 certificate in the backend and keep the certificate private. Never expose it to the Teams frontend.',
  businessCentral: {
    baseUrl: process.env.BC_API_URL || 'https://api.businesscentral.dynamics.com/v2.0',
    tenantId: process.env.BC_TENANT_ID || '<tenant-id>',
    environmentName: process.env.BC_ENVIRONMENT_NAME || '<environment-name>',
    companyId: process.env.BC_COMPANY_ID || '<company-id>',
    endpoint: '/companies(<company-id>)/vendors',
  },
}

// BC encodes blank/special option values as OData XML character escapes (e.g. "_x0020_" for a space)
function decodeODataOption(value) {
  if (!value) return ''
  return value.replace(/_x([0-9A-Fa-f]{4})_/g, (_, code) => String.fromCharCode(parseInt(code, 16))).trim()
}

function normalizeVendorRow(row, paymentTermsByCode = new Map()) {
  const blockedReason = decodeODataOption(row.blocked)

  return {
    id: row.id || row.systemId || row.number || row.No,
    no: row.number || row.No || row.no || '',
    name: row.displayName || row.name || row.Name || 'Unknown vendor',
    searchName: row.searchName || row.Name || row.displayName || '',
    city: row.city || row.City || '',
    countryRegion: row.country || row.countryRegionCode || row.countryRegion || '',
    phoneNo: row.phoneNumber || row.phoneNo || '',
    email: row.email || row.Email || '',
    vendorPostingGroup: row.vendorPostingGroup || '',
    balance: Number(row.balance || row.Balance || 0),
    status: row.Status || (blockedReason ? `Blocked (${blockedReason})` : 'Active'),
    taxRegistrationNo: row.taxRegistrationNumber || row.taxRegistrationNo || '',
    contactPerson: row.contactsInformation?.[0]?.contactName || row.contact || row.Contact || '',
    website: row.website || row.Website || '',
    paymentTerms: paymentTermsByCode.get(row.paymentTermsId) || row.paymentTermsCode || '',
    lastPurchaseDate: row.lastModifiedDateTime || row.Last_Purchase_Date || '',
    address: [row.addressLine1, row.addressLine2].filter(Boolean).join(', ') || row.Address || '',
    notes: row.notes || row.Notes || '',
    type: row.vendorType || row.Vendor_Type || '',
  }
}

// Helper to encode to base64url format
function toBase64Url(data) {
  return Buffer.from(data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

// Encode a hex-encoded SHA-1 thumbprint as base64url of its raw bytes (required for the x5t JWT header)
function hexThumbprintToBase64Url(hex) {
  return Buffer.from(hex, 'hex')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

async function getAppToken(scope) {
  const tenantId = process.env.BC_TENANT_ID
  const clientId = process.env.BC_CLIENT_ID
  const thumbprint = process.env.BC_CERT_THUMBPRINT

  if (!tenantId || !clientId || !thumbprint) {
    throw new Error('Missing BC certificate configuration')
  }

  // Try Method 1: MSAL with Windows cert store (direct thumbprint)
  console.log(`[App Auth] Attempting MSAL with Windows certificate store... (scope: ${scope})`)

  try {
    const cca = new ConfidentialClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        clientCertificate: {
          thumbprint,
          // MSAL on Windows can use certificates from the system store
          // No need to provide privateKey - MSAL will look it up by thumbprint
        },
      },
    })

    const tokenResponse = await cca.acquireTokenByClientCredential({
      scopes: [scope],
    })

    if (tokenResponse?.accessToken) {
      console.log('[App Auth] ✓ Access token acquired via MSAL (cert store)')
      return tokenResponse.accessToken
    }
  } catch (msalError) {
    console.log('[App Auth] MSAL method failed:', msalError.message)
  }

  // Fallback Method 2: Manual JWT with PEM private key
  console.log('[App Auth] Attempting manual JWT signing with PEM...')

  try {
    const certificatePath = process.env.BC_CERT_PATH
    const privateKey = process.env.BC_CERT_PEM || (certificatePath && fs.existsSync(certificatePath) ? fs.readFileSync(certificatePath, 'utf8') : null)

    if (!privateKey) {
      throw new Error('No certificate available: set BC_CERT_PEM (raw PEM content) or BC_CERT_PATH (local file)')
    }

    const now = Math.floor(Date.now() / 1000)
    const header = toBase64Url(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', x5t: hexThumbprintToBase64Url(thumbprint) })
    )
    const payload = toBase64Url(
      JSON.stringify({
        iss: clientId,
        sub: clientId,
        aud: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        exp: now + 600,
        iat: now,
      })
    )

    const message = `${header}.${payload}`
    const signature = toBase64Url(
      crypto
        .createSign('SHA256')
        .update(message)
        .sign(privateKey)
    )

    const jwt = `${message}.${signature}`

    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_assertion: jwt,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          scope,
        }),
      }
    )

    const data = await tokenResponse.json()

    if (!tokenResponse.ok) {
      throw new Error(`Token request failed: ${data.error_description || data.error}`)
    }

    if (!data.access_token) {
      throw new Error('No access token in response')
    }

    console.log('[App Auth] ✓ Access token acquired via JWT signing')
    return data.access_token
  } catch (jwtError) {
    console.error('[App Auth] ✗ Both methods failed:')
    console.error('  MSAL: Certificate store lookup')
    console.error('  JWT: Manual signing')
    throw new Error(`Certificate authentication failed: ${jwtError.message}`)
  }
}

function getBcAccessToken() {
  return getAppToken('https://api.businesscentral.dynamics.com/.default')
}

function getGraphAccessToken() {
  return getAppToken('https://graph.microsoft.com/.default')
}

function buildCompanyApiUrl(companyId, environmentName) {
  const template = process.env.BC_API_URL || 'https://api.businesscentral.dynamics.com/v2.0/{environmentName}/api/v2.0/companies({companyId})/vendors'
  const targetEnvironment = environmentName || process.env.BC_ENVIRONMENT_NAME || ''

  return template
    .replace('{companyId}', encodeURIComponent(companyId))
    .replace('{company-id}', encodeURIComponent(companyId))
    .replace('{env}', encodeURIComponent(targetEnvironment))
    .replace('{environmentName}', encodeURIComponent(targetEnvironment))
    .replace('{environment-name}', encodeURIComponent(targetEnvironment))
}

const paymentTermsCache = new Map()
const PAYMENT_TERMS_CACHE_TTL_MS = 10 * 60 * 1000

async function getPaymentTermsMap(environmentName, companyId, token) {
  const cacheKey = `${environmentName}|${companyId}`
  const cached = paymentTermsCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < PAYMENT_TERMS_CACHE_TTL_MS) {
    return cached.map
  }

  const map = new Map()
  try {
    const apiUrl = `https://api.businesscentral.dynamics.com/v2.0/${environmentName}/api/v2.0/companies(${companyId})/paymentTerms?$select=id,code`
    const response = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (response.ok) {
      const data = await response.json()
      for (const term of data.value || []) map.set(term.id, term.code)
    }
  } catch {
    // Payment terms are a display-only enrichment; ignore failures and fall back to blank.
  }

  paymentTermsCache.set(cacheKey, { map, timestamp: Date.now() })
  return map
}

async function fetchVendorsFromBusinessCentral(companyId, environmentName) {
  const targetCompanyId = companyId || process.env.BC_COMPANY_ID
  const targetEnvironment = environmentName || process.env.BC_ENVIRONMENT_NAME

  if (!targetCompanyId) {
    throw new Error('Missing companyId. Pass a companyId query parameter or set BC_COMPANY_ID.')
  }

  const baseUrl = buildCompanyApiUrl(targetCompanyId, environmentName)
  const apiUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}$expand=contactsInformation`
  const token = await getBcAccessToken()
  const [response, paymentTermsByCode] = await Promise.all([
    fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    }),
    getPaymentTermsMap(targetEnvironment, targetCompanyId, token),
  ])

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`BC request failed (${response.status}): ${text}`)
  }

  const payload = await response.json()
  const rows = Array.isArray(payload) ? payload : payload.value || []
  return rows.map((row) => normalizeVendorRow(row, paymentTermsByCode))
}

// Only these fields exist as real, writable properties on the BC v2.0 vendors entity.
// Contact person / posting group / type are shown read-only because BC's standard API
// doesn't expose them at all — there is nowhere to write them back to.
const EDITABLE_FIELD_MAP = {
  phoneNo: 'phoneNumber',
  email: 'email',
  website: 'website',
  city: 'city',
  countryRegion: 'country',
  address: 'addressLine1',
  taxRegistrationNo: 'taxRegistrationNumber',
}

// The BC "blocked" enum only accepts these three raw values (confirmed against $metadata).
// "_x0020_" is the literal wire value for "not blocked" — not an XML-escaping artifact we
// introduced, BC's own API returns and expects that exact string.
const STATUS_TO_BLOCKED = {
  Active: '_x0020_',
  'Blocked (Payment)': 'Payment',
  'Blocked (All)': 'All',
}

async function patchVendorInBusinessCentral(vendorId, companyId, environmentName, fields) {
  const targetEnvironment = environmentName || process.env.BC_ENVIRONMENT_NAME
  const targetCompany = companyId || process.env.BC_COMPANY_ID

  const bcFields = {}
  for (const [ourKey, value] of Object.entries(fields || {})) {
    if (ourKey === 'status') {
      if (Object.prototype.hasOwnProperty.call(STATUS_TO_BLOCKED, value)) {
        bcFields.blocked = STATUS_TO_BLOCKED[value]
      }
      continue
    }
    const bcKey = EDITABLE_FIELD_MAP[ourKey]
    if (bcKey) bcFields[bcKey] = value
  }

  if (Object.keys(bcFields).length === 0) {
    throw new Error('No editable fields were provided')
  }

  const token = await getBcAccessToken()
  const entityUrl = `https://api.businesscentral.dynamics.com/v2.0/${targetEnvironment}/api/v2.0/companies(${encodeURIComponent(targetCompany)})/vendors(${encodeURIComponent(vendorId)})`

  const currentResponse = await fetch(entityUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!currentResponse.ok) {
    const text = await currentResponse.text()
    throw new Error(`Failed to load current vendor (${currentResponse.status}): ${text}`)
  }
  const current = await currentResponse.json()

  const patchResponse = await fetch(entityUrl, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'If-Match': current['@odata.etag'] || '*',
    },
    body: JSON.stringify(bcFields),
  })

  if (!patchResponse.ok) {
    const text = await patchResponse.text()
    throw new Error(`BC update failed (${patchResponse.status}): ${text}`)
  }

  const updated = await patchResponse.json()
  const paymentTermsByCode = await getPaymentTermsMap(targetEnvironment, targetCompany, token)
  return normalizeVendorRow(updated, paymentTermsByCode)
}

async function fetchCompaniesFromBusinessCentral(environmentName) {
  const targetEnvironment = environmentName || process.env.BC_ENVIRONMENT_NAME

  if (!targetEnvironment) {
    throw new Error('Missing environmentName. Pass an environmentName query parameter or set BC_ENVIRONMENT_NAME.')
  }

  const token = await getBcAccessToken()
  const apiUrl = `https://api.businesscentral.dynamics.com/v2.0/${targetEnvironment}/api/v2.0/companies?$select=id,displayName,name`
  const response = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`BC request failed (${response.status}): ${text}`)
  }

  const payload = await response.json()
  const rows = payload.value || []
  return rows.map((row) => ({ id: row.id, companyId: row.id, name: row.displayName || row.name }))
}

function applySort(items, sort, direction) {
  const result = [...items]
  result.sort((a, b) => {
    const left = a[sort] ?? ''
    const right = b[sort] ?? ''

    if (typeof left === 'number' && typeof right === 'number') {
      return direction === 'asc' ? left - right : right - left
    }

    const valueA = String(left).toLowerCase()
    const valueB = String(right).toLowerCase()

    if (valueA < valueB) return direction === 'asc' ? -1 : 1
    if (valueA > valueB) return direction === 'asc' ? 1 : -1
    return 0
  })

  return result
}

app.get('/api/environments', (_req, res) => {
  const items = normalizeEnvironmentList()
  res.json({
    success: true,
    items,
    defaultEnvironment: process.env.BC_ENVIRONMENT_NAME || items[0]?.id || null,
  })
})

app.get('/api/companies', async (req, res) => {
  const requestedEnvironment = String(req.query.environmentName || process.env.BC_ENVIRONMENT_NAME || '').trim()

  if (process.env.BC_USE_REAL !== 'true') {
    return res.status(400).json({ success: false, message: 'BC_USE_REAL must be set to true.' })
  }

  if (!requestedEnvironment) {
    return res.status(400).json({
      success: false,
      message: 'environmentName is required when BC_USE_REAL=true. Use /api/environments to get the list.',
    })
  }

  try {
    const items = await fetchCompaniesFromBusinessCentral(requestedEnvironment)
    res.json({ success: true, items, defaultCompany: items[0]?.companyId || null })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ success: false, message })
  }
})

app.get('/api/vendors', async (req, res) => {
  const { q = '', sort = 'name', direction = 'asc', companyId, environmentName } = req.query
  const query = String(q).trim().toLowerCase()
  const requestedCompany = String(companyId || process.env.BC_COMPANY_ID || '').trim()
  const requestedEnvironment = String(environmentName || process.env.BC_ENVIRONMENT_NAME || '').trim()

  if (process.env.BC_USE_REAL !== 'true') {
    return res.status(400).json({ success: false, message: 'BC_USE_REAL must be set to true.' })
  }

  if (!requestedEnvironment || !requestedCompany) {
    return res.status(400).json({
      success: false,
      message: 'environmentName and companyId are required. Use /api/environments and /api/companies to get the lists.',
    })
  }

  try {
    const items = await fetchVendorsFromBusinessCentral(requestedCompany, requestedEnvironment)
    let result = [...items]

    if (query) {
      result = result.filter((vendor) =>
        [
          vendor.no,
          vendor.name,
          vendor.searchName,
          vendor.city,
          vendor.countryRegion,
          vendor.phoneNo,
          vendor.email,
          vendor.vendorPostingGroup,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query),
      )
    }

    result = applySort(result, sort, direction)

    res.json({
      success: true,
      source: 'business-central',
      authMode: 'certificate-based',
      environmentName: requestedEnvironment,
      companyId: requestedCompany,
      items: result,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ success: false, source: 'error', message })
  }
})

app.patch('/api/vendors/:id', async (req, res) => {
  const requestedEnvironment = String(req.query.environmentName || process.env.BC_ENVIRONMENT_NAME || '').trim()
  const requestedCompany = String(req.query.companyId || process.env.BC_COMPANY_ID || '').trim()

  if (process.env.BC_USE_REAL !== 'true') {
    return res.status(400).json({ success: false, message: 'Editing is only available in real Business Central mode.' })
  }

  if (!requestedEnvironment || !requestedCompany) {
    return res.status(400).json({
      success: false,
      message: 'environmentName and companyId query parameters are required.',
    })
  }

  try {
    const updated = await patchVendorInBusinessCentral(
      req.params.id,
      requestedCompany,
      requestedEnvironment,
      req.body,
    )
    res.json({ success: true, item: updated })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ success: false, message })
  }
})

function requireVendorFileParams(req, res) {
  const environmentName = String(req.query.environmentName || '').trim()
  const companyId = String(req.query.companyId || '').trim()
  const vendorNo = String(req.query.vendorNo || '').trim()

  if (!environmentName || !companyId || !vendorNo) {
    res.status(400).json({
      success: false,
      message: 'environmentName, companyId, and vendorNo query parameters are required.',
    })
    return null
  }

  return buildVendorFolderPath(environmentName, companyId, vendorNo)
}

app.get('/api/vendors/:id/files', async (req, res) => {
  const folderPath = requireVendorFileParams(req, res)
  if (!folderPath) return

  try {
    const token = await getGraphAccessToken()
    const items = await listVendorFiles(token, folderPath)
    res.json({ success: true, items })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ success: false, message })
  }
})

app.post('/api/vendors/:id/files', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const folderPath = requireVendorFileParams(req, res)
  if (!folderPath) return

  const filename = String(req.query.filename || '').trim()
  if (!filename) {
    return res.status(400).json({ success: false, message: 'filename query parameter is required.' })
  }

  const buffer = req.body
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return res.status(400).json({ success: false, message: 'Request body must be the raw file contents.' })
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    return res.status(413).json({
      success: false,
      message: `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit.`,
    })
  }

  try {
    const token = await getGraphAccessToken()
    const existingFiles = await listVendorFiles(token, folderPath)
    const item = await uploadVendorFile(token, folderPath, filename, buffer, req.headers['content-type'])

    // Recognition only runs for a vendor's very first uploaded file — checked server-side
    // against the actual folder contents, not client-supplied state.
    let suggestedFields = {}
    if (existingFiles.length === 0) {
      try {
        suggestedFields = await extractVendorFieldsFromDocument(buffer, req.headers['content-type'], filename)
      } catch (error) {
        console.error('Document field extraction failed', error)
      }
    }

    res.json({ success: true, item, suggestedFields })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ success: false, message })
  }
})

app.delete('/api/vendors/:id/files/:fileId', async (req, res) => {
  const folderPath = requireVendorFileParams(req, res)
  if (!folderPath) return

  try {
    const token = await getGraphAccessToken()
    await deleteVendorFile(token, req.params.fileId)
    res.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ success: false, message })
  }
})

app.get('/api/vendors/:id/files/:fileId/download', async (req, res) => {
  const folderPath = requireVendorFileParams(req, res)
  if (!folderPath) return

  // Returned as JSON (not a redirect) because this route sits behind requireTeamsAuth — a
  // plain <a href> navigation wouldn't carry the bearer token. The frontend fetches this via
  // apiFetch, then opens the returned URL directly; the URL itself is pre-authenticated by
  // Graph and needs no further auth.
  try {
    const token = await getGraphAccessToken()
    const downloadUrl = await getVendorFileDownloadUrl(token, req.params.fileId)
    res.json({ success: true, downloadUrl })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({ success: false, message })
  }
})

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.get('/api/auth/config', (_req, res) => {
  res.json({
    success: true,
    authMode: 'certificate-based',
    authType: 'Application permissions',
    note: 'The browser does not hold secrets. The backend authenticates to Business Central using a certificate.',
    config: certificateAuthConfig,
    env: {
      bcUseReal: process.env.BC_USE_REAL || 'false',
      tenantConfigured: Boolean(process.env.BC_TENANT_ID),
      clientConfigured: Boolean(process.env.BC_CLIENT_ID),
      certConfigured: Boolean(process.env.BC_CERT_PATH),
    },
  })
})

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get(/^(?!\/api|\/health).*/, (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

app.listen(port, () => {
  console.log(`Vendor API listening on http://localhost:${port}`)
  console.log(`Real BC certificate mode enabled: ${process.env.BC_USE_REAL === 'true'}`)
})
