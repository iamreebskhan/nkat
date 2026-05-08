/**
 * Pure DOM-rendering helpers for the sidebar. Easier to unit-test than the
 * full bootstrap module because they take in-memory data + a target element.
 */
import type { ExtractedCode } from './code-extractor';
import type { Finding, LookupResponse } from './api-client';

export function todayIso(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function renderDetectedCodes(target: HTMLUListElement, codes: ExtractedCode[]): void {
  target.innerHTML = '';
  for (const c of codes) {
    const li = document.createElement('li');
    const codeSpan = document.createElement('strong');
    codeSpan.textContent = c.code;
    const ctx = document.createElement('span');
    ctx.textContent = ` — ${c.context}`;
    li.append(codeSpan, ctx);
    target.appendChild(li);
  }
}

export function renderFindings(target: HTMLOListElement, resp: LookupResponse): void {
  target.innerHTML = '';
  const all: Finding[] = [
    ...resp.cross_line_findings,
    ...resp.lines.flatMap((l) => l.findings),
  ];
  if (all.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No findings — claim looks clean.';
    target.appendChild(li);
    return;
  }
  // critical → warning → info → ok
  const order = { critical: 0, warning: 1, info: 2, ok: 3 } as const;
  all.sort((a, b) => order[a.severity] - order[b.severity]);
  for (const f of all) {
    target.appendChild(buildFindingLi(f));
  }
}

function buildFindingLi(f: Finding): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `finding ${f.severity}`;
  const head = document.createElement('header');
  const sev = document.createElement('strong');
  sev.textContent = `[${f.severity.toUpperCase()}] `;
  const carc = document.createElement('span');
  carc.textContent = `${f.carc_class} — ${f.title}`;
  head.append(sev, carc);
  li.appendChild(head);

  if (f.detail) {
    const p = document.createElement('p');
    p.textContent = f.detail;
    li.appendChild(p);
  }
  if (f.recommendation) {
    const reco = document.createElement('p');
    reco.innerHTML = '<em>Recommendation:</em> ';
    reco.appendChild(document.createTextNode(f.recommendation));
    li.appendChild(reco);
  }
  for (const c of f.citations ?? []) {
    if (!c.source_url) continue;
    const cite = document.createElement('cite');
    const a = document.createElement('a');
    a.href = c.source_url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = c.source_url;
    cite.appendChild(a);
    if (c.verbatim_quote) {
      cite.appendChild(document.createTextNode(` — "${c.verbatim_quote}"`));
    }
    li.appendChild(cite);
  }
  const conf = document.createElement('small');
  conf.textContent = `confidence ${(f.confidence ?? 0).toFixed(2)}`;
  li.appendChild(conf);
  return li;
}
