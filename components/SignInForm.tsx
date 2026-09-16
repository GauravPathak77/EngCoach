'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, Card, Input, Label } from '@/components/ui/primitives';

export function SignInForm() {
  const router = useRouter();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/auth/${mode === 'signin' ? 'signin' : 'signup'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = (await response.json()) as
        | { ok: true; onboarded?: boolean }
        | { error: { message: string } };

      if (!response.ok || 'error' in data) {
        setError('error' in data ? data.error.message : 'Something went wrong.');
        return;
      }

      router.push(mode === 'signup' || data.onboarded === false ? '/onboarding' : '/home');
      router.refresh();
    } catch {
      setError('Could not reach the server. Is it running?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="w-full max-w-sm">
      <h1 className="text-lg font-semibold tracking-tight">EngCoach</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        {mode === 'signin' ? 'Welcome back.' : 'Set up your account.'}
      </p>

      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === 'signup' && (
            <p className="mt-1 text-xs text-[var(--color-dim)]">At least 8 characters.</p>
          )}
        </div>

        {error && <Banner tone="warn">{error}</Banner>}

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </Button>
      </form>

      <button
        onClick={() => {
          setMode((m) => (m === 'signin' ? 'signup' : 'signin'));
          setError(null);
        }}
        className="mt-4 w-full text-center text-xs text-[var(--color-dim)] hover:text-[var(--color-muted)]"
      >
        {mode === 'signin' ? 'No account yet? Create one' : 'Already have an account? Sign in'}
      </button>
    </Card>
  );
}
