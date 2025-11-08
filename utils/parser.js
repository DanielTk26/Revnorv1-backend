import { nanoid } from "nanoid";
import path from "path";
/**
 * Analyze the snippet inside CODEMASK markers and classify it.
 * Returns:
 *  {
 *    kind: 'decl' | 'arrow' | 'constant' | 'unknown',
 *    name: string|null,
 *    params: string,
 *    body: string,
 *    original: string
 *  }
 */
function analyze(snippet) {
  const trimmed = snippet.trim();

  // 1) async / normal function declarations
  //    e.g. function foo(a,b){ ... }  OR  async function foo(a,b){ ... }
  const decl =
    trimmed.match(
      /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([\s\S]*?)\)\s*\{([\s\S]*?)\}\s*$/
    );
  if (decl) {
    return {
      kind: "decl",
      name: decl[1].trim(),
      params: (decl[2] || "").trim(),
      body: (decl[3] || "").trim(),
      original: trimmed
    };
  }

  // 2) const/let + (async) arrow
  //    e.g. const foo = (a,b)=>{...}
  //         const foo = async (a,b)=>{...}
  //         let foo = async a => { ... }   (we normalize params via the match)
  const arrow =
    trimmed.match(
      /^(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(?([\s\S]*?)\)?\s*=>\s*\{([\s\S]*?)\}\s*;?\s*$/
    );
  if (arrow) {
    return {
      kind: "arrow",
      name: arrow[1].trim(),
      params: (arrow[2] || "").trim(),
      body: (arrow[3] || "").trim(),
      original: trimmed
    };
  }

  // 3) Non-function constants (objects/arrays/primitives)
  //    e.g. const secret_meta = { ... };
  //         let TABLE = [ ... ];
  //    We capture the entire const/let statement up to the trailing semicolon (optional).
  const constant =
    trimmed.match(/^(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*([\s\S]+?);?\s*$/);
  if (constant) {
    return {
      kind: "constant",
      name: constant[1].trim(),
      params: "",
      body: "", // not used for constants
      original: trimmed
    };
  }

  // 4) Unknown (fallback)
  return {
    kind: "unknown",
    name: null,
    params: "",
    body: "",
    original: trimmed
  };
}

/**
 * Turn one file (string) into a processed string with CODEMASK blocks replaced.
 * Collect chunk metadata to be stored by the backend.
 */
function transformFile(relativePath, content) {
  const CM_START = "/* CODEMASK_START */";
  const CM_END = "/* CODEMASK_END */";

  // No markers? return as-is
  if (!content.includes(CM_START)) {
    return { out: content, chunks: [] };
  }

  let out = "";
  let idx = 0;
  const chunks = [];

  while (idx < content.length) {
    const start = content.indexOf(CM_START, idx);
    if (start === -1) {
      out += content.slice(idx);
      break;
    }
    // keep code up to the marker
    out += content.slice(idx, start);

    const end = content.indexOf(CM_END, start);
    if (end === -1) {
      // unmatched; append rest and stop
      out += content.slice(start);
      break;
    }

    // Extract the snippet between markers
    const raw = content.slice(start + CM_START.length, end).trim();
    const info = analyze(raw);
    const chunkId = "chunk_" + nanoid(8);

    // Generate replacement stub according to kind
    if (info.kind === "decl") {
      // Recreate function name & params, proxy to remote chunk
      out +=
`/* CODEMASKED:${chunkId} */
async function ${info.name}(${info.params}) {
  const fn = await window.CodeMask.load("${chunkId}");
  return fn.apply(this, [${info.params}]);
}
/* END_CODEMASKED */
`;
      chunks.push({
        chunkId,
        type: "decl",
        name: info.name,
        params: info.params,
        body: info.body,
        original: info.original
      });
    } else if (info.kind === "arrow") {
      out +=
`/* CODEMASKED:${chunkId} */
const ${info.name} = async (${info.params}) => {
  const fn = await window.CodeMask.load("${chunkId}");
  return fn(${info.params});
};
/* END_CODEMASKED */
`;
      chunks.push({
        chunkId,
        type: "arrow",
        name: info.name,
        params: info.params,
        body: info.body,
        original: info.original
      });
    } else if (info.kind === "constant") {
      // For constants, we want NO manual injection.
      // Strategy: ask SDK to load the raw snippet and execute it immediately once,
      // so that the const/let is defined in the current scope (top-level).
      // We do it with a small IIFE so there's no top-level await requirement.
      out +=
`/* CODEMASKED:${chunkId} */
(function(){
  // Load & execute the raw constant snippet so it defines ${info.name}
  var p = window.CodeMask && window.CodeMask.load
    ? window.CodeMask.load("${chunkId}")
    : Promise.reject(new Error("CodeMask SDK not initialized before constants load"));

  p.then(function(fn){
    // SDK returns a function for 'raw' kind; call it to execute the snippet
    try { if (typeof fn === "function") fn(); } catch(e){ console.error("CodeMask constant exec error (${chunkId})", e); }
  }).catch(function(err){
    console.error("CodeMask constant load failed (${chunkId})", err);
  });
})();
/* END_CODEMASKED */
`;
      chunks.push({
        chunkId,
        type: "constant",
        name: info.name,
        params: "",
        body: "",
        original: info.original
      });
    } else {
      // Unknown: still avoid manual steps — auto-load and execute once.
      out +=
`/* CODEMASKED:${chunkId} */
(function(){
  var p = window.CodeMask && window.CodeMask.load
    ? window.CodeMask.load("${chunkId}")
    : Promise.reject(new Error("CodeMask SDK not initialized before unknown block load"));

  p.then(function(fn){
    try { if (typeof fn === "function") fn(); } catch(e){ console.error("CodeMask unknown exec error (${chunkId})", e); }
  }).catch(function(err){
    console.error("CodeMask unknown load failed (${chunkId})", err);
  });
})();
/* END_CODEMASKED */
`;
      chunks.push({
        chunkId,
        type: "raw",
        name: null,
        params: "",
        body: "",
        original: info.original
      });
    }

    // continue after the end marker
    idx = end + CM_END.length;
  }

  return { out, chunks };
}

/**
 * Main entry used by index.js
 * @param {Array<{relativePath:string, content:Buffer}>} files
 * @returns {{ processedFiles: Array<{relativePath:string, content:string}>, chunks: any[] }}
 */
export function processFiles(files) {
  const processedFiles = [];
  const chunks = [];

  for (const f of files) {
    const ext = path.extname(f.relativePath).toLowerCase();
    // We primarily transform JS/TS; pass through others
    const maybeText =
      ext === ".js" || ext === ".jsx" || ext === ".ts" || ext === ".tsx" || ext === ".mjs";

    if (!maybeText) {
      processedFiles.push({ relativePath: f.relativePath, content: f.content.toString("utf8") });
      continue;
    }

    const original = f.content.toString("utf8");
    const { out, chunks: fileChunks } = transformFile(f.relativePath, original);
    processedFiles.push({ relativePath: f.relativePath, content: out });
    chunks.push(...fileChunks);
  }

  return { processedFiles, chunks };
}
