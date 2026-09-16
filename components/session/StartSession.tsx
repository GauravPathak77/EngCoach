'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Banner } from '@/components/ui/primitives';

export function StartSession({
  mode,
  label,
  blurb,
}: {
  mode: string;
  label: string;
  blurb: string;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = (await response.json()) as
        | { sessionId: string }
        | { error: { message: string } };

      if (!response.ok || 'error' in data) {
        setError('error' in data ? data.error.message : 'Could not start the session.');
        setStarting(false);
        return;
      }
      router.push(`/session/${data.sessionId}`);
    } catch {
      setError('Could not reach the server. Check that it is running.');
      setStarting(false);
    }
  };

  return (
    <div>
      <button onClick={start} disabled={starting} className="block w-full text-left">
        <Card className="transition hover:border-[var(--color-accent-dim)]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">{label}</div>
              <div className="mt-0.5 text-xs text-[var(--color-muted)]">{blurb}</div>
            </div>
            <span className="shrink-0 text-sm text-[var(--color-accent)]">
              {starting ? '…' : 'Start →'}
            </span>
          </div>
        </Card>
      </button>
      {error && (
        <div className="mt-2">
          <Banner tone="warn">{error}</Banner>
        </div>
      )}
    </div>
  );
}
