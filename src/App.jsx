import { useEffect, useMemo, useState } from 'react'
import { apiFetch, getSsoDiagnostics } from './teamsAuth'
import './App.css'

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
})

const vendorColumns = [
  { key: 'no', label: 'Vendor No.' },
  { key: 'name', label: 'Name' },
  { key: 'countryRegion', label: 'Country' },
  { key: 'phoneNo', label: 'Phone' },
  { key: 'balance', label: 'Balance' },
  { key: 'status', label: 'Status' },
]

// Only these map to real, writable fields in the BC v2.0 vendors API — everything else
// in the detail panel (contact person, posting group, type) stays read-only display.
const EDITABLE_FIELDS = ['phoneNo', 'email', 'website', 'city', 'countryRegion', 'address', 'taxRegistrationNo', 'status']

// The BC "blocked" enum only has these three values — a dropdown, not free text.
const STATUS_OPTIONS = ['Active', 'Blocked (Payment)', 'Blocked (All)']

function App() {
  const [vendors, setVendors] = useState([])
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState('name')
  const [sortDirection, setSortDirection] = useState('asc')
  const [selectedVendorId, setSelectedVendorId] = useState(null)
  const [loading, setLoading] = useState(true)

  const [environments, setEnvironments] = useState([])
  const [selectedEnvironment, setSelectedEnvironment] = useState('')
  const [companies, setCompanies] = useState([])
  const [selectedCompany, setSelectedCompany] = useState('')
  const [companiesLoading, setCompaniesLoading] = useState(false)
  const [ssoDebug, setSsoDebug] = useState({ state: 'checking', detail: '' })
  const [apiDebug, setApiDebug] = useState(null)

  useEffect(() => {
    getSsoDiagnostics().then(setSsoDebug)
  }, [])

  useEffect(() => {
    const fetchEnvironments = async () => {
      try {
        const response = await apiFetch('/api/environments')
        const text = await response.text()
        if (!response.ok) {
          setApiDebug(`/api/environments -> HTTP ${response.status}: ${text.slice(0, 300)}`)
          return
        }
        const payload = JSON.parse(text)
        setEnvironments(payload.items ?? [])
        setSelectedEnvironment(payload.defaultEnvironment ?? payload.items?.[0]?.id ?? '')
        setApiDebug(null)
      } catch (error) {
        console.error('Unable to fetch environments from API', error)
        setApiDebug(`/api/environments -> ${error.message}`)
      }
    }

    fetchEnvironments()
  }, [])

  useEffect(() => {
    if (!selectedEnvironment) return

    const fetchCompanies = async () => {
      setCompaniesLoading(true)
      try {
        const url = `/api/companies?environmentName=${encodeURIComponent(selectedEnvironment)}`
        const response = await apiFetch(url)
        const payload = await response.json()
        const items = payload.items ?? []
        setCompanies(items)
        setSelectedCompany((prev) =>
          items.some((company) => company.companyId === prev) ? prev : items[0]?.companyId ?? '',
        )
      } catch (error) {
        console.error('Unable to fetch companies from API', error)
        setCompanies([])
      } finally {
        setCompaniesLoading(false)
      }
    }

    fetchCompanies()
  }, [selectedEnvironment])

  useEffect(() => {
    if (!selectedEnvironment || !selectedCompany) return

    const fetchVendors = async () => {
      setLoading(true)
      try {
        const url = `/api/vendors?q=${encodeURIComponent(query)}&sort=${sortKey}&direction=${sortDirection}&environmentName=${encodeURIComponent(selectedEnvironment)}&companyId=${encodeURIComponent(selectedCompany)}`
        const response = await apiFetch(url)
        const payload = await response.json()
        const items = payload.items ?? []
        setVendors(items)
        setSelectedVendorId((prev) =>
          items.some((vendor) => vendor.id === prev) ? prev : items[0]?.id ?? null,
        )
      } catch (error) {
        console.error('Unable to fetch vendors from API', error)
      } finally {
        setLoading(false)
      }
    }

    fetchVendors()
  }, [query, sortKey, sortDirection, selectedEnvironment, selectedCompany])

  const filteredVendors = useMemo(() => vendors, [vendors])

  const selectedVendor =
    filteredVendors.find((vendor) => vendor.id === selectedVendorId) ?? filteredVendors[0] ?? null

  const [draft, setDraft] = useState({})
  const [saveState, setSaveState] = useState({ status: 'idle', message: '' })

  useEffect(() => {
    if (!selectedVendor) return
    setDraft(Object.fromEntries(EDITABLE_FIELDS.map((key) => [key, selectedVendor[key] ?? ''])))
    setSaveState({ status: 'idle', message: '' })
  }, [selectedVendor?.id])

  const [files, setFiles] = useState([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [uploadState, setUploadState] = useState({ status: 'idle', message: '' })

  const vendorFilesQuery = useMemo(() => {
    if (!selectedVendor || !selectedEnvironment || !selectedCompany) return null
    return `environmentName=${encodeURIComponent(selectedEnvironment)}&companyId=${encodeURIComponent(selectedCompany)}&vendorNo=${encodeURIComponent(selectedVendor.no)}`
  }, [selectedVendor, selectedEnvironment, selectedCompany])

  useEffect(() => {
    setUploadState({ status: 'idle', message: '' })
    if (!vendorFilesQuery) {
      setFiles([])
      return
    }

    const fetchFiles = async () => {
      setFilesLoading(true)
      try {
        const response = await apiFetch(`/api/vendors/${encodeURIComponent(selectedVendor.id)}/files?${vendorFilesQuery}`)
        const payload = await response.json()
        if (!response.ok || !payload.success) {
          throw new Error(payload.message || `HTTP ${response.status}`)
        }
        setFiles(payload.items ?? [])
      } catch (error) {
        console.error('Unable to fetch vendor files', error)
        setFiles([])
      } finally {
        setFilesLoading(false)
      }
    }

    fetchFiles()
  }, [selectedVendor?.id, vendorFilesQuery])

  const handleUploadFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !selectedVendor || !vendorFilesQuery) return

    setUploadState({ status: 'uploading', message: '' })
    try {
      const url = `/api/vendors/${encodeURIComponent(selectedVendor.id)}/files?${vendorFilesQuery}&filename=${encodeURIComponent(file.name)}`
      const response = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      const payload = await response.json()
      if (!response.ok || !payload.success) {
        throw new Error(payload.message || `HTTP ${response.status}`)
      }
      setFiles((prev) => [payload.item, ...prev])
      setUploadState({ status: 'idle', message: '' })
    } catch (error) {
      setUploadState({ status: 'error', message: error.message })
    }
  }

  const handleDeleteFile = async (fileId) => {
    if (!selectedVendor || !vendorFilesQuery) return
    try {
      const url = `/api/vendors/${encodeURIComponent(selectedVendor.id)}/files/${encodeURIComponent(fileId)}?${vendorFilesQuery}`
      const response = await apiFetch(url, { method: 'DELETE' })
      const payload = await response.json()
      if (!response.ok || !payload.success) {
        throw new Error(payload.message || `HTTP ${response.status}`)
      }
      setFiles((prev) => prev.filter((item) => item.id !== fileId))
    } catch (error) {
      setUploadState({ status: 'error', message: error.message })
    }
  }

  const handleDownloadFile = async (fileId) => {
    if (!selectedVendor || !vendorFilesQuery) return
    try {
      const url = `/api/vendors/${encodeURIComponent(selectedVendor.id)}/files/${encodeURIComponent(fileId)}/download?${vendorFilesQuery}`
      const response = await apiFetch(url)
      const payload = await response.json()
      if (!response.ok || !payload.success) {
        throw new Error(payload.message || `HTTP ${response.status}`)
      }
      window.open(payload.downloadUrl, '_blank', 'noopener')
    } catch (error) {
      setUploadState({ status: 'error', message: error.message })
    }
  }

  const formatFileSize = (bytes) => {
    if (!bytes && bytes !== 0) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const dirtyFields = useMemo(() => {
    if (!selectedVendor) return {}
    const result = {}
    for (const key of EDITABLE_FIELDS) {
      if ((draft[key] ?? '') !== (selectedVendor[key] ?? '')) {
        result[key] = draft[key]
      }
    }
    return result
  }, [draft, selectedVendor])

  const isDirty = Object.keys(dirtyFields).length > 0

  const handleFieldChange = (key, value) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const handleSaveChanges = async () => {
    if (!selectedVendor || !isDirty) return
    setSaveState({ status: 'saving', message: '' })
    try {
      const url = `/api/vendors/${encodeURIComponent(selectedVendor.id)}?environmentName=${encodeURIComponent(selectedEnvironment)}&companyId=${encodeURIComponent(selectedCompany)}`
      const response = await apiFetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dirtyFields),
      })
      const payload = await response.json()
      if (!response.ok || !payload.success) {
        throw new Error(payload.message || `HTTP ${response.status}`)
      }
      setVendors((prev) => prev.map((v) => (v.id === payload.item.id ? { ...v, ...payload.item } : v)))
      setSaveState({ status: 'success', message: 'Saved to Business Central.' })
    } catch (error) {
      setSaveState({ status: 'error', message: error.message })
    }
  }

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }

    setSortKey(key)
    setSortDirection('asc')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Naga Vendors</p>
          <h1>Business Central Vendor Directory</h1>
        </div>
        <div className="headerBadge">Teams-ready</div>
      </header>

      {ssoDebug && ssoDebug.state !== 'ok' && (
        <div className="ssoDebugBanner">
          <strong>SSO status: {ssoDebug.state}</strong>
          {ssoDebug.detail ? <span> — {ssoDebug.detail}</span> : null}
        </div>
      )}

      {apiDebug && (
        <div className="ssoDebugBanner">
          <strong>API error:</strong> <span>{apiDebug}</span>
        </div>
      )}

      <main className="content-grid">
        <section className="panel list-panel">
          <div className="scopeBar">
            <label>
              <span>Environment</span>
              <select
                value={selectedEnvironment}
                onChange={(event) => setSelectedEnvironment(event.target.value)}
              >
                {environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Company</span>
              <select
                value={selectedCompany}
                onChange={(event) => setSelectedCompany(event.target.value)}
                disabled={companiesLoading || companies.length === 0}
              >
                {companiesLoading ? (
                  <option>Loading companies...</option>
                ) : (
                  companies.map((company) => (
                    <option key={company.companyId} value={company.companyId}>
                      {company.name}
                    </option>
                  ))
                )}
              </select>
            </label>
          </div>

          <div className="panelHeader">
            <div>
              <h2>Vendors</h2>
              <span>{filteredVendors.length} results</span>
            </div>

            <div className="toolbar">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search vendors..."
                aria-label="Search vendors"
              />
              <select value={sortKey} onChange={(event) => handleSort(event.target.value)}>
                <option value="name">Sort by Name</option>
                <option value="balance">Sort by Balance</option>
                <option value="city">Sort by City</option>
                <option value="status">Sort by Status</option>
              </select>
            </div>
          </div>

          <div className="table-wrap">
            {loading ? (
              <div className="loadingState">Loading vendors...</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    {vendorColumns.map((column) => (
                      <th key={column.key}>
                        <button type="button" onClick={() => handleSort(column.key)}>
                          {column.label}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredVendors.map((vendor) => (
                    <tr
                      key={vendor.id}
                      className={vendor.id === selectedVendor?.id ? 'selected' : ''}
                      onClick={() => setSelectedVendorId(vendor.id)}
                    >
                      <td>{vendor.no}</td>
                      <td>{vendor.name}</td>
                      <td>{vendor.countryRegion}</td>
                      <td>{vendor.phoneNo}</td>
                      <td>{currencyFormatter.format(vendor.balance)}</td>
                      <td>
                        <span className={`status status-${vendor.status.toLowerCase().replace(/\s+/g, '-')}`}>
                          {vendor.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <aside className="panel detail-panel">
          {!selectedVendor ? (
            <div className="emptyState">No vendor found for the current filters.</div>
          ) : (
            <>
              <div className="detailHeader">
                <div>
                  <p className="eyebrow">Vendor Profile</p>
                  <h2>{selectedVendor.name}</h2>
                </div>
                <button
                  type="button"
                  className="ghostButton"
                  disabled={!isDirty || saveState.status === 'saving'}
                  onClick={handleSaveChanges}
                >
                  {saveState.status === 'saving' ? 'Saving...' : 'Save changes'}
                </button>
              </div>

              {saveState.status === 'success' && (
                <div className="saveBanner saveBanner-success">{saveState.message}</div>
              )}
              {saveState.status === 'error' && (
                <div className="saveBanner saveBanner-error">Save failed: {saveState.message}</div>
              )}

              <div className="heroCard">
                <div>
                  <label>Vendor No.</label>
                  <strong>{selectedVendor.no}</strong>
                </div>
                <div>
                  <label>Status</label>
                  <select
                    className="editableField statusField"
                    value={draft.status ?? selectedVendor.status}
                    onChange={(event) => handleFieldChange('status', event.target.value)}
                  >
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Balance</label>
                  <strong>{currencyFormatter.format(selectedVendor.balance ?? 0)}</strong>
                </div>
              </div>

              <div className="infoGrid">
                <div className="infoBlock">
                  <h3>Contact</h3>
                  <dl>
                    <div>
                      <dt>Contact person</dt>
                      <input
                        className="editableField readOnlyField"
                        value={selectedVendor.contactPerson ?? ''}
                        readOnly
                        title="Read-only: the vendor-contact link can't be changed through the standard Business Central API"
                      />
                    </div>
                    <div>
                      <dt>Phone</dt>
                      <input
                        className="editableField"
                        value={draft.phoneNo ?? ''}
                        onChange={(event) => handleFieldChange('phoneNo', event.target.value)}
                      />
                    </div>
                    <div>
                      <dt>Email</dt>
                      <input
                        className="editableField"
                        value={draft.email ?? ''}
                        onChange={(event) => handleFieldChange('email', event.target.value)}
                      />
                    </div>
                    <div>
                      <dt>Website</dt>
                      <input
                        className="editableField"
                        value={draft.website ?? ''}
                        onChange={(event) => handleFieldChange('website', event.target.value)}
                      />
                    </div>
                  </dl>
                </div>

                <div className="infoBlock">
                  <h3>Address</h3>
                  <dl>
                    <div>
                      <dt>City</dt>
                      <input
                        className="editableField"
                        value={draft.city ?? ''}
                        onChange={(event) => handleFieldChange('city', event.target.value)}
                      />
                    </div>
                    <div>
                      <dt>Country</dt>
                      <input
                        className="editableField"
                        value={draft.countryRegion ?? ''}
                        onChange={(event) => handleFieldChange('countryRegion', event.target.value)}
                      />
                    </div>
                    <div>
                      <dt>Address</dt>
                      <input
                        className="editableField"
                        value={draft.address ?? ''}
                        onChange={(event) => handleFieldChange('address', event.target.value)}
                      />
                    </div>
                    <div>
                      <dt>Tax No.</dt>
                      <input
                        className="editableField"
                        value={draft.taxRegistrationNo ?? ''}
                        onChange={(event) => handleFieldChange('taxRegistrationNo', event.target.value)}
                      />
                    </div>
                  </dl>
                </div>

                <div className="infoBlock wide">
                  <h3>Business details</h3>
                  <dl>
                    <div>
                      <dt>Vendor posting group</dt>
                      <dd>{selectedVendor.vendorPostingGroup}</dd>
                    </div>
                    <div>
                      <dt>Payment terms</dt>
                      <dd>{selectedVendor.paymentTerms}</dd>
                    </div>
                    <div>
                      <dt>Last modified</dt>
                      <dd>{selectedVendor.lastPurchaseDate}</dd>
                    </div>
                    <div>
                      <dt>Type</dt>
                      <dd>{selectedVendor.type}</dd>
                    </div>
                  </dl>
                </div>
              </div>

              <div className="notesBox">
                <h3>Notes</h3>
                <p>{selectedVendor.notes}</p>
              </div>

              <div className="infoBlock wide filesBlock">
                <div className="filesHeader">
                  <h3>Files</h3>
                  <label className="ghostButton uploadButton">
                    {uploadState.status === 'uploading' ? 'Uploading...' : 'Upload'}
                    <input
                      type="file"
                      onChange={handleUploadFile}
                      disabled={uploadState.status === 'uploading' || !vendorFilesQuery}
                      hidden
                    />
                  </label>
                </div>

                {uploadState.status === 'error' && (
                  <div className="saveBanner saveBanner-error">{uploadState.message}</div>
                )}

                {filesLoading ? (
                  <div className="loadingState">Loading files...</div>
                ) : files.length === 0 ? (
                  <div className="emptyState">No files uploaded for this vendor yet.</div>
                ) : (
                  <dl className="fileList">
                    {files.map((file) => (
                      <div key={file.id} className="fileRow">
                        <dt>
                          <button type="button" className="linkButton" onClick={() => handleDownloadFile(file.id)}>
                            {file.name}
                          </button>
                          <span className="fileMeta">{formatFileSize(file.size)}</span>
                        </dt>
                        <dd>
                          <button type="button" className="ghostButton" onClick={() => handleDeleteFile(file.id)}>
                            Delete
                          </button>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </>
          )}
        </aside>
      </main>
    </div>
  )
}

export default App
