export function normalizeRecipients(values: string[]): { recipients: string[]; duplicates: number; invalid: number } {
  const seen = new Set<string>();
  let duplicates = 0;
  let invalid = 0;
  const recipients: string[] = [];
  for (const raw of values) {
    const email = raw.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      invalid++;
      continue;
    }
    if (seen.has(email)) {
      duplicates++;
      continue;
    }
    seen.add(email);
    recipients.push(email);
  }
  return { recipients, duplicates, invalid };
}
