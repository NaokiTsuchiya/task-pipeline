// task-pipeline/scripts/state-schema.ts
//
// state.json のスキーマ検証 — state.schema.json (JSON Schema draft 2020-12) を解釈する
// 汎用の再帰的 walker。ロック・原子的書き込み・heartbeat・CLI dispatch (task-pipeline の
// state.ts、別タスクの範囲) から完全に独立した純粋関数: 入力はJSオブジェクト、出力は
// valid/invalid + 違反パスのみで、ファイルI/O・排他は一切行わない。
//
// 公開API:
//   checkState(value: unknown): CheckResult
//     state.schema.json (静的import) に対して value を検証する。
//
// テスト (state-schema.test.ts) からのみ使う追加 export:
//   compileChecker(schema: unknown): (value: unknown) => CheckResult
//     任意のスキーマからチェッカーを作る。スキーマが ALLOWED_KEYWORDS の外の
//     キーワードを使っていれば、この呼び出し自体が throw する (fail-closed)。
//   collectSchemaNodes(schema: unknown): SchemaNodeEntry[]
//     スキーマ木を走査してノード一覧を返す (メタリントテストが同じ走査ロジックを再利用する)。
//   ALLOWED_KEYWORDS
//     checkState が解釈する固定キーワード集合 (type/required/properties/
//     additionalProperties/enum/items/minimum/$ref の8つ)。$schema/$defs は
//     スキーマ文書のルート直下でのみ許容され、この集合の対象外 (下記 rootNode 参照)。
//
// 実行時の外部依存はゼロ (npm パッケージ・jsr パッケージへの参照が無い)。
//
// テストの回し方: sh tests/state-schema.test.sh (deno 不在なら SKIP + exit 0)
//   直接実行する場合: deno test --allow-read=<repo> task-pipeline/scripts/state-schema.test.ts

import schemaJson from "./state.schema.json" with { type: "json" };

export type CheckResult =
  | { ok: true }
  | { ok: false; path: string; message: string };

export const ALLOWED_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "required",
  "properties",
  "additionalProperties",
  "enum",
  "items",
  "minimum",
  "$ref",
]);

// ルート直下でのみ許容し、キーワード検査の対象にしないドキュメントレベルのキー
// (値を検証するためのキーワードではなく、スキーマ文書のナビゲーション用メタキー)。
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

// ルートオブジェクトから $schema/$defs を除いた残りを、top-level スキーマノードとして扱う。
function rootNode(schema: Record<string, unknown>): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    if (!ROOT_ONLY_KEYS.has(key)) node[key] = schema[key];
  }
  return node;
}

// スキーマ木を走査してノード一覧を集める。ルート ($schema/$defs を除く) と $defs の
// 各エントリを起点に、properties の値・items を再帰的に辿る。$ref ノードはそのまま
// 1エントリとして収集し、解決はしない (解決の可否はメタリント側の独立した検査で見る)。
export function collectSchemaNodes(schema: unknown): SchemaNodeEntry[] {
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
      // $ref ノードは他キーワードと同居しない設計 (このスキーマでは常に単独)。
      // 子は辿らない — $ref先の中身は $defs 起点の走査で既にカバーされる。
      return;
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
  for (const { schemaPath, node } of collectSchemaNodes(schema)) {
    for (const key of Object.keys(node)) {
      if (!ALLOWED_KEYWORDS.has(key)) {
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
      // Number.isInteger で非整数 (1.5 等) を弾く。minimum の検査より必ず先に効く
      // (この判定を通らない限り minimum の分岐に到達しない)。
      return typeof value === "number" && Number.isInteger(value);
    case "object":
      // typeof null === "object" の罠を避けるため null を明示的に除外し、
      // Array.isArray で配列を除外する (配列は object 型として扱わない)。
      return typeof value === "object" && value !== null &&
        !Array.isArray(value);
    case "array":
      // Array.isArray で判定する — typeof value==="object" だけでは
      // 配列とプレーンオブジェクトを区別できない。
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
    // enum は type 判定と独立に見る — nullable-enum (enum に null を含む) で
    // null を正しく許可するため、"typeof value===string" 等のガードで先に弾かない。
    if (!enumValues.some((e) => e === value)) {
      return {
        ok: false,
        path,
        message: `value not in enum: ${describe(value)}`,
      };
    }
  }

  if (value === null) {
    // nullable object の properties/required 検査をここでスキップする
    // (すでに type/enum で null 許容であることは確認済み)。
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

// スキーマからチェッカーを作る。スキーマが ALLOWED_KEYWORDS の外のキーワードを
// 使っていれば、この呼び出し自体が throw する (fail-closed、要求2・受け入れ条件8)。
export function compileChecker(
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

export const checkState: (value: unknown) => CheckResult = compileChecker(
  schemaJson,
);
