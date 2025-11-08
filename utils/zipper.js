import AdmZip from "adm-zip";

export function makeZip(files) {
  const zip = new AdmZip();
  for (const f of files) {
    zip.addFile(f.relativePath, Buffer.from(f.content, "utf8"));
  }
  return zip.toBuffer();
}
