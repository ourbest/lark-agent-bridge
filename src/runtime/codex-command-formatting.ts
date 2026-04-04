const MAX_ITEMS = 10;
const MAX_SCALAR_LENGTH = 120;

type UnknownRecord = Record<string, unknown>;

export function formatCodexCommandResult(method: string, result: unknown): string[] {
  const list = readList(result);
  if (list !== null) {
    return formatList(method, list, method === 'thread/list' ? null : MAX_ITEMS);
  }

  if (isRecord(result)) {
    return formatObject(method, result);
  }

  return [`[codex-bridge] ${method}: ${formatScalar(result)}`];
}

function formatList(method: string, items: unknown[], maxItems: number | null): string[] {
  const lines = [`[codex-bridge] ${method}: ${items.length} item(s)`];

  if (items.length === 0) {
    lines.push('no items');
    return lines;
  }

  const displayedItems = maxItems === null ? items : items.slice(0, maxItems);
  for (const [index, item] of displayedItems.entries()) {
    if (!isRecord(item)) {
      lines.push(`${index + 1}. ${formatScalar(item)}`);
      continue;
    }

    const heading = readBestIdentifier(item);
    lines.push(`${index + 1}. ${heading}`);
    lines.push(...formatSummaryFields(item, '   '));
  }

  if (maxItems !== null && items.length > maxItems) {
    lines.push(`... ${items.length - maxItems} more item(s)`);
  }

  return lines;
}

function formatObject(method: string, value: UnknownRecord): string[] {
  return [`[codex-bridge] ${method}`, ...formatObjectFields(value)];
}

function formatObjectFields(value: UnknownRecord): string[] {
  const lines: string[] = [];
  const orderedKeys = [
    'id',
    'name',
    'preview',
    'status',
    'cwd',
    'createdAt',
    'updatedAt',
    'path',
  ];
  const seen = new Set<string>();

  for (const key of orderedKeys) {
    if (!(key in value)) {
      continue;
    }
    seen.add(key);
    const line = formatKeyValueLine(key, value[key]);
    if (line !== null) {
      lines.push(line);
    }
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    if (seen.has(key)) {
      continue;
    }
    const line = formatKeyValueLine(key, fieldValue);
    if (line !== null) {
      lines.push(line);
    }
  }

  return lines;
}

function formatSummaryFields(value: UnknownRecord, indent: string): string[] {
  const lines: string[] = [];
  const fields: Array<[label: string, fieldValue: unknown]> = [
    ['title', value.title],
    ['preview', value.preview],
    ['description', value.description],
    ['status', value.status],
    ['updated', value.updatedAt],
    ['cwd', value.cwd],
    ['source', value.source],
    ['branch', readBranch(value.gitInfo) ?? undefined],
  ];

  for (const [label, fieldValue] of fields) {
    const formatted = formatFieldValue(label, fieldValue);
    if (formatted !== null) {
      lines.push(`${indent}${label}: ${formatted}`);
    }
  }

  return lines;
}

function formatKeyValueLine(key: string, value: unknown): string | null {
  const formatted = formatFieldValue(key, value);
  return formatted === null ? null : `${key}: ${formatted}`;
}

function formatFieldValue(key: string, value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  if ((key === 'createdAt' || key === 'updatedAt' || key === 'updated') && typeof value === 'number') {
    return formatUnixSeconds(value);
  }

  if (key === 'status') {
    const type = readStatusType(value);
    return type ?? formatScalar(value);
  }

  if (Array.isArray(value)) {
    return `${value.length} item(s)`;
  }

  if (isRecord(value)) {
    return summarizeRecord(value);
  }

  return formatScalar(value);
}

function summarizeRecord(value: UnknownRecord): string {
  const identifier = readBestIdentifier(value);
  const extraFields = formatSummaryFields(value, '').slice(0, 2);
  if (extraFields.length === 0 || identifier !== formatScalar(value)) {
    return identifier;
  }
  return extraFields.join(', ');
}

function readList(result: unknown): unknown[] | null {
  if (Array.isArray(result)) {
    return result;
  }

  if (!isRecord(result)) {
    return null;
  }

  if (Array.isArray(result.data)) {
    return result.data;
  }

  if (Array.isArray(result.apps)) {
    return result.apps;
  }

  if (Array.isArray(result.sessions)) {
    return result.sessions;
  }

  if (Array.isArray(result.threads)) {
    return result.threads;
  }

  return null;
}

function readBestIdentifier(value: UnknownRecord): string {
  for (const key of ['id', 'name', 'title', 'preview']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return formatScalar(candidate);
    }
  }

  return formatScalar(value);
}

function readStatusType(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  return typeof value.type === 'string' && value.type.trim() !== '' ? value.type : null;
}

function readBranch(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  return typeof value.branch === 'string' && value.branch.trim() !== '' ? value.branch : null;
}

function formatUnixSeconds(value: number): string {
  const date = new Date(value * 1000);
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatScalar(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    text = String(value);
  } else {
    text = JSON.stringify(value);
  }

  return text.length > MAX_SCALAR_LENGTH ? `${text.slice(0, MAX_SCALAR_LENGTH - 3)}...` : text;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
