# CodeMask Backend (MVP)
- `npm i`
- Put `.env` values, then `npm run dev`
- Endpoints:
  - `POST /api/mask` (multipart form-data) => returns { projectId, envKey, sdkSnippet, download: base64 zip }
  - `GET /api/fetch/:projectId/:chunkId?key=...` => serves hidden function code
  - `GET /sdk/codemask-sdk.js` => SDK script
