'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Banner, Button, Card, Stat } from '@/components/ui/primitives';

type Report = {
  sessionId: string;
  topFixes: Array<{
    ruleTag: string;
    label: string;
    youSaid: string;
    better: string;
    why: string;
    occurrences: number;
    findingId: string | null;
  }>;
  phrasesToSteal: Array<{ phrase: string; insteadOf: string | null; note: string }>;
  vocabItems: Array<{ lemma: string; definition: string; register: string; anchor: string }>;
  sayItBetter: {
    original: string;
    variants: Array<{ register: string; text: string; why: string }>;
  } | null;
  oneThingThatWentWell: string;
  focusNext: string;
  metrics: {
    timingsReliable: boolean;
    wordCount: number;
    userSpeechMs: number;
    talkTimeRatio: number;
    speechRate: number;
    fillersPer100Words: number;
    meanMlr: number;
    mtld: number;
    hedgeDensityPer100Words: number;
    repairsPer100Words: number;
  };
};

/**
 * The session report — UX.md §2.
 *
 * Sixty seconds of reading. Exactly three fixes, each quoting the user's own words, one specific
 * positive, and a dispute affordance on every card. A wall of corrections after a conversation
 * they enjoyed is demotivating and will not be read.
 */
export function ReportClient({
  sessionId,
  initialReport,
}: {
  sessionId: string;
  initialReport: Report | null;
}) {
  const [report, setReport] = useState<Report | null>(initialReport);
  const [loading, setLoading] = useState(initialReport === null);
  const [error, setError] = useState<string | null>(null);
  const [disputed, setDisputed] = useState<Set<string>>(new Set());

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = (await response.json()) as Report | { error: { message: string } };
      if (!response.ok || 'error' in data) {
        setError('error' in data ? data.error.message : 'Could not build your report.');
        return;
      }
      setReport(data);
    } catch {
      setError('Could not reach the server to build your report.');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (initialReport === null) void generate();
  }, [initialReport, generate]);

  const dispute = async (findingId: string): Promise<void> => {
    setDisputed((prev) => new Set(prev).add(findingId));
    await fetch(`/api/findings/${findingId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: 'disagreed' }),
    }).catch(() => undefined);
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-2xl px-5 py-16 text-center">
        <p className="text-sm text-[var(--color-muted)]">Putting your session together…</p>
      </main>
    );
  }

  if (error || !report) {
    return (
      <main className="mx-auto max-w-2xl px-5 py-16">
        <Banner tone="warn">{error ?? 'No report available for this session.'}</Banner>
        <div className="mt-4 flex gap-3">
          <Button onClick={() => void generate()}>Try again</Button>
          <Link href="/home">
            <Button variant="ghost">Back</Button>
          </Link>
        </div>
      </main>
    );
  }

  const m = report.metrics;

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">How that went</h1>

      {/* --- The three things ------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
          {report.topFixes.length === 0 ? 'Nothing to fix' : 'The three things'}
        </h2>

        {report.topFixes.length === 0 ? (
          <Card className="mt-3">
            <p className="text-sm text-[var(--color-muted)]">
              Nothing came up that I was confident enough to flag. That is a real result, not an
              empty one — keep going and we will have more to work with.
            </p>
          </Card>
        ) : (
          <ol className="mt-3 space-y-3">
            {report.topFixes.map((fix, i) => (
              <li key={`${fix.ruleTag}-${i}`}>
                <Card>
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm font-medium">{fix.label}</span>
                    {fix.occurrences > 1 && (
                      <span className="shrink-0 rounded bg-[var(--color-raised)] px-1.5 py-0.5 text-xs tabular-nums text-[var(--color-dim)]">
                        ×{fix.occurrences} this session
                      </span>
                    )}
                  </div>

                  <div className="mt-3 grid gap-2 text-sm">
                    <div>
                      <span className="text-xs text-[var(--color-dim)]">you said </span>
                      <span className="text-[var(--color-muted)]">“{fix.youSaid}”</span>
                    </div>
                    <div>
                      <span className="text-xs text-[var(--color-dim)]">better </span>
                      <span className="text-[var(--color-accent)]">“{fix.better}”</span>
                    </div>
                    <div>
                      <span className="text-xs text-[var(--color-dim)]">why </span>
                      <span className="text-[var(--color-muted)]">{fix.why}</span>
                    </div>
                  </div>

                  {fix.findingId && (
                    <div className="mt-3 text-right">
                      {disputed.has(fix.findingId) ? (
                        <span className="text-xs text-[var(--color-dim)]">Noted — thanks</span>
                      ) : (
                        <button
                          onClick={() => void dispute(fix.findingId!)}
                          className="text-xs text-[var(--color-dim)] hover:text-[var(--color-warm)]"
                        >
                          This is wrong
                        </button>
                      )}
                    </div>
                  )}
                </Card>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* --- Steal these ------------------------------------------------- */}
      {report.phrasesToSteal.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
            Steal these
          </h2>
          <Card className="mt-3 space-y-3">
            {report.phrasesToSteal.map((phrase, i) => (
              <div key={i}>
                <div className="text-sm text-[var(--color-accent)]">“{phrase.phrase}”</div>
                {phrase.insteadOf && (
                  <div className="text-xs text-[var(--color-dim)]">
                    instead of “{phrase.insteadOf}”
                  </div>
                )}
                <div className="mt-0.5 text-xs text-[var(--color-muted)]">{phrase.note}</div>
              </div>
            ))}
          </Card>
        </section>
      )}

      {/* --- Vocabulary --------------------------------------------------- */}
      {report.vocabItems.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
            New words
          </h2>
          <Card className="mt-3 space-y-3">
            {report.vocabItems.map((item) => (
              <div key={item.lemma}>
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-[var(--color-accent)]">
                    {item.lemma}
                  </span>
                  <span className="text-xs text-[var(--color-dim)]">{item.register}</span>
                </div>
                <div className="text-xs text-[var(--color-muted)]">{item.definition}</div>
                {/* The anchor is what makes it stick — AI_BEHAVIOR.md §5.4. */}
                <div className="mt-0.5 text-xs text-[var(--color-dim)] italic">
                  from when you said “{item.anchor}”
                </div>
              </div>
            ))}
          </Card>
        </section>
      )}

      {/* --- Say it better ------------------------------------------------ */}
      {report.sayItBetter && (
        <section className="mt-8">
          <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
            One you could sharpen
          </h2>
          <Card className="mt-3">
            <div className="text-xs text-[var(--color-dim)]">you said</div>
            <p className="text-sm text-[var(--color-muted)]">{report.sayItBetter.original}</p>
            {report.sayItBetter.variants.map((variant) => (
              <div key={variant.register} className="mt-3">
                <div className="text-xs text-[var(--color-dim)] capitalize">{variant.register}</div>
                <p className="text-sm text-[var(--color-text)]">{variant.text}</p>
                <p className="text-xs text-[var(--color-dim)]">{variant.why}</p>
              </div>
            ))}
          </Card>
        </section>
      )}

      {/* --- Numbers ------------------------------------------------------ */}
      <section className="mt-8">
        <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
          Your numbers
        </h2>
        <Card className="mt-3">
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Stat label="Words spoken" value={String(m.wordCount)} />
            {/*
              The talk-time ratio needs measured SPEECH duration. A session done by typing has
              none, and rendering that as "0% — aim higher" would be an unsupported number
              dressed up as feedback (AI_BEHAVIOR.md §7.1).
            */}
            <Stat
              label="You talked"
              value={`${Math.round(m.talkTimeRatio * 100)}%`}
              hint={m.talkTimeRatio >= 0.6 ? 'good' : 'aim higher'}
              unavailable={m.userSpeechMs === 0}
            />
            <Stat
              label="Fillers / 100 words"
              value={String(m.fillersPer100Words)}
            />
            {/*
              Timing-derived metrics are only shown when the speech source actually gave us word
              timings (ADR-018). A fabricated pause profile would be exactly the unsupported
              number AI_BEHAVIOR.md §7.1 forbids.
            */}
            <Stat
              label="Speaking pace"
              value={`${Math.round(m.speechRate)} wpm`}
              unavailable={!m.timingsReliable}
            />
            <Stat
              label="Longest run"
              value={`${m.meanMlr} words`}
              unavailable={!m.timingsReliable}
            />
            <Stat label="Word variety" value={m.mtld > 0 ? String(m.mtld) : '—'} unavailable={m.mtld === 0} />
            <Stat label="Hedging / 100 w" value={String(m.hedgeDensityPer100Words)} />
            <Stat label="Self-corrections" value={String(m.repairsPer100Words)} />
          </div>

          {!m.timingsReliable && (
            <p className="mt-4 text-xs text-[var(--color-dim)]">
              Pace and run length need word-level timings, which this session&rsquo;s speech
              source could not provide. Add a Deepgram key to unlock them.
            </p>
          )}
        </Card>
      </section>

      {/* --- One thing that went well ------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
          One thing that went well
        </h2>
        <Card className="mt-3">
          <p className="text-sm text-[var(--color-text)]">{report.oneThingThatWentWell}</p>
        </Card>
      </section>

      {report.focusNext && (
        <p className="mt-6 text-sm text-[var(--color-muted)]">
          <span className="text-[var(--color-dim)]">Next time: </span>
          {report.focusNext}
        </p>
      )}

      <div className="mt-10 flex gap-3">
        <Link href="/home">
          <Button>Practise again</Button>
        </Link>
        <Link href="/progress">
          <Button variant="ghost">See progress</Button>
        </Link>
      </div>
    </main>
  );
}
