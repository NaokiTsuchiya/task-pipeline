<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Artifact;

/**
 * An open PR/branch (v2 design 1.3節 ArtifactState "open"). follow is nullable —
 * ship only creates one when ref is a pull-request URL (state-transitions-v2.ts
 * isPullRequestRef/freshFollow, research.md 4節).
 */
final readonly class ArtifactOpen
{
    public function __construct(
        public string $ref,
        public string $branch,
        public ?string $tip,
        public string $base,
        public ?Follow $follow,
    ) {
    }
}
