/** 标准 base64（不是 base64url）——账号同步的密文/密钥都用它，与手机/桌面端一致。 */
export function b64FromBytes(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

export function bytesFromB64(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
