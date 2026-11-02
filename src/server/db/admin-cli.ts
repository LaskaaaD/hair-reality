import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadLocalEnv } from "../config.js";
import { AccountAdminError, grantSalonMembership, resetAccountPassword } from "./admin.js";

const credentialsFile = path.resolve("var", "password-resets.txt");

async function main(): Promise<void> {
  loadLocalEnv();
  const config = loadConfig();
  if (!config.databaseUrl) throw new AccountAdminError("DATABASE_URL is required.");
  const [command, ...args] = process.argv.slice(2);
  if (command === "reset-password") {
    const email = args[0];
    if (!email) throw new AccountAdminError("Usage: npm run admin:reset-password -- user@example.com");
    const result = await resetAccountPassword({
      connectionString: config.databaseUrl,
      email,
      credentialsFile,
    });
    console.log(`Password reset for ${result.email}. The new credential was appended to var/password-resets.txt. Existing sessions were invalidated.`);
    return;
  }
  if (command === "grant-membership") {
    const [email, salonSlug, role] = args;
    if (!email || !salonSlug || (role !== "stylist" && role !== "admin")) {
      throw new AccountAdminError("Usage: npm run admin:grant-membership -- user@example.com salon-slug stylist|admin");
    }
    const result = await grantSalonMembership({
      connectionString: config.databaseUrl,
      email,
      salonSlug,
      role,
    });
    console.log(result.created
      ? `Granted ${role} membership at ${salonSlug}.`
      : `Membership at ${salonSlug} already existed.`);
    return;
  }
  throw new AccountAdminError("Usage: reset-password or grant-membership.");
}

const isDirect = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error: unknown) => {
    console.error(error instanceof AccountAdminError ? error.message : "Account administration failed.");
    process.exitCode = 1;
  });
}
