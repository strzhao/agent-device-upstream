// `node scripts/capability-matrix/generate.ts [--write]` — renders
// `website/docs/docs/capabilities.md` from the collected matrix.
//
// Table cells, column sets, and the partial-support notes all come from
// `collect.ts`; this file adds the labels and links from `annotations.ts` and the
// header's version stamp. Columns whose command sets are identical print once.
// Without `--write` the script compares the page on disk against the generated
// page and fails when they differ, which is what the drift guard runs.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandRuntimeUseRequirements } from '@agent-device/command-registry/registry';
import {
  MATRIX_SECTIONS,
  SCOPE_ROWS,
  type CellQualification,
  type FactRow,
} from './annotations.ts';
import { collectMatrix } from './run.ts';
import { groupIdenticalColumns, TARGETS, type Target, type TargetGroup } from './targets.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const PAGE_PATH = path.join('website', 'docs', 'docs', 'capabilities.md');

function targetById(id: string): Target {
  const target = TARGETS.find((candidate) => candidate.id === id);
  if (!target) throw new Error(`Unknown target "${id}".`);
  return target;
}

export type MatrixData = Readonly<{
  version: string;
  generatedAt: string;
  commands: readonly string[];
  support: ReadonlyMap<string, ReadonlySet<string>>;
  operations: ReadonlyMap<string, ReadonlySet<string>>;
}>;

async function collectPageData(): Promise<MatrixData> {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  const { commands, support, operations } = await collectMatrix();
  return {
    version: packageJson.version,
    generatedAt: new Date().toISOString().slice(0, 10),
    commands,
    support: new Map(Object.entries(support).map(([id, list]) => [id, new Set<string>(list)])),
    operations: new Map(
      Object.entries(operations).map(([id, list]) => [id, new Set<string>(list)]),
    ),
  };
}

export type Column = Readonly<{
  /** Representative target id, whose facts answer for the whole group. */
  id: string;
  label: string;
}>;

/**
 * One column per distinct command set. A merged column of one provider's two
 * platforms prints the provider's short name; any other merge names each target
 * it covers, so a lone provider column always keeps its platform.
 */
function columnsForGroup(group: TargetGroup, data: MatrixData): Column[] {
  const ids = TARGETS.filter((target) => target.group === group).map((target) => target.id);
  return groupIdenticalColumns(ids, data.operations).map((merged) => {
    const targets = merged.ids.map((id) => targetById(id));
    const providers = new Set(
      targets.map((target) => (target.kind === 'cloud-webdriver' ? target.provider : target.id)),
    );
    const label =
      merged.ids.length > 1 && providers.size === 1
        ? (targets[0] as Extract<Target, { kind: 'cloud-webdriver' }>).mergeLabel
        : [...new Set(targets.map((target) => target.label))].join(' / ');
    return { id: merged.id, label };
  });
}

/** Commands no row reports, and commands a row names that the registry does not have. */
export function annotationSymmetry(
  commands: readonly string[],
  rows: readonly FactRow[],
): { readonly unrowed: readonly string[]; readonly unknown: readonly string[] } {
  const declared = rows.flatMap((row) => row.commands);
  const declaredSet = new Set(declared);
  const known = new Set(commands);
  return {
    unrowed: commands.filter((command) => !declaredSet.has(command)),
    unknown: [...new Set(declared.filter((command) => !known.has(command)))].sort(),
  };
}

/**
 * Commands the column's representative target does not support. A row and a
 * column may never disagree on a single command without the page losing that
 * detail, which is what the guard's split-row check prevents.
 */
function unsupportedCommands(row: FactRow, supported: ReadonlySet<string>): string[] {
  return row.commands.filter((command) => !supported.has(command));
}

/**
 * The cell text for one row and column. The facts answer `Yes` or `No`; a
 * declared qualification replaces that text only while everything it names
 * still holds — a cell that claims an operation was admitted fails generation
 * the moment the runtime stops admitting it, and one that claims a refusal
 * fails the moment the operation appears. A `Yes`, plain or qualified, is not
 * an escape from operation-level proof: it renders only when the column admits
 * every operation the row advertises (see {@link advertisedOperations}), so an
 * operation removed while the command stays admitted fails generation instead
 * of quietly keeping its answer. A qualification that names its own operations
 * (`admits` / `refuses`) is the row's narrowing for that cell: those lists are
 * then the proof, and they must cover the operations the cell's text claims.
 */
function answer(row: FactRow, column: Column, data: MatrixData): string {
  const supported = data.support.get(column.id);
  if (!supported) throw new Error(`No facts collected for column "${column.id}".`);
  const base = unsupportedCommands(row, supported).length === 0 ? 'Yes' : 'No';
  const qualification = row.cells?.[column.id];
  if (!qualification) {
    if (base === 'Yes') assertAdvertised(row, column.id, data.operations.get(column.id));
    return base;
  }
  if (base !== 'Yes' && qualification.refusesCommands === undefined) {
    throw new Error(
      `Row "${row.id}" declares a qualification for column "${column.id}" but the facts ` +
        'already answer No; drop the qualification or declare refusesCommands.',
    );
  }
  assertQualification(row.id, column.id, qualification, supported, data.operations.get(column.id));
  if (base === 'Yes' && qualification.admits === undefined && qualification.refuses === undefined) {
    assertAdvertised(row, column.id, data.operations.get(column.id));
  }
  return qualification.text;
}

/**
 * The operations a row's label promises. The default is every operation the
 * row's commands name in their declared uses, which is the union of the
 * actions a single request can select. A row narrows it where its commands
 * admit on any one of several uses and the row does not claim the rest: the
 * narrowed list says exactly what each of that row's `Yes` cells proves.
 */
function advertisedOperations(row: FactRow): readonly string[] {
  if (row.advertises) return row.advertises;
  return [
    ...new Set(
      row.commands.flatMap((command) => (commandRuntimeUseRequirements(command) ?? []).flat()),
    ),
  ];
}

function assertAdvertised(
  row: FactRow,
  columnId: string,
  available: ReadonlySet<string> | undefined,
): void {
  const operations = available ?? new Set<string>();
  const missing = advertisedOperations(row).filter((operation) => !operations.has(operation));
  if (missing.length > 0) {
    throw new Error(
      `Cell "${row.id}" x "${columnId}" would read Yes while the facts refuse the ` +
        `advertised operations [${missing.join(', ')}]. Qualify the cell or narrow the row's ` +
        '`advertises` list in scripts/capability-matrix/annotations.ts only if the row label ' +
        'does not claim them.',
    );
  }
}

function assertQualification(
  rowId: string,
  columnId: string,
  qualification: CellQualification,
  supportedCommands: ReadonlySet<string>,
  availableOperations: ReadonlySet<string> | undefined,
): void {
  const operations = availableOperations ?? new Set<string>();
  const failing = [
    ...(qualification.commands ?? []).filter((command) => !supportedCommands.has(command)),
    ...(qualification.admits ?? []).filter((operation) => !operations.has(operation)),
    ...(qualification.refuses ?? []).filter((operation) => operations.has(operation)),
    ...(qualification.refusesCommands ?? []).filter((command) => supportedCommands.has(command)),
  ];
  if (failing.length > 0) {
    throw new Error(
      `Cell "${rowId}" x "${columnId}" names facts that no longer hold: [${failing.join(', ')}]. ` +
        'Update its text in scripts/capability-matrix/annotations.ts and regenerate the page.',
    );
  }
}

function tableFor(
  rows: readonly FactRow[],
  columns: readonly Column[],
  data: MatrixData,
): string[] {
  const lines = [
    `| Capability and reference |${columns.map((column) => ` ${column.label} |`).join('')}`,
    `| --- |${columns.map(() => ' --- |').join('')}`,
  ];
  for (const row of rows) {
    const cells = columns.map((column) => ` ${answer(row, column, data)} |`);
    lines.push(`| [${row.label}](${row.link}) |${cells.join('')}`);
  }
  return lines;
}

/** Row limits worth reading even when every cell answered Yes. */
function rowLimits(rows: readonly FactRow[]): string[] {
  return rows.filter((row) => row.note).map((row) => `- **${row.label}**: ${row.note as string}`);
}

const GROUPS: ReadonlyArray<{ readonly group: TargetGroup; readonly caption: string }> = [
  { group: 'local-mobile', caption: 'Mobile targets' },
  { group: 'local-tv', caption: 'TV targets' },
  { group: 'local-desktop-web', caption: 'Desktop and web targets' },
  { group: 'provider', caption: 'Hosted provider sessions' },
];

export function renderPage(data: MatrixData): string {
  const rows = MATRIX_SECTIONS.flatMap((section) => section.rows);
  const { unrowed, unknown } = annotationSymmetry(data.commands, rows);
  if (unrowed.length > 0 || unknown.length > 0) {
    throw new Error(
      `Capability annotations are out of sync with the command registry. Unrowed: ` +
        `[${unrowed.join(', ')}]; named but unknown: [${unknown.join(', ')}]. ` +
        `Update scripts/capability-matrix/annotations.ts.`,
    );
  }

  const columns = new Map<TargetGroup, Column[]>(
    GROUPS.map(({ group }) => [group, columnsForGroup(group, data)]),
  );
  // Every declared cell must land on a column that renders: when a facts change
  // merges its target into another column, the qualification would silently stop
  // applying, so generation fails until the cell is removed or the split returns.
  const rendered = new Set([...columns.values()].flat().map((column) => column.id));
  for (const row of rows) {
    for (const columnId of Object.keys(row.cells ?? {})) {
      if (!rendered.has(columnId)) {
        throw new Error(
          `Row "${row.id}" declares a cell for "${columnId}", which renders no column of its ` +
            'own. Drop the cell or split the targets apart in scripts/capability-matrix/.',
        );
      }
    }
  }

  const lines: string[] = [
    '---',
    'title: Capabilities',
    'description: Which commands each target supports, read from the runtime code that decides it.',
    '---',
    '',
    '# Capabilities',
    '',
    'The target tables below are generated from the runtime command-admission facts that back the `capabilities` command: a command that leaves the code leaves this page. Labels, limits, and integration rows are maintained beside the generator, and command availability does not establish support for every operation, subcommand, or device model.',
    `It covers agent-device ${data.version}, generated ${data.generatedAt}.`,
    '',
    '**Yes** means the facts admit every command in that row on the target and every operation the row advertises. **No** means at least one is refused. A qualified cell names the operations that answer there. Targets that share the same available operations print as one column.',
    '',
    'Physical iOS devices discovered only through `xctrace` use the XCTest backend rather than CoreDevice: they support open/close, interactions, snapshots, and screenshots, while app inventory, installation, logs, performance sampling, recording, deep links, and launch arguments need CoreDevice.',
    '',
    'One capability depends on the agent machine rather than the target: system audio sampling works only when the daemon runs on macOS, which is what this page assumes.',
    '',
    'Check the device in front of you rather than trusting a table:',
    '',
    '```bash',
    'agent-device capabilities --platform ios --device "iPhone 17 Pro"',
    'agent-device capabilities --session my-session --json',
    '```',
    '',
    'A provider column answers for that provider in its default configuration. Provider credentials, device selection, and artifact retrieval live on the provider pages.',
    '',
  ];

  for (const section of MATRIX_SECTIONS) {
    lines.push(`## ${section.title}`, '');
    for (const { caption, group } of GROUPS) {
      const groupColumns = columns.get(group) as Column[];
      lines.push(`### ${caption}`, '');
      lines.push(...tableFor(section.rows, groupColumns, data), '');
    }
    const limits = rowLimits(section.rows);
    if (limits.length > 0) {
      lines.push('What a **Yes** does not claim:', '', ...limits, '');
    }
  }

  lines.push('## Capabilities that are not per-device commands', '');
  lines.push(
    'These come with the tool rather than with a target, so no column above decides them.',
    '',
  );
  lines.push('| Capability | What it needs | Where it is documented |');
  lines.push('| --- | --- | --- |');
  for (const row of SCOPE_ROWS) {
    lines.push(`| ${row.label} | ${row.scope} | [${row.label}](${row.link}) |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** Line-by-line difference between the committed page and the generated one. */
function firstDifference(committed: string, generated: string): string {
  const a = committed.split('\n');
  const b = generated.split('\n');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) {
      return (
        `- line ${index + 1}\n` +
        `  committed: ${a[index] ?? '(end of file)'}\n` +
        `  generated: ${b[index] ?? '(end of file)'}`
      );
    }
  }
  return '(none)';
}

/**
 * The generation date in the page header's provenance line; see
 * {@link withNeutralProvenance}. Matching the full line structure keeps every
 * other word in the comparison: a change to the sentence, a different version,
 * or text appended after the date no longer matches and shows as drift.
 */
const PROVENANCE_LINE = /^(It covers agent-device [0-9][^,\n]*, generated )\d{4}-\d{2}-\d{2}(\.)$/m;

/**
 * The header's generation date is provenance, not a fact: it moves with every
 * new day the page is written. Drift comparison masks that one date so the
 * facts can be re-collected without a diff, while the version stays compared:
 * a page stamped with an older version than package.json is stale and fails
 * until it is regenerated. The pattern demands the exact shape the renderer
 * writes, so edited or appended text around the stamp still shows as drift.
 */
function withNeutralProvenance(page: string): string {
  return page.replace(PROVENANCE_LINE, '$1<date>$2');
}

/**
 * The drift report between the committed page and the generated one, or null
 * when they agree. Both are date-masked: the header's generation date moves
 * with every regeneration, while the version stamp and every table cell stay
 * compared exactly.
 */
export function driftReport(committed: string, generated: string): string | null {
  const a = withNeutralProvenance(committed);
  const b = withNeutralProvenance(generated);
  if (a === b) return null;
  return (
    `${PAGE_PATH} is stale. Run \`pnpm generate:capabilities\`.\nFirst difference:\n` +
    firstDifference(a, b)
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const page = renderPage(await collectPageData());
  const target = path.join(REPO_ROOT, PAGE_PATH);
  const committed = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (!argv.includes('--write')) {
    const drift = driftReport(committed, page);
    if (drift === null) {
      process.stdout.write(`${PAGE_PATH} is current.\n`);
      return 0;
    }
    process.stderr.write(`${drift}\n`);
    return 1;
  }
  if (committed === page) {
    process.stdout.write(`${PAGE_PATH} unchanged.\n`);
    return 0;
  }
  fs.writeFileSync(target, page);
  process.stdout.write(`Wrote ${PAGE_PATH}.\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(await main(process.argv.slice(2)));
}
