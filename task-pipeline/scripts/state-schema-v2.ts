// task-pipeline/scripts/state-schema-v2.ts
//
// state.json **v2** のスキーマ検証 — state.schema.json (JSON Schema draft 2020-12) を
// 解釈する再帰的 walker。純粋関数 (ファイルI/O・排他なし、外部パッケージ参照ゼロ) だが、
// v2 のスキーマは queueItem / run / artifact / attention を **判別付き oneOf
// (tagged union)** で宣言する (設計 3.1b節) ため、oneOf を解釈できる必要がある。
//
// **ファイル名に -v2 が残っている理由**: このモジュールは #36 で v1 の walker
// (state-schema.ts) と併存させるために新規ファイルとして置かれた。v1 の walker とスキーマは
// #37 で削除され、v2 のスキーマが state.schema.json という正式な名前を引き継いだので、
// 併存の必要はもう無い — 名前だけが残っている。改名は v2 の他のモジュール
// (state-model-v2 / state-transitions-v2 / state-migrate-v2 / state-ledger-v2) と揃えて
// まとめて行う方が差分が読みやすいので、ここでは据え置く。
//
// 公開API:
//   checkStateV2(value: unknown): CheckResult
//     state.schema.json (静的import) に対して value を検証する。
//
// テスト (state-schema-v2.test.ts) からのみ使う追加 export:
//   compileCheckerV2(schema: unknown): (value: unknown) => CheckResult
//     任意のスキーマからチェッカーを作る。ALLOWED_KEYWORDS_V2 の外のキーワードが
//     あれば、この呼び出し自体が throw する (fail-closed)。
//   collectSchemaNodesV2(schema: unknown): SchemaNodeEntry[]
//     スキーマ木のノード一覧 (properties / items / oneOf の枝を辿る)。
//   ALLOWED_KEYWORDS_V2
//     v1 の 8 キーワード + oneOf。
//
// テストの回し方: sh tests/state-schema-v2.test.sh (deno 不在なら SKIP + exit 0)

import schemaJson from "./state.schema.json" with { type: "json" };

export type CheckResult =
  | { ok: true }
  | { ok: false; path: string; message: string };

export const ALLOWED_KEYWORDS_V2: ReadonlySet<string> = new Set([
  "type",
  "required",
  "properties",
  "additionalProperties",
  "enum",
  "items",
  "minimum",
  "$ref",
  "oneOf",
]);

// ルート直下でのみ許容し、キーワード検査の対象にしないドキュメントレベルのキー。
const ROOT_ONLY_KEYS = new Set(["$schema", "$defs"]);

export interface SchemaNodeEntry {
  schemaPath: string;
  node: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getDefs(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = schema["$defs"];
  return isPlainRecord(defs) ? defs : {};
}

function rootNode(schema: Record<string, unknown>): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    if (!ROOT_ONLY_KEYS.has(key)) node[key] = schema[key];
  }
  return node;
}

// スキーマ木を走査してノード一覧を集める。ルート ($schema/$defs を除く) と $defs の
// 各エントリを起点に、properties の値・items・oneOf の枝を再帰的に辿る。$ref ノードは
// そのまま1エントリとして収集し、解決はしない。
export function collectSchemaNodesV2(schema: unknown): SchemaNodeEntry[] {
  if (!isPlainRecord(schema)) {
    throw new Error("schema root must be an object");
  }
  const entries: SchemaNodeEntry[] = [];
  const seen = new Set<string>();

  function visit(node: unknown, schemaPath: string): void {
    if (!isPlainRecord(node)) return;
    if (seen.has(schemaPath)) return;
    seen.add(schemaPath);
    entries.push({ schemaPath, node });

    if ("$ref" in node) {
      // $ref ノードは他キーワードと同居しない設計。子は辿らない —
      // $ref先の中身は $defs 起点の走査で既にカバーされる。
      return;
    }
    const oneOf = node["oneOf"];
    if (Array.isArray(oneOf)) {
      for (let i = 0; i < oneOf.length; i++) {
        visit(oneOf[i], `${schemaPath}.oneOf[${i}]`);
      }
    }
    const properties = node["properties"];
    if (isPlainRecord(properties)) {
      for (const key of Object.keys(properties)) {
        visit(properties[key], `${schemaPath}.properties.${key}`);
      }
    }
    const items = node["items"];
    if (items !== undefined) {
      visit(items, `${schemaPath}.items`);
    }
  }

  visit(rootNode(schema), "$root");
  const defs = getDefs(schema);
  for (const key of Object.keys(defs)) {
    visit(defs[key], `$defs.${key}`);
  }
  return entries;
}

function assertKnownKeywords(schema: Record<string, unknown>): void {
  for (const { schemaPath, node } of collectSchemaNodesV2(schema)) {
    for (const key of Object.keys(node)) {
      if (!ALLOWED_KEYWORDS_V2.has(key)) {
        throw new Error(`unsupported schema keyword "${key}" at ${schemaPath}`);
      }
    }
  }
}

function normalizeTypes(type: unknown): string[] {
  if (Array.isArray(type)) return type.map((t) => String(t));
  if (typeof type === "string") return [type];
  return [];
}

function matchesType(value: unknown, t: string): boolean {
  switch (t) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "object":
      return typeof value === "object" && value !== null &&
        !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      throw new Error(`unsupported type keyword: "${t}"`);
  }
}

function pathJoin(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function pathIndex(path: string, index: number): string {
  return `${path}[${index}]`;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function resolveRef(
  node: Record<string, unknown>,
  defs: Record<string, unknown>,
): Record<string, unknown> {
  const ref = node["$ref"];
  if (typeof ref !== "string") return node;
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) {
    throw new Error(`unsupported $ref target: "${ref}"`);
  }
  const target = defs[ref.slice(prefix.length)];
  if (!isPlainRecord(target)) {
    throw new Error(`$ref does not resolve within $defs: "${ref}"`);
  }
  return target;
}

function walk(
  rawNode: Record<string, unknown>,
  value: unknown,
  path: string,
  defs: Record<string, unknown>,
): CheckResult {
  const node = "$ref" in rawNode ? resolveRef(rawNode, defs) : rawNode;

  // oneOf: 適合した枝がちょうど1つのときだけ ok。0個なら「どのノードの形にも
  // 合わない」、2個以上なら判別が効いていない (スキーマ側の欠陥) なので、どちらも
  // fail にする — 後者を通すと tagged union であるという主張が黙って崩れる。
  const oneOf = node["oneOf"];
  if (Array.isArray(oneOf)) {
    let matched = 0;
    let lastFailure: CheckResult = {
      ok: false,
      path,
      message: "oneOf has no branches",
    };
    for (const branch of oneOf) {
      if (!isPlainRecord(branch)) {
        throw new Error(`oneOf branch must be an object at ${path}`);
      }
      const result = walk(branch, value, path, defs);
      if (result.ok) {
        matched++;
      } else {
        lastFailure = result;
      }
    }
    if (matched === 1) return { ok: true };
    if (matched === 0) {
      return {
        ok: false,
        path: lastFailure.ok ? path : lastFailure.path,
        message: `matched none of ${oneOf.length} oneOf branches` +
          (lastFailure.ok ? "" : ` (last branch: ${lastFailure.message})`),
      };
    }
    return {
      ok: false,
      path,
      message: `matched ${matched} of ${oneOf.length} oneOf branches ` +
        "(schema is not a discriminated union)",
    };
  }

  const types = normalizeTypes(node["type"]);
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    return {
      ok: false,
      path,
      message: `expected type ${types.join("|")}, got ${describe(value)}`,
    };
  }

  const enumValues = node["enum"];
  if (Array.isArray(enumValues)) {
    // enum は type 判定と独立に見る (nullable-enum で null を正しく許可するため)。
    if (!enumValues.some((e) => e === value)) {
      return {
        ok: false,
        path,
        message: `value not in enum: ${describe(value)}`,
      };
    }
  }

  if (value === null) {
    // nullable object の properties/required 検査はここで打ち切る
    // (null 許容であることは type/enum で確認済み)。
    return { ok: true };
  }

  if (types.includes("object") && isPlainRecord(value)) {
    const required = node["required"];
    if (Array.isArray(required)) {
      for (const rawKey of required) {
        const key = String(rawKey);
        if (!(key in value)) {
          return {
            ok: false,
            path: pathJoin(path, key),
            message: "missing required property",
          };
        }
      }
    }
    const properties = node["properties"];
    const propertiesRecord = isPlainRecord(properties) ? properties : {};
    if (node["additionalProperties"] === false) {
      for (const key of Object.keys(value)) {
        if (!(key in propertiesRecord)) {
          return {
            ok: false,
            path: pathJoin(path, key),
            message: "unknown property",
          };
        }
      }
    }
    for (const key of Object.keys(propertiesRecord)) {
      if (!(key in value)) continue;
      const childSchema = propertiesRecord[key];
      if (!isPlainRecord(childSchema)) continue;
      const result = walk(childSchema, value[key], pathJoin(path, key), defs);
      if (!result.ok) return result;
    }
  }

  if (types.includes("array") && Array.isArray(value)) {
    const items = node["items"];
    if (isPlainRecord(items)) {
      for (let i = 0; i < value.length; i++) {
        const result = walk(items, value[i], pathIndex(path, i), defs);
        if (!result.ok) return result;
      }
    }
  }

  if (
    types.includes("integer") && typeof value === "number" &&
    Number.isInteger(value)
  ) {
    const minimum = node["minimum"];
    if (typeof minimum === "number" && value < minimum) {
      return {
        ok: false,
        path,
        message: `value ${value} below minimum ${minimum}`,
      };
    }
  }

  return { ok: true };
}

// スキーマからチェッカーを作る。ALLOWED_KEYWORDS_V2 の外のキーワードを使っていれば
// この呼び出し自体が throw する (fail-closed)。
export function compileCheckerV2(
  schema: unknown,
): (value: unknown) => CheckResult {
  if (!isPlainRecord(schema)) {
    throw new Error("schema root must be an object");
  }
  assertKnownKeywords(schema);
  const root = rootNode(schema);
  const defs = getDefs(schema);
  return (value: unknown) => walk(root, value, "", defs);
}

export const checkStateV2: (value: unknown) => CheckResult = compileCheckerV2(
  schemaJson,
);
