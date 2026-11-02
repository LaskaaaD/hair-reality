import { isAbsolute } from "node:path";
import { z } from "zod";

const PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-random-session-secret",
  "replace-with-a-random-secret",
  "replace-with-youcam-key",
  "replace-with-openai-key",
  "changeme",
  "change-me",
  "secret",
  "password",
]);

const optionalText = z.string().min(1).optional();
export const OFFICIAL_YOUCAM_API_BASE_URL = "https://yce-api-01.makeupar.com";
export const DOCUMENTED_DOWNLOAD_HOSTS = ["yce-us.s3-accelerate.amazonaws.com", "app-cdn.makeupar.com"] as const;
const postgresUrl = z.string().min(1).optional();

const environmentSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  appOrigin: z.url().default("http://localhost:3000"),
  databaseUrl: postgresUrl,
  testDatabaseUrl: postgresUrl,
  sessionSecret: optionalText,
  privateStorageDir: z.string().min(1).default("var/private"),
  providerMode: z.enum(["fixture", "recorded_demo", "live"]).optional(),
  budgetPhase: z.enum(["development", "demo"]).default("development"),
  youcamApiBaseUrl: optionalText,
  youcamApiKey: optionalText,
  openaiApiKey: optionalText,
  openaiModel: z.string().min(1).default("gpt-5.4-mini"),
  openaiTimeoutMs: z.coerce.number().int().min(5_000).max(120_000).default(45_000),
  youcamDevCap: z.coerce.number().int().min(0).max(500).default(500),
  youcamDemoCap: z.coerce.number().int().min(0).max(300).default(300),
  youcamTotalCap: z.coerce.number().int().min(0).max(800).default(800),
  youcamReserve: z.coerce.number().int().min(200).max(200).default(200),
  openaiBudgetUsd: z.coerce.number().min(0).max(6).default(5),
  assetRetentionDays: z.coerce.number().int().min(1).max(30).default(30),
  demoSessionCap: z.coerce.number().int().min(1).max(80).default(40),
  demoDailyCap: z.coerce.number().int().min(1).max(800).default(200),
  demoJudgeSecret: optionalText,
  demoJudgeSessionCap: z.coerce.number().int().min(1).max(400).default(120),
  demoJudgeDailyCap: z.coerce.number().int().min(1).max(2000).default(400),
  analysisMode: z.enum(["hackathon", "salon"]).default("hackathon"),
  demoLean: z.enum(["0", "1"]).default("0"),
  demoSalonTimezone: z.string().min(1).default("Europe/Warsaw"),
  deletionJournalMode: z.enum(["local", "remote", "none"]).default("local"),
  deletionJournalDir: z.string().min(1).default("var/deletion-journal"),
  backupHost: optionalText,
  backupPath: optionalText,
  deletionJournalPath: optionalText,
  trustProxy: z.enum(["0", "1"]).default("0"),
  providerDownloadAllowlist: z.string().optional(),
  renderCacheDir: z.string().min(1).default("var/render-cache"),
  renderJobTimeoutMs: z.coerce.number().int().min(5_000).max(300_000).default(45_000),
});

type EnvironmentInput = z.infer<typeof environmentSchema>;

export type AppConfig = Omit<EnvironmentInput, "demoLean"> & {
  providerMode: "fixture" | "recorded_demo" | "live";
  providerDownloadHosts: readonly string[];
  youcamLiveSubmission: boolean;
  openaiLiveSubmission: boolean;
  operatorProbe: boolean;
  fixtureAuthPartition: boolean;
  demoLean: boolean;
};

export class ConfigError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`Invalid configuration: ${fields.join(", ")}`);
    this.name = "ConfigError";
    this.fields = fields;
  }
}

export function loadLocalEnv(): void {
  // Tests set this so a developer .env file cannot change fixture assertions.
  if (process.env.HAIR_REALITY_SKIP_ENV_FILE === "1") return;
  const path = ".env";
  try {
    process.loadEnvFile(path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return;
    throw new ConfigError(["env_file"]);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(readInput(env));
  if (!parsed.success) {
    throw new ConfigError(issueFields(parsed.error));
  }
  const youcamApiBaseUrl = parsed.data.youcamApiBaseUrl ?? OFFICIAL_YOUCAM_API_BASE_URL;
  const partition = env.HAIR_REALITY_FIXTURE_AUTH_PARTITION?.trim() ?? "";
  if (partition !== "" && partition !== "1") throw new ConfigError(["HAIR_REALITY_FIXTURE_AUTH_PARTITION"]);
  const mode = parsed.data.providerMode ?? "fixture";
  if (partition === "1" && (parsed.data.nodeEnv === "production" || mode !== "fixture")) {
    throw new ConfigError(["HAIR_REALITY_FIXTURE_AUTH_PARTITION"]);
  }
  const violations = unsafeFields({ ...parsed.data, youcamApiBaseUrl });
  if (violations.length > 0) {
    throw new ConfigError(violations);
  }
  const providerDownloadHosts = parsed.data.providerDownloadAllowlist === undefined
    ? [...DOCUMENTED_DOWNLOAD_HOSTS]
    : downloadHosts(parsed.data.providerDownloadAllowlist);
  if (providerDownloadHosts === null) throw new ConfigError(["PROVIDER_DOWNLOAD_ALLOWLIST"]);
  const submission = env.YOUCAM_LIVE_SUBMISSION?.trim() ?? "";
  if (submission !== "" && submission !== "1") throw new ConfigError(["YOUCAM_LIVE_SUBMISSION"]);
  const openAISubmission = env.OPENAI_LIVE_SUBMISSION?.trim() ?? "";
  if (openAISubmission !== "" && openAISubmission !== "1") throw new ConfigError(["OPENAI_LIVE_SUBMISSION"]);
  const operatorProbe = env.HAIR_REALITY_OPERATOR_PROBE?.trim() ?? "";
  if (operatorProbe !== "" && operatorProbe !== "1") throw new ConfigError(["HAIR_REALITY_OPERATOR_PROBE"]);
  return {
    ...parsed.data,
    providerMode: mode,
    youcamApiBaseUrl,
    providerDownloadHosts,
    youcamLiveSubmission: submission === "1",
    openaiLiveSubmission: openAISubmission === "1",
    operatorProbe: operatorProbe === "1",
    fixtureAuthPartition: partition === "1",
    demoLean: parsed.data.demoLean === "1",
  };
}

export function assertSupportedNode(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new ConfigError(["node"]);
  }
}

function readInput(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const assign = (key: string, value: string | undefined) => {
    const trimmed = blank(value);
    if (trimmed !== undefined) input[key] = trimmed;
  };
  assign("nodeEnv", env.NODE_ENV);
  assign("port", env.PORT);
  assign("appOrigin", env.APP_ORIGIN);
  assign("databaseUrl", env.DATABASE_URL);
  assign("testDatabaseUrl", env.TEST_DATABASE_URL);
  assign("sessionSecret", env.SESSION_SECRET);
  assign("privateStorageDir", env.PRIVATE_STORAGE_DIR);
  assign("providerMode", env.PROVIDER_MODE);
  assign("budgetPhase", env.BUDGET_PHASE);
  assign("youcamApiBaseUrl", env.YOUCAM_API_BASE_URL);
  assign("youcamApiKey", env.YOUCAM_API_KEY);
  assign("openaiApiKey", env.OPENAI_API_KEY);
  assign("openaiModel", env.OPENAI_MODEL);
  assign("openaiTimeoutMs", env.OPENAI_TIMEOUT_MS);
  assign("youcamDevCap", env.YOUCAM_DEV_CAP);
  assign("youcamDemoCap", env.YOUCAM_DEMO_CAP);
  assign("youcamTotalCap", env.YOUCAM_TOTAL_CAP);
  assign("youcamReserve", env.YOUCAM_RESERVE);
  assign("openaiBudgetUsd", env.OPENAI_BUDGET_USD);
  assign("assetRetentionDays", env.ASSET_RETENTION_DAYS);
  assign("demoSessionCap", env.DEMO_SESSION_CAP);
  assign("demoDailyCap", env.DEMO_DAILY_CAP);
  assign("demoJudgeSecret", env.DEMO_JUDGE_SECRET);
  assign("demoJudgeSessionCap", env.DEMO_JUDGE_SESSION_CAP);
  assign("demoJudgeDailyCap", env.DEMO_JUDGE_DAILY_CAP);
  assign("analysisMode", env.ANALYSIS_MODE);
  assign("demoLean", env.DEMO_LEAN);
  assign("demoSalonTimezone", env.DEMO_SALON_TIMEZONE);
  assign("deletionJournalMode", env.DELETION_JOURNAL_MODE);
  assign("deletionJournalDir", env.DELETION_JOURNAL_DIR);
  assign("backupHost", env.BACKUP_HOST);
  assign("backupPath", env.BACKUP_PATH);
  assign("deletionJournalPath", env.DELETION_JOURNAL_PATH);
  assign("trustProxy", env.TRUST_PROXY);
  assign("providerDownloadAllowlist", env.PROVIDER_DOWNLOAD_ALLOWLIST);
  assign("renderCacheDir", env.RENDER_CACHE_DIR);
  assign("renderJobTimeoutMs", env.RENDER_JOB_TIMEOUT_MS);
  return input;
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function issueFields(error: z.ZodError): string[] {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    const key = issue.path[0];
    fields.add(typeof key === "string" ? envName(key) : "config");
  }
  return [...fields];
}

function unsafeFields(config: EnvironmentInput): string[] {
  const fields: string[] = [];
  const production = config.nodeEnv === "production";

  if (config.sessionSecret === undefined) {
    if (production) fields.push("SESSION_SECRET");
  } else if (config.sessionSecret.length < 32 || (production && isPlaceholder(config.sessionSecret))) {
    fields.push("SESSION_SECRET");
  }

  if (!isPublicOrigin(config.appOrigin, production)) fields.push("APP_ORIGIN");
  if (!isTimeZone(config.demoSalonTimezone)) fields.push("DEMO_SALON_TIMEZONE");

  if (config.databaseUrl === undefined) {
    if (production) fields.push("DATABASE_URL");
  } else if (!isPostgresUrl(config.databaseUrl) || (production && hasPlaceholderPassword(config.databaseUrl))) {
    fields.push("DATABASE_URL");
  }

  if (config.testDatabaseUrl !== undefined) {
    if (!isPostgresUrl(config.testDatabaseUrl) || (production && hasPlaceholderPassword(config.testDatabaseUrl))) {
      fields.push("TEST_DATABASE_URL");
    } else if (config.databaseUrl !== undefined && config.testDatabaseUrl === config.databaseUrl) {
      fields.push("TEST_DATABASE_URL");
    }
  }

  if (production && !isAbsolute(config.privateStorageDir)) fields.push("PRIVATE_STORAGE_DIR");
  if (production && config.providerMode === undefined) fields.push("PROVIDER_MODE");
  if (production && config.deletionJournalMode === "local") fields.push("DELETION_JOURNAL_MODE");

  if (config.deletionJournalMode === "remote") {
    if (config.backupHost === undefined) fields.push("BACKUP_HOST");
    if (config.backupPath === undefined || !isAbsolute(config.backupPath)) fields.push("BACKUP_PATH");
    if (config.deletionJournalPath === undefined || !isAbsolute(config.deletionJournalPath)) {
      fields.push("DELETION_JOURNAL_PATH");
    }
  } else if (config.deletionJournalMode === "local" && !config.deletionJournalDir) {
    fields.push("DELETION_JOURNAL_DIR");
  }

  if (config.providerDownloadAllowlist !== undefined && downloadHosts(config.providerDownloadAllowlist) === null) {
    fields.push("PROVIDER_DOWNLOAD_ALLOWLIST");
  }

  const mode = config.providerMode ?? "fixture";
  if (mode === "live") {
    if (config.youcamApiKey === undefined || isPlaceholder(config.youcamApiKey)) fields.push("YOUCAM_API_KEY");
    if (config.openaiApiKey === undefined || isPlaceholder(config.openaiApiKey)) fields.push("OPENAI_API_KEY");
    if (config.youcamApiBaseUrl === undefined || !isHttpsUrl(config.youcamApiBaseUrl)) {
      fields.push("YOUCAM_API_BASE_URL");
    }
  } else if (config.youcamApiKey !== undefined && isPlaceholder(config.youcamApiKey)) {
    fields.push("YOUCAM_API_KEY");
  } else if (config.openaiApiKey !== undefined && isPlaceholder(config.openaiApiKey)) {
    fields.push("OPENAI_API_KEY");
  }

  return unique(fields);
}

function isPublicOrigin(value: string, production: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  if (url.search || url.hash) return false;
  if (production && url.protocol !== "https:") return false;
  return url.protocol === "http:" || url.protocol === "https:";
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}

function hasPlaceholderPassword(value: string): boolean {
  return value.includes("replace-with-local-password");
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_SECRETS.has(value.trim().toLowerCase());
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const ENV_NAMES: Record<string, string> = {
  nodeEnv: "NODE_ENV",
  port: "PORT",
  appOrigin: "APP_ORIGIN",
  databaseUrl: "DATABASE_URL",
  testDatabaseUrl: "TEST_DATABASE_URL",
  sessionSecret: "SESSION_SECRET",
  privateStorageDir: "PRIVATE_STORAGE_DIR",
  providerMode: "PROVIDER_MODE",
  budgetPhase: "BUDGET_PHASE",
  youcamApiBaseUrl: "YOUCAM_API_BASE_URL",
  youcamApiKey: "YOUCAM_API_KEY",
  openaiApiKey: "OPENAI_API_KEY",
  openaiModel: "OPENAI_MODEL",
  openaiTimeoutMs: "OPENAI_TIMEOUT_MS",
  youcamDevCap: "YOUCAM_DEV_CAP",
  youcamDemoCap: "YOUCAM_DEMO_CAP",
  youcamTotalCap: "YOUCAM_TOTAL_CAP",
  youcamReserve: "YOUCAM_RESERVE",
  openaiBudgetUsd: "OPENAI_BUDGET_USD",
  assetRetentionDays: "ASSET_RETENTION_DAYS",
  demoSessionCap: "DEMO_SESSION_CAP",
  demoDailyCap: "DEMO_DAILY_CAP",
  demoJudgeSecret: "DEMO_JUDGE_SECRET",
  demoJudgeSessionCap: "DEMO_JUDGE_SESSION_CAP",
  demoJudgeDailyCap: "DEMO_JUDGE_DAILY_CAP",
  analysisMode: "ANALYSIS_MODE",
  demoLean: "DEMO_LEAN",
  demoSalonTimezone: "DEMO_SALON_TIMEZONE",
  deletionJournalMode: "DELETION_JOURNAL_MODE",
  deletionJournalDir: "DELETION_JOURNAL_DIR",
  backupHost: "BACKUP_HOST",
  backupPath: "BACKUP_PATH",
  deletionJournalPath: "DELETION_JOURNAL_PATH",
  trustProxy: "TRUST_PROXY",
  providerDownloadAllowlist: "PROVIDER_DOWNLOAD_ALLOWLIST",
  renderCacheDir: "RENDER_CACHE_DIR",
  renderJobTimeoutMs: "RENDER_JOB_TIMEOUT_MS",
};

const DOWNLOAD_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function downloadHosts(value: string | undefined): readonly string[] | null {
  if (value === undefined || value.trim() === "") return [];
  const hosts = value.split(",").map((host) => host.trim().toLowerCase()).filter((host) => host !== "");
  if (hosts.length === 0 || hosts.some((host) => host.includes("*") || !DOWNLOAD_HOST.test(host))) return null;
  return hosts;
}

function envName(field: string): string {
  return ENV_NAMES[field] ?? field;
}
