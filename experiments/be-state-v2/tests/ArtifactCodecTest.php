<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests;

use DomainException;
use Experiment\BeStateV2\Artifact\ArtifactMerged;
use Experiment\BeStateV2\Artifact\ArtifactNone;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\ArtifactWithdrawn;
use Experiment\BeStateV2\Artifact\Attention\Human;
use Experiment\BeStateV2\Artifact\FixAsk\Taken;
use Experiment\BeStateV2\Cli\ArtifactCodec;
use PHPUnit\Framework\TestCase;

/**
 * Covers ArtifactCodec's input-class matrix (accept/reject representatives for
 * each of its type/attention/fixAsk/ledger/probe discriminators). The path
 * through the actual CLI entry point (bin/advance) is covered separately by
 * tests/CliAdvanceTest.php.
 */
final class ArtifactCodecTest extends TestCase
{
    // --- A4: artifact.type 判別 (受理側 — 4クラス代表) ---

    public function testDecodeNone(): void
    {
        $artifact = ArtifactCodec::decode(['type' => 'none']);
        self::assertInstanceOf(ArtifactNone::class, $artifact);
        self::assertSame(['type' => 'none'], ArtifactCodec::encode($artifact));
    }

    public function testDecodeMerged(): void
    {
        $json = ['type' => 'merged', 'ref' => 'r', 'branch' => 'b', 'tip' => 't', 'base' => 'main'];
        $artifact = ArtifactCodec::decode($json);
        self::assertInstanceOf(ArtifactMerged::class, $artifact);
        self::assertSame($json, ArtifactCodec::encode($artifact));
    }

    public function testDecodeWithdrawn(): void
    {
        $json = [
            'type' => 'withdrawn', 'ref' => 'r', 'branch' => 'b', 'tip' => 't', 'base' => 'main',
            'asked' => true, 'note' => 'why',
        ];
        $artifact = ArtifactCodec::decode($json);
        self::assertInstanceOf(ArtifactWithdrawn::class, $artifact);
        self::assertSame($json, ArtifactCodec::encode($artifact));
    }

    public function testDecodeOpenWithNullFollow(): void
    {
        $json = ['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => null];
        $artifact = ArtifactCodec::decode($json);
        self::assertInstanceOf(ArtifactOpen::class, $artifact);
        self::assertNull($artifact->follow);
        self::assertSame($json, ArtifactCodec::encode($artifact));
    }

    public function testDecodeOpenFollowOmittedIsSameAsNull(): void
    {
        $json = ['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main'];
        $artifact = ArtifactCodec::decode($json);
        self::assertInstanceOf(ArtifactOpen::class, $artifact);
        self::assertNull($artifact->follow);
    }

    public function testDecodeOpenWithFullFollowRoundTrips(): void
    {
        $json = [
            'type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => 'abc', 'base' => 'main',
            'follow' => [
                'attention' => ['type' => 'human', 'reason' => 'fix_limit'],
                'fixAsk' => ['type' => 'taken'],
                'ledger' => ['fixAttempts' => 2],
                'probe' => ['proc' => 'pid:99'],
            ],
        ];
        $artifact = ArtifactCodec::decode($json);
        self::assertInstanceOf(ArtifactOpen::class, $artifact);
        self::assertInstanceOf(Human::class, $artifact->follow?->attention);
        self::assertSame('fix_limit', $artifact->follow->attention->reason);
        self::assertInstanceOf(Taken::class, $artifact->follow->fixAsk);
        self::assertSame(2, $artifact->follow->ledger->fixAttempts);
        self::assertSame('pid:99', $artifact->follow->probe->proc);
        self::assertSame($json, ArtifactCodec::encode($artifact));
    }

    // --- A4 拒否側 ---

    public function testDecodeRejectsMissingType(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode([]);
    }

    public function testDecodeRejectsNullType(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => null]);
    }

    public function testDecodeRejectsUnknownType(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'closed']);
    }

    public function testDecodeRejectsCaseVariantType(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'None']);
    }

    public function testDecodeRejectsPrefixMatchType(): void
    {
        // guards against an implementation that matches "open" by substring
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'reopen']);
    }

    // --- A5 拒否側: follow は非object を許さない ---

    public function testDecodeRejectsNonObjectFollow(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => 'x']);
    }

    // --- A6: attention 判別 ---

    public function testDecodeRejectsMissingAttention(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => [
            'fixAsk' => null, 'ledger' => ['fixAttempts' => 0], 'probe' => ['proc' => null],
        ]]);
    }

    public function testDecodeRejectsUnknownAttentionType(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => [
            'attention' => ['type' => 'manual'], 'fixAsk' => null, 'ledger' => ['fixAttempts' => 0], 'probe' => ['proc' => null],
        ]]);
    }

    public function testDecodeRejectsHumanAttentionWithoutReason(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => [
            'attention' => ['type' => 'human'], 'fixAsk' => null, 'ledger' => ['fixAttempts' => 0], 'probe' => ['proc' => null],
        ]]);
    }

    // --- A7: fixAsk 判別 ---

    /** @return array<string, mixed> */
    private function followWith(mixed $fixAsk): array
    {
        return [
            'attention' => ['type' => 'auto'], 'fixAsk' => $fixAsk,
            'ledger' => ['fixAttempts' => 0], 'probe' => ['proc' => null],
        ];
    }

    public function testDecodeAcceptsBothFixAskClasses(): void
    {
        $pending = ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => $this->followWith(['type' => 'pending'])]);
        $taken = ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => $this->followWith(['type' => 'taken'])]);
        self::assertInstanceOf(ArtifactOpen::class, $pending);
        self::assertInstanceOf(ArtifactOpen::class, $taken);
        // guards against an implementation that always returns Pending regardless of type
        self::assertNotSame($pending->follow?->fixAsk::class, $taken->follow?->fixAsk::class);
    }

    public function testDecodeRejectsUnknownFixAskType(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => $this->followWith(['type' => 'done'])]);
    }

    public function testDecodeRejectsFixAskObjectWithoutType(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => $this->followWith([])]);
    }

    // --- A2/A8 相当 (str/nstr): id は PhaseCodec 側だが、ref を代表に共有ヘルパーを確認 ---

    public function testDecodeRejectsMissingRequiredStringField(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'merged', 'branch' => 'b', 'tip' => 't', 'base' => 'main']);
    }

    public function testDecodeRejectsNonStringRequiredField(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'merged', 'ref' => 123, 'branch' => 'b', 'tip' => 't', 'base' => 'main']);
    }

    // --- A10: follow.ledger ---

    public function testDecodeRejectsMissingLedger(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => [
            'attention' => ['type' => 'auto'], 'fixAsk' => null, 'probe' => ['proc' => null],
        ]]);
    }

    public function testDecodeRejectsNullLedger(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => [
            'attention' => ['type' => 'auto'], 'fixAsk' => null, 'ledger' => null, 'probe' => ['proc' => null],
        ]]);
    }

    public function testDecodeRejectsNonObjectLedger(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => [
            'attention' => ['type' => 'auto'], 'fixAsk' => null, 'ledger' => 'x', 'probe' => ['proc' => null],
        ]]);
    }

    // --- A11: follow.probe ---

    public function testDecodeRejectsMissingProbe(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => [
            'attention' => ['type' => 'auto'], 'fixAsk' => null, 'ledger' => ['fixAttempts' => 0],
        ]]);
    }

    public function testDecodeAcceptsProbeWithNullProc(): void
    {
        $artifact = ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => $this->followWith(null)]);
        self::assertInstanceOf(ArtifactOpen::class, $artifact);
        self::assertNull($artifact->follow?->probe->proc);
    }

    // --- A12: ledger.fixAttempts は int ---

    public function testDecodeAcceptsIntegerFixAttempts(): void
    {
        $artifact = ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => [
            'attention' => ['type' => 'auto'], 'fixAsk' => null, 'ledger' => ['fixAttempts' => 3], 'probe' => ['proc' => null],
        ]]);
        self::assertInstanceOf(ArtifactOpen::class, $artifact);
        self::assertSame(3, $artifact->follow?->ledger->fixAttempts);
    }

    public function testDecodeRejectsStringFixAttempts(): void
    {
        // guards against an implicit (int) cast implementation that would accept "0"
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => [
            'attention' => ['type' => 'auto'], 'fixAsk' => null, 'ledger' => ['fixAttempts' => '0'], 'probe' => ['proc' => null],
        ]]);
    }

    public function testDecodeRejectsFloatFixAttempts(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => [
            'attention' => ['type' => 'auto'], 'fixAsk' => null, 'ledger' => ['fixAttempts' => 1.5], 'probe' => ['proc' => null],
        ]]);
    }

    public function testDecodeRejectsMissingFixAttempts(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'open', 'ref' => 'r', 'branch' => 'b', 'tip' => null, 'base' => 'main', 'follow' => [
            'attention' => ['type' => 'auto'], 'fixAsk' => null, 'ledger' => [], 'probe' => ['proc' => null],
        ]]);
    }

    // --- A13: withdrawn.asked は bool ---

    public function testDecodeAcceptsBothBooleanAskedValues(): void
    {
        $true = ArtifactCodec::decode(['type' => 'withdrawn', 'ref' => 'r', 'branch' => 'b', 'tip' => 't', 'base' => 'main', 'asked' => true, 'note' => null]);
        $false = ArtifactCodec::decode(['type' => 'withdrawn', 'ref' => 'r', 'branch' => 'b', 'tip' => 't', 'base' => 'main', 'asked' => false, 'note' => null]);
        self::assertInstanceOf(ArtifactWithdrawn::class, $true);
        self::assertInstanceOf(ArtifactWithdrawn::class, $false);
        self::assertTrue($true->asked);
        self::assertFalse($false->asked);
    }

    public function testDecodeRejectsMissingAsked(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'withdrawn', 'ref' => 'r', 'branch' => 'b', 'tip' => 't', 'base' => 'main', 'note' => null]);
    }

    public function testDecodeRejectsStringAsked(): void
    {
        // guards against an implicit (bool) cast implementation that would accept any non-empty string
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'withdrawn', 'ref' => 'r', 'branch' => 'b', 'tip' => 't', 'base' => 'main', 'asked' => 'true', 'note' => null]);
    }

    public function testDecodeRejectsIntegerAsked(): void
    {
        $this->expectException(DomainException::class);
        ArtifactCodec::decode(['type' => 'withdrawn', 'ref' => 'r', 'branch' => 'b', 'tip' => 't', 'base' => 'main', 'asked' => 1, 'note' => null]);
    }
}
