<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Progress\RunningPrFix;

use Be\Framework\Exception\UnbecomingException;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Node;
use Ray\InputQuery\Attribute\Input;

/**
 * run={kind:pr_fix, phase:pr_fix} (v2 design 2.1節). Reached only via fix-start
 * (Verbs\FixStart\FixStartInput), which offers this class as the first of two
 * #[Be] candidates; the constructor throws UnbecomingException when the attempt
 * limit was exceeded so Be's type-matching falls through to the second candidate
 * (Progress\Resting, latched to Attention\Human) instead — see FixStartInput's
 * docblock for why the limit itself cannot be expressed as a type constraint.
 * $started is not read again after construction (Be's #[Input] binding needs it
 * as a real constructor parameter to see the value at all); it is kept public
 * only because readonly promoted properties cannot be write-only.
 */
final readonly class PhasePrFix implements Node
{
    public function __construct(
        #[Input] public string $id,
        #[Input] public ArtifactOpen $artifact,
        #[Input] public bool $started,
    ) {
        if (!$this->started) {
            throw new UnbecomingException(
                'fix-start: attempt limit exceeded, not entering pr_fix',
            );
        }
    }
}
