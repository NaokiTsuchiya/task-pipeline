// task-pipeline/scripts/state-schema.test.ts
//
// state-schema.ts (checkState / compileChecker / collectSchemaNodes) のテスト。
//
//   deno test --allow-read=<repo> task-pipeline/scripts/state-schema.test.ts
//   または: sh tests/state-schema.test.sh (deno 不在なら SKIP + exit 0)
//
// 依存ゼロ・ネットワーク不要 (ajv-agreement の npm:ajv 取得を除く。取得不能環境では
// そのテストのみ早期 return で SKIP 相当になり、他は全て PASS する)。
//
// 系統:
//   1. meta-lint            — state.schema.json 自体の形式検査
//   2. mutation-generation  — スキーマから機械生成した invalid ケース群
//   3. fixed-walker-cases   — walker のキーワード実装そのものを検査する固定ケース
//   4. valid-fixtures       — 正当なファイルを誤って拒否しないことの確認
//   5. ajv-agreement        — ajv (draft 2020-12) との判定一致
//   6. no-npm-jsr-references — state-schema.ts の実行時依存ゼロを grep で固定
//   7. init-throws-on-unknown-keyword — fail-closed の確認

import {
  ALLOWED_KEYWORDS,
  type CheckResult,
  checkState,
  collectSchemaNodes,
  compileChecker,
} from "./state-schema.ts";

import schemaJsonRaw from "./state.schema.json" with { type: "json" };
import validLegacyLiveRaw from "../../tests/fixtures/state-cli/valid-legacy-live.json" with {
  type: "json",
};
import validSkillExampleRaw from "../../tests/fixtures/state-cli/valid-skill-example.json" with {
  type: "json",
};
import validWatchRebaseRaw from "../../tests/fixtures/state-cli/valid-watch-rebase.json" with {
  type: "json",
};

// JSON静的importは中身に応じた精密なリテラル型が付くため、汎用ヘルパ (isPlainRecord 等)
// で扱えるよう unknown に戻す。state-schema.ts 自身の checkState も unknown を受ける。
const schemaJson: unknown = schemaJsonRaw;
const validLegacyLive: unknown = validLegacyLiveRaw;
const validSkillExample: unknown = validSkillExampleRaw;
const validWatchRebase: unknown = validWatchRebaseRaw;

// ---------------------------------------------------------------------------
// 汎用ヘルパ (JSON 値の型ガード・パスベースの読み書き)
// ---------------------------------------------------------------------------

type PathSegment = string | number;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["type"];
  if (Array.isArray(t)) return t.map((x) => String(x));
  if (typeof t === "string") return [t];
  return [];
}

function defsOf(schema: unknown): Record<string, unknown> {
  if (isPlainRecord(schema)) {
    const defs = schema["$defs"];
    if (isPlainRecord(defs)) return defs;
  }
  return {};
}

function describePath(path: PathSegment[]): string {
  let result = "";
  for (const seg of path) {
    if (typeof seg === "number") {
      result += `[${seg}]`;
    } else {
      result = result === "" ? seg : `${result}.${seg}`;
    }
  }
  return result;
}

function getAt(root: unknown, path: PathSegment[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (Array.isArray(cur) && typeof seg === "number") {
      cur = cur[seg];
    } else if (isPlainRecord(cur) && typeof seg === "string") {
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function deleteAt(root: unknown, path: PathSegment[]): unknown {
  const clone = structuredClone(root);
  const parent = getAt(clone, path.slice(0, -1));
  const lastKey = path[path.length - 1];
  if (isPlainRecord(parent) && typeof lastKey === "string") {
    delete parent[lastKey];
  } else if (Array.isArray(parent) && typeof lastKey === "number") {
    parent.splice(lastKey, 1);
  }
  return clone;
}

function replaceAt(
  root: unknown,
  path: PathSegment[],
  value: unknown,
): unknown {
  const clone = structuredClone(root);
  const parent = getAt(clone, path.slice(0, -1));
  const lastKey = path[path.length - 1];
  if (isPlainRecord(parent) && typeof lastKey === "string") {
    parent[lastKey] = value;
  } else if (Array.isArray(parent) && typeof lastKey === "number") {
    parent[lastKey] = value;
  }
  return clone;
}

function injectAt(
  root: unknown,
  path: PathSegment[],
  key: string,
  value: unknown,
): unknown {
  const clone = structuredClone(root);
  const target = getAt(clone, path);
  if (isPlainRecord(target)) {
    target[key] = value;
  }
  return clone;
}

function assertOk(result: CheckResult, label: string): void {
  if (!result.ok) {
    throw new Error(
      `${label}: expected ok, got fail at "${result.path}": ${result.message}`,
    );
  }
}

function assertFail(result: CheckResult, label: string): void {
  if (result.ok) {
    throw new Error(`${label}: expected fail, got ok`);
  }
}

// ---------------------------------------------------------------------------
// 1. meta-lint — state.schema.json 自体の形式検査 (要求3a)
// ---------------------------------------------------------------------------

Deno.test("meta-lint", async (t) => {
  const nodes = collectSchemaNodes(schemaJson);

  await t.step(
    "all object nodes have properties + additionalProperties:false",
    () => {
      for (const { schemaPath, node } of nodes) {
        if (!typesOf(node).includes("object")) continue;
        if (!isPlainRecord(node["properties"])) {
          throw new Error(`${schemaPath}: object node missing "properties"`);
        }
        if (node["additionalProperties"] !== false) {
          throw new Error(
            `${schemaPath}: object node missing additionalProperties:false`,
          );
        }
      }
    },
  );

  await t.step("all required keys exist in properties", () => {
    for (const { schemaPath, node } of nodes) {
      const required = node["required"];
      if (!Array.isArray(required)) continue;
      const properties = isPlainRecord(node["properties"])
        ? node["properties"]
        : {};
      for (const key of required) {
        if (!(String(key) in properties)) {
          throw new Error(
            `${schemaPath}: required key "${key}" not present in properties`,
          );
        }
      }
    }
  });

  await t.step("all $ref resolve within $defs", () => {
    const defs = defsOf(schemaJson);
    for (const { schemaPath, node } of nodes) {
      const ref = node["$ref"];
      if (typeof ref !== "string") continue;
      if (!ref.startsWith("#/$defs/")) {
        throw new Error(`${schemaPath}: unsupported $ref form "${ref}"`);
      }
      const name = ref.slice("#/$defs/".length);
      if (!(name in defs)) {
        throw new Error(
          `${schemaPath}: $ref "${ref}" does not resolve within $defs`,
        );
      }
    }
  });

  await t.step("no keywords outside the fixed set", () => {
    for (const { schemaPath, node } of nodes) {
      for (const key of Object.keys(node)) {
        if (!ALLOWED_KEYWORDS.has(key)) {
          throw new Error(`${schemaPath}: unsupported schema keyword "${key}"`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. mutation-generation — スキーマから機械生成した invalid ケース群 (要求3b)
// ---------------------------------------------------------------------------

interface MutationCase {
  description: string;
  value: unknown;
}

const schemaDefs = defsOf(schemaJson);

function resolveNode(
  rawNode: Record<string, unknown>,
): Record<string, unknown> {
  const ref = rawNode["$ref"];
  if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
    const target = schemaDefs[ref.slice("#/$defs/".length)];
    if (isPlainRecord(target)) return target;
  }
  return rawNode;
}

// wrong-type の代表値: node の許容 type 集合に含まれないものを先頭から選ぶ
// (含まれなければ確実に型違いになる)。
function wrongTypeValue(types: string[]): unknown {
  const candidates: [string, unknown][] = [
    ["string", "__mutation_wrong_type__"],
    ["integer", 999],
    ["boolean", true],
    ["object", { __mutation_wrong_type__: true }],
    ["array", ["__mutation_wrong_type__"]],
    ["null", null],
  ];
  for (const [t, v] of candidates) {
    if (!types.includes(t)) return v;
  }
  throw new Error(
    `cannot synthesize a wrong-type value for types: ${types.join(",")}`,
  );
}

// スキーマと具体値 (baseRoot) を共走査し、各 object ノードの各プロパティについて
// required削除・wrong-type置換・enum逸脱(enumを持つ場合)・minimum未満(minimumを持つ場合)、
// 各 object ノードについて未知キー注入、をそれぞれ機械生成する。
function* generateMutations(baseRoot: unknown): Generator<MutationCase> {
  function* walkNode(
    rawNode: unknown,
    path: PathSegment[],
  ): Generator<MutationCase> {
    if (!isPlainRecord(rawNode)) return;
    const node = resolveNode(rawNode);
    const types = typesOf(node);
    const value = getAt(baseRoot, path);

    if (types.includes("object") && isPlainRecord(value)) {
      const requiredRaw = node["required"];
      const required = Array.isArray(requiredRaw)
        ? requiredRaw.map(String)
        : [];
      const propertiesRaw = node["properties"];
      const properties = isPlainRecord(propertiesRaw) ? propertiesRaw : {};

      for (const key of required) {
        if (key in value) {
          yield {
            description: `required missing: ${describePath(path.concat(key))}`,
            value: deleteAt(baseRoot, path.concat(key)),
          };
        }
      }

      for (const key of Object.keys(properties)) {
        if (!(key in value)) continue;
        const childRaw = properties[key];
        if (!isPlainRecord(childRaw)) continue;
        const child = resolveNode(childRaw);
        const childTypes = typesOf(child);
        const childPath = path.concat(key);

        yield {
          description: `wrong type: ${describePath(childPath)}`,
          value: replaceAt(baseRoot, childPath, wrongTypeValue(childTypes)),
        };

        const childEnum = child["enum"];
        if (Array.isArray(childEnum)) {
          yield {
            description: `enum violation: ${describePath(childPath)}`,
            value: replaceAt(baseRoot, childPath, "__mutation_invalid_enum__"),
          };
        }

        const childMinimum = child["minimum"];
        if (typeof childMinimum === "number") {
          yield {
            description: `below minimum: ${describePath(childPath)}`,
            value: replaceAt(baseRoot, childPath, childMinimum - 1),
          };
        }
      }

      const loc = describePath(path);
      yield {
        description: `unknown key injected: ${loc === "" ? "(root)" : loc}`,
        value: injectAt(baseRoot, path, "__mutation_unknown_key__", true),
      };

      for (const key of Object.keys(properties)) {
        if (!(key in value)) continue;
        yield* walkNode(properties[key], path.concat(key));
      }
    } else if (
      types.includes("array") && Array.isArray(value) && value.length > 0
    ) {
      yield* walkNode(node["items"], path.concat(0));
    }
  }

  yield* walkNode(schemaJson, []);
}

Deno.test("mutation-generation", async (t) => {
  const mutations = Array.from(generateMutations(validWatchRebase));
  console.log(`mutation cases: ${mutations.length}`);
  if (mutations.length === 0) {
    throw new Error("mutation-generation produced zero cases");
  }
  for (const m of mutations) {
    await t.step(m.description, () => {
      assertFail(checkState(m.value), m.description);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. fixed-walker-cases — walker のキーワード実装そのものを検査する固定ケース (要求3c)
// ---------------------------------------------------------------------------

Deno.test("fixed-walker-cases", async (t) => {
  await t.step(
    "a. typeof null === object に騙されない (non-nullable object に null)",
    () => {
      const mutated = replaceAt(validWatchRebase, [
        "queue",
        0,
        "review",
        "watch",
      ], null);
      assertFail(checkState(mutated), "review.watch = null");
    },
  );

  await t.step("b. Array.isArray で配列判定 (queue を {} に置換)", () => {
    const mutated = replaceAt(validWatchRebase, ["queue"], {});
    assertFail(checkState(mutated), "queue = {}");
  });

  await t.step(
    "c. Number.isInteger が minimum より先に効く (attempts = 1.5)",
    () => {
      const mutated = replaceAt(
        validWatchRebase,
        ["queue", 0, "attempts"],
        1.5,
      );
      assertFail(checkState(mutated), "attempts = 1.5");
    },
  );

  await t.step(
    "d. nullable string (session) は null / 文字列の両方を受理する",
    () => {
      const withNull = replaceAt(
        validWatchRebase,
        ["queue", 0, "session"],
        null,
      );
      assertOk(checkState(withNull), "session = null");
      const withString = replaceAt(
        validWatchRebase,
        ["queue", 0, "session"],
        "sess-xyz",
      );
      assertOk(checkState(withString), "session = string");
    },
  );

  await t.step(
    "e. nullable object (review) が null のとき properties/required をスキップ",
    () => {
      const mutated = replaceAt(validWatchRebase, ["queue", 0, "review"], null);
      assertOk(checkState(mutated), "review = null");
    },
  );

  await t.step(
    "f. nullable-enum (phase) の null許容とenum membership、非null-enum (status) との対比",
    () => {
      assertOk(
        checkState(replaceAt(validWatchRebase, ["queue", 0, "phase"], null)),
        "phase = null",
      );
      assertOk(
        checkState(replaceAt(validWatchRebase, ["queue", 0, "phase"], "plan")),
        "phase = plan",
      );
      assertFail(
        checkState(replaceAt(validWatchRebase, ["queue", 0, "phase"], "bogus")),
        "phase = bogus",
      );
      assertFail(
        checkState(
          replaceAt(validWatchRebase, ["queue", 0, "status"], "bogus"),
        ),
        "status = bogus (non-null enum)",
      );
    },
  );

  await t.step(
    "g. ネストした additionalProperties:false が正しい階層の properties 集合を参照する",
    () => {
      const unknownInWatch = injectAt(
        validWatchRebase,
        ["queue", 0, "review", "watch"],
        "__unknown__",
        1,
      );
      assertFail(checkState(unknownInWatch), "unknown key inside review.watch");

      // review.watch のキー名を top-level 直下に注入しても、top-level の
      // properties 集合には無いので additionalProperties:false に引っかかる
      // (階層混同 — グローバルなキー集合を参照してしまう誤実装を検出する)。
      const watchKeyAtRoot = injectAt(
        validWatchRebase,
        [],
        "state",
        "watching",
      );
      assertFail(
        checkState(watchKeyAtRoot),
        'top-level "state" (borrowed from review.watch)',
      );
    },
  );

  await t.step(
    "h. 違反時の path が正しいネスト位置を指す (queue[3].phase)",
    () => {
      const item = getAt(validWatchRebase, ["queue", 0]);
      // structuredClone は同一クローン呼び出し内で共有参照を保ったまま複製する
      // ("[item, item, item, item]" をそのまま置換すると、後段の replaceAt の
      // structuredClone でも4要素が同一オブジェクトを指し続けてしまう) ため、
      // 4要素それぞれを個別に structuredClone して独立させる。
      const fourItems = replaceAt(validWatchRebase, ["queue"], [
        structuredClone(item),
        structuredClone(item),
        structuredClone(item),
        structuredClone(item),
      ]);
      const corrupted = replaceAt(fourItems, ["queue", 3, "phase"], "bogus");
      const result = checkState(corrupted);
      assertFail(result, "queue[3].phase = bogus");
      if (!result.ok && result.path !== "queue[3].phase") {
        throw new Error(`expected path "queue[3].phase", got "${result.path}"`);
      }
    },
  );

  await t.step(
    "i. スカラー items 配列 (promoted) の要素そのものへの wrong-type",
    () => {
      const mutated = replaceAt(validWatchRebase, ["promoted"], [
        "t-promoted-1",
        123,
      ]);
      assertFail(checkState(mutated), "promoted = [string, number]");
    },
  );
});

// ---------------------------------------------------------------------------
// 4. valid-fixtures — 正当なファイルを誤って拒否しないことの確認 (要求4)
// ---------------------------------------------------------------------------

Deno.test("valid-fixtures", async (t) => {
  await t.step("valid-legacy-live.json", () => {
    assertOk(checkState(validLegacyLive), "valid-legacy-live");
  });
  await t.step("valid-skill-example.json", () => {
    assertOk(checkState(validSkillExample), "valid-skill-example");
  });
  await t.step("valid-watch-rebase.json", () => {
    assertOk(checkState(validWatchRebase), "valid-watch-rebase");
  });
});

// ---------------------------------------------------------------------------
// 5. ajv-agreement — ajv (draft 2020-12) との判定一致 (要求5)
// ---------------------------------------------------------------------------

interface AjvValidateFn {
  (data: unknown): boolean;
}
interface AjvInstance {
  compile(schema: unknown): AjvValidateFn;
}
interface AjvConstructor {
  new (options: { strict: boolean }): AjvInstance;
}

Deno.test("ajv-agreement", async (t) => {
  let AjvCtor: AjvConstructor;
  try {
    const mod = await import("npm:ajv@8.17.1/dist/2020.js");
    AjvCtor = mod.default as unknown as AjvConstructor;
  } catch {
    console.log(
      "SKIP: ajv unavailable (offline or --cached-only) — skipping ajv-agreement",
    );
    return;
  }

  const ajv = new AjvCtor({ strict: true });
  const validate = ajv.compile(schemaJson);

  const cases: { label: string; value: unknown }[] = [
    { label: "valid-legacy-live", value: validLegacyLive },
    { label: "valid-skill-example", value: validSkillExample },
    { label: "valid-watch-rebase", value: validWatchRebase },
    ...Array.from(generateMutations(validWatchRebase)).map((m, i) => ({
      label: `mutation[${i}] ${m.description}`,
      value: m.value,
    })),
  ];

  for (const c of cases) {
    await t.step(c.label, () => {
      const ajvOk = validate(c.value);
      const ourOk = checkState(c.value).ok;
      if (ajvOk !== ourOk) {
        throw new Error(`disagreement: ajv=${ajvOk} checkState=${ourOk}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 6. no-npm-jsr-references — state-schema.ts の実行時依存ゼロを grep で固定 (要求7)
// ---------------------------------------------------------------------------

Deno.test("no-npm-jsr-references", async () => {
  const src = await Deno.readTextFile(
    new URL("./state-schema.ts", import.meta.url),
  );
  if (/\bnpm:|\bjsr:/.test(src)) {
    throw new Error(
      "state-schema.ts must not reference npm: or jsr: specifiers",
    );
  }
});

// ---------------------------------------------------------------------------
// 7. init-throws-on-unknown-keyword — fail-closed の確認 (要求2・受け入れ条件8)
// ---------------------------------------------------------------------------

Deno.test("init-throws-on-unknown-keyword", () => {
  const mutated = injectAt(
    schemaJson,
    ["$defs", "queueItem", "properties", "id"],
    "pattern",
    ".*",
  );
  let threw = false;
  try {
    compileChecker(mutated);
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(
      "expected compileChecker to throw on a schema with an unsupported keyword",
    );
  }
});
