/**
 * ThreadPanel — Phase F patient-scoped messaging widget.
 *
 * Drops into a patient page. Lists messages, accepts new ones, exposes
 * the 5-minute edit window on the caller's own posts. @mentions are
 * parsed server-side at write-time; this UI just renders them as bold.
 */
"use client";

import { Send } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

interface Message {
  id: string;
  authorUserId: string;
  body: string;
  mentionedUserIds: string[];
  editedAt: string | null;
  createdAt: string;
}

interface Props {
  patientId: string;
  /** Caller's user id — used to enable Edit on their own messages. */
  selfUserId: string;
}

export function ThreadPanel({ patientId, selfUserId }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");

  // 5-minute edit window (mirrors EDIT_WINDOW_MS server-side).
  const EDIT_WINDOW_MS = 5 * 60 * 1000;
  function canEdit(m: Message): boolean {
    return (
      m.authorUserId === selfUserId &&
      Date.now() - new Date(m.createdAt).getTime() < EDIT_WINDOW_MS
    );
  }

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

  async function load() {
    setLoading(true);
    const r = await fetch(`/api/patients/${patientId}/messages`);
    const data = await r.json();
    if (data.success) setMessages(data.data.messages);
    else setError(data.error ?? "Failed to load.");
    setLoading(false);
  }

  useEffect(() => {
    load();
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
                {m.authorUserId === selfUserId ? "You" : m.authorUserId.slice(0, 8)}
              </span>
              <span className="flex items-center gap-2">
                {new Date(m.createdAt).toLocaleString()}
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
                  <Button size="sm" onClick={() => saveEdit(m.id)} disabled={!editBody.trim()}>
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
              <p className="whitespace-pre-wrap text-slate-800">{m.body}</p>
            )}
          </li>
        ))}
      </ol>
      <div className="border-t border-slate-100 p-2 flex gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message the team… (use @name to mention)"
          rows={2}
          maxLength={5000}
          className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
        />
        <Button size="sm" onClick={send} loading={sending} disabled={!body.trim()}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
