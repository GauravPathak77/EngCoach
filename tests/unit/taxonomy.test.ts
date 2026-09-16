/**
 * lib/analysis/taxonomy — ADR-003.
 *
 * The taxonomy is the aggregation key for the entire product. If a tag can be invented,
 * duplicated, or silently dropped, the progress dashboard stops being able to count anything.
 */

import { describe, expect, it } from 'vitest';
import {
  TAXONOMY,
  RULE_TAGS,
  categoryOf,
  defaultSeverity,
  elicitableRules,
  familyOf,
  getRule,
  isAsrProne,
  isKnownRuleTag,
  renderExplanation,
} from '@/lib/analysis/taxonomy';
import { FINDING_TYPES, SEVERITIES } from '@/lib/types';

describe('taxonomy integrity', () => {
  it('has ids that are unique', () => {
    expect(new Set(RULE_TAGS).size).toBe(RULE_TAGS.length);
  });

  it('is within the size the blueprint budgets for (60-90 tags at V1)', () => {
    // A system that reliably catches 20 error types beats one that unreliably catches 80
    // (ROADMAP.md M5). This guards against unbounded growth.
    expect(TAXONOMY.length).toBeGreaterThanOrEqual(20);
    expect(TAXONOMY.length).toBeLessThanOrEqual(90);
  });

  it('uses only declared categories and severities', () => {
    for (const entry of TAXONOMY) {
      expect(FINDING_TYPES, entry.id).toContain(entry.category);
      expect(SEVERITIES, entry.id).toContain(entry.defaultSeverity);
    }
  });

  it('uses dotted ids so families can be derived', () => {
    for (const entry of TAXONOMY) {
      expect(entry.id, entry.id).toMatch(/^[a-z_]+(\.[a-z_0-9]+)+$/);
    }
  });

  it('gives every entry a human label', () => {
    for (const entry of TAXONOMY) {
      expect(entry.label.length, entry.id).toBeGreaterThan(3);
    }
  });
});

describe('asr-prone flags', () => {
  it('marks the categories a recogniser actually mangles', () => {
    // Articles, plurals, verb inflections and agreement are exactly what ASR drops, and they
    // are exactly what we look for — hence the Gate 1 suppression.
    expect(isAsrProne('grammar.article.definite')).toBe(true);
    expect(isAsrProne('grammar.article.indefinite')).toBe(true);
    expect(isAsrProne('grammar.agreement.subject_verb')).toBe(true);
    expect(isAsrProne('grammar.plural.form')).toBe(true);
    expect(isAsrProne('grammar.tense.past_simple.irregular')).toBe(true);
  });

  it('does not mark rules a recogniser cannot affect', () => {
    // Word order and collocation survive transcription intact.
    expect(isAsrProne('grammar.word_order.question')).toBe(false);
    expect(isAsrProne('lexical.collocation')).toBe(false);
    expect(isAsrProne('naturalness.calque')).toBe(false);
  });

  it('defaults to false for an unknown tag rather than throwing', () => {
    expect(isAsrProne('not.a.real.tag')).toBe(false);
  });
});

describe('lookup helpers', () => {
  it('recognises known tags and rejects invented ones', () => {
    expect(isKnownRuleTag('grammar.countability')).toBe(true);
    expect(isKnownRuleTag('grammar.made.up')).toBe(false);
    expect(getRule('grammar.made.up')).toBeUndefined();
  });

  it('derives the family from the first two segments', () => {
    expect(familyOf('grammar.tense.past_simple.irregular')).toBe('grammar.tense');
    expect(familyOf('lexical.collocation')).toBe('lexical.collocation');
  });

  it('returns the declared category and severity', () => {
    expect(categoryOf('lexical.collocation')).toBe('lexical_choice');
    expect(categoryOf('unknown.tag')).toBeNull();
    expect(defaultSeverity('grammar.word_order.question')).toBe('blocking');
    expect(defaultSeverity('unknown.tag')).toBe('polish');
  });
});

describe('elicitation strategies', () => {
  it('provides enough elicitable rules for the adaptive engine to work with', () => {
    expect(elicitableRules().length).toBeGreaterThanOrEqual(10);
  });

  it('only returns rules that actually carry a strategy', () => {
    for (const rule of elicitableRules()) {
      expect(rule.elicitation, rule.id).not.toBeNull();
      expect(rule.elicitation!.length, rule.id).toBeGreaterThan(10);
    }
  });

  it('leaves rules with no natural context unelicitable', () => {
    // You cannot engineer a conversation that forces someone to overuse "good".
    expect(getRule('lexical.overuse')?.elicitation).toBeNull();
    expect(getRule('filler.hedge_density')?.elicitation).toBeNull();
  });
});

describe('canonical explanations — the hallucinated-grammar guard (RISKS.md R4)', () => {
  it('substitutes the corrected form into the template', () => {
    const text = renderExplanation('grammar.tense.past_simple.irregular', 'have went', 'went');
    expect(text).toContain('went');
    expect(text).not.toContain('{corrected}');
  });

  it('returns null when a rule has no template, so the analyzer text is used', () => {
    expect(renderExplanation('lexical.overuse', 'good', 'solid')).toBeNull();
  });

  it('covers the common grammar rules, where hallucination risk is highest', () => {
    const withTemplates = TAXONOMY.filter(
      (t) => t.category === 'grammar' && t.explanationTemplate !== null,
    );
    expect(withTemplates.length).toBeGreaterThanOrEqual(15);
  });

  it('falls back to the original when there is no correction to substitute', () => {
    const text = renderExplanation('grammar.article.definite', 'a market', null);
    expect(text).toContain('a market');
  });
});
