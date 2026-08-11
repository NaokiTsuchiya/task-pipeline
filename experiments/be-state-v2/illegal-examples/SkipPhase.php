<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Illegal;

use Experiment\BeStateV2\Progress\Queued;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseImplement;

/**
 * Defect #1 / acceptance condition 6: attempts to reach PhaseImplement without
 * going through PhaseResearch and PhasePlan. PhaseImplement::__construct
 * requires a PhasePlan-typed $prev (src/progress/RunningInitialFull/
 * PhaseImplement.php); a Queued is not one, so this is rejected by Psalm's
 * static type check, not left to fail at runtime.
 *
 * Deliberately not in projectFiles (psalm.xml only analyses src/) — plan.md 1節
 * requires this file to be individually resolvable by file argument instead, so
 * type-checking src/ stays green (condition 4) while this stays a standing,
 * separately-run demonstration (condition 6).
 */
function attemptSkipPhase(Queued $q): PhaseImplement
{
    return new PhaseImplement($q);
}
