import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { OpenAGErrorCode, PatcherError, type PatcherStatus, type PatchItem } from "../types.js";

export interface PatchResult {
  success: boolean;
  message: string;
}

export interface ProductJson {
  checksums?: Record<string, string>;
}

const TAG_AUTORUN = "/*OPENAG:autorun*/";

let cachedAppRoot: string | null = null;
let customAppRootOverride: string | null = null;

export function atomicWriteFile(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  const tempPath = path.join(dir, `.openag-tmp-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Suppress unlink error
      }
    }
    throw new PatcherError(
      `Atomic file write failed for ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
      OpenAGErrorCode.PATCHER_WRITE_FAILED,
      err,
    );
  }
}

export function setAppRootOverride(dir: string | null): void {
  customAppRootOverride = dir;
  cachedAppRoot = null;
}

function getAppRoot(): string | null {
  if (customAppRootOverride && fs.existsSync(customAppRootOverride)) return customAppRootOverride;
  if (cachedAppRoot && fs.existsSync(cachedAppRoot)) return cachedAppRoot;

  try {
    // SAFETY: vscode module shape when loaded inside VS Code runtime
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require("vscode") as typeof import("vscode") | undefined;
    const envAppRoot = vscode?.env?.appRoot;
    if (envAppRoot) {
      if (fs.existsSync(path.join(envAppRoot, "out", "vs", "workbench", "workbench.desktop.main.js"))) {
        cachedAppRoot = envAppRoot;
        return envAppRoot;
      }
      const envRes = path.join(envAppRoot, "resources", "app");
      if (fs.existsSync(path.join(envRes, "out", "vs", "workbench", "workbench.desktop.main.js"))) {
        cachedAppRoot = envRes;
        return envRes;
      }
    }
  } catch { /* ignore */ }

  if (process.execPath) {
    try {
      const execDir = path.dirname(process.execPath);
      const execCandidates = [
        path.join(execDir, "resources", "app"),
        path.join(execDir, "..", "Resources", "app"),
        path.join(execDir, "app"),
      ];
      for (const cand of execCandidates) {
        if (fs.existsSync(path.join(cand, "out", "vs", "workbench", "workbench.desktop.main.js"))) {
          cachedAppRoot = cand;
          return cand;
        }
      }
    } catch { /* ignore */ }
  }

  const candidates: string[] = [];

  if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA || "";
    if (localApp) {
      candidates.push(
        path.join(localApp, "Programs", "Antigravity IDE", "resources", "app"),
        path.join(localApp, "Programs", "Antigravity", "resources", "app"),
      );
    }
    const progFiles = process.env.ProgramFiles || "";
    if (progFiles) {
      candidates.push(
        path.join(progFiles, "Antigravity IDE", "resources", "app"),
        path.join(progFiles, "Antigravity", "resources", "app"),
      );
    }
  } else if (process.platform === "darwin") {
    const home = process.env.HOME || "";
    candidates.push(
      "/Applications/Antigravity IDE.app/Contents/Resources/app",
      "/Applications/Antigravity.app/Contents/Resources/app",
      path.join(home, "Applications", "Antigravity IDE.app", "Contents", "Resources", "app"),
      path.join(home, "Applications", "Antigravity.app", "Contents", "Resources", "app"),
    );
  } else {
    const home = process.env.HOME || "";
    candidates.push(
      "/opt/Antigravity/resources/app",
      "/opt/Antigravity IDE/resources/app",
      "/usr/share/antigravity/resources/app",
      "/usr/share/antigravity-ide/resources/app",
      "/usr/lib/antigravity/resources/app",
      path.join(home, ".local", "share", "Antigravity", "resources", "app"),
      path.join(home, ".local", "share", "Antigravity IDE", "resources", "app"),
    );
  }

  for (const cand of candidates) {
    if (fs.existsSync(path.join(cand, "out", "vs", "workbench", "workbench.desktop.main.js"))) {
      cachedAppRoot = cand;
      return cand;
    }
  }
  return null;
}

function getOriginalContent(fullPath: string): string | null {
  if (!fs.existsSync(fullPath)) return null;
  const backupPath = `${fullPath}.openag-backup`;
  if (fs.existsSync(backupPath)) {
    return fs.readFileSync(backupPath, "utf8");
  }
  const current = fs.readFileSync(fullPath, "utf8");
  if (!current.includes("/*OPENAG:")) {
    try {
      fs.copyFileSync(fullPath, backupPath);
    } catch { /* ignore */ }
  }
  return current;
}

function getStatus(): PatcherStatus {
  const appRoot = getAppRoot();
  if (!appRoot) {
    return { supported: false, appRoot: null, version: "unknown", error: "Antigravity install directory not found", patches: [] };
  }

  let version = "unknown";
  try {
    // SAFETY: IDE application root package.json for version reading
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")) as { version?: string };
    version = pkg.version || "unknown";
  } catch { /* ignore */ }

  const jetskiPath = path.join(appRoot, "out", "jetskiAgent", "main.js");
  const wbPath = path.join(appRoot, "out", "vs", "workbench", "workbench.desktop.main.js");
  if (!fs.existsSync(jetskiPath) && !fs.existsSync(wbPath)) {
    return { supported: false, appRoot, version, error: "Antigravity bundle files missing", patches: [] };
  }

  const jetskiContent = fs.existsSync(jetskiPath) ? fs.readFileSync(jetskiPath, "utf8") : "";
  const wbContent = fs.existsSync(wbPath) ? fs.readFileSync(wbPath, "utf8") : "";
  const currentContent = jetskiContent + wbContent;

  const origJetski = (fs.existsSync(jetskiPath) ? getOriginalContent(jetskiPath) : null) || jetskiContent;
  const origWb = (fs.existsSync(wbPath) ? getOriginalContent(wbPath) : null) || wbContent;
  const origContent = origJetski + origWb;

  const patches: PatchItem[] = [
    {
      id: "autorun",
      name: "Auto-Run & Auto-Approve",
      description: "Auto-approves terminal commands, file reads, and tool interactions on mount without waiting for manual confirmation prompts.",
      isPatched: currentContent.includes(TAG_AUTORUN),
      canApply: origContent.includes('{case:"runCommand",value:') || origContent.includes('{case:"filePermission",value:'),
    },
  ];

  for (const p of patches) {
    if (!p.canApply && !p.isPatched) {
      p.warning = "Code pattern not found in current Antigravity version. Patch disabled to prevent crash.";
    }
  }

  return { supported: true, appRoot, version, patches };
}

function applyPatches(enabledIds: Set<string>): PatchResult {
  const appRoot = getAppRoot();
  if (!appRoot) return { success: false, message: "Could not locate Antigravity installation path." };

  const targets = [
    { rel: path.join("out", "vs", "workbench", "workbench.desktop.main.js"), hookId: "co", effectId: "yt" },
    { rel: path.join("out", "jetskiAgent", "main.js"), hookId: "ia", effectId: "ze" },
  ];

  try {
    const productPath = path.join(appRoot, "product.json");
    let productJson: ProductJson = {};
    if (fs.existsSync(productPath)) {
      if (!fs.existsSync(`${productPath}.openag-backup`)) {
        fs.copyFileSync(productPath, `${productPath}.openag-backup`);
      }
      // SAFETY: product.json structure for integrity checksums map
      productJson = JSON.parse(fs.readFileSync(productPath, "utf8")) as ProductJson;
      if (!productJson.checksums) productJson.checksums = {};
    }

    for (const { rel, hookId, effectId } of targets) {
      const fullPath = path.join(appRoot, rel);
      const origContent = getOriginalContent(fullPath);
      if (!origContent) continue;

      let content = origContent;

      // Anti-corruption: suppress VS Code integrity check warning and mark as pure
      if (content.includes("async _isPure(){const e=this.productService.checksums||{};")) {
        content = content.replace(
          "async _isPure(){const e=this.productService.checksums||{};",
          "async _isPure(){return{isPure:!0,proof:[]};const e=this.productService.checksums||{};",
        );
      }
      if (content.includes("async _compute(){const{isPure:e}=await this.isPure();if(e)return;")) {
        content = content.replace(
          "async _compute(){const{isPure:e}=await this.isPure();if(e)return;",
          "async _compute(){return;const{isPure:e}=await this.isPure();if(e)return;",
        );
      }

      if (enabledIds.has("autorun")) {
        // 1. Hook terminal runCommand confirmation
        const rcAnchor = '{case:"runCommand",value:';
        for (let idx = content.indexOf(rcAnchor); idx !== -1; idx = content.indexOf(rcAnchor, idx + rcAnchor.length)) {
          const winStart = Math.max(0, idx - 150);
          const winEnd = Math.min(content.length, idx + 50);
          const winStr = content.slice(winStart, winEnd);
          const match = winStr.match(/([a-zA-Z0-9_$]+)\s*=\s*([a-zA-Z0-9_$]+)\s*\(\s*([a-zA-Z0-9_$]+)\s*=>\s*\{/);
          if (match) {
            const cbVar = match[1];
            const afterAnchor = content.slice(idx, idx + 300);
            const cbEndMatch = afterAnchor.match(/\},\s*\[[^\]]*\]\s*\)\s*;/);
            if (cbEndMatch && cbEndMatch.index !== undefined) {
              const cbEndPos = idx + cbEndMatch.index + cbEndMatch[0].length;
              const patchCode = `${TAG_AUTORUN};((typeof ${effectId}==="function"?${effectId}:null)||(typeof React!=="undefined"?React.useEffect:null))?.(()=>{try{let _h=(typeof ${hookId}==="function"?${hookId}:null);let _st=_h?.()?.stepHandler;if(!_st?.secureModeEnabled)${cbVar}(!0)}catch{}},[${cbVar}]);`;
              content = content.slice(0, cbEndPos) + patchCode + content.slice(cbEndPos);
              break;
            }
          }
        }

        // 2. Hook filePermission request (file reading and access)
        const fpAnchor = '{case:"filePermission",value:';
        for (let idx = content.indexOf(fpAnchor); idx !== -1; idx = content.indexOf(fpAnchor, idx + fpAnchor.length)) {
          const winStart = Math.max(0, idx - 150);
          const winStr = content.slice(winStart, idx);
          const match = winStr.match(/([a-zA-Z0-9_$]+)\s*=\s*\(([a-zA-Z0-9_$]+),\s*([a-zA-Z0-9_$]+)\)\s*=>\s*\{/);
          if (match) {
            const cbVar = match[1];
            const afterAnchor = content.slice(idx, idx + 200);
            const endMatch = afterAnchor.match(/\};/);
            if (endMatch && endMatch.index !== undefined) {
              const cbEndPos = idx + endMatch.index + endMatch[0].length;
              const patchCode = `;((typeof ${effectId}==="function"?${effectId}:null)||(typeof React!=="undefined"?React.useEffect:null))?.(()=>{try{let _h=(typeof ${hookId}==="function"?${hookId}:null);let _st=_h?.()?.stepHandler;if(!_st?.secureModeEnabled)${cbVar}(!0,1)}catch{}},[${cbVar}]);`;
              content = content.slice(0, cbEndPos) + patchCode + content.slice(cbEndPos);
              break;
            }
          }
        }

        // 3. Hook generic approvalInteraction
        const appAnchor = '{case:"approvalInteraction",value:';
        for (let idx = content.indexOf(appAnchor); idx !== -1; idx = content.indexOf(appAnchor, idx + appAnchor.length)) {
          const winStart = Math.max(0, idx - 150);
          const winStr = content.slice(winStart, idx + 50);
          const match = winStr.match(/([a-zA-Z0-9_$]+)\s*=\s*([a-zA-Z0-9_$]+)\s*\(\s*([a-zA-Z0-9_$]+)\s*=>\s*\{/);
          if (match) {
            const cbVar = match[1];
            const afterAnchor = content.slice(idx, idx + 200);
            const endMatch = afterAnchor.match(/\},\s*\[[^\]]*\]\s*\)/);
            if (endMatch && endMatch.index !== undefined) {
              const cbEndPos = idx + endMatch.index + endMatch[0].length;
              const patchCode = `;((typeof ${effectId}==="function"?${effectId}:null)||(typeof React!=="undefined"?React.useEffect:null))?.(()=>{try{let _h=(typeof ${hookId}==="function"?${hookId}:null);let _st=_h?.()?.stepHandler;if(!_st?.secureModeEnabled)${cbVar}(!0)}catch{}},[${cbVar}]);`;
              content = content.slice(0, cbEndPos) + patchCode + content.slice(cbEndPos);
              break;
            }
          }
        }

        // 4. Hook generic ask_permission prompt
        const permAnchor = 'toolName:"ask_permission"';
        const permIdx = content.indexOf(permAnchor);
        if (permIdx !== -1) {
          const winStart = Math.max(0, permIdx - 300);
          const winStr = content.slice(winStart, permIdx);
          const match = winStr.match(/([a-zA-Z0-9_$]+)\s*=\s*([a-zA-Z0-9_$]+)\s*\(\s*\(\)\s*=>\s*\{[^}]*\}\s*,\s*\[[^\]]*\]\s*\)/);
          if (match) {
            const cbVar = match[1];
            const matchPos = winStart + (match.index || 0) + match[0].length;
            const patchCode = `;((typeof ${effectId}==="function"?${effectId}:null)||(typeof React!=="undefined"?React.useEffect:null))?.(()=>{try{let _h=(typeof ${hookId}==="function"?${hookId}:null);let _st=_h?.()?.stepHandler;if(!_st?.secureModeEnabled)${cbVar}?.()}catch{}},[${cbVar}]);`;
            content = content.slice(0, matchPos) + patchCode + content.slice(matchPos);
          }
        }

        content = content.replace(/label:"Always run",isAllowed:[a-zA-Z0-9_$]+&&![a-zA-Z0-9_$]+/g, 'label:"Always run",isAllowed:!0');
      }

      atomicWriteFile(fullPath, content);
      const normRel = rel.replace(/^out[\\/]/, "").replace(/\\/g, "/");
      if (productJson.checksums) {
        productJson.checksums[normRel] = crypto.createHash("sha256").update(content).digest("base64").replace(/=+$/, "");
      }
    }

    if (fs.existsSync(productPath)) {
      atomicWriteFile(productPath, JSON.stringify(productJson, null, "\t"));
    }

    return { success: true, message: "Settings updated successfully! Reload Antigravity window to take effect." };
  } catch (err: unknown) {
    return { success: false, message: `Failed to update settings: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function togglePatch(patchId: string, enable?: boolean): PatchResult {
  const status = getStatus();
  const target = status.patches.find((p) => p.id === patchId);
  if (!target) return { success: false, message: `Unknown patch: ${patchId}` };

  const currentPatched = new Set(status.patches.filter((p) => p.isPatched).map((p) => p.id));
  const willEnable = enable !== undefined ? enable : !target.isPatched;

  if (willEnable) {
    if (!target.canApply && !target.isPatched) {
      return { success: false, message: target.warning || "Cannot apply patch on this Antigravity build." };
    }
    currentPatched.add(patchId);
  } else {
    currentPatched.delete(patchId);
  }

  return applyPatches(currentPatched);
}

export const AutoRunPatcher = {
  getAppRoot,
  getStatus,
  setAppRootOverride,
  togglePatch,
  applyPatches,
  atomicWriteFile,
  apply: () => togglePatch("autorun", true),
  revert: () => togglePatch("autorun", false),
};
