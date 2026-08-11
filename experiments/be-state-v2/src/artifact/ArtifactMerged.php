<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Artifact;

/**
 * A merged PR (v2 design 1.3節 ArtifactState "merged"). Deliberately has no
 * $follow property at all — that absence is defect #7's "表現不能" mechanism
 * (state-transitions-v2.ts applyMerged 667行: "follow は破棄される").
 */
final readonly class ArtifactMerged
{
    public function __construct(
        public string $ref,
        public string $branch,
        public string $tip,
        public string $base,
    ) {
    }
}
