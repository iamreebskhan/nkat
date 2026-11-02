/**
 * Who a team message @mentions (Level-1 doc:57).
 *
 * The parser took "@" and one run of non-space characters, so "@Helen Okafor"
 * looked up a member named "Helen", found none, and nobody was told: only an
 * email address could mention anyone. Names are matched against the org's
 * active roster instead: a member's full name, their email, or their first
 * name where only one member has it. Case and spacing do not matter, the
 * longest match wins ("@Ann Lee" over "@Ann"), and a name must end where a
 * word ends, so "@Annabel" is not Ann. Pure, so the composer's suggestions
 * and the server agree on what counts.
 */

export interface Mentionable {
  userId: string;
  fullName: string | null;
  email: string;
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const firstName = (m: Mentionable) => (m.fullName ? normalize(m.fullName).split(" ")[0] ?? "" : "");
const WORD = /[\p{L}\p{N}]/u;
/** Characters an email address is made of: an "@" after one is inside an address. */
const ADDRESS = /[\p{L}\p{N}._%+-]/u;

/** The user ids a message mentions, each once, in no particular order. */
export function findMentions(body: string, roster: readonly Mentionable[]): string[] {
  const firstNames = new Map<string, number>();
  for (const m of roster) {
    const f = firstName(m);
    if (f) firstNames.set(f, (firstNames.get(f) ?? 0) + 1);
  }
  const keys: { key: string; userId: string }[] = [];
  for (const m of roster) {
    if (m.fullName && normalize(m.fullName)) keys.push({ key: normalize(m.fullName), userId: m.userId });
    if (m.email) keys.push({ key: normalize(m.email), userId: m.userId });
    const f = firstName(m);
    if (f && firstNames.get(f) === 1) keys.push({ key: f, userId: m.userId });
  }
  keys.sort((a, b) => b.key.length - a.key.length);

  const text = normalize(body);
  const found = new Set<string>();
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at > 0 && ADDRESS.test(text.charAt(at - 1))) continue;
    const rest = text.slice(at + 1);
    const hit = keys.find((k) => rest.startsWith(k.key) && !WORD.test(rest.charAt(k.key.length)));
    if (hit) found.add(hit.userId);
  }
  return [...found];
}

/**
 * The "@" word the caret is in, for the composer's suggestions: what follows
 * the last "@" before the caret, if it starts a mention and has no line
 * break. null when the caret is not in one.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && ADDRESS.test(before.charAt(at - 1))) return null;
  const query = before.slice(at + 1);
  // A name is at most a few words; a long run past the @ is ordinary text.
  if (/[\n@]/.test(query) || query.length > 40 || query.split(" ").length > 3) return null;
  return { start: at, query };
}

/** Members whose name or email starts with the query, or has a word that does. */
export function suggestMentions(query: string, roster: readonly Mentionable[], limit = 6): Mentionable[] {
  const q = normalize(query);
  return roster
    .filter((m) => {
      if (!q) return true;
      const name = m.fullName ? normalize(m.fullName) : "";
      return name.startsWith(q) || name.split(" ").some((w) => w.startsWith(q)) || normalize(m.email).startsWith(q);
    })
    .slice(0, limit);
}
