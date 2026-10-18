const encoder = new TextEncoder();
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
async function encryptionKey(secret: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  } catch {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    );
  }
  if (bytes.length !== 32)
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    );
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes).buffer,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function encryptSecret(
  value: unknown,
  secret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode("organizer:calendar:v1"),
      },
      await encryptionKey(secret),
      encoder.encode(JSON.stringify(value)),
    ),
  );
  return `v1.${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...encrypted))}`;
}
export async function decryptSecret<T>(
  value: string,
  secret: string,
): Promise<T> {
  const [version, iv, body] = value.split(".");
  if (version !== "v1" || !iv || !body)
    throw new Error("Invalid encrypted credentials.");
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Uint8Array.from(atob(iv), (c) => c.charCodeAt(0)),
      additionalData: encoder.encode("organizer:calendar:v1"),
    },
    await encryptionKey(secret),
    Uint8Array.from(atob(body), (c) => c.charCodeAt(0)),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
