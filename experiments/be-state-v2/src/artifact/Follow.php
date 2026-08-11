<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Artifact;

use Experiment\BeStateV2\Artifact\Attention\Auto;
use Experiment\BeStateV2\Artifact\Attention\Human;
use Experiment\BeStateV2\Artifact\FixAsk\Pending;
use Experiment\BeStateV2\Artifact\FixAsk\Taken;

/**
 * The follow record an ArtifactOpen may carry (v2 design 1.3節 FollowFields).
 * ArtifactMerged/ArtifactWithdrawn/ArtifactNone have no follow property at all —
 * that is the direct mechanism behind defects #7 and the (in_progress/research,
 * gate:light) aside (research.md 4節).
 */
final readonly class Follow
{
    public function __construct(
        public Auto|Human $attention,
        public Pending|Taken|null $fixAsk,
        public Ledger $ledger,
        public Probe $probe,
    ) {
    }
}
