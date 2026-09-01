// pdf-parse's pdfjs-dist dependency needs a global DOMMatrix (used internally for glyph
// positioning, even during plain text extraction). It tries to get one from the optional
// @napi-rs/canvas native binding — but that binding is built for the machine `npm install`
// ran on, and this project builds on Windows then zip-deploys straight to Linux Azure with
// no server-side install step, so the Linux binary is never present and pdfjs-dist crashes
// at import time with "DOMMatrix is not defined". Pre-seeding a pure-JS polyfill here (must be
// imported before pdf-parse) makes pdfjs-dist skip the native-canvas lookup entirely — no
// native binary, so no platform mismatch is possible.
import CSSMatrix from 'dommatrix'

if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = CSSMatrix
}
