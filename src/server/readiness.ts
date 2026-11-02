import pg from "pg";

export async function databaseIsAccessible(databaseUrl: string | undefined): Promise<boolean> {
  if (!databaseUrl) return false;
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch (error) {
    const code = errorCode(error);
    console.error(`database_unavailable ${code}`);
    return false;
  } finally {
    try {
      await client.end();
    } catch (error) {
      console.error(`database_client_close_failed ${errorCode(error)}`);
    }
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "unavailable";
}
