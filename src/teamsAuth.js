import { app, authentication } from '@microsoft/teams-js'

let tokenPromise = null

export const ssoStatus = {
  state: 'checking', // 'checking' | 'not-in-teams' | 'ok' | 'error'
  detail: '',
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

async function acquireToken() {
  try {
    await withTimeout(app.initialize(), 5000, 'app.initialize()')
  } catch (error) {
    ssoStatus.state = 'not-in-teams'
    ssoStatus.detail = error?.message || String(error)
    return null
  }

  try {
    const token = await withTimeout(authentication.getAuthToken(), 8000, 'authentication.getAuthToken()')
    ssoStatus.state = 'ok'
    ssoStatus.detail = ''
    return token
  } catch (error) {
    ssoStatus.state = 'error'
    ssoStatus.detail = error?.message || JSON.stringify(error)
    console.error('Teams SSO token acquisition failed', error)
    return null
  }
}

function getTeamsAuthToken() {
  if (!tokenPromise) tokenPromise = acquireToken()
  return tokenPromise
}

export async function getSsoDiagnostics() {
  await getTeamsAuthToken()
  return { ...ssoStatus }
}

export async function apiFetch(url, options = {}) {
  const token = await getTeamsAuthToken()
  const headers = { ...options.headers }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(url, { ...options, headers })
}
