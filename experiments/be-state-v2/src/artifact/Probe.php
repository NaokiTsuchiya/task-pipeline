<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Artifact;

/**
 * Reduced to the one field defect #8 (restore の watch 持ち越し) and the
 * fix-start/ship narrowing paths read or write: whether a follow process lease is
 * held. The TS probe record also tracks proc_started_at/sig/head/ci/checked_at/
 * errors/note (state-transitions-v2.ts ProbeFields) — out of scope here.
 */
final readonly class Probe
{
    public function __construct(
        public ?string $proc,
    ) {
    }
}
