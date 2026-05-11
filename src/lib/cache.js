const store = new Map();

export async function cached(key, ttlMs, fetchFn) {
  const entry = store.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.value;
  const value = await fetchFn();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}
