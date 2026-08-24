import { execFile, execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

export const KEYRING_TARGET = "gemini:antigravity";

export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    const version = fs.readFileSync("/proc/version", "utf8");
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

export function getPsExecutable(): string {
  if (process.platform === "win32") return "powershell";
  if (isWsl()) return "powershell.exe";
  return "powershell";
}

export interface KeyringToken {
  access_token: string;
  token_type: string;
  refresh_token: string;
  expiry: string;
}

export interface KeyringPayload {
  token: KeyringToken;
  auth_method: string;
}

const WIN32_CSHARP_HELPER = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinCred {
    [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] int flags);

    [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, int type, int flags);

    [DllImport("Advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
    public static extern void CredFree([In] IntPtr cred);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static string Read(string target) {
        IntPtr ptr;
        if (CredRead(target, 1, 0, out ptr)) {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
            CredFree(ptr);
            string sUtf8 = Encoding.UTF8.GetString(bytes);
            if (sUtf8.Contains("{") || sUtf8.Contains("token")) return sUtf8;
            return Encoding.Unicode.GetString(bytes);
        }
        return null;
    }

    public static bool Write(string target, string userName, string secret) {
        byte[] bytes = Encoding.UTF8.GetBytes(secret);
        IntPtr blobPtr = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, blobPtr, bytes.Length);
            CREDENTIAL cred = new CREDENTIAL();
            cred.Type = 1;
            cred.TargetName = target;
            cred.CredentialBlobSize = bytes.Length;
            cred.CredentialBlob = blobPtr;
            cred.Persist = 2;
            cred.UserName = userName ?? "";
            return CredWrite(ref cred, 0);
        } finally {
            Marshal.FreeHGlobal(blobPtr);
        }
    }

    public static bool Delete(string target) {
        return CredDelete(target, 1, 0);
    }
}
`;

function encodeBase64Command(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function formatKeyringPayload(accessToken: string, refreshToken: string, expirySeconds: number): KeyringPayload {
  const expiryDate = expirySeconds > 0 ? new Date(expirySeconds * 1000) : new Date(Date.now() + 3600000);
  return {
    token: {
      access_token: accessToken,
      token_type: "Bearer",
      refresh_token: refreshToken,
      expiry: expiryDate.toISOString(),
    },
    auth_method: "consumer",
  };
}

export function parseKeyringPayload(raw: string): KeyringPayload | null {
  if (!raw?.trim()) return null;
  try {
    // SAFETY: OS Keyring JSON payload parsing
    const parsed = JSON.parse(raw.trim()) as KeyringPayload;
    if (parsed?.token?.access_token) {
      return parsed;
    }
  } catch { /* ignore parse error */ }
  return null;
}

export const NativeKeyring = {
  read(target = KEYRING_TARGET): Promise<KeyringPayload | null> {
    return new Promise((resolve) => {
      const platform = os.platform();
      if (platform === "win32" || (platform === "linux" && isWsl())) {
        const psScript = `
Add-Type -TypeDefinition @"
${WIN32_CSHARP_HELPER}
"@
$v = [WinCred]::Read('${target}')
if ($v) { [Console]::Out.Write($v) }
`;
        execFile(
          getPsExecutable(),
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeBase64Command(psScript)],
          { windowsHide: true, timeout: 5000 },
          (err, stdout) => {
            if (err || !stdout) {
              resolve(null);
              return;
            }
            resolve(parseKeyringPayload(stdout));
          },
        );
      } else if (platform === "darwin") {
        execFile(
          "security",
          ["find-generic-password", "-s", target, "-w"],
          { timeout: 5000 },
          (err, stdout) => {
            if (err || !stdout) {
              resolve(null);
              return;
            }
            resolve(parseKeyringPayload(stdout));
          },
        );
      } else {
        execFile(
          "secret-tool",
          ["lookup", "service", target],
          { timeout: 5000 },
          (err, stdout) => {
            if (err || !stdout) {
              resolve(null);
              return;
            }
            resolve(parseKeyringPayload(stdout));
          },
        );
      }
    });
  },

  readSync(target = KEYRING_TARGET): KeyringPayload | null {
    const platform = os.platform();
    try {
      if (platform === "win32" || (platform === "linux" && isWsl())) {
        const psScript = `
Add-Type -TypeDefinition @"
${WIN32_CSHARP_HELPER}
"@
$v = [WinCred]::Read('${target}')
if ($v) { [Console]::Out.Write($v) }
`;
        const out = execFileSync(
          getPsExecutable(),
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeBase64Command(psScript)],
          { windowsHide: true, timeout: 5000, encoding: "utf8" },
        );
        return parseKeyringPayload(out);
      }
      if (platform === "darwin") {
        const out = execFileSync("security", ["find-generic-password", "-s", target, "-w"], {
          timeout: 5000,
          encoding: "utf8",
        });
        return parseKeyringPayload(out);
      }
      const out = execFileSync("secret-tool", ["lookup", "service", target], {
        timeout: 5000,
        encoding: "utf8",
      });
      return parseKeyringPayload(out);
    } catch {
      return null;
    }
  },

  write(
    token: { accessToken: string; refreshToken: string; expiryDateSeconds: number },
    target = KEYRING_TARGET,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const payload = formatKeyringPayload(token.accessToken, token.refreshToken, token.expiryDateSeconds);
      const jsonStr = JSON.stringify(payload);
      const platform = os.platform();

      if (platform === "win32" || (platform === "linux" && isWsl())) {
        const base64Secret = Buffer.from(jsonStr, "utf8").toString("base64");
        const psScript = `
Add-Type -TypeDefinition @"
${WIN32_CSHARP_HELPER}
"@
$raw = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64Secret}'))
$ok = [WinCred]::Write('${target}', 'gemini', $raw)
if ($ok) { [Console]::Out.Write('OK') } else { [Console]::Out.Write('FAIL') }
`;
        execFile(
          getPsExecutable(),
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeBase64Command(psScript)],
          { windowsHide: true, timeout: 5000 },
          (err, stdout) => {
            if (err || !stdout || !stdout.includes("OK")) {
              resolve(false);
              return;
            }
            resolve(true);
          },
        );
      } else if (platform === "darwin") {
        execFile(
          "security",
          ["add-generic-password", "-U", "-s", target, "-a", "gemini", "-w", jsonStr],
          { timeout: 5000 },
          (err) => {
            resolve(!err);
          },
        );
      } else {
        const proc = spawnSync("secret-tool", ["store", `--label=${target}`, "service", target], {
          input: jsonStr,
          timeout: 5000,
        });
        resolve(proc.status === 0);
      }
    });
  },

  delete(target = KEYRING_TARGET): Promise<boolean> {
    return new Promise((resolve) => {
      const platform = os.platform();
      if (platform === "win32" || (platform === "linux" && isWsl())) {
        const psScript = `
Add-Type -TypeDefinition @"
${WIN32_CSHARP_HELPER}
"@
$ok = [WinCred]::Delete('${target}')
if ($ok) { [Console]::Out.Write('OK') } else { [Console]::Out.Write('FAIL') }
`;
        execFile(
          getPsExecutable(),
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeBase64Command(psScript)],
          { windowsHide: true, timeout: 5000 },
          (err, stdout) => {
            if (err || !stdout || !stdout.includes("OK")) {
              resolve(false);
              return;
            }
            resolve(true);
          },
        );
      } else if (platform === "darwin") {
        execFile("security", ["delete-generic-password", "-s", target], { timeout: 5000 }, (err) => {
          resolve(!err);
        });
      } else {
        execFile("secret-tool", ["clear", "service", target], { timeout: 5000 }, (err) => {
          resolve(!err);
        });
      }
    });
  },
};
