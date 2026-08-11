<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\AttentionSet;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\Attention\Auto;
use Experiment\BeStateV2\Artifact\Attention\Human;
use Experiment\BeStateV2\Artifact\Follow;
use Experiment\BeStateV2\Artifact\Probe;
use Experiment\BeStateV2\Progress\Resting;

/**
 * attention-set: Resting×ArtifactOpen(follow≠null) → Resting, attention set to
 * auto or human(reason) (state-transitions-v2.ts applyAttentionSet 1192-1216行台,
 * VERB_SPEC a.from = A_OPEN_FOLLOW_KEYS).
 *
 * Two from-guards, two different mechanisms:
 * - progress≠resting (e.g. a running phase) is a type mismatch — Resting is the
 *   only type this constructor accepts, so Be's type-matching rejects a running
 *   value before construction is even attempted (illegal-examples/
 *   AttentionSetOnRunning.php exercises this, defect #6's stronger half).
 * - artifact not open, or open-without-follow, cannot be excluded the same way:
 *   Resting's $artifact property is the full 4-way union (it must be, since
 *   restore/merged/ship all produce different Resting shapes) and ArtifactOpen's
 *   $follow is nullable by construction (ship only creates one for PR-URL refs).
 *   Both are construction-time value checks (DomainException) —
 *   AttentionSetRejectsNullFollowTest exercises the follow=null case; the
 *   None/Merged/Withdrawn cases share the same guard but are not independently
 *   tested (see plan.md 2節 attention-set 行 for why).
 */
#[Be([Resting::class])]
final readonly class AttentionSetInput
{
    public string $id;
    public ArtifactOpen $artifact;

    public function __construct(Resting $prev, ?string $humanReason = null)
    {
        if (!($prev->artifact instanceof ArtifactOpen)) {
            throw new \DomainException('attention-set requires an ArtifactOpen artifact');
        }
        $open = $prev->artifact;
        if ($open->follow === null) {
            throw new \DomainException('attention-set requires an artifact with a follow');
        }
        $follow = $open->follow;

        $this->id = $prev->id;
        $this->artifact = new ArtifactOpen(
            ref: $open->ref,
            branch: $open->branch,
            tip: $open->tip,
            base: $open->base,
            follow: $humanReason === null
                ? new Follow(
                    attention: new Auto(),
                    fixAsk: $follow->fixAsk,
                    ledger: $follow->ledger,
                    probe: $follow->probe,
                )
                : new Follow(
                    attention: new Human($humanReason),
                    fixAsk: $follow->fixAsk,
                    ledger: $follow->ledger,
                    probe: new Probe(proc: null),
                ),
        );
    }
}
