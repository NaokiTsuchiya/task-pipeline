<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests\Support;

use Be\Framework\Becoming;
use Ray\Di\Injector;
use Ray\Di\NullModule;

/**
 * Every test drives a becoming chain through the same DI-free Becoming
 * instance (research.md 9-f: no verb in this reduction needs a binding, so
 * NullModule is enough).
 */
final class Chain
{
    public static function becoming(): Becoming
    {
        return new Becoming(new Injector(new NullModule()));
    }
}
