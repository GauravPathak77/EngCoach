'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, Card, Input, Label } from '@/components/ui/primitives';
import { ALL_COACH_VOICES, type VoicePresentation } from '@/lib/voice/tts/voices';

type Settings = {
  voiceCorrectionsEnabled: boolean;
  drillsOptIn: boolean;
  difficulty: number;
  handsFree: boolean;
  retainAudio: boolean;
  coachVoice: VoicePresentation;
};

export function SettingsClient({
  email,
  initial,
  providers,
}: {
  email: string;
  initial: Settings;
  providers: { llm: string; stt: string; tts: string; db: string };
}) {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings>(initial);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = async (patch: Partial<Settings>): Promise<void> => {
    const next = { ...settings, ...patch };
    setSettings(next);
    setSaved(false);
    await fetch('/api/account/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => undefined);
    setSaved(true);
  };

  const deleteEverything = async (): Promise<void> => {
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: { message?: string } };
        setError(data.error?.message ?? 'Could not delete your data.');
        setDeleting(false);
        return;
      }
      router.push('/signin');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
      setDeleting(false);
    }
  };

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="mt-8">
        <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
          How the coach behaves
        </h2>
        <Card className="mt-3 space-y-4">
          <Toggle
            label="Spoken corrections"
            description="When off, corrections only ever appear on screen. The conversation stays completely uninterrupted."
            checked={settings.voiceCorrectionsEnabled}
            onChange={(v) => void update({ voiceCorrectionsEnabled: v })}
          />
          <Toggle
            label="Repeat-after-me drills"
            description="Coach mode only, maximum two per session. Off by default."
            checked={settings.drillsOptIn}
            onChange={(v) => void update({ drillsOptIn: v })}
          />
          <Toggle
            label="Hands-free turns"
            description="Your turn ends automatically after a short silence. Turn off if your room is noisy."
            checked={settings.handsFree}
            onChange={(v) => void update({ handsFree: v })}
          />

          {/*
            Coach voice — ADR-020. Two options, not a marketplace. The value stored is a
            provider-agnostic key; the OpenAI voice id lives in the voice registry.
          */}
          <div className="border-t border-[var(--color-line)] pt-4">
            <Label htmlFor="coachVoice">Coach voice</Label>
            <select
              id="coachVoice"
              value={settings.coachVoice}
              onChange={(e) => void update({ coachVoice: e.target.value as VoicePresentation })}
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] px-3 py-2 text-sm text-[var(--color-text)]"
            >
              {ALL_COACH_VOICES.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.displayName} — {voice.presentation}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-[var(--color-dim)]">
              {ALL_COACH_VOICES.find((v) => v.id === settings.coachVoice)?.description}
              {providers.tts !== 'server' && (
                <>
                  {' '}
                  Your browser is doing the speaking, so the exact voice depends on what it
                  offers — we pick the closest match available.
                </>
              )}
            </p>
          </div>

          <div>
            <Label htmlFor="difficulty">Difficulty · {settings.difficulty}/10</Label>
            <input
              id="difficulty"
              type="range"
              min={1}
              max={10}
              value={settings.difficulty}
              onChange={(e) => void update({ difficulty: Number(e.target.value) })}
              className="w-full accent-[var(--color-accent)]"
            />
            <p className="mt-1 text-xs text-[var(--color-dim)]">
              One dial: it moves the coach&rsquo;s vocabulary, pace and how abstract its questions
              get, all together.
            </p>
          </div>
        </Card>
      </section>

      <section className="mt-8">
        <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
          Your data
        </h2>
        <Card className="mt-3 space-y-4">
          <Toggle
            label="Keep audio for 24 hours"
            description="Off by default: your recording is discarded as soon as it has been transcribed. Either way audio is never kept beyond 24 hours."
            checked={settings.retainAudio}
            onChange={(v) => void update({ retainAudio: v })}
          />

          <div className="border-t border-[var(--color-line)] pt-4">
            <a href="/api/account/export" download>
              <Button variant="ghost" size="sm">
                Export everything (JSON)
              </Button>
            </a>
            <p className="mt-2 text-xs text-[var(--color-dim)]">
              Transcripts, findings, vocabulary and progress. It is your learning history.
            </p>
          </div>

          <div className="border-t border-[var(--color-line)] pt-4">
            <div className="text-sm">Delete everything</div>
            <p className="mt-1 text-xs text-[var(--color-dim)]">
              Hard delete, no recovery. Type <span className="text-[var(--color-muted)]">{email}</span>{' '}
              to confirm.
            </p>
            <div className="mt-2 flex gap-2">
              <Input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={email}
              />
              <Button
                variant="danger"
                onClick={() => void deleteEverything()}
                disabled={confirm !== email || deleting}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
            {error && (
              <div className="mt-2">
                <Banner tone="warn">{error}</Banner>
              </div>
            )}
          </div>
        </Card>
      </section>

      <section className="mt-8">
        <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
          Providers
        </h2>
        <Card className="mt-3">
          <dl className="space-y-2 text-sm">
            <Row label="Coach model" value={providers.llm === 'live' ? 'Anthropic (live)' : 'scripted (no API key)'} warn={providers.llm !== 'live'} />
            <Row label="Speech recognition" value={providers.stt === 'deepgram' ? 'Deepgram' : 'browser (degraded)'} warn={providers.stt !== 'deepgram'} />
            <Row label="Voice" value={providers.tts === 'server' ? 'OpenAI TTS' : 'browser speech'} warn={providers.tts !== 'server'} />
            <Row label="Database" value={providers.db === 'pglite' ? 'PGlite (embedded)' : 'Postgres'} />
          </dl>
          <p className="mt-3 text-xs text-[var(--color-dim)]">
            Anything marked degraded works, but is not the real experience. See the README for
            which environment variables to set.
          </p>
        </Card>
      </section>

      <div className="mt-8 flex items-center justify-between">
        {saved && <span className="text-xs text-[var(--color-dim)]">Saved</span>}
        <form action="/api/auth/signout" method="post" className="ml-auto">
          <Button
            variant="subtle"
            size="sm"
            type="button"
            onClick={async () => {
              await fetch('/api/auth/signout', { method: 'POST' });
              router.push('/signin');
              router.refresh();
            }}
          >
            Sign out
          </Button>
        </form>
      </div>
    </main>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className={warn ? 'text-[var(--color-warm)]' : 'text-[var(--color-text)]'}>{value}</dd>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        <p className="mt-0.5 text-xs text-[var(--color-dim)]">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 h-5 w-9 shrink-0 rounded-full transition ${
          checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-line)]'
        }`}
      >
        <span
          className={`block h-4 w-4 rounded-full bg-white transition ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}
