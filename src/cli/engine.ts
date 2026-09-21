import { HookServer } from "../core/hook-server.js";
import { NativeKeyring } from "../core/native-keyring.js";
import { OAuthFlow } from "../core/oauth-flow.js";
import { QuotaMonitor } from "../core/quota-monitor.js";
import {
  DRAIN_WINDOW_MS,
  IMMINENT_RESET_MS,
  matchesModelAffinity,
  resolveModelFamily,
} from "../core/model-affinity.js";
import { USSBridge } from "../core/uss-bridge.js";
import type {
  Account,
  AccountQuota,
  AccountTier,
  EffectiveQuota,
  ModelAffinity,
  RotationStrategy,
} from "../types.js";
import { CliStorage, type CliConfig, type CliStorageData } from "./storage.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export class CliEngine {
  private readonly storage: CliStorage;
  private data: CliStorageData = {
    accounts: [],
    secrets: {},
    config: {
      activeEmail: "",
      rotationStrategy: "auto_highest",
      minQuotaThreshold: 10,
      pollingIntervalSec: 60,
      hookPort: 27182,
      syncKeyring: true,
    },
  };

  private quotaMonitor!: QuotaMonitor;
  private hookServer: HookServer | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly refreshPromises = new Map<string, Promise<string>>();
  private readonly logs: string[] = [];
  public onUpdate?: () => void;
  public onLog?: (msg: string) => void;

  constructor(customStorageDir?: string) {
    this.storage = new CliStorage(customStorageDir);
  }

  public get accounts(): Account[] {
    return this.data.accounts;
  }

  public get config(): CliConfig {
    return this.data.config;
  }

  public get activeEmail(): string {
    return this.data.config.activeEmail;
  }

  public get logHistory(): string[] {
    return this.logs;
  }

  public log(msg: string): void {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${msg}`;
    this.logs.push(formatted);
    if (this.logs.length > 500) this.logs.shift();
    this.onLog?.(formatted);
  }

  public autoRotationActive = false;

  public async init(options: { startServices?: boolean } = {}): Promise<void> {
    const startServices = options.startServices ?? true;
    this.data = await this.storage.load();

    // Auto-import active token from OS keyring if available
    await this.storage.autoImportKeyring(this.data);

    // Auto-import any accounts configured in Antigravity IDE
    await this.storage.autoImportIde(this.data);

    // If active account is missing or disabled, pick the first healthy non-disabled account
    const active = this.getActiveAccount();
    if ((!active || active.status === "disabled") && this.data.accounts.length > 0) {
      const first = this.data.accounts.find((a) => a.status !== "disabled");
      if (first) {
        this.data.config.activeEmail = first.email;
        await this.storage.save(this.data);
      }
    }

    // Initialize QuotaMonitor with adapter
    const adapter = {
      isExtensionEnabled: () => true,
      isRotationEnabled: () => this.autoRotationActive,
      getAccounts: () => this.data.accounts,
      getActiveAccount: () => this.getActiveAccount(),
      getValidAccessToken: (acc: Account) => this.getValidAccessToken(acc),
      updateAccountTier: (email: string, tier: AccountTier) => this.updateAccountTier(email, tier),
      autoSelectHighestQuota: (
        quotas: Record<string, AccountQuota>,
        reason?: string,
        model?: string,
      ) => this.autoRotate(reason, model),
      getEffectiveQuota: (
        email: string,
        quotas: Record<string, AccountQuota>,
        model?: string,
      ) => this.getEffectiveQuota(email, quotas, model),
    };

    // SAFETY: Duck-typed TokenManager adapter for QuotaMonitor
    this.quotaMonitor = new QuotaMonitor(adapter as never, (msg) => this.log(msg), () => {
      this.onUpdate?.();
    });

    if (startServices) {
      // Start background loops
      this.startTokenRefreshLoop();
      this.startQuotaPollLoop();

      // Start local HookServer for Antigravity IDE and pre-invocation hooks
      try {
        this.hookServer = new HookServer(adapter as never, this.quotaMonitor, (msg) => this.log(msg));
        const port = await this.hookServer.start(this.data.config.hookPort);
        if (port > 0) {
          this.log(`Hook server listening on port ${port} (ready for Antigravity IDE)`);
        }
      } catch (e) {
        this.log(`Hook server start error: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Initial quota fetch
      void this.refreshQuotas();

      // Initial sync to OS keyring
      if (this.data.config.syncKeyring && this.data.config.activeEmail) {
        void this.syncActiveToKeyring();
      }
    }
  }

  public getActiveAccount(): Account | null {
    if (!this.data.config.activeEmail) return null;
    return this.data.accounts.find((a) => a.email.toLowerCase() === this.data.config.activeEmail.toLowerCase()) ?? null;
  }

  public getAllQuotas(): Record<string, AccountQuota> {
    return this.quotaMonitor ? this.quotaMonitor.getAllQuotas() : {};
  }

  public getAccountQuota(email: string): AccountQuota | undefined {
    return this.quotaMonitor ? this.quotaMonitor.getQuota(email) : undefined;
  }

  public async refreshQuotas(): Promise<void> {
    this.log("Refreshing account quotas...");
    if (this.quotaMonitor) {
      await this.quotaMonitor.pollAllAccounts();
      this.onUpdate?.();
    }
  }

  public async selectAccount(email: string): Promise<Account | null> {
    const target = this.data.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (!target || target.status === "disabled") return null;

    this.data.config.activeEmail = target.email;
    await this.storage.save(this.data);
    this.log(`Active account switched to: ${target.email}`);

    if (this.data.config.syncKeyring) {
      await this.syncActiveToKeyring();
    }

    this.onUpdate?.();
    return target;
  }

  public async syncActiveToKeyring(): Promise<boolean> {
    const active = this.getActiveAccount();
    if (!active) return false;

    const secret = this.data.secrets[active.email.toLowerCase()];
    if (!secret) return false;

    try {
      // Ensure token is fresh
      const token = await this.getValidAccessToken(active);
      const updatedSecret = this.data.secrets[active.email.toLowerCase()] || secret;

      // 1. Sync to Windows Credential Manager (gemini:antigravity) for Antigravity Desktop & CLI
      const ok = await NativeKeyring.write({
        accessToken: token,
        refreshToken: updatedSecret.refreshToken || "",
        expiryDateSeconds: updatedSecret.expiryDateSeconds || Math.floor(Date.now() / 1000) + 3600,
      });

      // 2. Sync to Antigravity IDE via USS if IDE is running
      await USSBridge.setOAuthToken({
        accessToken: token,
        refreshToken: updatedSecret.refreshToken || "",
        expiryDateSeconds: updatedSecret.expiryDateSeconds || Math.floor(Date.now() / 1000) + 3600,
        tokenType: updatedSecret.tokenType || "Bearer",
        isGcpTos: active.isGcpTos ?? false,
      });

      if (ok) {
        this.log(`[Sync] Synced ${active.email} credentials to Windows Credential Manager & IDE`);
      }
      return ok;
    } catch (err: unknown) {
      this.log(`[Sync Error] Failed to sync keyring: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  public async addAccountViaOAuth(): Promise<Account | null> {
    this.log("Starting browser OAuth login flow...");
    try {
      const result = await OAuthFlow.startLogin();
      const normEmail = result.email.toLowerCase();

      this.data.secrets[normEmail] = result.tokens;
      let acc = this.data.accounts.find((a) => a.email.toLowerCase() === normEmail);
      if (!acc) {
        acc = {
          id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          email: result.email,
          tier: "pro",
          status: "active",
          sortOrder: this.data.accounts.length,
          affinity: "all",
          role: "primary",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          tokenExpiresAt: result.tokens.expiryDateSeconds,
        };
        this.data.accounts.push(acc);
      } else {
        acc.tokenExpiresAt = result.tokens.expiryDateSeconds;
        acc.updatedAt = Date.now();
      }

      if (!this.data.config.activeEmail) {
        this.data.config.activeEmail = result.email;
      }

      await this.storage.save(this.data);
      this.log(`Account successfully added: ${result.email}`);

      // Refresh quota immediately for the new account
      void this.quotaMonitor?.fetchAccountQuota(acc);
      void this.syncActiveToKeyring();
      this.onUpdate?.();
      return acc;
    } catch (err: unknown) {
      this.log(`OAuth login failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  public async toggleAccount(email: string): Promise<void> {
    const acc = this.data.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (!acc) return;

    acc.status = acc.status === "disabled" ? "active" : "disabled";
    acc.updatedAt = Date.now();

    if (acc.status === "disabled" && this.data.config.activeEmail.toLowerCase() === email.toLowerCase()) {
      const next = this.data.accounts.find((a) => a.status !== "disabled" && a.email.toLowerCase() !== email.toLowerCase());
      this.data.config.activeEmail = next?.email ?? "";
      if (this.data.config.activeEmail) void this.syncActiveToKeyring();
    } else if (acc.status === "active" && !this.data.config.activeEmail) {
      this.data.config.activeEmail = acc.email;
      void this.syncActiveToKeyring();
    }

    await this.storage.save(this.data);
    this.log(`Account ${email} pool status: ${acc.status}`);
    this.onUpdate?.();
  }

  public async removeAccount(email: string): Promise<boolean> {
    const idx = this.data.accounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
    if (idx === -1) return false;

    this.data.accounts.splice(idx, 1);
    delete this.data.secrets[email.toLowerCase()];

    if (this.data.config.activeEmail.toLowerCase() === email.toLowerCase()) {
      const next = this.data.accounts.find((a) => a.status !== "disabled");
      this.data.config.activeEmail = next?.email ?? "";
      if (this.data.config.activeEmail) void this.syncActiveToKeyring();
    }

    await this.storage.save(this.data);
    this.log(`Removed account ${email} from pool`);
    this.onUpdate?.();
    return true;
  }

  public async cycleAffinity(email: string): Promise<void> {
    const acc = this.data.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (!acc) return;

    const cycle: ModelAffinity[] = ["all", "gemini", "claude"];
    const curIdx = cycle.indexOf(acc.affinity || "all");
    acc.affinity = cycle[(curIdx + 1) % cycle.length]!;
    acc.updatedAt = Date.now();

    await this.storage.save(this.data);
    this.log(`Account ${email} affinity set to: ${(acc.affinity || "all").toUpperCase()}`);
    this.onUpdate?.();
  }

  public async cycleRole(email: string): Promise<void> {
    const acc = this.data.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (!acc) return;

    acc.role = (acc.role || "primary") === "primary" ? "reserve" : "primary";
    acc.updatedAt = Date.now();

    await this.storage.save(this.data);
    this.log(`Account ${email} pool role set to: ${acc.role.toUpperCase()}`);
    this.onUpdate?.();
  }

  public async setStrategy(strategy: RotationStrategy): Promise<void> {
    this.data.config.rotationStrategy = strategy;
    await this.storage.save(this.data);
    this.log(`Rotation strategy set to: ${strategy}`);
    this.onUpdate?.();
  }

  public async updateAccountTier(email: string, tier: AccountTier): Promise<void> {
    const acc = this.data.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (acc && acc.tier !== tier) {
      acc.tier = tier;
      acc.updatedAt = Date.now();
      await this.storage.save(this.data);
      this.onUpdate?.();
    }
  }

  public getEffectiveQuota(
    email: string,
    quotas: Record<string, AccountQuota>,
    targetModel?: string,
  ): EffectiveQuota {
    const q = quotas[email.toLowerCase()];
    if (!q?.families || q.families.length === 0) return { percent: -1, resetTs: Infinity };

    const modelName = targetModel || "Gemini 3.7 Flash High";
    const famKey = resolveModelFamily(modelName);
    if (famKey !== "other") {
      const fam = q.families.find((f) => f.key === famKey);
      if (fam) {
        const p5h = fam.limit5h?.percent ?? fam.percent ?? 100;
        const pWk = fam.limitWeekly?.percent ?? 100;
        const pct = pWk <= 0 ? 0 : p5h;
        const resetStr = fam.limit5h?.resetTime ?? fam.resetTime;
        const resetTs = resetStr ? Date.parse(resetStr) : Infinity;
        return { percent: pct, resetTs: Number.isNaN(resetTs) ? Infinity : resetTs };
      }
      return { percent: 0, resetTs: Infinity };
    }

    let minPct = 100, minResetTs = Infinity;
    for (const f of q.families) {
      const p5h = f.limit5h?.percent ?? f.percent ?? 100;
      const pWk = f.limitWeekly?.percent ?? 100;
      const pct = pWk <= 0 ? 0 : p5h;
      minPct = Math.min(minPct, pct);
      const resetTime = f.limit5h?.resetTime ?? f.resetTime;
      if (resetTime) {
        const ts = Date.parse(resetTime);
        if (!Number.isNaN(ts) && ts < minResetTs) minResetTs = ts;
      }
    }
    return { percent: minPct, resetTs: minResetTs };
  }

  public async autoRotate(reason?: string, targetModel?: string): Promise<Account | null> {
    if (this.data.accounts.length <= 1) return null;

    const available = this.data.accounts.filter((a) => a.status !== "disabled");
    if (available.length <= 1) return null;

    const quotas = this.getAllQuotas();
    const model = targetModel || "Gemini 3.7 Flash High";
    const famKey = resolveModelFamily(model);
    const now = Date.now();
    const activeEmail = this.data.config.activeEmail.toLowerCase();
    const activeAcc = this.getActiveAccount();
    const activeInfo = this.getEffectiveQuota(activeEmail, quotas, model);

    // 1. Model Affinity Filtering
    const affinityMatched = available.filter((a) => matchesModelAffinity(a, famKey));
    const pool = affinityMatched.length > 0 ? affinityMatched : available;

    // 2. Reserve Pool Filtering
    const primaryPool = pool.filter((a) => (a.role || "primary") !== "reserve");
    const hasUsablePrimary = primaryPool.some((a) => this.getEffectiveQuota(a.email, quotas, model).percent > 10);
    const candidates = hasUsablePrimary ? primaryPool : pool;

    // 3. Tier Priority
    const paidPool = candidates.filter((a) => a.tier !== "free");
    const hasUsablePaid = paidPool.some((a) => this.getEffectiveQuota(a.email, quotas, model).percent > 10);
    const tierCandidates = hasUsablePaid ? paidPool : candidates;

    const isRateLimitFailover = reason === "rate_limit_failover";
    const activeMatchesAffinity = activeAcc ? matchesModelAffinity(activeAcc, famKey) : true;
    const activeIsFreeWhenPaidAvailable = activeAcc?.tier === "free" && hasUsablePaid;

    // 4. Timing Priority (Drain Window)
    if (
      !isRateLimitFailover &&
      !activeIsFreeWhenPaidAvailable &&
      activeMatchesAffinity &&
      activeInfo.percent > 5 &&
      activeInfo.resetTs - now > 0 &&
      activeInfo.resetTs - now <= DRAIN_WINDOW_MS
    ) {
      return null;
    }

    const strategy = this.data.config.rotationStrategy;

    if (strategy === "cache_optimized" && !isRateLimitFailover) {
      if (!activeIsFreeWhenPaidAvailable && activeMatchesAffinity && activeInfo.percent > 15) {
        return null;
      }
    } else if (strategy === "round_robin" && !isRateLimitFailover) {
      const imminentCandidate = tierCandidates.find((a) => {
        const qInfo = this.getEffectiveQuota(a.email, quotas, model);
        const timeToReset = qInfo.resetTs - now;
        return timeToReset > 0 && timeToReset <= IMMINENT_RESET_MS && qInfo.percent > 10 && a.email.toLowerCase() !== activeEmail;
      });

      if (imminentCandidate) {
        return this.selectAccount(imminentCandidate.email);
      }

      const curIdx = tierCandidates.findIndex((a) => a.email.toLowerCase() === activeEmail);
      for (let offset = 1; offset <= tierCandidates.length; offset++) {
        const nextIdx = (curIdx + offset) % tierCandidates.length;
        const candidate = tierCandidates[nextIdx];
        if (!candidate) continue;
        const qInfo = this.getEffectiveQuota(candidate.email, quotas, model);
        if (qInfo.percent > 10 && candidate.email.toLowerCase() !== activeEmail) {
          return this.selectAccount(candidate.email);
        }
      }
      return null;
    }

    // Auto-Highest Candidate Scoring
    let bestAcc: Account | null = null;
    let bestScore = -1;
    let bestPct = -1;
    let bestResetTs = Infinity;

    for (const acc of tierCandidates) {
      const info = this.getEffectiveQuota(acc.email, quotas, model);
      if (info.percent <= 0) continue;

      const timeToReset = info.resetTs - now;
      const isImminent = timeToReset > 0 && timeToReset <= IMMINENT_RESET_MS && info.percent > 10;
      const tierBonus = acc.tier === "ultra" ? 20 : acc.tier === "pro" ? 10 : 0;
      const score = info.percent + (isImminent ? 1000 : 0) + tierBonus;

      if (score > bestScore || (score === bestScore && info.resetTs < bestResetTs)) {
        bestAcc = acc;
        bestScore = score;
        bestPct = info.percent;
        bestResetTs = info.resetTs;
      }
    }

    const activeTimeToReset = activeInfo.resetTs - now;
    const isActiveImminent = activeTimeToReset > 0 && activeTimeToReset <= IMMINENT_RESET_MS && activeInfo.percent > 10;
    const activeTierBonus = activeAcc?.tier === "ultra" ? 20 : activeAcc?.tier === "pro" ? 10 : 0;
    const activeScore = activeMatchesAffinity && !activeIsFreeWhenPaidAvailable
      ? activeInfo.percent + (isActiveImminent ? 1000 : 0) + activeTierBonus
      : -1;

    if (!bestAcc || bestPct <= 0 || bestAcc.email.toLowerCase() === activeEmail || (!isRateLimitFailover && bestScore <= activeScore)) {
      return null;
    }

    this.log(`[AutoRotate] Rotating to highest quota account ${bestAcc.email} (${bestPct}%) from ${this.data.config.activeEmail} (${activeInfo.percent}%) [reason: ${reason || "auto"}]`);
    return this.selectAccount(bestAcc.email);
  }

  public async getValidAccessToken(account: Account): Promise<string> {
    const normEmail = account.email.toLowerCase();
    const sec = this.data.secrets[normEmail];
    const nowSec = Math.floor(Date.now() / 1000);

    if (sec?.accessToken && sec.expiryDateSeconds - nowSec > 120) {
      return sec.accessToken;
    }

    const existingPromise = this.refreshPromises.get(normEmail);
    if (existingPromise) return existingPromise;

    const promise = (async () => {
      try {
        if (!sec?.refreshToken) {
          throw new Error(`No refresh token found for ${account.email}`);
        }

        const creds = USSBridge.getClientCredentials();
        const body = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: sec.refreshToken,
          client_id: creds.clientId,
        });
        if (creds.clientSecret) body.set("client_secret", creds.clientSecret);

        const res = await fetch(GOOGLE_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: AbortSignal.timeout(15000),
        });

        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Token refresh HTTP ${res.status}: ${err}`);
        }

        const data = (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
        sec.accessToken = data.access_token;
        if (data.refresh_token) sec.refreshToken = data.refresh_token;
        sec.expiryDateSeconds = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);

        account.tokenExpiresAt = sec.expiryDateSeconds;
        account.updatedAt = Date.now();

        await this.storage.save(this.data);
        return sec.accessToken;
      } finally {
        this.refreshPromises.delete(normEmail);
      }
    })();

    this.refreshPromises.set(normEmail, promise);
    return promise;
  }

  private startTokenRefreshLoop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      const nowSec = Math.floor(Date.now() / 1000);
      for (const acc of this.data.accounts) {
        if (acc.status === "disabled") continue;
        const sec = this.data.secrets[acc.email.toLowerCase()];
        if (sec && sec.expiryDateSeconds - nowSec < 300) {
          void this.getValidAccessToken(acc).catch((e) => {
            this.log(`Background token refresh error for ${acc.email}: ${e instanceof Error ? e.message : String(e)}`);
          });
        }
      }
    }, 60000);
  }

  private startQuotaPollLoop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    const intervalMs = Math.max(15, this.data.config.pollingIntervalSec) * 1000;
    this.pollTimer = setInterval(() => {
      void this.refreshQuotas();
    }, intervalMs);
  }

  public dispose(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    this.quotaMonitor?.dispose();
    this.hookServer?.dispose();
  }
}
