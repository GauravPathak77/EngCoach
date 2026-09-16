'use client';

import { cn } from '@/lib/cn';

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'subtle' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
        'disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' && 'px-3 py-1.5 text-sm',
        size === 'md' && 'px-4 py-2 text-sm',
        size === 'lg' && 'px-6 py-3 text-base',
        variant === 'primary' &&
          'bg-[var(--color-accent)] text-[var(--color-ink)] hover:brightness-110',
        variant === 'ghost' &&
          'border border-[var(--color-line)] text-[var(--color-text)] hover:bg-[var(--color-raised)]',
        variant === 'subtle' && 'text-[var(--color-muted)] hover:text-[var(--color-text)]',
        variant === 'danger' && 'border border-[#5c2a2a] text-[#e08c8c] hover:bg-[#2a1616]',
        className,
      )}
      {...props}
    />
  );
}

export function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] px-3 py-2 text-sm',
        'text-[var(--color-text)] placeholder:text-[var(--color-dim)]',
        'focus:border-[var(--color-accent-dim)] focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-[var(--color-muted)]">
      {children}
    </label>
  );
}

/**
 * "Gathering evidence" — the honest alternative to a number we cannot support
 * (AI_BEHAVIOR.md §6.1). Showing a confident figure from two conversations is how a product
 * loses credibility the first time the user disagrees with it.
 */
export function GatheringEvidence({ detail }: { detail?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--color-dim)]">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-dim)]" />
      Gathering evidence
      {detail && <span className="text-[var(--color-dim)]">· {detail}</span>}
    </span>
  );
}

export function Banner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn';
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-xs',
        tone === 'info' && 'border-[var(--color-line)] bg-[var(--color-raised)] text-[var(--color-muted)]',
        tone === 'warn' && 'border-[#5c4a2a] bg-[#241d12] text-[var(--color-warm)]',
      )}
    >
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  unavailable,
}: {
  label: string;
  value: string;
  hint?: string;
  unavailable?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-[var(--color-dim)]">{label}</div>
      {unavailable ? (
        <div className="mt-1">
          <GatheringEvidence />
        </div>
      ) : (
        <>
          <div className="mt-0.5 text-xl font-semibold tabular-nums text-[var(--color-text)]">
            {value}
          </div>
          {hint && <div className="text-xs text-[var(--color-dim)]">{hint}</div>}
        </>
      )}
    </div>
  );
}
