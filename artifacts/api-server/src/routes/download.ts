import { Router, type IRouter } from "express";
import fs from "node:fs";
import path from "node:path";

// Temporary convenience: lets the user download the project zip from the
// browser. No arbitrary path access — only the allowlisted file.
// Resolve the workspace root independently of launch CWD (dev runs from the
// package dir, production runs from the workspace root) by walking up from
// the module location until we find the workspace marker.
function findWorkspaceRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate workspace root from " + import.meta.dirname);
}
const WORKSPACE_ROOT = findWorkspaceRoot();

const ALLOWED_FILES: Record<string, string> = {
  "kiwi-buzz-source.zip": path.join(WORKSPACE_ROOT, "kiwi-buzz-source.zip"),
};

const downloadRouter: IRouter = Router();

downloadRouter.get("/download/:file", (req, res) => {
  const name = req.params["file"];
  const filePath = name ? ALLOWED_FILES[name] : undefined;
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { size } = fs.statSync(filePath);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Length", size);
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  stream.pipe(res);
});

export default downloadRouter;
