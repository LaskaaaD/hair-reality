import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../../src/server/config.js";

const sessionSecret = "unit-test-session-secret-value-0123456789";

test("the copied development example starts without a real database password", () => {
  const config = loadConfig({
    NODE_ENV: "development",
    PORT: "3000",
    APP_ORIGIN: "http://localhost:3000",
    DATABASE_URL: "postgres://hair_reality:replace-with-local-password@127.0.0.1:5432/hair_reality",
    TEST_DATABASE_URL: "postgres://hair_reality:replace-with-local-password@127.0.0.1:5432/hair_reality_test",
    SESSION_SECRET: "replace-with-a-random-session-secret",
    PRIVATE_STORAGE_DIR: "var/private",
    PROVIDER_MODE: "fixture",
    DELETION_JOURNAL_MODE: "local",
  });
  assert.equal(config.providerMode, "fixture");
  assert.equal(config.port, 3000);
  assert.equal(config.appOrigin, "http://localhost:3000");
});

test("fixture mode starts without provider credentials or a database", () => {
  const config = loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "fixture",
    HAIR_REALITY_SKIP_ENV_FILE: "1",
  });
  assert.equal(config.providerMode, "fixture");
  assert.equal(config.databaseUrl, undefined);
  assert.equal(config.youcamApiKey, undefined);
  assert.equal(config.openaiApiKey, undefined);
  assert.equal(config.port, 3000);
  assert.equal(config.appOrigin, "http://localhost:3000");
  assert.equal(config.youcamDevCap, 500);
  assert.equal(config.youcamDemoCap, 300);
  assert.equal(config.youcamTotalCap, 800);
  assert.equal(config.youcamReserve, 200);
  assert.equal(config.fixtureAuthPartition, false);
  assert.equal(config.openaiBudgetUsd, 5);
});

test("production rejects placeholder secrets, http origins and a local deletion journal", () => {
  const error = configError(() => loadConfig({
    NODE_ENV: "production",
    PORT: "3000",
    APP_ORIGIN: "http://localhost:3000",
    SESSION_SECRET: "replace-with-a-random-session-secret",
    DATABASE_URL: "postgres://hair_reality:replace-with-local-password@127.0.0.1:5432/hair_reality",
    PRIVATE_STORAGE_DIR: "var/private",
    PROVIDER_MODE: "fixture",
    DELETION_JOURNAL_MODE: "local",
  }));
  assert.equal(error.message.includes("replace-with-a-random-session-secret"), false);
  assert.equal(error.message.includes("replace-with-local-password"), false);
  for (const field of ["SESSION_SECRET", "APP_ORIGIN", "DATABASE_URL", "PRIVATE_STORAGE_DIR", "DELETION_JOURNAL_MODE"]) {
    assert.ok(error.fields.includes(field), field);
  }
});

test("production fixture mode accepts an explicit safe configuration without provider keys", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    PORT: "443",
    APP_ORIGIN: "https://salon.example",
    SESSION_SECRET: sessionSecret,
    DATABASE_URL: "postgres://hair_reality:unit-test@127.0.0.1:5432/hair_reality",
    TEST_DATABASE_URL: "postgres://hair_reality:unit-test@127.0.0.1:5432/hair_reality_test",
    PRIVATE_STORAGE_DIR: resolve("var", "private"),
    PROVIDER_MODE: "fixture",
    DELETION_JOURNAL_MODE: "remote",
    BACKUP_HOST: "backup.example",
    BACKUP_PATH: resolve("var", "backups"),
    DELETION_JOURNAL_PATH: resolve("var", "backups", "journal"),
  });
  assert.equal(config.providerMode, "fixture");
  assert.equal(config.youcamApiKey, undefined);
  assert.equal(config.openaiApiKey, undefined);
});

test("live mode requires provider credentials and refuses a raised budget ceiling", () => {
  const missingKeys = configError(() => loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "live",
  }));
  assert.ok(missingKeys.fields.includes("YOUCAM_API_KEY"));
  assert.ok(missingKeys.fields.includes("OPENAI_API_KEY"));
  assert.equal(missingKeys.fields.includes("YOUCAM_API_BASE_URL"), false);

  const raisedBudget = configError(() => loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "fixture",
    YOUCAM_TOTAL_CAP: "801",
    OPENAI_BUDGET_USD: "10",
  }));
  assert.ok(raisedBudget.fields.includes("YOUCAM_TOTAL_CAP"));
  assert.ok(raisedBudget.fields.includes("OPENAI_BUDGET_USD"));
});

test("the test database cannot reuse the application database URL", () => {
  const databaseUrl = "postgres://hair_reality:unit-test@127.0.0.1:5432/hair_reality";
  const error = configError(() => loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
  }));
  assert.ok(error.fields.includes("TEST_DATABASE_URL"));
  assert.equal(error.message.includes(databaseUrl), false);
});

test("fixture auth partitioning stays off outside the fixture server", () => {
  const enabled = loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "fixture",
    HAIR_REALITY_FIXTURE_AUTH_PARTITION: "1",
  });
  assert.equal(enabled.fixtureAuthPartition, true);
  const production = configError(() => loadConfig({
    NODE_ENV: "production",
    PORT: "443",
    APP_ORIGIN: "https://salon.example",
    SESSION_SECRET: sessionSecret,
    DATABASE_URL: "postgres://hair_reality:unit-test@127.0.0.1:5432/hair_reality",
    PRIVATE_STORAGE_DIR: resolve("var/private"),
    PROVIDER_MODE: "fixture",
    DELETION_JOURNAL_MODE: "remote",
    BACKUP_HOST: "backup.example",
    BACKUP_PATH: resolve("var/backup"),
    DELETION_JOURNAL_PATH: resolve("var/journal"),
    HAIR_REALITY_FIXTURE_AUTH_PARTITION: "1",
  }));
  assert.ok(production.fields.includes("HAIR_REALITY_FIXTURE_AUTH_PARTITION"));
  const live = configError(() => loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "live",
    YOUCAM_API_KEY: "synthetic-youcam-key",
    OPENAI_API_KEY: "synthetic-openai-key",
    YOUCAM_API_BASE_URL: "https://api.synthetic.youcam.invalid",
    HAIR_REALITY_FIXTURE_AUTH_PARTITION: "1",
  }));
  assert.ok(live.fields.includes("HAIR_REALITY_FIXTURE_AUTH_PARTITION"));
});

function configError(load: () => void): ConfigError {
  try {
    load();
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error;
  }
  assert.fail("expected ConfigError");
}

test("production accepts no deletion journal for the demo and then fails closed", async () => {
  const config = loadConfig({
    NODE_ENV: "production",
    PORT: "3000",
    APP_ORIGIN: "https://salon.example",
    SESSION_SECRET: sessionSecret,
    DATABASE_URL: "postgres://hair_reality:unit-test@db:5432/hair_reality",
    PRIVATE_STORAGE_DIR: resolve("var", "private"),
    PROVIDER_MODE: "fixture",
    DELETION_JOURNAL_MODE: "none",
  });
  const { createDeletionJournal, JournalUnavailableError } = await import("../../src/server/assets/journal.js");
  await assert.rejects(
    createDeletionJournal(config).append({ operationId: "op", resourceId: "r", scope: "asset", timestamp: new Date().toISOString() }),
    JournalUnavailableError,
  );
});
