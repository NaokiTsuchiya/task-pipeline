<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Illegal;

use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseResearch;
use Experiment\BeStateV2\Verbs\AttentionSet\AttentionSetInput;

/**
 * Defect #6, progress-axis half: attention-set's from is Resting only
 * (src/verbs/AttentionSet/AttentionSetInput.php); a running phase is not one, so
 * this is rejected by Psalm the same way SkipPhase.php is (PhaseResearch is not
 * assignable to the Resting $prev parameter). The artifact-axis half
 * (follow≠null) cannot be excluded this way — see AttentionSetInput's docblock
 * and tests/AttentionSetRejectsNullFollowTest.php for why that guard is a
 * construction-time DomainException instead.
 */
function attemptAttentionSetOnRunning(PhaseResearch $running): AttentionSetInput
{
    return new AttentionSetInput($running);
}
