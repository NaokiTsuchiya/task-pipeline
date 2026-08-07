// task-pipeline/scripts/state-flags.ts
//
// state CLI の **層 1 — 引数パース**。`--name value` の列を Map にし、値の形
// (必須・整数・真偽・nullable・enum・CSV) を検査して usage エラーに落とす。
//
// **Deno API も状態モデルも知らない純粋関数群である** — ここが投げるのは
// CliErrorV2("usage") だけで、state.json には触れない。層の一覧は state-io.ts の冒頭。

import { CliErrorV2 } from "./state-transitions-v2.ts";

export const DEFAULT_LOCK_RETRY_MS = 10_000;
export const DEFAULT_LOCK_MAX_RETRIES = 3;

export function parseCsv(raw: string): string[] {
  return raw === "" ? [] : raw.split(",");
}

export function requireEnumFlag(
  flags: Map<string, string>,
  name: string,
  allowed: readonly string[],
): string {
  const value = requireFlag(flags, name);
  if (!allowed.includes(value)) {
    throw new CliErrorV2(
      "usage",
      `invalid --${name}: ${value} (expected one of ${allowed.join(", ")})`,
    );
  }
  return value;
}

export function optionalEnumFlag(
  flags: Map<string, string>,
  name: string,
  allowed: readonly string[],
): string | undefined {
  if (!flags.has(name)) return undefined;
  return requireEnumFlag(flags, name, allowed);
}

// 非負整数フラグの唯一の解釈。`Number("")` と `Number(" ")` が 0 になる JS の規則に
// 引きずられないよう、**十進数字だけの文字列**を要求する (空文字・空白・符号付き・
// 指数表記・16 進はすべて usage)。空の値は書き手のバグであって 0 の意図ではない。
function parseIntFlag(name: string, raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new CliErrorV2("usage", `invalid --${name}: ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

export function requireIntFlag(
  flags: Map<string, string>,
  name: string,
): number {
  return parseIntFlag(name, requireFlag(flags, name));
}

// 値なしの真偽フラグ。parseFlags は全フラグに値を要求するので、真偽フラグは規約として
// 「省略 = false」「`--<name> true` = true」の2値だけを受け付ける (それ以外の値は usage)。
export function boolFlag(flags: Map<string, string>, name: string): boolean {
  if (!flags.has(name)) return false;
  if (flags.get(name) !== "true") {
    throw new CliErrorV2(
      "usage",
      `invalid --${name}: expected "true" or omit the flag`,
    );
  }
  return true;
}

// "null" という文字列を JSON の null として扱う (nullable なフィールドを CLI フラグで
// 表現するための規約)。実際の値が文字列 "null" になることは運用上想定していない
// (proc/sig/head 等はすべて不透明な id・sha であり、その値そのものが "null" になることは無い)。
export function nullableFlag(raw: string): string | null {
  return raw === "null" ? null : raw;
}

export function parseFlags(rest: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith("--")) {
      throw new CliErrorV2("usage", `unexpected argument: ${tok}`);
    }
    const name = tok.slice(2);
    const value = rest[i + 1];
    if (value === undefined) {
      throw new CliErrorV2("usage", `flag --${name} requires a value`);
    }
    flags.set(name, value);
    i++;
  }
  return flags;
}

export function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) {
    throw new CliErrorV2("usage", `missing required flag: --${name}`);
  }
  return value;
}

export function intFlag(
  flags: Map<string, string>,
  name: string,
  defaultValue: number,
): number {
  if (!flags.has(name)) return defaultValue;
  return parseIntFlag(name, flags.get(name)!);
}

export function validateSessionId(id: string): void {
  if (id === "" || id === "." || id === ".." || id.includes("/")) {
    throw new CliErrorV2("usage", `invalid --id: ${JSON.stringify(id)}`);
  }
}

// 書き込み系 verb が共通で受け付ける lock フラグの取り出し。
export function lockOpts(
  flags: Map<string, string>,
): { retryMs: number; maxRetries: number } {
  return {
    retryMs: intFlag(flags, "lock-retry-ms", DEFAULT_LOCK_RETRY_MS),
    maxRetries: intFlag(flags, "lock-max-retries", DEFAULT_LOCK_MAX_RETRIES),
  };
}

// 成功ペイロードに載せる run の値は、書き込んだ state から読み戻す (リテラルの複製を
