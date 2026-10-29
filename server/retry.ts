// Retries with exponential backoff before giving up.
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 400): Promise<{ value?: T; error?: Error; tries: number }> {
  let lastError: Error | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      return { value: await fn(), tries: i + 1 };
    } catch (e) {
      lastError = e as Error;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  return { error: lastError, tries: attempts };
}
