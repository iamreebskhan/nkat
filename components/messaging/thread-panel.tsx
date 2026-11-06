/**
 * ThreadPanel — Phase F patient-scoped messaging widget.
 *
 * Drops into a patient page. Lists messages, accepts new ones, exposes
 * the 5-minute edit window on the caller's own posts. @mentions are
 * parsed server-side at write-time (mentions.ts); typing "@" offers the
 * team by name (Level-1 doc:57), and a mention that reached someone is
 * shown bold.
 */
"use client";

import { Send } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { mentionQueryAt, suggestMentions, type Mentionable } from "@/lib/features/messaging/mentions";
import { usePracticeTime } from "@/lib/features/schedule/use-practice-zone";

interface Message {
  id: string;
  authorUserId: string;
  /** Null only for an author no longer on file. */
  authorName: string | null;
  body: string;
  mentionedUserIds: string[];
  editedAt: string | null;
  createdAt: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The body with each mention that reached someone in bold: "@" and the
 * name, email or first name of a member the server resolved.
 */
function withMentions(body: string, mentioned: string[], roster: Mentionable[]): ReactNode {
  const names = roster
    .filter((m) => mentioned.includes(m.userId))
    .flatMap((m) => [m.fullName, m.email, m.fullName?.trim().split(/\s+/)[0]])
    .filter((n): n is string => Boolean(n && n.trim()))
    .map((n) => escapeRe(n.trim()).replace(/\s+/g, "\\s+"))
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return body;
  const re = new RegExp(`(@(?:${names.join("|")}))(?![\\p{L}\\p{N}])`, "giu");
  return body.split(re).map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold text-emerald-800">
        {part}
      </strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

interface Props {
  patientId: string;
  /** Caller's user id — used to enable Edit on their own messages. */
  selfUserId: string;
}

// 5-minute edit window (mirrors EDIT_WINDOW_MS server-side).
const EDIT_WINDOW_MS = 5 * 60 * 1000;

export function ThreadPanel({ patientId, selfUserId }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  // Each message on the practice's clock, as the rest of the record.
  const atPractice = usePracticeTime();
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  // Who can be mentioned, for suggestions and for showing mentions bold.
  // Empty when the caller cannot send, which leaves both off.
  const [roster, setRoster] = useState<Mentionable[]>([]);
  // The open suggestion list: where its "@" starts and which row is picked.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [picked, setPicked] = useState(0);
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let abandoned = false;
    fetch("/api/messaging/members")
      .then((r) => r.json())
      .then((d) => {
        if (!abandoned && d.success) setRoster(d.data?.rows ?? []);
      })
      .catch(() => {
        /* no suggestions; typing a full name still mentions */
      });
    return () => {
      abandoned = true;
    };
  }, []);

  const suggestions = mention
    ? suggestMentions(mention.query, roster.filter((m) => m.userId !== selfUserId))
    : [];

  function track(text: string, caret: number) {
    setMention(mentionQueryAt(text, caret));
    setPicked(0);
  }

  function choose(m: Mentionable) {
    const el = composer.current;
    if (!mention || !el) return;
    const caret = el.selectionStart ?? body.length;
    const insert = `@${m.fullName?.trim() || m.email} `;
    const next = body.slice(0, mention.start) + insert + body.slice(caret);
    setBody(next);
    setMention(null);
    const at = mention.start + insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  }

  // The edit window's clock, held in state rather than read during render.
  // load() stamps it with each fetch, and the timer below moves it on when
  // the caller's next window closes, so an Edit link drops off on time.
  const [now, setNow] = useState(() => Date.now());
  function canEdit(m: Message): boolean {
    return (
      m.authorUserId === selfUserId &&
      now - new Date(m.createdAt).getTime() < EDIT_WINDOW_MS
    );
  }

  useEffect(() => {
    const closes = messages
      .filter((m) => m.authorUserId === selfUserId)
      .map((m) => new Date(m.createdAt).getTime() + EDIT_WINDOW_MS)
      .filter((t) => t > now);
    if (closes.length === 0) return;
    // Capped at one window. That never binds for a post made in the past,
    // but a far-future createdAt would overflow setTimeout, fire at once,
    // and loop.
    const wait = Math.min(Math.min(...closes) - Date.now(), EDIT_WINDOW_MS);
    const t = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(t);
  }, [messages, now, selfUserId]);

  async function saveEdit(id: string) {
    if (editBody.trim().length === 0) return;
    const r = await fetch(`/api/messages/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: editBody.trim() }),
    });
    const data = await r.json();
    if (data.success) {
      setEditingId(null);
      setEditBody("");
      load();
    } else {
      setError(data.error ?? "Edit failed.");
    }
  }

  // Save's handler, bound here rather than as a closure inside messages.map
  // below: the compiler treats a handler made there as possibly called
  // during render, and flags the clock read in load(). Save only renders on
  // the message being edited, so editingId is that message's id.
  function saveCurrentEdit() {
    if (editingId) saveEdit(editingId);
  }

  async function load() {
    setLoading(true);
    const r = await fetch(`/api/patients/${patientId}/messages`);
    const data = await r.json();
    setNow(Date.now());
    if (data.success) setMessages(data.data.messages);
    else setError(data.error ?? "Failed to load.");
    setLoading(false);
  }

  useEffect(() => {
    // Started from a timer rather than synchronously in the effect body:
    // load() sets loading first, which would cascade a second render.
    const t = setTimeout(() => load(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  async function send() {
    if (body.trim().length === 0) return;
    setSending(true);
    const r = await fetch(`/api/patients/${patientId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: body.trim() }),
    });
    const data = await r.json();
    setSending(false);
    if (data.success) {
      setBody("");
      load();
    } else {
      setError(data.error ?? "Send failed.");
    }
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white flex flex-col h-96">
      <header className="px-3 py-2 text-xs font-medium text-slate-500 border-b border-slate-100">
        Team messages about this patient
      </header>
      <ol className="flex-1 overflow-y-auto px-3 py-2 space-y-2 text-sm">
        {loading && <li className="text-slate-400 text-xs">Loading…</li>}
        {error && <li className="text-red-700 text-xs">{error}</li>}
        {!loading && messages.length === 0 && (
          <li className="text-slate-400 text-xs">No messages yet. Start the conversation.</li>
        )}
        {messages.map((m) => (
          <li
            key={m.id}
            className={
              m.authorUserId === selfUserId
                ? "bg-emerald-50/40 px-2 py-1.5 rounded"
                : "bg-slate-50/40 px-2 py-1.5 rounded"
            }
          >
            <div className="text-[11px] text-slate-500 tabular flex items-center justify-between">
              <span>
                {m.authorUserId === selfUserId ? "You" : (m.authorName ?? "Former team member")}
              </span>
              <span className="flex items-center gap-2">
                {atPractice(m.createdAt)}
                {m.editedAt && <span className="italic">(edited)</span>}
                {editingId !== m.id && canEdit(m) && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(m.id);
                      setEditBody(m.body);
                    }}
                    className="text-emerald-700 hover:underline"
                  >
                    edit
                  </button>
                )}
              </span>
            </div>
            {editingId === m.id ? (
              <div className="mt-1 space-y-1">
                <textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={2}
                  maxLength={5000}
                  className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveCurrentEdit} disabled={!editBody.trim()}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(null);
                      setEditBody("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <p className="whitespace-pre-wrap text-slate-800">
                {withMentions(m.body, m.mentionedUserIds, roster)}
              </p>
            )}
          </li>
        ))}
      </ol>
      <div className="relative border-t border-slate-100 p-2 flex gap-2">
        {suggestions.length > 0 && (
          <ul
            id="mention-suggestions"
            role="listbox"
            aria-label="Mention a team member"
            className="absolute bottom-full left-2 mb-1 w-72 max-w-[calc(100%-1rem)] rounded-md border border-slate-200 bg-white py-1 shadow-lg z-10"
          >
            {suggestions.map((m, i) => (
              <li
                key={m.userId}
                role="option"
                aria-selected={i === picked}
                // mousedown, not click: a click would blur the composer first
                // and lose the caret the mention is inserted at.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(m);
                }}
                className={`px-3 py-1.5 text-sm cursor-pointer ${i === picked ? "bg-emerald-50 text-emerald-900" : "text-slate-700 hover:bg-slate-50"}`}
              >
                {m.fullName?.trim() || m.email}
                {m.fullName?.trim() && <span className="ml-2 text-xs text-slate-400">{m.email}</span>}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={composer}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            track(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onClick={(e) => track(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
          onBlur={() => setMention(null)}
          onKeyDown={(e) => {
            if (suggestions.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setPicked((p) => (p + step + suggestions.length) % suggestions.length);
                return;
              }
              if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
                e.preventDefault();
                choose(suggestions[picked] ?? suggestions[0]!);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message the team… (type @ to mention someone)"
          aria-label="Message the team"
          aria-controls={suggestions.length > 0 ? "mention-suggestions" : undefined}
          rows={2}
          maxLength={5000}
          className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
        />
        {/* Icon-only, so it needs a name of its own: with just the glyph a
            screen reader announces "button" and nothing else, which is the
            one control in this panel that actually sends. aria-hidden on the
            icon stops the name being read twice. */}
        <Button
          size="sm"
          onClick={send}
          loading={sending}
          disabled={!body.trim()}
          aria-label="Send message"
          title="Send message"
        >
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
