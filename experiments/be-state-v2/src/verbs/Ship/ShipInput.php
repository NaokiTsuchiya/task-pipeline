<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\Ship;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Artifact\ArtifactMerged;
use Experiment\BeStateV2\Artifact\ArtifactNone;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\ArtifactWithdrawn;
use Experiment\BeStateV2\Artifact\Attention\Auto;
use Experiment\BeStateV2\Artifact\FixAsk\Taken;
use Experiment\BeStateV2\Artifact\Follow;
use Experiment\BeStateV2\Artifact\Ledger;
use Experiment\BeStateV2\Artifact\Probe;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseFinalize;
use Experiment\BeStateV2\Progress\RunningPrFix\PhasePrFixFinalize;

/**
 * ship: PhaseFinalize|PhasePrFixFinalize → Resting (v2 design 2.2節,
 * state-transitions-v2.ts applyShip 557-657行). $source is typed as the union of
 * the three artifact shapes this reduction models (none/open/withdrawn); the
 * concrete candidate Be selects is decided by which one $source actually is at
 * runtime (BecomingType::match() checks `$value instanceof $paramType`, not the
 * declared property type — vendor/be-framework/be/src/BecomingType.php
 * handleNamedType), the same dispatch research.md 6節's BeGreeting example uses
 * for CasualStyle|FormalStyle.
 *
 * commits=0 (finish=none, artifact left untouched) is out of this reduction's
 * scope — none of the required tests exercise it, and TS's commits=0 branch
 * (applyShip 578-582行) still runs the asks/probe narrowing below when the prior
 * artifact was already open, which would need a fourth branch with no test to
 * anchor it. Only commits>=1 is modelled; commits<1 is a DomainException here.
 *
 * ArtifactMerged as a source is likewise not modelled (only 3 of the 4 artifact
 * states have a ShipFrom* candidate) — shipping again after merge is not part of
 * NormalPathChainTest's flow, and VERB_SPEC's a.from = A_NODE_KEYS is broader
 * than what plan.md's 7-verb reduction chose to exercise.
 */
#[Be([ShipFromNone::class, ShipFromOpen::class, ShipFromWithdrawn::class])]
final readonly class ShipInput
{
    public string $id;
    public ArtifactNone|ArtifactOpen|ArtifactWithdrawn $source;
    public string $ref;
    public string $branch;
    public string $tip;
    public string $base;

    public function __construct(
        PhaseFinalize|PhasePrFixFinalize $prev,
        int $commits,
        string $ref,
        string $branch,
        string $tip,
        string $base,
    ) {
        if ($commits < 1) {
            throw new \DomainException('ship: commits=0 (finish=none) is not modelled in this reduction');
        }
        if ($prev->artifact instanceof ArtifactMerged) {
            throw new \DomainException('ship: source artifact must not already be merged (not modelled in this reduction)');
        }
        $this->id = $prev->id;
        $this->source = $prev->artifact;
        $this->ref = $ref;
        $this->branch = $branch;
        $this->tip = $tip;
        $this->base = $base;
    }

    /**
     * Consumes a taken fix-ask (state-transitions-v2.ts applyShip 610-633行) — the
     * narrowing every ship of an already-open, followed artifact performs,
     * regardless of which ShipFrom* candidate ran. TS also demotes an unconsumed
     * rebase resolve-queue to quiet in the same step; this experiment does not
     * model rebase-ask at all (out of the 7-verb reduction), so that half is
     * omitted rather than reduced to a no-op.
     */
    public static function narrowFollow(Follow $follow): Follow
    {
        $fixAsk = $follow->fixAsk instanceof Taken ? null : $follow->fixAsk;

        return new Follow(
            attention: $follow->attention,
            fixAsk: $fixAsk,
            ledger: $follow->ledger,
            probe: $follow->probe,
        );
    }

    /**
     * design 1.3節: follow is only created when ref is a pull-request URL — a
     * finish=commit branch/sha reference never gets one (state-transitions-v2.ts
     * isPullRequestRef 507行).
     */
    public static function isPullRequestRef(string $ref): bool
    {
        return (bool) preg_match('#^https?://[^\s]+/pull/\d+$#', $ref);
    }

    /**
     * design 1.3節: a freshly created follow's fixed initial shape
     * (state-transitions-v2.ts freshFollow 513行).
     */
    public static function freshFollow(): Follow
    {
        return new Follow(
            attention: new Auto(),
            fixAsk: null,
            ledger: new Ledger(fixAttempts: 0),
            probe: new Probe(proc: null),
        );
    }
}
