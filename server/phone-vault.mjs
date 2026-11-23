const encoder = new TextEncoder();

function unbase64(value) {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function vaultKey(env) {
  const value = env.TALA_APPLICATION_KEY;
  if (typeof value !== "string" || !/^[\w-]{43}$/.test(value)) return null;
  return crypto.subtle.importKey("raw", unbase64(value), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealPhone(key, phone, reference) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(reference) }, key, encoder.encode(phone));
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(encrypted)));
}

export async function openPhone(key, ciphertext, reference) {
  const bytes = unbase64(ciphertext);
  const phone = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(reference) }, key, bytes.slice(12));
  return new TextDecoder().decode(phone);
}
