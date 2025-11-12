// Simple in-memory store for demo. Replace with Redis/DB in prod.
const store = new Map();
// Structure: store.set(projectId, { key: 'envKey123', chunks: Map(chunkId => {code,type,name,params,body}) })

export function createProject(projectId, key) {
  store.set(projectId, { key, chunks: new Map() });
}

export function putChunk(projectId, chunkId, chunkMeta) {
  const proj = store.get(projectId);
  if (!proj) throw new Error("Project not found");
  proj.chunks.set(chunkId, chunkMeta);
}

export function getProject(projectId) {
  return store.get(projectId);
}

export function getChunk(projectId, chunkId) {
  const proj = store.get(projectId);
  if (!proj) return null;
  return proj.chunks.get(chunkId);
}


export function getAllProjects() {
  return projects; 
}
