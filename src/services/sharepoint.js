// Vendor file storage backed by a SharePoint document library, reached via Microsoft Graph.
// Callers pass in an already-acquired Graph app token (see getGraphAccessToken in server.js) —
// this module only knows how to talk to Graph, not how to authenticate.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const SITE_HOSTNAME = 'tvpsystems.sharepoint.com'
const SITE_PATH = '/sites/VendorsStorage'

// Graph's simple (single-request) upload endpoint tops out at 4 MB; larger files need a
// resumable upload session, which this app doesn't implement.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024

let cachedSiteId = null

async function graphFetch(token, url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...options.headers,
    },
  })
}

function sanitizePathSegment(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_').trim()
}

function encodeGraphPath(path) {
  return path.split('/').map(encodeURIComponent).join('/')
}

function toFileEntry(item) {
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    lastModifiedDateTime: item.lastModifiedDateTime,
  }
}

async function getSiteId(token) {
  if (cachedSiteId) return cachedSiteId

  const response = await graphFetch(token, `${GRAPH_BASE}/sites/${SITE_HOSTNAME}:${SITE_PATH}`)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to resolve SharePoint site (${response.status}): ${text}`)
  }

  const data = await response.json()
  cachedSiteId = data.id
  return cachedSiteId
}

export function buildVendorFolderPath(environmentName, companyId, vendorNo) {
  return [environmentName, companyId, vendorNo].map(sanitizePathSegment).join('/')
}

// Creates each missing segment of the folder path. Using conflictBehavior "replace" for a
// *folder* creation request is idempotent in Graph — it resolves to the existing folder
// instead of deleting its contents (that destructive behavior only applies to files).
async function ensureVendorFolder(token, folderPath) {
  const siteId = await getSiteId(token)
  const segments = folderPath.split('/').filter(Boolean)
  let parentPath = ''

  for (const segment of segments) {
    const childrenUrl = parentPath
      ? `${GRAPH_BASE}/sites/${siteId}/drive/root:/${encodeGraphPath(parentPath)}:/children`
      : `${GRAPH_BASE}/sites/${siteId}/drive/root/children`

    const response = await graphFetch(token, childrenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: segment,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'replace',
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Failed to create folder "${segment}" (${response.status}): ${text}`)
    }

    parentPath = parentPath ? `${parentPath}/${segment}` : segment
  }
}

export async function listVendorFiles(token, folderPath) {
  const siteId = await getSiteId(token)
  const url = `${GRAPH_BASE}/sites/${siteId}/drive/root:/${encodeGraphPath(folderPath)}:/children`
  const response = await graphFetch(token, url)

  if (response.status === 404) return []
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to list files (${response.status}): ${text}`)
  }

  const data = await response.json()
  return (data.value || []).filter((item) => item.file).map(toFileEntry)
}

export async function uploadVendorFile(token, folderPath, filename, buffer, contentType) {
  await ensureVendorFolder(token, folderPath)

  const siteId = await getSiteId(token)
  const safeFilename = sanitizePathSegment(filename) || 'upload.bin'
  const url = `${GRAPH_BASE}/sites/${siteId}/drive/root:/${encodeGraphPath(folderPath)}/${encodeURIComponent(safeFilename)}:/content`

  const response = await graphFetch(token, url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: buffer,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Upload failed (${response.status}): ${text}`)
  }

  return toFileEntry(await response.json())
}

export async function deleteVendorFile(token, fileId) {
  const siteId = await getSiteId(token)
  const url = `${GRAPH_BASE}/sites/${siteId}/drive/items/${encodeURIComponent(fileId)}`
  const response = await graphFetch(token, url, { method: 'DELETE' })

  if (!response.ok && response.status !== 404) {
    const text = await response.text()
    throw new Error(`Delete failed (${response.status}): ${text}`)
  }
}

export async function getVendorFileDownloadUrl(token, fileId) {
  const siteId = await getSiteId(token)
  // Deliberately no $select here — the @microsoft.graph.downloadUrl annotation is only
  // included on a plain item GET, not when $select restricts the returned fields.
  const url = `${GRAPH_BASE}/sites/${siteId}/drive/items/${encodeURIComponent(fileId)}`
  const response = await graphFetch(token, url)

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to get download URL (${response.status}): ${text}`)
  }

  const data = await response.json()
  const downloadUrl = data['@microsoft.graph.downloadUrl']
  if (!downloadUrl) throw new Error('No download URL returned by Graph')
  return downloadUrl
}
