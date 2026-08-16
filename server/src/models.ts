/**
 * Model and effort choices offered by the UI.
 *
 * Aliases rather than pinned ids (`opus`, not `claude-opus-5`) so a new model
 * generation is picked up without a code change. Verified against the CLI:
 * opus → claude-opus-5, sonnet → claude-sonnet-5, haiku → claude-haiku-4-5.
 * `fable` resolves only on plans that include it, so it isn't offered here —
 * use the custom field if your account has access.
 */
export interface ModelChoice {
  id: string;
  label: string;
  hint: string;
}

export const MODEL_CHOICES: ModelChoice[] = [
  {
    id: '',
    label: 'Default',
    hint: 'Whatever your Claude Code settings use',
  },
  {
    id: 'opus',
    label: 'Opus',
    hint: 'Hard, multi-file work. Highest cost.',
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    hint: 'Near-Opus coding quality, noticeably cheaper.',
  },
  {
    id: 'haiku',
    label: 'Haiku',
    hint: 'Fast and cheap. Small, well-specified edits.',
  },
];

/**
 * Effort is often a bigger lever than model choice: it controls how much the
 * agent explores and verifies before answering. `xhigh` suits agentic coding;
 * the lower levels are stronger than their names suggest on current models.
 */
export interface EffortChoice {
  id: string;
  label: string;
  hint: string;
}

export const EFFORT_CHOICES: EffortChoice[] = [
  { id: '', label: 'Default', hint: 'CLI default (high)' },
  { id: 'low', label: 'Low', hint: 'Short, scoped edits. Fastest.' },
  { id: 'medium', label: 'Medium', hint: 'Good balance for routine tasks.' },
  { id: 'high', label: 'High', hint: 'Most tasks that need real thought.' },
  { id: 'xhigh', label: 'X-High', hint: 'Best for agentic coding.' },
  { id: 'max', label: 'Max', hint: 'Correctness over cost. Can overthink.' },
];

const EFFORT_IDS = new Set(EFFORT_CHOICES.map((choice) => choice.id).filter(Boolean));

export function normalizeEffort(value: unknown): string | null {
  return typeof value === 'string' && EFFORT_IDS.has(value) ? value : null;
}

export function normalizeModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Anything non-empty is allowed through: the CLI accepts full model names as
  // well as aliases, and rejecting unknown strings would block new releases.
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null;
}
