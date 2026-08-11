<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Artifact;

/**
 * A withdrawn PR (v2 design 1.3節 ArtifactState "withdrawn"). No $follow
 * property, matching applyWithdraw (state-transitions-v2.ts) which does not
 * carry one over either.
 */
final readonly class ArtifactWithdrawn
{
    public function __construct(
        public string $ref,
        public string $branch,
        public string $tip,
        public string $base,
        public bool $asked,
        public ?string $note,
    ) {
    }
}
