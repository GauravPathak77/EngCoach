import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ensureSchema } from '@/db/migrate';
import { getCurrentUser } from '@/server/auth';
import { listSessions } from '@/server/services/sessionService';
import { ruleAccuracies, sessionCountFor } from '@/server/services/profileService';
import { dueCount } from '@/server/services/vocabService';
import { ALL_MODES } from '@/lib/modes/registry';
import { StartSession } from '@/components/session/StartSession';
import { Card } from '@/components/ui/primitives';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) redirect('/signin');
  if (!user.onboardedAt) redirect('/onboarding');

  const [sessions, sessionCount, accuracies, due] = await Promise.all([
    listSessions(user.id, 6),
    sessionCountFor(user.id),
    ruleAccuracies(user.id),
    dueCount(user.id, new Date()),
  ]);

  // Only rules with enough evidence get named. A weakness claimed from two data points is
  // exactly the unsupported conclusion AI_BEHAVIOR.md §6.1 forbids.
  const topWeakness = accuracies.find(
    (a) => a.confidence !== 'insufficient' && a.errors > 0,
  );

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">
        {sessionCount === 0 ? 'Ready when you are' : 'What shall we talk about?'}
      </h1>
      <p className="mt-1.5 text-sm text-[var(--color-muted)]">
        {sessionCount === 0
          ? 'Pick a mode and start talking. Ten minutes is plenty.'
          : topWeakness
            ? `Last few sessions, ${topWeakness.label.toLowerCase()} has come up a few times. I'll steer us there naturally.`
            : 'Pick a mode and start talking.'}
        {due > 0 && ` ${due} word${due === 1 ? '' : 's'} due for review.`}
      </p>

      <div className="mt-8 space-y-3">
        {ALL_MODES.map((mode) => (
          <StartSession key={mode.id} mode={mode.id} label={mode.label} blurb={mode.blurb} />
        ))}
      </div>

      {sessions.length > 0 && (
        <section className="mt-12">
          <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
            Recent sessions
          </h2>
          <div className="mt-3 space-y-2">
            {sessions.map((session) => (
              <Link
                key={session.id}
                href={session.status === 'ended' ? `/report/${session.id}` : `/session/${session.id}`}
                className="block"
              >
                <Card className="flex items-center justify-between p-4 transition hover:border-[var(--color-accent-dim)]">
                  <div>
                    <div className="text-sm capitalize">{session.mode.replace('_', ' ')}</div>
                    <div className="text-xs text-[var(--color-dim)]">
                      {new Date(session.startedAt).toLocaleDateString()} ·{' '}
                      {session.status === 'active' ? 'in progress' : `${session.wordCount ?? 0} words`}
                    </div>
                  </div>
                  {session.talkTimeRatio !== null && session.talkTimeRatio !== undefined && (
                    <div className="text-xs tabular-nums text-[var(--color-dim)]">
                      you {Math.round(session.talkTimeRatio * 100)}%
                    </div>
                  )}
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
