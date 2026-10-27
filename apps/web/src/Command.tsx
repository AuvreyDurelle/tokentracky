import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ProjectSummary } from '@tokentracky/core';
import type { ApiClient } from './api';
import { formatCompact } from './format';
import { Modal, SearchIcon } from './ui';

export interface Command { id: string; label: string; hint: string; run: () => void }

/** "Jump to…": pages, plus local projects in the app. Enter runs the top match; arrow keys move through results. */
export function CommandPalette({ api, local, pages, onProject, onClose }: { api: ApiClient; local: boolean; pages: Command[]; onProject: (path: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // The dialog opens in Modal's effect, which runs first; focus the search box once it is visible.
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (!local) return;
    let live = true;
    api.localProjects({ days: 90 }).then((value) => { if (live) setProjects(value.items); }).catch(() => {});
    return () => { live = false; };
  }, [api, local]);
  const run = (command: Command) => { onClose(); command.run(); };
  const text = query.trim().toLowerCase();
  const results = [
    ...pages,
    ...projects.map((project) => ({ id: `project:${project.name}`, label: project.name.split(/[\\/]/).filter(Boolean).at(-1) ?? project.name, hint: `Project · ${formatCompact(project.tokens)} tokens`, path: project.name, run: () => onProject(project.name) })),
  ].filter((item) => !text || `${item.label} ${'path' in item ? item.path : ''}`.toLowerCase().includes(text));
  const move = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...(list.current?.querySelectorAll('button') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
    if (next < 0) input.current?.focus(); else buttons[Math.min(next, buttons.length - 1)]?.focus();
  };
  return <Modal title="Jump to…" onClose={onClose}>
    <div className="command" onKeyDown={move}>
      <label className="search command-search"><SearchIcon /><span className="sr-only">Find a page or project</span>
        <input ref={input} className="input" type="search" placeholder="Find a page or project…" value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && results[0]) { event.preventDefault(); run(results[0]); } }} /></label>
      {results.length ? <ul ref={list} className="command-list">{results.map((item) => <li key={item.id}>
        <button type="button" onClick={() => run(item)}><span>{item.label}</span><small>{item.hint}</small></button>
      </li>)}</ul> : <p className="panel-empty">No matching pages or projects.</p>}
    </div>
  </Modal>;
}
