import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPsExecutable, NativeKeyring } from "../core/native-keyring.js";
import { loadSqlite } from "../core/sqlite-utils.js";
import { USSBridge } from "../core/uss-bridge.js";
import type { Account, OAuthTokens, RotationStrategy } from "../types.js";
import { Dpapi } from "./dpapi.js";

export interface CliConfig {
  activeEmail: string;
  rotationStrategy: RotationStrategy;
  minQuotaThreshold: number;
  pollingIntervalSec: number;
  hookPort: number;
  syncKeyring: boolean;
}

export const DEFAULT_CONFIG: CliConfig = {
  activeEmail: "",
  rotationStrategy: "auto_highest",
  minQuotaThreshold: 10,
  pollingIntervalSec: 60,
  hookPort: 27182,
  syncKeyring: true,
};

export interface CliStorageData {
  accounts: Account[];
  secrets: Record<string, OAuthTokens>;
  config: CliConfig;
}

function atomicWriteFile(filePath: string, content: string, mode = 0o600): void {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode });
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    fs.copyFileSync(tmpPath, filePath);
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

export class CliStorage {
  private readonly dirPath: string;
  private readonly accountsPath: string;
  private readonly configPath: string;
  private readonly vaultPath: string;

  constructor(customDir?: string) {
    this.dirPath = customDir || path.join(os.homedir(), ".openag");
    this.accountsPath = path.join(this.dirPath, "accounts.json");
    this.configPath = path.join(this.dirPath, "config.json");
    this.vaultPath = path.join(this.dirPath, "vault.bin");
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dirPath)) {
      fs.mkdirSync(this.dirPath, { recursive: true, mode: 0o700 });
    }
  }

  public async load(): Promise<CliStorageData> {
    this.ensureDir();
    let accounts: Account[] = [];
    let config: CliConfig = { ...DEFAULT_CONFIG };
    let secrets: Record<string, OAuthTokens> = {};

    if (fs.existsSync(this.accountsPath)) {
      try {
        const raw = fs.readFileSync(this.accountsPath, "utf8");
        accounts = JSON.parse(raw) as Account[];
      } catch {
        accounts = [];
      }
    }

    if (fs.existsSync(this.configPath)) {
      try {
        const raw = fs.readFileSync(this.configPath, "utf8");
        config = { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<CliConfig>) };
      } catch {
        config = { ...DEFAULT_CONFIG };
      }
    }

    if (fs.existsSync(this.vaultPath)) {
      try {
        const rawCipher = fs.readFileSync(this.vaultPath, "utf8");
        if (rawCipher.trim()) {
          const decrypted = await Dpapi.unprotect(rawCipher.trim());
          secrets = JSON.parse(decrypted) as Record<string, OAuthTokens>;
        }
      } catch {
        secrets = {};
      }
    }

    return { accounts, secrets, config };
  }

  public async save(data: CliStorageData): Promise<void> {
    this.ensureDir();
    atomicWriteFile(this.accountsPath, JSON.stringify(data.accounts, null, 2), 0o600);
    atomicWriteFile(this.configPath, JSON.stringify(data.config, null, 2), 0o600);

    const secretJson = JSON.stringify(data.secrets);
    const cipher = await Dpapi.protect(secretJson);
    atomicWriteFile(this.vaultPath, cipher, 0o600);
  }

  public async autoImportKeyring(currentData: CliStorageData): Promise<boolean> {
    try {
      const cred = await NativeKeyring.read();
      if (!cred?.token?.access_token) return false;

      const accessToken = cred.token.access_token;
      const email = await USSBridge.getEmailFromToken(accessToken);
      if (!email) return false;

      const normEmail = email.toLowerCase();
      const existing = currentData.accounts.find((a) => a.email.toLowerCase() === normEmail);

      const tokens: OAuthTokens = {
        accessToken,
        refreshToken: cred.token.refresh_token || "",
        expiryDateSeconds: cred.token.expiry ? Math.floor(Date.parse(cred.token.expiry) / 1000) : Math.floor(Date.now() / 1000) + 3600,
        tokenType: cred.token.token_type || "Bearer",
      };

      currentData.secrets[normEmail] = tokens;

      if (!existing) {
        const newAcc: Account = {
          id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          email,
          tier: "pro",
          status: "active",
          sortOrder: currentData.accounts.length,
          affinity: "all",
          role: "primary",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          tokenExpiresAt: tokens.expiryDateSeconds,
        };
        currentData.accounts.push(newAcc);
      } else {
        existing.tokenExpiresAt = tokens.expiryDateSeconds;
        existing.updatedAt = Date.now();
      }

      if (!currentData.config.activeEmail) {
        currentData.config.activeEmail = email;
      }

      await this.save(currentData);
      return true;
    } catch {
      return false;
    }
  }

  public async autoImportIde(currentData: CliStorageData): Promise<number> {
    if (process.platform !== "win32") return 0;
    try {
      const localStatePath = path.join(os.homedir(), "AppData", "Roaming", "Antigravity IDE", "Local State");
      const dbPath = path.join(os.homedir(), "AppData", "Roaming", "Antigravity IDE", "User", "globalStorage", "state.vscdb");
      if (!fs.existsSync(localStatePath) || !fs.existsSync(dbPath)) return 0;

      const ls = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
      const encKeyB64 = ls.os_crypt?.encrypted_key;
      if (!encKeyB64) return 0;

      const rawKey = Buffer.from(encKeyB64, "base64").subarray(5);
      const psScript = `
$ProgressPreference = 'SilentlyContinue';
Add-Type -AssemblyName System.Security
$bytes = [System.Convert]::FromBase64String('${rawKey.toString("base64")}')
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([System.Convert]::ToBase64String($dec))
`;
      const masterKeyB64 = execFileSync(
        getPsExecutable(),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(psScript, "utf16le").toString("base64")],
        { encoding: "utf8", windowsHide: true },
      ).trim();
      const masterKey = Buffer.from(masterKeyB64, "base64");

      const sqlite = loadSqlite();
      if (!sqlite) return 0;

      let importedCount = 0;
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'secret://%openag%secret.%'").all<{ key: string; value: string }>();
        for (const r of rows) {
          let email = "";
          if (r.key.startsWith("secret://")) {
            try {
              const parsed = JSON.parse(r.key.slice(9)) as { key?: string };
              if (parsed.key?.includes(".secret.")) {
                email = parsed.key.split(".secret.")[1] || "";
              }
            } catch {
              email = r.key.split(".secret.")[1]?.replace(/["}]+$/, "").trim() || "";
            }
          } else if (r.key.includes(".secret.")) {
            email = r.key.split(".secret.")[1]?.replace(/["}]+$/, "").trim() || "";
          }
          if (!email || !email.includes("@")) continue;

          const raw = JSON.parse(r.value);
          const buf = Buffer.from(raw.data);
          const iv = buf.subarray(3, 15);
          const tag = buf.subarray(buf.length - 16);
          const ciphertext = buf.subarray(15, buf.length - 16);
          const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
          decipher.setAuthTag(tag);
          const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          const cred = JSON.parse(decrypted.toString("utf8")) as OAuthTokens;

          const normEmail = email.toLowerCase();
          currentData.secrets[normEmail] = cred;

          let existing = currentData.accounts.find((a) => a.email.toLowerCase() === normEmail);
          if (!existing) {
            existing = {
              id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              email,
              tier: "pro",
              status: "active",
              sortOrder: currentData.accounts.length,
              affinity: "all",
              role: "primary",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              tokenExpiresAt: cred.expiryDateSeconds || Math.floor(Date.now() / 1000) + 3600,
            };
            currentData.accounts.push(existing);
            importedCount++;
          }

          if (!currentData.config.activeEmail) {
            currentData.config.activeEmail = email;
          }
        }
      } finally {
        db.close();
      }

      if (importedCount > 0) {
        await this.save(currentData);
      }
      return importedCount;
    } catch {
      return 0;
    }
  }
}
