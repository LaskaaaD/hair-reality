import { hash, verify } from "@node-rs/argon2";

const options = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error("Password does not meet the minimum length");
  return hash(password, options);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  if (!passwordHash.startsWith("$argon2id$")) return false;
  return verify(passwordHash, password);
}
