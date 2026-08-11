<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\FixStart;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\Attention\Auto;
use Experiment\BeStateV2\Artifact\Attention\Human;
use Experiment\BeStateV2\Artifact\FixAsk\Pending;
use Experiment\BeStateV2\Artifact\FixAsk\Taken;
use Experiment\BeStateV2\Artifact\Follow;
use Experiment\BeStateV2\Artifact\Ledger;
use Experiment\BeStateV2\Progress\Resting;
use Experiment\BeStateV2\Progress\RunningPrFix\PhasePrFix;

/**
 * fix-start: Resting×ArtifactOpen(attention=auto, fixAsk=pending) → dynamic
 * (state-transitions-v2.ts applyFixStart 874-931行, FIX_ATTEMPT_LIMIT=3 @866行).
 *
 * The from-guards (attention/fixAsk) are ordinary construction-time checks —
 * DomainException, same mechanism as merged/restore/attention-set. The
 * attempts>3 branch is different: it picks between two *result types*
 * (PhasePrFix vs Resting), which Be's type system cannot express as a
 * constructor-parameter type (both candidates would need the exact same
 * $started value to type-match either way — BecomingType::match() only checks
 * whether a value is `instanceof` the declared param type, not an arbitrary
 * boolean). Instead this experiment uses the mechanism research.md 6節
 * documents for exactly this situation: #[Be] lists PhasePrFix first;
 * PhasePrFix's own constructor throws UnbecomingException when $started is
 * false, and Be's type-matching (performTypeMatching, vendor/be-framework/be/
 * src/Being.php) falls through to the second candidate. This is why defect #9
 * is judged "構築時に落ちる" rather than "表現不能" — the limit itself is still a
 * runtime decision, just one whose *outcome* the type system then enforces.
 */
#[Be([PhasePrFix::class, Resting::class])]
final readonly class FixStartInput
{
    public const ATTEMPT_LIMIT = 3;

    public string $id;
    public bool $started;
    public ArtifactOpen $artifact;

    public function __construct(Resting $prev)
    {
        if (!($prev->artifact instanceof ArtifactOpen)) {
            throw new \DomainException('fix-start requires an ArtifactOpen artifact');
        }
        $open = $prev->artifact;
        if ($open->follow === null) {
            throw new \DomainException('fix-start requires an artifact with a follow');
        }
        $follow = $open->follow;
        if (!($follow->attention instanceof Auto)) {
            throw new \DomainException('fix-start requires follow.attention === auto');
        }
        if (!($follow->fixAsk instanceof Pending)) {
            throw new \DomainException('fix-start requires follow.fixAsk === pending');
        }

        $nextAttempts = $follow->ledger->fixAttempts + 1;
        $this->id = $prev->id;
        $this->started = $nextAttempts <= self::ATTEMPT_LIMIT;
        $this->artifact = new ArtifactOpen(
            ref: $open->ref,
            branch: $open->branch,
            tip: $open->tip,
            base: $open->base,
            follow: $this->started
                ? new Follow(
                    attention: $follow->attention,
                    fixAsk: new Taken(),
                    ledger: new Ledger(fixAttempts: $nextAttempts),
                    probe: $follow->probe,
                )
                : new Follow(
                    attention: new Human('fix_limit'),
                    fixAsk: $follow->fixAsk,
                    ledger: new Ledger(fixAttempts: $nextAttempts),
                    probe: $follow->probe,
                ),
        );
    }
}
