import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ensureSchema } from '@/db/migrate';
import { getCurrentUser } from '@/server/auth';
import {
  getSkillEstimates,
  recentSessionMetrics,
  recomputeSkills,
  ruleAccuracies,
  sessionCountFor,
} from '@/server/services/profileService';
import { getVocabRows } from '@/server/services/vocabService';
import { listSessions } from '@/server/services/sessionService';
import { Card, GatheringEvidence, Stat } from '@/components/ui/primitives';
import { VOCAB_STATES } from '@/lib/types';

export const dynamic = 'force-dynamic';

const SKILL_LABELS: Record<string, string> = {
  fluency: 'Fluency',
  vocabulary: 'Vocabulary',
};

const VOCAB_SHELF_LABELS: Record<string, string> = {
  introduced: 'Learning',
  recognised: 'Recognised',
  used_prompted: 'Used with a nudge',
  used_spontaneous: 'You used it',
  retained: 'Yours now',
};

export default async function ProgressPage() {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) redirect('/signin');

  await recomputeSkills(user.id);

  const [skills, accuracies, vocab, sessions, sessionCount, recent] = await Promise.all([
    getSkillEstimates(user.id),
    ruleAccuracies(user.id),
    getVocabRows(user.id),
    listSessions(user.id, 10),
    sessionCountFor(user.id),
    recentSessionMetrics(user.id),
  ]);

  const recurring = accuracies.filter((a) => a.errors > 0).slice(0, 8);

  // The headline is an OUTCOME, not a grade (UX.md §3a). And it only claims something when
  // there is enough evidence to claim it.
  const improving = recurring.filter(
    (a) => a.confidence !== 'insufficient' && a.mastery > 0.6,
  ).length;
  const named = recurring.filter((a) => a.confidence !== 'insufficient').length;

  const minutes = Math.round(
    recent.reduce((a, r) => a + (r.wordCount ?? 0) / 130, 0),
  );

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Progress</h1>

      <p className="mt-2 text-sm text-[var(--color-muted)]">
        {sessionCount < 2 ? (
          <>
            After a couple more conversations there will be enough here to say something useful.
            Right now I have {sessionCount} session{sessionCount === 1 ? '' : 's'} of evidence.
          </>
        ) : named === 0 ? (
          <>Still gathering evidence on your recurring patterns.</>
        ) : (
          <>
            {improving} of your {named} tracked pattern{named === 1 ? '' : 's'}{' '}
            {improving === 1 ? 'is' : 'are'} holding up well.
          </>
        )}
      </p>

      {/* --- Recurring mistakes ------------------------------------------ */}
      <section className="mt-8">
        <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
          Recurring patterns
        </h2>
        {recurring.length === 0 ? (
          <Card className="mt-3">
            <p className="text-sm text-[var(--color-muted)]">
              Nothing recurring yet. Have a few more conversations and patterns will show up here.
            </p>
          </Card>
        ) : (
          <div className="mt-3 space-y-2">
            {recurring.map((rule) => (
              <Card key={rule.ruleTag} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm">{rule.label}</div>
                    {/*
                      The denominator is shown, always. "2 errors out of 3 opportunities" and
                      "2 out of 30" are completely different facts (AI_BEHAVIOR.md §2.1).
                    */}
                    <div className="mt-0.5 text-xs text-[var(--color-dim)]">
                      {rule.errors} slip{rule.errors === 1 ? '' : 's'} in{' '}
                      {rule.obligatoryContexts} opportunit
                      {rule.obligatoryContexts === 1 ? 'y' : 'ies'}
                      {rule.avoidanceCount > 0 && (
                        <> · avoided it {rule.avoidanceCount} time{rule.avoidanceCount === 1 ? '' : 's'}</>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    {rule.confidence === 'insufficient' ? (
                      <GatheringEvidence />
                    ) : (
                      <>
                        <div className="text-sm font-semibold tabular-nums">
                          {Math.round(rule.mastery * 100)}%
                        </div>
                        <div className="text-xs text-[var(--color-dim)]">
                          getting it right
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* --- Skills ------------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
          Skills
        </h2>
        <Card className="mt-3 space-y-4">
          {skills
            .filter((s) => SKILL_LABELS[s.skill])
            .map((skill) => (
              <div key={skill.skill}>
                <div className="flex items-baseline justify-between">
                  <span className="text-sm">{SKILL_LABELS[skill.skill]}</span>
                  {skill.confidence === 'insufficient' ? (
                    <GatheringEvidence detail={`${skill.evidenceCount} sessions`} />
                  ) : (
                    <span className="text-xs text-[var(--color-dim)]">
                      {skill.confidence} confidence · {skill.evidenceCount} sessions
                    </span>
                  )}
                </div>
                {skill.confidence !== 'insufficient' && (
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-raised)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-accent)]"
                      style={{ width: `${Math.round(skill.value * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          {skills.filter((s) => SKILL_LABELS[s.skill]).length === 0 && (
            <GatheringEvidence detail="no sessions yet" />
          )}
        </Card>
      </section>

      {/* --- Confidence proxies ------------------------------------------- */}
      {recent.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
            Signals worth watching
          </h2>
          <Card className="mt-3">
            {/*
              Deliberately NOT aggregated into a "confidence score" (ADR-008). Hesitancy in a
              second language is processing load, not personality — a number here would be
              wrong, demoralising, and would erode trust in the numbers that are sound.
            */}
            <p className="mb-4 text-xs text-[var(--color-dim)]">
              These are observations, not a score. Read them together with what you were talking
              about — an unfamiliar topic moves all of them.
            </p>
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
              <Stat
                label="Hedging / 100 w"
                value={String(avg(recent.map((r) => r.hedgeDensity)))}
              />
              <Stat
                label="Self-corrections"
                value={String(avg(recent.map((r) => r.repairs)))}
              />
              <Stat
                label="Fillers / 100 w"
                value={String(avg(recent.map((r) => r.fillersPer100Words)))}
              />
              <Stat label="Sessions (28d)" value={String(recent.length)} />
            </div>
          </Card>
        </section>
      )}

      {/* --- Vocabulary shelf --------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
          Vocabulary
        </h2>
        {vocab.length === 0 ? (
          <Card className="mt-3">
            <p className="text-sm text-[var(--color-muted)]">
              Words you could have used will collect here, each with the sentence it came from.
            </p>
          </Card>
        ) : (
          <div className="mt-3 space-y-3">
            {VOCAB_STATES.filter((state) => state !== 'candidate').map((state) => {
              const items = vocab.filter((v) => v.state === state);
              if (items.length === 0) return null;
              return (
                <Card key={state}>
                  <div className="text-xs text-[var(--color-dim)]">
                    {VOCAB_SHELF_LABELS[state] ?? state}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {items.map((item) => (
                      <span
                        key={item.itemId}
                        title={`${item.definition} — from “${item.anchorUtterance}”`}
                        className="rounded-full border border-[var(--color-line)] bg-[var(--color-raised)] px-2.5 py-1 text-xs"
                      >
                        {item.lemma}
                        <span className="ml-1.5 text-[var(--color-dim)]">{item.register}</span>
                      </span>
                    ))}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* --- History ------------------------------------------------------ */}
      {sessions.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
            History
          </h2>
          <Card className="mt-3">
            <div className="mb-4 grid grid-cols-2 gap-5">
              <Stat label="Sessions" value={String(sessionCount)} />
              <Stat label="Minutes practised (est.)" value={String(minutes)} />
            </div>
            <div className="space-y-1.5">
              {sessions.map((session) => (
                <Link
                  key={session.id}
                  href={`/report/${session.id}`}
                  className="flex items-center justify-between rounded px-1 py-1 text-xs hover:bg-[var(--color-raised)]"
                >
                  <span className="text-[var(--color-muted)] capitalize">
                    {session.mode.replace('_', ' ')}
                  </span>
                  <span className="text-[var(--color-dim)]">
                    {new Date(session.startedAt).toLocaleDateString()}
                  </span>
                </Link>
              ))}
            </div>
          </Card>
        </section>
      )}
    </main>
  );
}

function avg(values: Array<number | null>): number {
  const clean = values.filter((v): v is number => v !== null);
  if (clean.length === 0) return 0;
  return Math.round((clean.reduce((a, b) => a + b, 0) / clean.length) * 10) / 10;
}
