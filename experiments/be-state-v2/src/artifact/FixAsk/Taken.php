<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Artifact\FixAsk;

/**
 * A fix request already consumed by a fix-start (v2 design 1.3節 fix-ask axis "taken").
 */
final readonly class Taken
{
    public function __construct()
    {
    }
}
