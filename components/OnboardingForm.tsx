'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, Card, Input, Label } from '@/components/ui/primitives';

/**
 * Onboarding — UX.md §4. Three screens, then talking. No placement test.
 *
 * The first session's real purpose is to gather baseline evidence, which is exactly why the
 * profile must render "gathering evidence" afterwards rather than a verdict.
 */
export function OnboardingForm() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [goals, setGoals] = useState('');
  const [bothers, setBothers] = useState('');
  const [nativeLanguage, setNativeLanguage] = useState('');
  const [level, setLevel] = useState('B2');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/account/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goals: goals.split(',').map((g) => g.trim()).filter(Boolean),
          interests: bothers.split(',').map((g) => g.trim()).filter(Boolean),
          nativeLanguage: nativeLanguage.trim() || null,
          selfReportedLevel: level,
        }),
      });
      if (!response.ok) throw new Error('Could not save your answers.');
      router.push('/home');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-lg px-5 py-16">
      {step === 0 && (
        <Card>
          <h1 className="text-xl font-semibold tracking-tight">How this works</h1>
          <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">
            You talk, I listen and reply like a person would. While we talk I quietly notice
            patterns in your English and put small notes on the side of the screen — you can
            ignore them completely. At the end you get sixty seconds of feedback that is actually
            about you.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">
            I will ask for your microphone. Your speech is sent to a transcription service and to
            the language model that replies to you. Audio is deleted within 24 hours; the
            transcripts stay so I can track how you are doing, and you can delete everything at
            any time from Settings.
          </p>
          <Button className="mt-6" onClick={() => setStep(1)}>
            Makes sense
          </Button>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <h1 className="text-xl font-semibold tracking-tight">Two quick questions</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            This gives our first conversation something to be about.
          </p>

          <div className="mt-6 space-y-4">
            <div>
              <Label htmlFor="goals">What do you use English for?</Label>
              <Input
                id="goals"
                placeholder="work meetings, interviews, travel"
                value={goals}
                onChange={(e) => setGoals(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="bothers">What are you interested in talking about?</Label>
              <Input
                id="bothers"
                placeholder="cricket, product design, cooking"
                value={bothers}
                onChange={(e) => setBothers(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="native">Your first language (optional)</Label>
              <Input
                id="native"
                placeholder="Hindi"
                value={nativeLanguage}
                onChange={(e) => setNativeLanguage(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="level">Roughly where are you?</Label>
              <select
                id="level"
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] px-3 py-2 text-sm text-[var(--color-text)]"
              >
                <option value="A2">A2 — basic</option>
                <option value="B1">B1 — intermediate</option>
                <option value="B2">B2 — upper intermediate</option>
                <option value="C1">C1 — advanced</option>
              </select>
              <p className="mt-1 text-xs text-[var(--color-dim)]">
                A rough guess is fine. I work this out from how you actually speak.
              </p>
            </div>
          </div>

          {error && (
            <div className="mt-4">
              <Banner tone="warn">{error}</Banner>
            </div>
          )}

          <div className="mt-6 flex gap-3">
            <Button onClick={() => void finish()} disabled={busy}>
              {busy ? 'Saving…' : 'Start talking'}
            </Button>
            <Button variant="subtle" onClick={() => void finish()} disabled={busy}>
              Skip
            </Button>
          </div>
        </Card>
      )}
    </main>
  );
}
