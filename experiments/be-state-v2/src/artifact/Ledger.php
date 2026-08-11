<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Artifact;

/**
 * Reduced to the one field the 7-verb subset actually reads or writes
 * (fixAttempts, exercised by defects #3 and #9). The TS ledger also tracks
 * handled/review_only/answered/fix_cycle_tip/fix_rerun_tip (state-transitions-v2.ts
 * 285-291行) — out of scope here since none of claim/advance/ship/fix-start/
 * restore/merged/attention-set in this reduction read or write them.
 */
final readonly class Ledger
{
    public function __construct(
        public int $fixAttempts,
    ) {
    }
}
