<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Cli;

use DomainException;
use Experiment\BeStateV2\Artifact\ArtifactMerged;
use Experiment\BeStateV2\Artifact\ArtifactNone;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\ArtifactWithdrawn;
use Experiment\BeStateV2\Artifact\Attention\Auto;
use Experiment\BeStateV2\Artifact\Attention\Human;
use Experiment\BeStateV2\Artifact\FixAsk\Pending;
use Experiment\BeStateV2\Artifact\FixAsk\Taken;
use Experiment\BeStateV2\Artifact\Follow;
use Experiment\BeStateV2\Artifact\Ledger;
use Experiment\BeStateV2\Artifact\Probe;

/**
 * Decodes/encodes the ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn
 * union (and ArtifactOpen's nested follow) to/from a JSON-ready array. This is
 * the part of the round trip that sits outside becoming's constructor-driven
 * type safety: Psalm can confirm decode() returns one of the four classes,
 * but nothing checks that it picked the class actually matching the JSON's
 * shape — that correctness rests on the match() arms below and this file's
 * tests, not on the type system.
 */
final class ArtifactCodec
{
    /** @param array<string, mixed> $json */
    public static function decode(array $json): ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn
    {
        $type = $json['type'] ?? null;

        return match ($type) {
            'none' => new ArtifactNone(),
            'open' => new ArtifactOpen(
                ref: self::str($json, 'ref'),
                branch: self::str($json, 'branch'),
                tip: self::nstr($json, 'tip'),
                base: self::str($json, 'base'),
                follow: self::decodeOptionalFollow($json),
            ),
            'merged' => new ArtifactMerged(
                ref: self::str($json, 'ref'),
                branch: self::str($json, 'branch'),
                tip: self::str($json, 'tip'),
                base: self::str($json, 'base'),
            ),
            'withdrawn' => new ArtifactWithdrawn(
                ref: self::str($json, 'ref'),
                branch: self::str($json, 'branch'),
                tip: self::str($json, 'tip'),
                base: self::str($json, 'base'),
                asked: self::bool($json, 'asked'),
                note: self::nstr($json, 'note'),
            ),
            default => throw new DomainException('unknown artifact.type: ' . self::describe($type)),
        };
    }

    /** @return array<string, mixed> */
    public static function encode(ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn $artifact): array
    {
        return match (true) {
            $artifact instanceof ArtifactNone => ['type' => 'none'],
            $artifact instanceof ArtifactOpen => [
                'type' => 'open',
                'ref' => $artifact->ref,
                'branch' => $artifact->branch,
                'tip' => $artifact->tip,
                'base' => $artifact->base,
                'follow' => $artifact->follow === null ? null : self::encodeFollow($artifact->follow),
            ],
            $artifact instanceof ArtifactMerged => [
                'type' => 'merged',
                'ref' => $artifact->ref,
                'branch' => $artifact->branch,
                'tip' => $artifact->tip,
                'base' => $artifact->base,
            ],
            $artifact instanceof ArtifactWithdrawn => [
                'type' => 'withdrawn',
                'ref' => $artifact->ref,
                'branch' => $artifact->branch,
                'tip' => $artifact->tip,
                'base' => $artifact->base,
                'asked' => $artifact->asked,
                'note' => $artifact->note,
            ],
        };
    }

    /** @param array<string, mixed> $json */
    private static function decodeOptionalFollow(array $json): Follow|null
    {
        $followJson = $json['follow'] ?? null;
        if ($followJson === null) {
            return null;
        }

        if (!is_array($followJson)) {
            throw new DomainException('field artifact.follow must be an object or null');
        }

        return self::decodeFollow($followJson);
    }

    /** @param array<string, mixed> $json */
    private static function decodeFollow(array $json): Follow
    {
        $attentionJson = $json['attention'] ?? throw new DomainException('missing field: artifact.follow.attention');
        if (!is_array($attentionJson)) {
            throw new DomainException('field artifact.follow.attention must be an object');
        }
        $attention = match ($attentionJson['type'] ?? null) {
            'auto' => new Auto(),
            'human' => new Human(reason: self::str($attentionJson, 'reason')),
            default => throw new DomainException('unknown follow.attention.type: ' . self::describe($attentionJson['type'] ?? null)),
        };

        $fixAskJson = $json['fixAsk'] ?? null;
        $fixAsk = self::decodeFixAsk($fixAskJson);

        $ledgerJson = $json['ledger'] ?? throw new DomainException('missing field: artifact.follow.ledger');
        if (!is_array($ledgerJson)) {
            throw new DomainException('field artifact.follow.ledger must be an object');
        }

        $probeJson = $json['probe'] ?? throw new DomainException('missing field: artifact.follow.probe');
        if (!is_array($probeJson)) {
            throw new DomainException('field artifact.follow.probe must be an object');
        }

        return new Follow(
            attention: $attention,
            fixAsk: $fixAsk,
            ledger: new Ledger(fixAttempts: self::int($ledgerJson, 'fixAttempts')),
            probe: new Probe(proc: self::nstr($probeJson, 'proc')),
        );
    }

    private static function decodeFixAsk(mixed $fixAskJson): Pending|Taken|null
    {
        if ($fixAskJson === null) {
            return null;
        }

        if (!is_array($fixAskJson)) {
            throw new DomainException('field artifact.follow.fixAsk must be an object or null');
        }

        return match ($fixAskJson['type'] ?? null) {
            'pending' => new Pending(),
            'taken' => new Taken(),
            default => throw new DomainException('unknown follow.fixAsk.type: ' . self::describe($fixAskJson['type'] ?? null)),
        };
    }

    /** @return array<string, mixed> */
    private static function encodeFollow(Follow $follow): array
    {
        return [
            'attention' => match (true) {
                $follow->attention instanceof Auto => ['type' => 'auto'],
                $follow->attention instanceof Human => ['type' => 'human', 'reason' => $follow->attention->reason],
            },
            'fixAsk' => match (true) {
                $follow->fixAsk === null => null,
                $follow->fixAsk instanceof Pending => ['type' => 'pending'],
                $follow->fixAsk instanceof Taken => ['type' => 'taken'],
            },
            'ledger' => ['fixAttempts' => $follow->ledger->fixAttempts],
            'probe' => ['proc' => $follow->probe->proc],
        ];
    }

    /** @param array<string, mixed> $json */
    private static function str(array $json, string $key): string
    {
        $value = $json[$key] ?? throw new DomainException("missing field: $key");
        if (!is_string($value)) {
            throw new DomainException("field $key must be a string, got " . self::describe($value));
        }

        return $value;
    }

    /** @param array<string, mixed> $json */
    private static function nstr(array $json, string $key): string|null
    {
        $value = $json[$key] ?? null;
        if ($value !== null && !is_string($value)) {
            throw new DomainException("field $key must be a string or null, got " . self::describe($value));
        }

        return $value;
    }

    /** @param array<string, mixed> $json */
    private static function int(array $json, string $key): int
    {
        $value = $json[$key] ?? throw new DomainException("missing field: $key");
        if (!is_int($value)) {
            throw new DomainException("field $key must be an integer, got " . self::describe($value));
        }

        return $value;
    }

    /** @param array<string, mixed> $json */
    private static function bool(array $json, string $key): bool
    {
        $value = $json[$key] ?? throw new DomainException("missing field: $key");
        if (!is_bool($value)) {
            throw new DomainException("field $key must be a boolean, got " . self::describe($value));
        }

        return $value;
    }

    private static function describe(mixed $value): string
    {
        return is_string($value) ? "\"$value\"" : get_debug_type($value);
    }
}
