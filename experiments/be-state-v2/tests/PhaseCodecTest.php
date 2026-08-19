<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests;

use Be\Framework\Becoming;
use DomainException;
use Experiment\BeStateV2\Cli\PhaseCodec;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseImplement;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhasePlan;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseResearch;
use Experiment\BeStateV2\Tests\Support\Chain;
use PHPUnit\Framework\TestCase;

/**
 * Covers PhaseCodec's phase/id/artifact input-class matrix and the
 * decode/advance/encode round trip.
 */
final class PhaseCodecTest extends TestCase
{
    private Becoming $becoming;

    protected function setUp(): void
    {
        $this->becoming = Chain::becoming();
    }

    // --- A1: phase 判別 (受理側) ---

    public function testDecodeResearch(): void
    {
        $node = PhaseCodec::decode(['phase' => 'research', 'id' => 'task-1', 'artifact' => ['type' => 'none']]);
        self::assertInstanceOf(PhaseResearch::class, $node);
        self::assertSame('task-1', $node->id);
    }

    public function testDecodePlanRehydratesWithSameIdAndArtifact(): void
    {
        $node = PhaseCodec::decode(['phase' => 'plan', 'id' => 'task-1', 'artifact' => ['type' => 'none']]);
        self::assertInstanceOf(PhasePlan::class, $node);
        self::assertSame('task-1', $node->id);
    }

    // --- A1 拒否側 ---

    public function testDecodeRejectsMissingPhase(): void
    {
        $this->expectException(DomainException::class);
        PhaseCodec::decode(['id' => 'task-1', 'artifact' => ['type' => 'none']]);
    }

    public function testDecodeRejectsNullPhase(): void
    {
        $this->expectException(DomainException::class);
        PhaseCodec::decode(['phase' => null, 'id' => 'task-1', 'artifact' => ['type' => 'none']]);
    }

    public function testDecodeRejectsUnsupportedButValidPhaseName(): void
    {
        // "implement" is a real phase name elsewhere in the domain but this CLI only wires
        // research/plan — guards against a prefix/substring match implementation
        $this->expectException(DomainException::class);
        PhaseCodec::decode(['phase' => 'implement', 'id' => 'task-1', 'artifact' => ['type' => 'none']]);
    }

    public function testDecodeRejectsCaseVariantPhase(): void
    {
        $this->expectException(DomainException::class);
        PhaseCodec::decode(['phase' => 'Research', 'id' => 'task-1', 'artifact' => ['type' => 'none']]);
    }

    public function testDecodeRejectsEmptyStringPhase(): void
    {
        $this->expectException(DomainException::class);
        PhaseCodec::decode(['phase' => '', 'id' => 'task-1', 'artifact' => ['type' => 'none']]);
    }

    public function testDecodeRejectsNonStringPhase(): void
    {
        // guards against an implementation that treats a falsy non-string value as "research"
        $this->expectException(DomainException::class);
        PhaseCodec::decode(['phase' => 0, 'id' => 'task-1', 'artifact' => ['type' => 'none']]);
    }

    // --- A2: id ---

    public function testDecodeAcceptsEmptyStringId(): void
    {
        $node = PhaseCodec::decode(['phase' => 'research', 'id' => '', 'artifact' => ['type' => 'none']]);
        self::assertSame('', $node->id);
    }

    public function testDecodeRejectsMissingId(): void
    {
        $this->expectException(DomainException::class);
        PhaseCodec::decode(['phase' => 'research', 'artifact' => ['type' => 'none']]);
    }

    public function testDecodeRejectsNonStringId(): void
    {
        $this->expectException(DomainException::class);
        PhaseCodec::decode(['phase' => 'research', 'id' => 123, 'artifact' => ['type' => 'none']]);
    }

    // --- A3: artifact ---

    public function testDecodeRejectsMissingArtifact(): void
    {
        $this->expectException(DomainException::class);
        PhaseCodec::decode(['phase' => 'research', 'id' => 'task-1']);
    }

    public function testDecodeRejectsStringArtifact(): void
    {
        // a plausible near-miss: passing the bare type string instead of an object
        $this->expectException(DomainException::class);
        PhaseCodec::decode(['phase' => 'research', 'id' => 'task-1', 'artifact' => 'none']);
    }

    // --- encode / advance round trip ---

    public function testAdvanceFromResearchProducesPlan(): void
    {
        $node = PhaseCodec::decode(['phase' => 'research', 'id' => 'task-1', 'artifact' => ['type' => 'none']]);
        $result = PhaseCodec::advance($node, $this->becoming);
        self::assertInstanceOf(PhasePlan::class, $result);
        self::assertSame(['phase' => 'plan', 'id' => 'task-1', 'artifact' => ['type' => 'none']], PhaseCodec::encode($result));
    }

    public function testAdvanceFromPlanProducesImplement(): void
    {
        $node = PhaseCodec::decode(['phase' => 'plan', 'id' => 'task-1', 'artifact' => ['type' => 'none']]);
        $result = PhaseCodec::advance($node, $this->becoming);
        self::assertInstanceOf(PhaseImplement::class, $result);
        self::assertSame(['phase' => 'implement', 'id' => 'task-1', 'artifact' => ['type' => 'none']], PhaseCodec::encode($result));
    }

    public function testChainedAdvanceMatchesDirectBecomingChain(): void
    {
        // cross-checks the JSON round trip against the object chain
        // tests/NormalPathChainTest.php drives directly
        $viaCodec = PhaseCodec::decode(['phase' => 'plan', 'id' => 'task-1', 'artifact' => ['type' => 'none']]);
        $viaCodecResult = PhaseCodec::advance($viaCodec, $this->becoming);

        $research = new PhaseResearch(id: 'task-1', artifact: new \Experiment\BeStateV2\Artifact\ArtifactNone());
        $plan = ($this->becoming)(new \Experiment\BeStateV2\Verbs\Advance\FromResearch($research));
        self::assertInstanceOf(PhasePlan::class, $plan);
        $directResult = ($this->becoming)(new \Experiment\BeStateV2\Verbs\Advance\FromPlan($plan));

        self::assertEquals($directResult, $viaCodecResult);
    }
}
