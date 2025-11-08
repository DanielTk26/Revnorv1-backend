import express from "express";
import cors from "cors";
import multer from "multer";
import { config } from "dotenv";
import { nanoid } from "nanoid";

import { processFiles } from "./utils/parser.js";
import { makeZip } from "./utils/zipper.js";
import { createProject, putChunk, getChunk, getProject } from "./utils/chunkStore.js";

config();
const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

/* ------------------------------------------------------------------ */
/* Helper: Inject SDK + init automatically into any HTML file         */
/* ------------------------------------------------------------------ */
function injectSdkIntoHtml(html, sdkSnippet, projectId, envKey) {
  // Construct a working version of the snippet with correct URLs
  const injectedSnippet = `
<!-- CodeMask SDK (auto-injected) -->
<script src="http://localhost:5050/sdk/codemask-sdk.js"></script>
<script>
  if (window.CodeMask) {
    window.CodeMask.init({
      baseUrl: "http://localhost:5050",
      projectId: "${projectId}",
      key: "${envKey}"
    });
  } else {
    console.error("CodeMask SDK failed to load before init()");
  }
</script>
<!-- End CodeMask SDK -->
`;

  // place the snippet before main.js or before </body>
  if (html.includes("main.js")) {
    return html.replace(
      /<script[^>]*src=["'][^"']*main\.js["'][^>]*><\/script>/i,
      `${injectedSnippet}\n<script src="main.js"></script>`
    );
  } else if (html.includes("</body>")) {
    return html.replace(/<\/body>/i, `${injectedSnippet}\n</body>`);
  } else {
    // fallback: append at the end
    return html + `\n${injectedSnippet}`;
  }
}

/* ------------------------------------------------------------------ */
/* POST /api/mask                                                     */
/* ------------------------------------------------------------------ */
app.post("/api/mask", upload.array("files"), async (req, res) => {
  try {
    const projectId = nanoid(10);
    const envKey = nanoid(20);

    createProject(projectId, envKey);

    const files = (req.files || []).map((f) => ({
      relativePath: f.originalname,
      content: f.buffer
    }));

    const { processedFiles, chunks } = processFiles(files);

    // Store chunks in memory
    for (const c of chunks) {
      putChunk(projectId, c.chunkId, {
        type: c.type,
        name: c.name,
        params: c.params,
        body: c.body,
        original: c.original
      });
    }

    // Prepare the SDK snippet for display
    const sdkSnippet = `<script src="http://localhost:5050/sdk/codemask-sdk.js"></script>
<script>
  window.CodeMask.init({
    baseUrl: "http://localhost:5050",
    projectId: "${projectId}",
    key: "${envKey}"
  });
</script>`;

    // Inject SDK automatically into HTML files
    for (let file of processedFiles) {
      if (file.relativePath.endsWith(".html")) {
        file.content = injectSdkIntoHtml(file.content, sdkSnippet, projectId, envKey);
      }
    }

    // Zip the processed files
    const zipBuffer = makeZip(processedFiles);
    const base64Zip = zipBuffer.toString("base64");

    return res.json({
      projectId,
      envKey,
      sdkSnippet,
      message:
        "SDK snippet auto-injected into your HTML files. You can still copy the snippet manually if needed.",
      download: base64Zip
    });
  } catch (e) {
    console.error("MASK ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/fetch/:projectId/:chunkId                                 */
/* ------------------------------------------------------------------ */
app.get("/api/fetch/:projectId/:chunkId", (req, res) => {
  const { projectId, chunkId } = req.params;
  const qkey = req.query.key;

  const project = getProject(projectId);
  if (!project) {
    console.warn("FETCH 404 project:", projectId, chunkId);
    return res.status(404).json({ error: "Project not found" });
  }

  if (qkey !== project.key) {
    console.warn("FETCH 403 key mismatch:", projectId, chunkId);
    return res.status(403).json({ error: "Invalid key" });
  }

  const chunk = getChunk(projectId, chunkId);
  if (!chunk) {
    console.warn("FETCH 404 chunk:", projectId, chunkId);
    return res.status(404).json({ error: "Chunk not found" });
  }

  console.log("FETCH 200", projectId, chunkId, "type:", chunk.type);

  if (chunk.type === "decl" || chunk.type === "arrow") {
    const funcSource = `(${chunk.params}) => { ${chunk.body} }`;
    return res.json({ ok: true, kind: "function", name: chunk.name, code: funcSource });
  }

  // constants / raw
  return res.json({ ok: true, kind: "raw", code: chunk.original });
});

/* ------------------------------------------------------------------ */
/* Serve SDK (ready-safe)                                             */
/* ------------------------------------------------------------------ */
app.get("/sdk/codemask-sdk.js", (req, res) => {
  const sdk = `// Lightweight CodeMask SDK (ready-safe)
(function () {
  const state = { baseUrl: "", projectId: "", key: "", cache: new Map() };
  let initialized = false;
  let waiters = [];
  let _resolveReady;
  const ready = new Promise(res => { _resolveReady = res; });

  function init(opts) {
    state.baseUrl = opts.baseUrl;
    state.projectId = opts.projectId;
    state.key = opts.key;
    initialized = true;
    _resolveReady();
    const queued = waiters.slice(); waiters = [];
    queued.forEach(fn => { try { fn(); } catch(_){} });
    try { window.dispatchEvent(new Event("CodeMaskReady")); } catch(_) {}
    window.CodeMask._state = state;
  }

  async function _loadImpl(chunkId) {
    if (state.cache.has(chunkId)) return state.cache.get(chunkId);
    const url = state.baseUrl + "/api/fetch/" + state.projectId + "/" + chunkId + "?key=" + encodeURIComponent(state.key);
    const r = await fetch(url);
    if (!r.ok) throw new Error("Failed to load chunk " + chunkId);
    const data = await r.json();
    if (data.kind === "function") {
      const fn = new Function("return " + data.code)();
      state.cache.set(chunkId, fn);
      return fn;
    } else {
      return new Function(data.code);
    }
  }

  function load(chunkId) {
    if (initialized) return _loadImpl(chunkId);
    return new Promise((resolve, reject) => {
      waiters.push(async () => {
        try { resolve(await _loadImpl(chunkId)); } catch (e) { reject(e); }
      });
    });
  }

  async function inject(chunkId) {
    const fn = await load(chunkId);
    return fn;
  }

  window.CodeMask = { init, load, inject, ready };
})();
`;
  res.setHeader("Content-Type", "application/javascript");
  res.send(sdk);
});

/* ------------------------------------------------------------------ */
/* Start Server                                                       */
/* ------------------------------------------------------------------ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ CodeMask backend running on port " + PORT);
});
