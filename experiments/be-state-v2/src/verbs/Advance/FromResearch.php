<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\Advance;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseResearch;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhasePlan;

/**
 * advance research→plan, one of the "each edge gets its own becoming link"
 * (plan.md 1節「advance に汎用クラスを作らない理由」). The phase classes
 * (PhaseResearch..PhaseFinalize) deliberately carry no #[Be] of their own —
 * Becoming::__invoke() loops until the *current* object has no #[Be] attribute
 * (vendor/be-framework/be/src/Becoming.php), so if PhaseResearch pointed straight
 * at PhasePlan and PhasePlan at PhaseImplement, a single claim call would cascade
 * through the entire chain in one shot instead of stopping for each of the 5
 * separate advance calls NormalPathChainTest makes. Putting #[Be] on a thin
 * per-edge wrapper class instead, and nowhere else, is what keeps each advance a
 * distinct, externally-triggered step.
 */
#[Be([PhasePlan::class])]
final readonly class FromResearch
{
    public function __construct(
        public PhaseResearch $prev,
    ) {
    }
}
