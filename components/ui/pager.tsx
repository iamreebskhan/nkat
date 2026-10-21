/**
 * "Showing a–b of N" with Previous / Next, for lists paged on the server.
 *
 * Audit R34: the superbill and denial screens fetched one page of 50 and
 * presented it as the whole list, and nothing could reach row 51. A list that
 * is paged has to say so, and has to let you turn the page.
 */
"use client";

export function Pager({
  page,
  pageSize,
  total,
  shown,
  onPage,
}: {
  /** Zero-based. */
  page: number;
  pageSize: number;
  /** Size of the whole filtered list, from the server. */
  total: number;
  /** Rows on this page. */
  shown: number;
  onPage: (page: number) => void;
}) {
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + shown;
  const last = Math.max(0, Math.ceil(total / pageSize) - 1);
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-slate-100 text-sm">
      <span className="text-slate-600 tabular">
        Showing {from}–{to} of {total}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 0}
          onClick={() => onPage(page - 1)}
          className="px-3 py-1 rounded text-xs bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40"
        >
          ← Previous
        </button>
        <button
          type="button"
          disabled={page >= last}
          onClick={() => onPage(page + 1)}
          className="px-3 py-1 rounded text-xs bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
