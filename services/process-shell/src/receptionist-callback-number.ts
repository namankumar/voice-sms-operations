export function callbackNumberReadbackQuestion(value: string | null | undefined, name?: string | null): string {
  const named = typeof name === "string" && name.trim().length > 0 ? `I have your name as ${name.trim()}. ` : "";
  if (value === null || value === undefined || !/^\+[1-9]\d{7,14}$/.test(value)) return `${named}What number should the team call back?`;
  return `${named}Is plus ${value.slice(1).split("").join(" ")} the best number to call you back?`;
}


/** Identifies the structure of a callback confirmation without trusting its name or number. */
export function callbackNumberReadbackCandidate(transcript: string): boolean {
  const normalized = transcript.normalize("NFKC").toLowerCase().replace(/[’]/g, "'");
  const marker = /\b(?:best number to call(?: you)? back|callback number)\b/.exec(normalized);
  if (marker === null) return false;
  const beforeMarker = normalized.slice(0, marker.index);
  return /\bname\s+as\s+\S/.test(beforeMarker)
    || /\bis\s+(?:plus\s+)?(?:\d|zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/.test(beforeMarker);
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

function readbackName(transcript: string): { name: string; numberStart: number } | null {
  const normalized = transcript.normalize("NFKC").toLowerCase().replace(/[’]/g, "'");
  const match = /\bname\s+as\s+(.+?)(?:[.!?]|,\s*(?=(?:is\s+)?(?:plus|\d))|\s+is\s+(?=(?:plus|\d)))/.exec(normalized);
  return match === null ? null : { name: normalizedName(match[1]!), numberStart: match.index + match[0].length };
}

/** Matches a callback-number readback by its trusted name, number, and confirmation intent—not arbitrary prose. */
export function callbackNumberReadbackMatches(transcript: string, value: string | null | undefined, name: string | null | undefined): boolean {
  if (typeof value !== "string" || !/^\+[1-9]\d{7,14}$/.test(value) || typeof name !== "string" || name.trim() === "" || !callbackNumberReadbackCandidate(transcript)) return false;
  const parsedName = readbackName(transcript);
  if (parsedName === null || parsedName.name !== normalizedName(name)) return false;
  const normalized = transcript.normalize("NFKC").toLowerCase().replace(/[’]/g, "'");
  const marker = /\b(?:best number to call(?: you)? back|callback number)\b/.exec(normalized);
  if (marker === null || marker.index < parsedName.numberStart) return false;
  const numberSpan = normalized.slice(parsedName.numberStart, marker.index);
  const words: Readonly<Record<string, string>> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
  const digits = numberSpan.replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (_match, word: string) => words[word]!)
    .replace(/[^\d]/g, "");
  return digits === value.slice(1) || value.startsWith("+1") && digits.length === 10 && `1${digits}` === value.slice(1);
}
