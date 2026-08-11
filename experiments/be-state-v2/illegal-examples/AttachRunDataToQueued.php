<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Illegal;

use Experiment\BeStateV2\Artifact\ArtifactNone;
use Experiment\BeStateV2\Progress\Queued;

/**
 * Defect #5 / 別掲: Queued has no phase or gate property at all
 * (src/progress/Queued.php) — a non-running item simply has nowhere to carry
 * either. Both attempts below are rejected by Psalm with TooManyArguments +
 * InvalidNamedArgument (research.md 9-g verified this exact mechanism against a
 * single-property toy class in scratchpad/be-trial/illegal/
 * AttachPhaseToQueued.php before this file was written).
 */
function attemptAttachPhase(): Queued
{
    return new Queued(id: 'x', artifact: new ArtifactNone(), phase: 'plan');
}

function attemptAttachGate(): Queued
{
    return new Queued(id: 'x', artifact: new ArtifactNone(), gate: 'light');
}
