import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertTestDatabase,
  DatabaseUrlError,
  databaseIdentity,
  isSameDatabase,
  TestDatabaseGuardError,
} from "../../src/server/db/database-identity.js";
import { hashPassword, verifyPassword } from "../../src/server/db/passwords.js";
import { seed } from "../../src/server/db/seed.js";

const application = "postgres://hair_reality:replace-with-local-password@127.0.0.1:5432/hair_reality";

test("database identity treats loopback aliases and cosmetic URL differences as one database", () => {
  const equivalent = [
    "postgresql://other:different@localhost/Hair_Reality",
    "postgres://hair_reality:replace-with-local-password@[::1]/hair_reality?sslmode=disable",
    "postgres://hair_reality:replace-with-local-password@127.0.0.1:5432/hair_reality",
  ];
  for (const candidate of equivalent) {
    assert.equal(isSameDatabase(application, candidate), true);
    assert.throws(() => assertTestDatabase(application, candidate), TestDatabaseGuardError);
  }
  const identity = databaseIdentity(application);
  assert.deepEqual(identity, { host: "loopback", port: 5432, database: "hair_reality" });
  assert.equal(isSameDatabase(application, "postgres://hair_reality:x@127.0.0.1:5433/hair_reality"), false);
  assert.equal(isSameDatabase(application, "postgres://hair_reality:pw@127.0.0.1:1/hair_reality?port=5432"), true);
  assert.equal(isSameDatabase(application, "postgres://hair_reality:pw@203.0.113.10:5432/hair_reality?host=localhost&port=1&port=5432"), true);
  assert.equal(isSameDatabase(application, "postgres://hair_reality:pw@127.0.0.1:5432/hair_reality?host=evil.example&host="), true);
  assert.equal(isSameDatabase(application, "postgres://hair_reality:pw@127.0.0.1:5432/hair_reality?port=1&port="), true);
  assert.throws(() => assertTestDatabase(application, "postgres://hair_reality:pw@127.0.0.1:5432/hair_reality?host=evil.example&host="), TestDatabaseGuardError);
  assert.throws(() => assertTestDatabase(application, "postgres://hair_reality:pw@127.0.0.1:1/hair_reality?port=5432"), TestDatabaseGuardError);
  assert.equal(isSameDatabase(application, "postgres://hair_reality:pw@127.0.0.1:5432/hair_reality_test?port=5432"), false);
  assert.doesNotThrow(() => assertTestDatabase(
    application,
    "postgres://hair_reality:replace-with-local-password@127.0.0.1:5432/hair_reality_test",
  ));
});

test("an unusable database URL cannot bypass the reset guard", () => {
  assert.throws(() => databaseIdentity("mysql://localhost/hair_reality"), DatabaseUrlError);
  assert.throws(() => databaseIdentity("not a url"), DatabaseUrlError);
  assert.throws(() => assertTestDatabase(application, "not a url"), TestDatabaseGuardError);
  assert.throws(() => assertTestDatabase("not a url", application), TestDatabaseGuardError);
});

test("passwords are Argon2id and short secrets are rejected", async () => {
  const password = "local-test-password-value";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.equal(first.startsWith("$argon2id$"), true);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("another-local-test-password", first), false);
  assert.equal(await verifyPassword(password, "$2b$not-argon2id"), false);
  await assert.rejects(() => hashPassword("short"), /minimum length/);
});

test("production seed is refused before a connection", async () => {
  await assert.rejects(() => seed({
    connectionString: application,
    nodeEnv: "production",
    credentialsFile: null,
  }), /production/);
});
