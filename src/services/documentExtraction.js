// Best-effort text extraction + field recognition for uploaded vendor documents. Runs entirely
// locally (no paid OCR/API service): pdf-parse reads the embedded text layer of digital PDFs,
// tesseract.js OCRs plain images. Scanned PDFs (image-only, no text layer) aren't rasterized —
// that would need a native-binary dependency (e.g. node-canvas/poppler), which is unsafe for this
// project's Windows-build -> Linux-Azure zip-deploy pipeline. They upload normally, just without suggestions.

import path from 'node:path'
import { PDFParse } from 'pdf-parse'
import { createWorker } from 'tesseract.js'

const MIN_PDF_TEXT_LENGTH = 20
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const IMAGE_CONTENT_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])

let ocrWorkerPromise = null
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker('eng+ron')
  }
  return ocrWorkerPromise
}

function isPdf(contentType, filename) {
  return contentType === 'application/pdf' || /\.pdf$/i.test(filename || '')
}

function isImage(contentType, filename) {
  if (IMAGE_CONTENT_TYPES.has(contentType)) return true
  return IMAGE_EXTENSIONS.has(path.extname(filename || '').toLowerCase())
}

export async function extractText(buffer, contentType, filename) {
  if (isPdf(contentType, filename)) {
    let parser
    try {
      parser = new PDFParse({ data: buffer })
      const { text } = await parser.getText()
      if (text && text.trim().length >= MIN_PDF_TEXT_LENGTH) return text
    } catch (error) {
      console.error('pdf-parse failed', error)
    } finally {
      await parser?.destroy()
    }
    return ''
  }

  if (isImage(contentType, filename)) {
    try {
      const worker = await getOcrWorker()
      const { data } = await worker.recognize(buffer)
      return data.text || ''
    } catch (error) {
      console.error('tesseract.js OCR failed', error)
      return ''
    }
  }

  return ''
}

// Ordered {field, patterns, build} rules matched against the raw extracted text. `field` keys
// map directly onto App.jsx's EDITABLE_FIELDS. Generic v1 patterns (RO/EN labels) — refine once
// real sample documents are available.
const FIELD_PATTERNS = [
  {
    field: 'taxRegistrationNo',
    patterns: [/\b(?:CUI|C\.U\.I\.?|CIF|C\.I\.F\.?|Cod\s*fiscal|Tax\s*(?:registration\s*)?(?:no\.?|number))\s*[:-]?\s*(RO)?\s*([0-9]{2,12})\b/i],
    build: (m) => `${m[1] ? 'RO' : ''}${m[2]}`,
  },
  {
    field: 'email',
    patterns: [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/],
    build: (m) => m[0],
  },
  {
    field: 'website',
    patterns: [/\b(?:https?:\/\/[^\s,;]+|www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s,;]*)/i],
    build: (m) => m[0],
  },
  {
    field: 'phoneNo',
    patterns: [/\b(?:Tel(?:efon)?|Phone|Mobil)\.?\s*[:-]?\s*(\+?[0-9][0-9().-\s]{6,18}[0-9])/i],
    build: (m) => m[1].trim(),
  },
  {
    field: 'address',
    patterns: [/\b(?:Adres[aă]|Address|Sediul?)\s*[:-]?\s*(.+)/i],
    build: (m) => m[1].trim(),
  },
  {
    field: 'city',
    patterns: [/\b(?:Ora[sș]|Localitate|City)\s*[:-]?\s*([A-Za-zĂÂÎȘȚăâîșț .-]{2,40})/i],
    build: (m) => m[1].trim(),
  },
  {
    field: 'countryRegion',
    patterns: [/\b(?:[TȚ]ar[aă]|Country)\s*[:-]?\s*([A-Za-zĂÂÎȘȚăâîșț .-]{2,40})/i],
    build: (m) => m[1].trim(),
  },
]

export function extractVendorFields(text) {
  if (!text) return {}

  const result = {}
  for (const { field, patterns, build } of FIELD_PATTERNS) {
    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (match) {
        const value = build(match)
        if (value) {
          result[field] = value
          break
        }
      }
    }
  }
  return result
}

export async function extractVendorFieldsFromDocument(buffer, contentType, filename) {
  const text = await extractText(buffer, contentType, filename)
  return extractVendorFields(text)
}
