<?php

declare(strict_types=1);

namespace Experiment\BeStateV2;

/**
 * Marker interface for every progress-axis state class (Queued/Resting/Blocked and
 * the RunningInitialFull/RunningPrFix phase classes). Not used by the becoming
 * engine itself — it only documents, for a reader of this experiment, which classes
 * are "coordinates" as opposed to input/wrapper classes.
 */
interface Node
{
}
