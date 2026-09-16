'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/primitives';

export type Note = {
  id: string;
  ruleTag: string;
  originalUtterance: string;
  originalSpanText: string;
  suggestedUtterance: string | null;
  suggestedSpanText: string | null;
  explanationShort: string;
  severity: string;
  userFeedback: string | null;
  repeatCount?: number;
};

/**
 * The Notes rail — UX.md §1.
 *
 * Silent, non-interrupting, collapsible. Cards animate in ONLY while the coach is speaking
 * (`canAnimate`), never while the user is speaking or during the pause after their turn. A card
 * that appears mid-utterance breaks the sentence the user is building.
 *
 * Corrections are neutral-toned, never error-coloured. This is a conversation, not a linter.
 */
export function NotesRail({
  notes,
  canAnimate,
  onDispute,
  className,
}: {
  notes: Note[];
  canAnimate: boolean;
  onDispute: (id: string) => void;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        'flex flex-col border-l border-[var(--color-line)] bg-[var(--color-surface)]',
        collapsed ? 'w-14' : 'w-full lg:w-80',
        className,
      )}
      aria-label="Notes"
    >
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-3 text-left"
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <span className="mx-auto text-xs text-[var(--color-muted)]">{notes.length}</span>
        ) : (
          <>
            <span className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
              Notes
            </span>
            <span className="rounded-full bg-[var(--color-raised)] px-2 py-0.5 text-xs text-[var(--color-muted)] tabular-nums">
              {notes.length}
            </span>
          </>
        )}
      </button>

      {!collapsed && (
        <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
          {notes.length === 0 ? (
            <p className="px-1 py-6 text-xs leading-relaxed text-[var(--color-dim)]">
              Anything worth noticing will appear here quietly while we talk. You can ignore it
              completely and read it at the end.
            </p>
          ) : (
            <ul className="space-y-2">
              {notes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  animate={canAnimate}
                  onDispute={() => onDispute(note.id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}

function NoteCard({
  note,
  animate,
  onDispute,
}: {
  note: Note;
  animate: boolean;
  onDispute: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const disputed = note.userFeedback === 'disagreed';

  return (
    <li
      className={cn(
        'rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] p-3',
        animate && 'animate-card-in',
        disputed && 'opacity-45',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-[var(--color-dim)]">You said</div>
          <div className="truncate text-sm text-[var(--color-muted)] line-through decoration-[var(--color-dim)]">
            {note.originalSpanText}
          </div>

          <div className="mt-2 text-xs text-[var(--color-dim)]">Better</div>
          <div className="text-sm font-medium text-[var(--color-accent)]">
            {note.suggestedSpanText ?? note.suggestedUtterance ?? '—'}
          </div>
        </div>

        {note.repeatCount && note.repeatCount > 1 && (
          <span className="shrink-0 rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-xs tabular-nums text-[var(--color-dim)]">
            ×{note.repeatCount}
          </span>
        )}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-[var(--color-muted)]">
        {note.explanationShort}
      </p>

      {expanded && (
        <p className="mt-2 border-t border-[var(--color-line)] pt-2 text-xs text-[var(--color-dim)]">
          In full: “{note.originalUtterance}” →{' '}
          {note.suggestedUtterance ? `“${note.suggestedUtterance}”` : '—'}
        </p>
      )}

      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="text-xs text-[var(--color-dim)] hover:text-[var(--color-muted)]"
        >
          {expanded ? 'Less' : 'Full sentence'}
        </button>
        {/*
          The dispute affordance. One tap, and it feeds the suppression list, the frustration
          brake, and our precision metric. A product that cannot be told it is wrong loses trust
          silently rather than loudly (UX.md §2).
        */}
        {!disputed ? (
          <button
            onClick={onDispute}
            className="ml-auto text-xs text-[var(--color-dim)] hover:text-[var(--color-warm)]"
          >
            This is wrong
          </button>
        ) : (
          <span className="ml-auto text-xs text-[var(--color-dim)]">Noted — thanks</span>
        )}
      </div>
    </li>
  );
}

export function SayItBetterPanel({
  result,
  loading,
  onExpand,
  onClose,
}: {
  result: {
    originalText: string;
    variants: Array<{ register: string; text: string; why: string }>;
    canExpand: boolean;
  } | null;
  loading: boolean;
  onExpand: () => void;
  onClose: () => void;
}) {
  if (!loading && !result) return null;

  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] p-4">
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
          Say it better
        </span>
        <button onClick={onClose} className="text-xs text-[var(--color-dim)] hover:text-[var(--color-text)]">
          Close
        </button>
      </div>

      {loading || !result ? (
        <p className="mt-3 text-sm text-[var(--color-dim)]">Thinking about it…</p>
      ) : (
        <>
          <div className="mt-3">
            <div className="text-xs text-[var(--color-dim)]">You said</div>
            <p className="text-sm text-[var(--color-muted)]">{result.originalText}</p>
          </div>

          {result.variants.map((variant) => (
            <div key={variant.register} className="mt-3">
              <div className="text-xs text-[var(--color-dim)] capitalize">{variant.register}</div>
              <p className="text-sm text-[var(--color-text)]">{variant.text}</p>
              <p className="mt-0.5 text-xs text-[var(--color-dim)]">{variant.why}</p>
            </div>
          ))}

          {result.canExpand && (
            <Button variant="subtle" size="sm" className="mt-3 px-0" onClick={onExpand}>
              + Show professional / persuasive
            </Button>
          )}
        </>
      )}
    </div>
  );
}
