export function verifyToken(tok: string): boolean {
  return tok.trim().length >= 24;
}
