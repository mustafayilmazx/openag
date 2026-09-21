import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { getPsExecutable, isWsl } from "../core/native-keyring.js";

function encodeBase64Command(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function getFallbackKey(): Buffer {
  const seed = `${os.hostname()}-${os.userInfo().username}-openag-fallback-key`;
  return crypto.createHash("sha256").update(seed).digest();
}

function fallbackEncrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const key = getFallbackKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let enc = cipher.update(plaintext, "utf8", "hex");
  enc += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `FALLBACK_GCM:${iv.toString("hex")}:${tag}:${enc}`;
}

function fallbackDecrypt(ciphertext: string): string {
  if (!ciphertext.startsWith("FALLBACK_GCM:")) {
    throw new Error("Invalid fallback ciphertext envelope");
  }
  const parts = ciphertext.split(":");
  if (parts.length !== 4) throw new Error("Corrupted ciphertext parts");
  const iv = Buffer.from(parts[1]!, "hex");
  const tag = Buffer.from(parts[2]!, "hex");
  const enc = parts[3]!;
  const key = getFallbackKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let dec = decipher.update(enc, "hex", "utf8");
  dec += decipher.final("utf8");
  return dec;
}

export const Dpapi = {
  isWindowsNative(): boolean {
    return os.platform() === "win32" || (os.platform() === "linux" && isWsl());
  },

  protect(plaintext: string): Promise<string> {
    try {
      return Promise.resolve(this.protectSync(plaintext));
    } catch (err) {
      return Promise.reject(err);
    }
  },

  unprotect(ciphertext: string): Promise<string> {
    try {
      return Promise.resolve(this.unprotectSync(ciphertext));
    } catch (err) {
      return Promise.reject(err);
    }
  },

  protectSync(plaintext: string): string {
    if (!this.isWindowsNative()) {
      return fallbackEncrypt(plaintext);
    }
    const inputB64 = Buffer.from(plaintext, "utf8").toString("base64");
    const psScript = `
$ProgressPreference = 'SilentlyContinue';
Add-Type -AssemblyName System.Security
$plainBytes = [Convert]::FromBase64String('${inputB64}')
$encBytes = [System.Security.Cryptography.ProtectedData]::Protect($plainBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($encBytes))
`;
    try {
      const out = execFileSync(
        getPsExecutable(),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeBase64Command(psScript)],
        { windowsHide: true, timeout: 10000, encoding: "utf8" },
      );
      return `DPAPI:${out.trim()}`;
    } catch {
      return fallbackEncrypt(plaintext);
    }
  },

  unprotectSync(ciphertext: string): string {
    if (ciphertext.startsWith("FALLBACK_GCM:")) {
      return fallbackDecrypt(ciphertext);
    }
    const raw = (ciphertext.startsWith("DPAPI:") ? ciphertext.slice(6) : ciphertext).trim();
    if (!this.isWindowsNative()) {
      throw new Error("DPAPI ciphertext cannot be decrypted on non-Windows environment");
    }
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) {
      throw new Error("Invalid base64 payload in DPAPI ciphertext");
    }
    const psScript = `
$ProgressPreference = 'SilentlyContinue';
Add-Type -AssemblyName System.Security
$encBytes = [Convert]::FromBase64String('${raw}')
$plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($encBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plainBytes))
`;
    try {
      const out = execFileSync(
        getPsExecutable(),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeBase64Command(psScript)],
        { windowsHide: true, timeout: 10000, encoding: "utf8" },
      );
      return Buffer.from(out.trim(), "base64").toString("utf8");
    } catch {
      // Retry once on transient Windows spawn lock
      const out = execFileSync(
        getPsExecutable(),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeBase64Command(psScript)],
        { windowsHide: true, timeout: 10000, encoding: "utf8" },
      );
      return Buffer.from(out.trim(), "base64").toString("utf8");
    }
  },
};
