<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Cli;

use Be\Framework\Becoming;
use DomainException;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseImplement;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhasePlan;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseResearch;
use Experiment\BeStateV2\Verbs\Advance\FromPlan;
use Experiment\BeStateV2\Verbs\Advance\FromResearch;
use LogicException;

/**
 * Decodes a JSON-ready array into the progress node its "phase" tag names,
 * drives exactly one becoming step forward via the matching Advance verb, and
 * re-encodes the result. Two edges only (research→plan, plan→implement):
 * demonstrating a subprocess chain needs at least two, since a second
 * invocation must be able to accept the first invocation's output as its own
 * input; wiring the remaining three RunningInitialFull edges would follow the
 * same shape but add nothing to that demonstration.
 */
final class PhaseCodec
{
    /** @param array<string, mixed> $json */
    public static function decode(array $json): PhaseResearch|PhasePlan
    {
        $phase = $json['phase'] ?? null;

        $id = $json['id'] ?? throw new DomainException('missing field: id');
        if (!is_string($id)) {
            throw new DomainException('field id must be a string, got ' . get_debug_type($id));
        }

        $artifactJson = $json['artifact'] ?? throw new DomainException('missing field: artifact');
        if (!is_array($artifactJson)) {
            throw new DomainException('field artifact must be an object, got ' . get_debug_type($artifactJson));
        }

        $artifact = ArtifactCodec::decode($artifactJson);

        return match ($phase) {
            'research' => new PhaseResearch(id: $id, artifact: $artifact),
            // PhasePlan's constructor takes only `#[Input] PhaseResearch $prev`
            // (src/progress/RunningInitialFull/PhasePlan.php) and copies id/artifact from it
            // — there is no constructor path that accepts id/artifact directly. Rehydrating a
            // PhasePlan from JSON therefore requires reconstructing a stand-in PhaseResearch
            // with the same id/artifact purely to satisfy that signature; PhasePlan discards
            // it immediately (it never stores $prev), so the result is identical to what the
            // real chain would have produced. Psalm accepts this because the *type* matches —
            // nothing in the type system checks that the stand-in is a faithful rehydration
            // rather than a fabricated one; that guarantee is this decode() method's job, not
            // becoming's.
            'plan' => new PhasePlan(new PhaseResearch(id: $id, artifact: $artifact)),
            default => throw new DomainException(
                'unknown or unsupported phase: ' . (is_string($phase) ? "\"$phase\"" : get_debug_type($phase))
                . ' (supported: research, plan)',
            ),
        };
    }

    /** @return array<string, mixed> */
    public static function encode(PhaseResearch|PhasePlan|PhaseImplement $node): array
    {
        return [
            'phase' => match (true) {
                $node instanceof PhaseResearch => 'research',
                $node instanceof PhasePlan => 'plan',
                $node instanceof PhaseImplement => 'implement',
            },
            'id' => $node->id,
            'artifact' => ArtifactCodec::encode($node->artifact),
        ];
    }

    /**
     * Drives becoming one step forward. Becoming::__invoke() is declared to
     * return plain `object` (vendor/be-framework/be/src/Becoming.php:53-54) —
     * every caller must narrow that back down itself; the type system gives no
     * static guarantee the result is PhasePlan|PhaseImplement, only whatever
     * the #[Be] attribute on FromResearch/FromPlan happens to declare today.
     * This is likewise outside becoming's own type safety.
     */
    public static function advance(PhaseResearch|PhasePlan $node, Becoming $becoming): PhasePlan|PhaseImplement
    {
        $result = match (true) {
            $node instanceof PhaseResearch => $becoming(new FromResearch($node)),
            $node instanceof PhasePlan => $becoming(new FromPlan($node)),
        };

        return match (true) {
            $result instanceof PhasePlan => $result,
            $result instanceof PhaseImplement => $result,
            // Unreachable from any JSON this CLI accepts: FromResearch/FromPlan's #[Be]
            // attributes fix their target class statically (src/verbs/Advance/
            // FromResearch.php:23, FromPlan.php:17), so becoming's result type here is
            // determined at compile time, not by external input. Kept as a defensive
            // guard rather than an assert so a future edit that changes those
            // attributes fails loudly here instead of silently mis-tagging output.
            default => throw new LogicException('unexpected becoming result: ' . get_debug_type($result)),
        };
    }
}
