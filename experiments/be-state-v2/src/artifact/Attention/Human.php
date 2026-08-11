<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Artifact\Attention;

/**
 * Next action is delegated to a human, with the reason it was latched
 * (v2 design 1.3節 HUMAN_ATTENTION_REASON_VALUES; this experiment only needs
 * "fix_limit", the reason defect #9 exercises).
 */
final readonly class Human
{
    public function __construct(
        public string $reason,
    ) {
    }
}
