import {
  listDocumentEventsInTimeRange,
  listServerIncidentEventsByRequestId,
  listServerIncidentEventsInTimeRange,
  type DocumentEventRow,
  type ServerIncidentEventRow,
} from './db.js';
import { getBuildInfo } from './build-info.js';
import {
  ACTIVE_INCIDENT_CODE,
  ACTIVE_INCIDENT_AGENT_NOTE,
  ACTIVE_INCIDENT_EVIDENCE_EXAMPLES,
  ACTIVE_INCIDENT_REPORT_HINT,
  ACTIVE_INCIDENT_SUMMARY,
  REPORT_BUG_OPEN_SOURCE_REPO_URL,
} from './agent-guidance.js';
import { buildAppsignalCorrelation, type AppsignalCorrelation } from './observability.js';

export type BugReportType = 'bug' | 'performance' | 'ux';
export type BugReportSeverity = 'blocker' | 'high' | 'medium' | 'low';
export type BugReportReporterMode = 'api_only' | 'in_product_web' | 'native_app' | 'human_assisted';
export type BugReportReporterEventSource = 'api' | 'client' | 'operator';
export type BugReportReporterEventClass =
  | 'primary_failure'
  | 'related_write'
  | 'related_read'
  | 'background_poll'
  | 'diagnostic';
export type BugReportEvidenceKind =
  | 'http_request'
  | 'http_response'
  | 'error'
  | 'console'
  | 'operator_note'
  | 'raw_json';

export type BugReportQuestionAnswer = {
  question: string;
  answer: string;
};

export type BugReportTranscriptEntry = {
  role: string;
  content: string;
};

export type BugReportReporterEvent = {
  timestamp: string | null;
  source: BugReportReporterEventSource;
  class: BugReportReporterEventClass;
  type: string;
  level: string | null;
  message: string | null;
  data: Record<string, unknown>;
};

export type BugReportRawEvidence = {
  timestamp: string | null;
  kind: BugReportEvidenceKind;
  source: BugReportReporterEventSource;
  level: string | null;
  message: string | null;
  requestId: string | null;
  url: string | null;
  method: string | null;
  status: number | null;
  text: string | null;
  data: Record<string, unknown>;
  lines: string[];
};

export type NormalizedBugReport = {
  reportType: BugReportType;
  severity: BugReportSeverity;
  reporterMode: BugReportReporterMode;
  summary: string;
  expected: string | null;
  actual: string | null;
  repro: string | null;
  context: string | null;
  writeup: string | null;
  userNotes: string | null;
  additionalContext: string | null;
  slug: string | null;
  requestId: string | null;
  occurredAt: string | null;
  capturedAt: string;
  subsystemGuess: string | null;
  environment: Record<string, unknown> & { runtime: string };
  documentContext: Record<string, unknown>;
  questionsAsked: BugReportQuestionAnswer[];
  operatorTranscript: BugReportTranscriptEntry[];
  rawEvidence: BugReportRawEvidence[];
  reporterEvents: BugReportReporterEvent[];
};

export type NormalizedBugReportFollowUp = {
  reporterMode: BugReportReporterMode;
  context: string | null;
  writeup: string | null;
  userNotes: string | null;
  additionalContext: string | null;
  slug: string | null;
  requestId: string | null;
  occurredAt: string | null;
  capturedAt: string;
  subsystemGuess: string | null;
  environment: Record<string, unknown> & { runtime: string };
  documentContext: Record<string, unknown>;
  questionsAsked: BugReportQuestionAnswer[];
  operatorTranscript: BugReportTranscriptEntry[];
  rawEvidence: BugReportRawEvidence[];
  reporterEvents: BugReportReporterEvent[];
};

export type BugReportPrimaryRequest = {
  requestId: string | null;
  method: string | null;
  url: string | null;
  pathname: string | null;
  status: number | null;
  statusText: string | null;
  source: BugReportReporterEventSource;
  eventType: string;
  message: string | null;
  timestamp: string | null;
};

export type BugReportEvidenceSummary = {
  serverIncidentEventCount: number;
  documentEventCount: number;
  reporterEventCount: number;
  backgroundPollOmittedCount: number;
  requestIdMatched: boolean;
  slugWindowMatched: boolean;
};

export type BugReportEvidenceBundle = {
  report: NormalizedBugReport;
  selection: {
    requestId: string | null;
    slug: string | null;
    timeWindow: { from: string; to: string } | null;
    usedRequestId: boolean;
    usedSlugWindow: boolean;
  };
  inferredSubsystem: string;
  labels: string[];
  primaryRequest: BugReportPrimaryRequest | null;
  routeHint: string | null;
  routeTemplate: string | null;
  primaryError: string | null;
  suspectedFiles: string[];
  fixerBrief: BugReportFixerBrief;
  summary: BugReportEvidenceSummary;
  serverIncidentEvents: Array<Record<string, unknown>>;
  documentEvents: Array<Record<string, unknown>>;
  rawEvidence: BugReportRawEvidence[];
  reporterEvents: BugReportReporterEvent[];
  buildInfo: ReturnType<typeof getBuildInfo>;
};

export type BugReportFollowUpEvidenceBundle = {
  followUp: NormalizedBugReportFollowUp;
  selection: {
    requestId: string | null;
    slug: string | null;
    timeWindow: { from: string; to: string } | null;
    usedRequestId: boolean;
    usedSlugWindow: boolean;
  };
  inferredSubsystem: string;
  primaryRequest: BugReportPrimaryRequest | null;
  routeHint: string | null;
  routeTemplate: string | null;
  primaryError: string | null;
  suspectedFiles: string[];
  fixerBrief: BugReportFixerBrief;
  summary: BugReportEvidenceSummary;
  serverIncidentEvents: Array<Record<string, unknown>>;
  documentEvents: Array<Record<string, unknown>>;
  rawEvidence: BugReportRawEvidence[];
  reporterEvents: BugReportReporterEvent[];
  buildInfo: ReturnType<typeof getBuildInfo>;
};

export type BugReportFixerBrief = {
  summary: string;
  likelySubsystem: string;
  suspectedFiles: string[];
  routeTemplate: string | null;
  primaryRequest: BugReportPrimaryRequest | null;
  primaryError: string | null;
  issueNumber: number | null;
  issueUrl: string | null;
};

export type GitHubIssueCreateResult = {
  issueNumber: number;
  issueUrl: string;
  issueApiUrl: string;
  labels: string[];
};

export type BugReportValidationResult =
  | { ok: true; report: NormalizedBugReport }
  | { ok: false; missingFields: string[]; suggestedQuestions: string[] };

export type BugReportFollowUpValidationResult =
  | { ok: true; followUp: NormalizedBugReportFollowUp }
  | { ok: false; missingFields: string[]; suggestedQuestions: string[] };

export type ReportBugToolResponse =
  | {
    status: 'created';
    issueNumber: number;
    issueUrl: string;
    evidenceSummary: BugReportEvidenceSummary;
    fixerBrief: BugReportFixerBrief;
    missingFields: string[];
    suggestedQuestions: string[];
    nextBestEvidence: string[];
    requestId: string | null;
    appsignal?: AppsignalCorrelation | null;
  }
  | {
    status: 'follow_up_added';
    issueNumber: number;
    issueUrl: string | null;
    evidenceSummary: BugReportEvidenceSummary;
    fixerBrief: BugReportFixerBrief;
    missingFields: string[];
    suggestedQuestions: string[];
    nextBestEvidence: string[];
    requestId: string | null;
    appsignal?: AppsignalCorrelation | null;
  }
  | {
    status: 'needs_more_info';
    issueNumber: number | null;
    issueUrl: string | null;
    evidenceSummary: BugReportEvidenceSummary | null;
    fixerBrief: BugReportFixerBrief | null;
    missingFields: string[];
    suggestedQuestions: string[];
    nextBestEvidence: string[];
    requestId: string | null;
    appsignal?: AppsignalCorrelation | null;
  };

const BUG_REPORT_SPEC_VERSION = '2026-03-11-bridge-v5';
const DEFAULT_GITHUB_OWNER = 'EveryInc';
const DEFAULT_GITHUB_REPO = 'proof';
const SERVER_TRACE_LOOKBACK_MS = 5 * 60 * 1000;
const SERVER_TRACE_LOOKAHEAD_MS = 2 * 60 * 1000;
const MAX_SERVER_INCIDENT_EVENTS = 80;
const MAX_DOCUMENT_EVENTS = 50;
const MAX_RAW_EVIDENCE = 50;
const MAX_REPORTER_EVENTS = 50;
const MAX_TRANSCRIPT_ENTRIES = 40;
const MAX_QUESTION_ANSWERS = 20;
const MAX_TEXT_CHARS = 8000;
const MAX_TIMELINE_LINES = 10;
const MAX_SUSPECTED_FILES = 4;
const GITHUB_ISSUE_COMMENT_RETRY_ATTEMPTS = 3;
const GITHUB_ISSUE_COMMENT_RETRY_DELAY_MS = parsePositiveInt(process.env.PROOF_GITHUB_ISSUE_COMMENT_RETRY_DELAY_MS, 400);

const REPORTER_MODES: BugReportReporterMode[] = [
  'api_only',
  'in_product_web',
  'native_app',
  'human_assisted',
];

const REPORTER_EVENT_SOURCES: BugReportReporterEventSource[] = ['api', 'client', 'operator'];
const REPORTER_EVENT_CLASSES: BugReportReporterEventClass[] = [
  'primary_failure',
  'related_write',
  'related_read',
  'background_poll',
  'diagnostic',
];

const REPORTER_EVENT_CLASS_PRIORITY: Record<BugReportReporterEventClass, number> = {
  primary_failure: 0,
  related_write: 1,
  related_read: 2,
  diagnostic: 3,
  background_poll: 4,
};

const REPORTER_MODE_REQUIRED_FIELDS: Record<BugReportReporterMode, string[]> = {
  api_only: ['reporterMode', 'writeup', 'reporterEvents', 'operatorTranscript'],
  in_product_web: ['reporterMode', 'reporterEvents'],
  native_app: ['reporterMode', 'reporterEvents'],
  human_assisted: ['reporterMode', 'writeup'],
};

const MISSING_FIELD_QUESTIONS: Record<string, string> = {
  summary: 'What went wrong in one sentence?',
  expected: 'What should have happened instead?',
  actual: 'What actually happened?',
  repro: 'What exact steps reproduce the issue?',
  severity: 'How severe is this for the user right now?',
  'environment.runtime': 'Which runtime did this happen in: web, macOS app, iOS, Android, or server?',
  requestId_or_slug: 'Which request ID or document slug was involved?',
  occurredAt: 'About what time did this happen?',
  follow_up_content: 'What new context or evidence do you want appended to the issue?',
};

const MODE_SUGGESTED_QUESTIONS: Record<BugReportReporterMode, string[]> = {
  api_only: [
    'Which API request failed first, and what status code did it return?',
    'What exact request payload did the user steer the agent to send?',
    'What did the API response body say, if anything?',
  ],
  in_product_web: [
    'What visible behavior did the user or agent see in the product?',
    'Did the page show any toast, warning, or stuck state?',
    'Which UI action triggered the problem?',
  ],
  native_app: [
    'What native app action triggered the issue?',
    'Did the bridge or local runtime show a distinct error?',
    'Was the issue reproducible after restarting the app?',
  ],
  human_assisted: [
    'What did the user tell the agent happened in their own words?',
    'What additional notes or context should be attached for the fixer?',
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown, maxLength: number = MAX_TEXT_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function readIsoString(value: unknown): string | null {
  const raw = readTrimmedString(value, 200);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function toMultilineText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? truncateText(trimmed, MAX_TEXT_CHARS) : null;
  }
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
    if (entries.length === 0) return null;
    return truncateText(entries.join('\n'), MAX_TEXT_CHARS);
  }
  return null;
}

function normalizeQuestionAnswers(value: unknown): BugReportQuestionAnswer[] {
  if (!Array.isArray(value)) return [];
  const entries: BugReportQuestionAnswer[] = [];
  for (const entry of value.slice(0, MAX_QUESTION_ANSWERS)) {
    if (!isRecord(entry)) continue;
    const question = readTrimmedString(entry.question, 500);
    const answer = readTrimmedString(entry.answer, 2000);
    if (!question || !answer) continue;
    entries.push({ question, answer });
  }
  return entries;
}

function normalizeTranscript(value: unknown): BugReportTranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: BugReportTranscriptEntry[] = [];
  for (const entry of value.slice(0, MAX_TRANSCRIPT_ENTRIES)) {
    if (!isRecord(entry)) continue;
    const role = readTrimmedString(entry.role, 100) ?? 'assistant';
    const content = readTrimmedString(entry.content, 4000);
    if (!content) continue;
    entries.push({ role, content });
  }
  return entries;
}

function buildContextText(raw: Record<string, unknown>, fallbackFollowUp: boolean = false): string | null {
  const explicit = toMultilineText(raw.context ?? (fallbackFollowUp ? raw.followUp : null));
  if (explicit) return explicit;
  const sections = [
    readTrimmedString(raw.writeup, MAX_TEXT_CHARS),
    readTrimmedString(raw.userNotes, MAX_TEXT_CHARS),
    readTrimmedString(raw.additionalContext, MAX_TEXT_CHARS),
    fallbackFollowUp ? readTrimmedString(raw.followUp, MAX_TEXT_CHARS) : null,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (sections.length === 0) return null;
  return truncateText(sections.join('\n\n'), MAX_TEXT_CHARS);
}

function normalizeReporterEventSource(
  value: unknown,
  fallback: BugReportReporterEventSource = 'client',
): BugReportReporterEventSource {
  const normalized = readTrimmedString(value, 50)?.toLowerCase();
  if (normalized === 'api') return 'api';
  if (normalized === 'operator') return 'operator';
  if (normalized === 'client') return 'client';
  return fallback;
}

function inferLegacyReporterEventClass(
  type: string,
  level: string | null,
  data: Record<string, unknown>,
): BugReportReporterEventClass {
  const loweredType = type.toLowerCase();
  const loweredMessage = typeof data.url === 'string' ? data.url.toLowerCase() : '';
  if (loweredType.includes('poll') || loweredMessage.includes('/events/pending')) return 'background_poll';
  if (loweredType.includes('failed') || loweredType.includes('exception') || level === 'error') {
    return 'primary_failure';
  }
  if (loweredType.includes('write') || loweredType.includes('mutation') || loweredType.includes('submit')) {
    return 'related_write';
  }
  if (loweredType.includes('fetch') || loweredType.includes('read') || loweredType.includes('load')) {
    return 'related_read';
  }
  return 'diagnostic';
}

function normalizeReporterEventClass(
  value: unknown,
  fallback: BugReportReporterEventClass,
): BugReportReporterEventClass {
  const normalized = readTrimmedString(value, 50)?.toLowerCase();
  if (normalized === 'primary_failure') return 'primary_failure';
  if (normalized === 'related_write') return 'related_write';
  if (normalized === 'related_read') return 'related_read';
  if (normalized === 'background_poll') return 'background_poll';
  if (normalized === 'diagnostic') return 'diagnostic';
  return fallback;
}

function normalizeEvidenceKind(value: unknown, fallback: BugReportEvidenceKind): BugReportEvidenceKind {
  const normalized = readTrimmedString(value, 50)?.toLowerCase();
  if (normalized === 'http_request') return 'http_request';
  if (normalized === 'http_response') return 'http_response';
  if (normalized === 'error') return 'error';
  if (normalized === 'console') return 'console';
  if (normalized === 'operator_note') return 'operator_note';
  if (normalized === 'raw_json') return 'raw_json';
  return fallback;
}

function inferEvidenceKind(entry: Record<string, unknown>): BugReportEvidenceKind {
  const explicit = normalizeEvidenceKind(entry.kind, 'raw_json');
  if (readTrimmedString(entry.kind, 50)) return explicit;
  const type = readTrimmedString(entry.type, 200)?.toLowerCase() ?? '';
  const level = readTrimmedString(entry.level, 50)?.toLowerCase() ?? '';
  if (Array.isArray(entry.lines)) return 'console';
  if (type.includes('operator') || normalizeReporterEventSource(entry.source, 'client') === 'operator') return 'operator_note';
  if (type.includes('http.response') || entry.status !== undefined) return 'http_response';
  if (type.includes('http.request') || (entry.method !== undefined && entry.url !== undefined)) return 'http_request';
  if (type.includes('error') || type.includes('exception') || level === 'error') return 'error';
  return 'raw_json';
}

function normalizeRawEvidence(value: unknown): BugReportRawEvidence[] {
  if (!Array.isArray(value)) return [];
  const evidence: BugReportRawEvidence[] = [];
  for (const entry of value.slice(0, MAX_RAW_EVIDENCE)) {
    if (!isRecord(entry)) continue;
    const kind = inferEvidenceKind(entry);
    const source = normalizeReporterEventSource(entry.source, kind === 'operator_note' ? 'operator' : 'api');
    const level = readTrimmedString(entry.level, 50);
    const requestId = readTrimmedString(entry.requestId, 300)
      ?? (isRecord(entry.data) ? readTrimmedString(entry.data.requestId, 300) : null);
    const url = readTrimmedString(entry.url, 4000)
      ?? (isRecord(entry.data) ? readTrimmedString(entry.data.url, 4000) : null);
    const method = readTrimmedString(entry.method, 20)
      ?? (isRecord(entry.data) ? readTrimmedString(entry.data.method, 20) : null);
    const status = readNumberField(entry.status)
      ?? (isRecord(entry.data) ? readNumberField(entry.data.status) : null);
    const text = toMultilineText(entry.text)
      ?? readTrimmedString(entry.message, 2000)
      ?? (Array.isArray(entry.lines)
        ? toMultilineText(entry.lines)
        : null);
    const data = isRecord(entry.data)
      ? { ...entry.data }
      : Object.fromEntries(
        Object.entries(entry).filter(([key]) => ![
          'kind',
          'timestamp',
          'source',
          'level',
          'message',
          'requestId',
          'url',
          'method',
          'status',
          'text',
          'lines',
        ].includes(key)),
      );
    const lines = Array.isArray(entry.lines)
      ? entry.lines
          .map((line) => (typeof line === 'string' ? truncateText(line, 1000) : ''))
          .filter((line) => line.length > 0)
      : [];
    evidence.push({
      timestamp: readIsoString(entry.timestamp),
      kind,
      source,
      level,
      message: readTrimmedString(entry.message, 2000),
      requestId,
      url,
      method: method?.toUpperCase() ?? null,
      status,
      text,
      data,
      lines,
    });
  }
  return evidence;
}

function rawEvidenceFromReporterEvents(events: BugReportReporterEvent[]): BugReportRawEvidence[] {
  return events.map((event) => ({
    timestamp: event.timestamp,
    kind: event.type === 'operator.note'
      ? 'operator_note'
      : event.type.includes('http.response')
        ? 'http_response'
        : event.type.includes('http.request')
          ? 'http_request'
          : event.level === 'error'
            ? 'error'
            : 'raw_json',
    source: event.source,
    level: event.level,
    message: event.message,
    requestId: readStringField(event.data.requestId),
    url: readStringField(event.data.url),
    method: readStringField(event.data.method)?.toUpperCase() ?? null,
    status: readNumberField(event.data.status),
    text: readStringField(event.data.text) ?? null,
    data: { ...event.data },
    lines: [],
  }));
}

function inferEvidenceEventClass(evidence: BugReportRawEvidence): BugReportReporterEventClass {
  if (evidence.kind === 'operator_note') return 'diagnostic';
  if ((evidence.url ?? '').includes('/events/pending')) return 'background_poll';
  if (evidence.kind === 'http_response') {
    if ((evidence.status ?? 0) >= 400) return 'primary_failure';
    const method = evidence.method ?? '';
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return 'related_write';
    return 'related_read';
  }
  if (evidence.kind === 'http_request') {
    const method = evidence.method ?? '';
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return 'related_write';
    return 'related_read';
  }
  if (evidence.kind === 'error') return 'primary_failure';
  const loweredUrl = evidence.url?.toLowerCase() ?? '';
  if (loweredUrl.includes('/events/pending')) return 'background_poll';
  if (evidence.level === 'error') return 'primary_failure';
  return 'diagnostic';
}

function reporterEventsFromRawEvidence(evidence: BugReportRawEvidence[]): BugReportReporterEvent[] {
  return evidence.map((entry) => {
    const message = entry.message ?? entry.text ?? null;
    const type = entry.kind === 'operator_note'
      ? 'operator.note'
      : entry.kind === 'http_response'
        ? 'http.response'
        : entry.kind === 'http_request'
          ? 'http.request'
          : entry.kind === 'console'
            ? 'console.output'
            : entry.kind === 'error'
              ? 'error.message'
              : 'raw.evidence';
    const data: Record<string, unknown> = {
      ...entry.data,
    };
    if (entry.requestId) data.requestId = entry.requestId;
    if (entry.url) data.url = entry.url;
    if (entry.method) data.method = entry.method;
    if (entry.status !== null) data.status = entry.status;
    if (entry.text) data.text = entry.text;
    if (entry.lines.length > 0) data.lines = entry.lines;
    return {
      timestamp: entry.timestamp,
      source: entry.source,
      class: inferEvidenceEventClass(entry),
      type,
      level: entry.level,
      message,
      data,
    };
  });
}

function normalizeReporterEvents(
  value: unknown,
  fallbackSource: BugReportReporterEventSource = 'client',
): BugReportReporterEvent[] {
  if (!Array.isArray(value)) return [];
  const entries: BugReportReporterEvent[] = [];
  for (const entry of value.slice(0, MAX_REPORTER_EVENTS)) {
    if (!isRecord(entry)) continue;
    const type = readTrimmedString(entry.type, 200);
    if (!type) continue;
    const data = isRecord(entry.data) ? entry.data : {};
    const level = readTrimmedString(entry.level, 50);
    const source = normalizeReporterEventSource(entry.source, fallbackSource);
    const fallbackClass = inferLegacyReporterEventClass(type, level, data);
    entries.push({
      timestamp: readIsoString(entry.timestamp),
      source,
      class: normalizeReporterEventClass(entry.class, fallbackClass),
      type,
      level,
      message: readTrimmedString(entry.message, 2000),
      data,
    });
  }
  return entries;
}

function normalizeEnvironment(raw: Record<string, unknown>): Record<string, unknown> & { runtime: string } {
  const source = isRecord(raw.environment)
    ? { ...raw.environment }
    : isRecord(raw.runtimeContext)
      ? { ...raw.runtimeContext }
      : {};
  const runtime = readTrimmedString(source.runtime ?? raw.runtime, 100) ?? 'unknown';
  const keys = ['platform', 'route', 'build', 'clientVersion', 'appVersion', 'os', 'userAgent', 'windowId', 'documentId'];
  const environment: Record<string, unknown> & { runtime: string } = { runtime };
  for (const key of keys) {
    const value = readTrimmedString(source[key] ?? raw[key], 500);
    if (value) environment[key] = value;
  }
  return environment;
}

function normalizeDocumentContext(raw: Record<string, unknown>, slug: string | null): Record<string, unknown> {
  const source = isRecord(raw.documentContext) ? raw.documentContext : {};
  const context: Record<string, unknown> = {};
  const keys = ['docId', 'windowId', 'title', 'excerpt', 'url'];
  for (const key of keys) {
    const value = readTrimmedString(source[key] ?? raw[key], key === 'excerpt' ? 1000 : 500);
    if (value) context[key] = value;
  }
  if (slug) context.slug = slug;
  return context;
}

function normalizeBugReportType(value: unknown): BugReportType {
  const normalized = readTrimmedString(value, 50)?.toLowerCase();
  if (normalized === 'performance') return 'performance';
  if (normalized === 'ux') return 'ux';
  return 'bug';
}

function normalizeSeverity(value: unknown): BugReportSeverity {
  const normalized = readTrimmedString(value, 50)?.toLowerCase();
  if (normalized === 'blocker') return 'blocker';
  if (normalized === 'high') return 'high';
  if (normalized === 'low') return 'low';
  return 'medium';
}

function normalizeSlug(raw: Record<string, unknown>): string | null {
  return readTrimmedString(raw.slug, 300)
    ?? (isRecord(raw.documentContext) ? readTrimmedString(raw.documentContext.slug, 300) : null);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function inferReporterMode(raw: Record<string, unknown>, environment: { runtime: string }): BugReportReporterMode {
  const explicit = readTrimmedString(raw.reporterMode, 50)?.toLowerCase();
  if (explicit === 'api_only') return 'api_only';
  if (explicit === 'in_product_web') return 'in_product_web';
  if (explicit === 'native_app') return 'native_app';
  if (explicit === 'human_assisted') return 'human_assisted';
  if (Array.isArray(raw.recentClientEvents) || Array.isArray(raw.clientEventSlice)) {
    return environment.runtime === 'macos' ? 'native_app' : 'in_product_web';
  }
  if (Array.isArray(raw.agentTranscript) || Array.isArray(raw.conversationTranscript)) {
    return 'human_assisted';
  }
  return 'human_assisted';
}

export function getBugReportSpec(): Record<string, unknown> {
  return {
    version: BUG_REPORT_SPEC_VERSION,
    repo: {
      owner: process.env.PROOF_GITHUB_ISSUES_OWNER?.trim() || DEFAULT_GITHUB_OWNER,
      name: process.env.PROOF_GITHUB_ISSUES_REPO?.trim() || DEFAULT_GITHUB_REPO,
    },
    reportTypes: ['bug', 'performance', 'ux'],
    severityLevels: ['blocker', 'high', 'medium', 'low'],
    reporterModes: REPORTER_MODES,
    requiredFields: {
      common: ['summary', 'expected', 'actual', 'repro', 'severity', 'environment.runtime'],
      evidence: ['requestId_or_slug', 'occurredAt (required when requestId is not supplied)'],
      byMode: REPORTER_MODE_REQUIRED_FIELDS,
    },
    evidenceChecklist: [
      'Include the exact expected vs actual behavior.',
      'Include step-by-step reproduction instructions.',
      'Include runtime context such as platform, build, and route when available.',
      'Include either a requestId or a document slug so server traces can be attached.',
      'If you do not have a requestId, include occurredAt so the server evidence window can be narrowed.',
      'Attach reporter events, operator transcript, and user notes when available.',
    ],
    reporterEvidence: {
      fields: ['timestamp', 'source', 'class', 'type', 'level', 'message', 'data'],
      sources: REPORTER_EVENT_SOURCES,
      classes: REPORTER_EVENT_CLASSES,
    },
    payloadLimits: {
      maxSummaryChars: MAX_TEXT_CHARS,
      maxTranscriptEntries: MAX_TRANSCRIPT_ENTRIES,
      maxReporterEvents: MAX_REPORTER_EVENTS,
      maxQuestionAnswers: MAX_QUESTION_ANSWERS,
      maxServerIncidentEvents: MAX_SERVER_INCIDENT_EVENTS,
      maxDocumentEvents: MAX_DOCUMENT_EVENTS,
      slugTraceLookbackMs: SERVER_TRACE_LOOKBACK_MS,
      slugTraceLookaheadMs: SERVER_TRACE_LOOKAHEAD_MS,
    },
    suggestedQuestions: {
      common: MISSING_FIELD_QUESTIONS,
      byMode: MODE_SUGGESTED_QUESTIONS,
    },
    examples: {
      api_only: {
        reporterMode: 'api_only',
        reportType: 'bug',
        severity: 'high',
        summary: 'PUT /api/documents/:slug/title returned 500 during a title update.',
        expected: 'The title update should return 200 and persist the new title.',
        actual: 'The API returned 500 and the title stayed unchanged.',
        repro: [
          'Create or load a shared document.',
          'Send PUT /api/documents/:slug/title with a new title.',
          'Observe the 500 response and unchanged title.',
        ],
        writeup: 'I was steering the agent over HTTP only and the title update failed on the first write.',
        userNotes: 'This blocks the user from renaming the document.',
        additionalContext: 'The failing request is the first write after document creation.',
        slug: 'example-slug',
        requestId: 'example-request-id',
        occurredAt: new Date(0).toISOString(),
        environment: {
          runtime: 'server',
          route: 'PUT /api/documents/example-slug/title',
          build: 'local',
        },
        operatorTranscript: [
          { role: 'user', content: 'Rename the document to "Launch Notes!" and tell me what happens.' },
          { role: 'assistant', content: 'The API returned 500 when I tried the title update.' },
        ],
        reporterEvents: [
          {
            timestamp: new Date(0).toISOString(),
            source: 'api',
            class: 'primary_failure',
            type: 'http.response',
            level: 'error',
            message: 'PUT /api/documents/example-slug/title returned 500',
            data: {
              method: 'PUT',
              url: 'http://127.0.0.1:5556/api/documents/example-slug/title',
              status: 500,
              statusText: 'Internal Server Error',
              requestId: 'example-request-id',
              requestBodyExcerpt: { title: 'Launch Notes!' },
              responseExcerpt: { error: 'Document title update failed unexpectedly' },
            },
          },
        ],
      },
    },
    serverBuild: getBuildInfo(),
  };
}

function extractRequestIdFromRawEvidence(evidence: BugReportRawEvidence[]): string | null {
  for (const entry of evidence) {
    if (entry.requestId && ((entry.status ?? 0) >= 400 || entry.kind === 'error')) return entry.requestId;
  }
  for (const entry of evidence) {
    if (entry.requestId) return entry.requestId;
  }
  return null;
}

function extractSlugFromUrl(url: string | null): string | null {
  const pathname = parseUrlPathname(url);
  if (!pathname) return null;
  const directMatch = pathname.match(/^\/d\/([^/]+)\//);
  if (directMatch?.[1]) return directMatch[1];
  const documentMatch = pathname.match(/^\/api\/documents\/([^/]+)/);
  if (documentMatch?.[1]) return documentMatch[1];
  const agentMatch = pathname.match(/^\/api\/agent\/([^/]+)/);
  if (agentMatch?.[1] && !['bug-reports', 'events'].includes(agentMatch[1])) return agentMatch[1];
  return null;
}

function extractSlugFromRawEvidence(evidence: BugReportRawEvidence[]): string | null {
  for (const entry of evidence) {
    const slug = extractSlugFromUrl(entry.url);
    if (slug) return slug;
  }
  return null;
}

function deriveSummaryFromSignals(
  explicit: string | null,
  context: string | null,
  reporterEvents: BugReportReporterEvent[],
  rawEvidence: BugReportRawEvidence[],
): string | null {
  if (explicit) return explicit;
  for (const event of reporterEvents) {
    if ((event.class === 'primary_failure' || event.level === 'error') && event.message) {
      return truncateText(event.message, 8000);
    }
  }
  for (const entry of rawEvidence) {
    if ((entry.status ?? 0) >= 400 && entry.url) {
      const method = entry.method ?? 'REQUEST';
      return truncateText(`${method} ${parseUrlPathname(entry.url) ?? entry.url} returned ${entry.status}`, 8000);
    }
    if (entry.message) return truncateText(entry.message, 8000);
    if (entry.text) return truncateText(entry.text, 8000);
  }
  if (!context) return null;
  const firstLine = context.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  return firstLine ? truncateText(firstLine, 8000) : null;
}

function deriveActualFromSignals(
  explicit: string | null,
  context: string | null,
  reporterEvents: BugReportReporterEvent[],
  rawEvidence: BugReportRawEvidence[],
): string | null {
  if (explicit) return explicit;
  for (const event of reporterEvents) {
    if ((event.class === 'primary_failure' || event.level === 'error') && event.message) {
      return truncateText(event.message, 8000);
    }
  }
  for (const entry of rawEvidence) {
    if (entry.message) return truncateText(entry.message, 8000);
    if (entry.text) return truncateText(entry.text, 8000);
  }
  return context ? truncateText(context, 8000) : null;
}

function buildNextBestEvidence(input: {
  expected: string | null;
  context: string | null;
  requestId: string | null;
  slug: string | null;
  rawEvidence: BugReportRawEvidence[];
}): string[] {
  const suggestions: string[] = [];
  if (!input.requestId && !input.slug) {
    suggestions.push('Include the document slug or the x-request-id from the first failing request.');
  }
  const hasFailingHttp = input.rawEvidence.some((entry) => entry.kind === 'http_response' && (entry.status ?? 0) >= 400);
  if (!hasFailingHttp) {
    suggestions.push('Attach the first failing HTTP response, including URL, status, response body, and x-request-id if available.');
  }
  if (!input.context) {
    suggestions.push('Describe what you were trying to do when the failure happened.');
  }
  if (!input.expected) {
    suggestions.push('If you know what should have happened, include that expected behavior.');
  }
  return uniqueStrings(suggestions).slice(0, 4);
}

function deriveToolSuggestedQuestions(missingFields: string[], expected: string | null): string[] {
  const suggestions = missingFields.map((field) => {
    if (field === 'context_or_evidence') return 'What were you doing, and what evidence do you have from the failure?';
    return MISSING_FIELD_QUESTIONS[field];
  }).filter((question): question is string => typeof question === 'string' && question.length > 0);
  if (!expected) {
    suggestions.push('If you know the intended behavior, what should have happened instead?');
  }
  return uniqueStrings(suggestions);
}

type BridgeBugReportValidationResult =
  | { ok: true; report: NormalizedBugReport }
  | { ok: false; missingFields: string[]; suggestedQuestions: string[]; nextBestEvidence: string[] };

type BridgeBugReportFollowUpValidationResult =
  | { ok: true; followUp: NormalizedBugReportFollowUp }
  | { ok: false; missingFields: string[]; suggestedQuestions: string[]; nextBestEvidence: string[] };

export function getReportBugToolSpec(input: { slugFromPath?: string | null; baseUrl?: string | null } = {}): Record<string, unknown> {
  const slugNote = input.slugFromPath ? `Slug context is already bound to ${input.slugFromPath}.` : 'Provide slug when you want server/document evidence enrichment.';
  const canonicalBaseUrl = readTrimmedString(input.baseUrl, 2000) ?? 'https://www.proofeditor.ai';
  const reportBugUrl = `${canonicalBaseUrl}/api/bridge/report_bug`;
  const exampleEditUrl = `${canonicalBaseUrl}/api/agent/example/edit/v2`;
  return {
    success: true,
    tool: 'report_bug',
    version: BUG_REPORT_SPEC_VERSION,
    description: 'Create or update a Proof bug report through one HTTP bridge tool call.',
    method: 'POST',
    auth: 'none',
    endpoint: reportBugUrl,
    paths: {
      canonical: '/api/bridge/report_bug',
      docAwareAlias: '/d/:slug/bridge/report_bug',
    },
    guidance: {
      summary: 'Call POST /api/bridge/report_bug with what you know. If the response says needs_more_info, ask the suggested questions and call it again. If you need to append context later, call the same endpoint with issueNumber.',
      slugContext: slugNote,
      non2xxRule: 'Only transport, auth, or server failures use non-2xx responses. Missing bug details return 200 with status=needs_more_info.',
      knownIncident: {
        code: ACTIVE_INCIDENT_CODE,
        status: 'active',
        summary: ACTIVE_INCIDENT_SUMMARY,
        reportHint: ACTIVE_INCIDENT_REPORT_HINT,
        agentNote: ACTIVE_INCIDENT_AGENT_NOTE,
        bestEvidence: ACTIVE_INCIDENT_EVIDENCE_EXAMPLES,
      },
      bestEvidenceExamples: ACTIVE_INCIDENT_EVIDENCE_EXAMPLES,
    },
    input: {
      required: ['summary or context', 'evidence or requestId/slug'],
      fields: {
        summary: 'One-line bug summary when you have it.',
        actual: 'What happened.',
        expected: 'What should have happened.',
        repro: 'Steps to reproduce, if known.',
        context: 'Free-form narrative for everything that does not fit the structured fields.',
        evidence: 'Raw evidence blobs. The server classifies them for the fixer.',
        requestId: 'Optional x-request-id for server trace lookup.',
        occurredAt: 'Optional ISO timestamp for narrowing the evidence window.',
        slug: 'Optional document slug on the top-level path.',
        issueNumber: 'When present, the same tool appends follow-up context to an existing issue.',
        followUp: 'Explicit follow-up text when issueNumber is present.',
      },
      evidenceKinds: ['http_request', 'http_response', 'error', 'console', 'operator_note', 'raw_json'],
    },
    response: {
      statuses: ['created', 'needs_more_info', 'follow_up_added'],
      fields: ['missingFields', 'suggestedQuestions', 'nextBestEvidence', 'evidenceSummary', 'fixerBrief', 'issueNumber', 'issueUrl'],
    },
    openSourceReference: {
      name: 'EveryInc/proof-sdk',
      url: REPORT_BUG_OPEN_SOURCE_REPO_URL,
      guidance: 'If you want reference code while debugging, you can inspect this repo while preparing the report.',
    },
    examples: {
      minimal: {
        summary: 'edit/v2 returned 500 while inserting a mark',
        context: 'I was trying to add a mark to the selected text and the first write failed.',
        evidence: [
          {
            kind: 'http_response',
            method: 'POST',
            url: exampleEditUrl,
            status: 500,
            requestId: 'example-request-id',
            data: {
              responseBody: { error: 'Internal Server Error' },
            },
          },
        ],
      },
      needsMoreInfo: {
        context: 'Something weird happened after I clicked publish.',
      },
      followUp: {
        issueNumber: 42,
        followUp: 'Tried again with a single mark and it still failed.',
        evidence: [
          {
            kind: 'http_response',
            method: 'POST',
            url: exampleEditUrl,
            status: 500,
            requestId: 'example-request-id',
          },
        ],
      },
    },
    curlExamples: {
      create: `curl -X POST ${reportBugUrl} -H 'content-type: application/json' -d '{"summary":"edit/v2 returned 500","context":"I tried to insert a mark and the first write failed.","evidence":[{"kind":"http_response","method":"POST","url":"${exampleEditUrl}","status":500,"requestId":"example-request-id"}]}'`,
      followUp: `curl -X POST ${reportBugUrl} -H 'content-type: application/json' -d '{"issueNumber":42,"followUp":"Tried again with a single mark and it still failed."}'`,
    },
  };
}

export function validateReportBugToolCreate(body: unknown, slugFromPath: string | null = null): BridgeBugReportValidationResult {
  const raw = isRecord(body) ? body : {};
  const explicitSummary = readTrimmedString(raw.summary ?? raw.title);
  const explicitActual = toMultilineText(raw.actual);
  const expected = toMultilineText(raw.expected);
  const repro = toMultilineText(raw.repro ?? raw.reproSteps);
  const context = buildContextText(raw);
  const environment = normalizeEnvironment(raw);
  const reporterMode = inferReporterMode(raw, environment);
  const legacyReporterEvents = normalizeReporterEvents(raw.reporterEvents ?? raw.recentClientEvents ?? raw.clientEventSlice);
  const rawEvidenceInput = normalizeRawEvidence(raw.evidence);
  const rawEvidence = rawEvidenceInput.length > 0 ? rawEvidenceInput : rawEvidenceFromReporterEvents(legacyReporterEvents);
  const reporterEvents = rawEvidence.length > 0 ? reporterEventsFromRawEvidence(rawEvidence) : legacyReporterEvents;
  const slug = slugFromPath ?? normalizeSlug(raw) ?? extractSlugFromRawEvidence(rawEvidence);
  const requestId = readTrimmedString(raw.requestId, 300) ?? extractRequestIdFromRawEvidence(rawEvidence);
  const occurredAt = readIsoString(raw.occurredAt ?? raw.observedAt)
    ?? rawEvidence.find((entry) => entry.timestamp)?.timestamp
    ?? reporterEvents.find((entry) => entry.timestamp)?.timestamp
    ?? null;
  const summary = deriveSummaryFromSignals(explicitSummary, context, reporterEvents, rawEvidence);
  const actual = deriveActualFromSignals(explicitActual, context, reporterEvents, rawEvidence);
  const missingFields: string[] = [];

  if (!summary) missingFields.push('summary');
  if (!context && !actual && rawEvidence.length === 0 && reporterEvents.length === 0) {
    missingFields.push('context_or_evidence');
  }
  if (!requestId && !slug) missingFields.push('requestId_or_slug');

  if (missingFields.length > 0) {
    return {
      ok: false,
      missingFields: uniqueStrings(missingFields),
      suggestedQuestions: deriveToolSuggestedQuestions(missingFields, expected),
      nextBestEvidence: buildNextBestEvidence({
        expected,
        context,
        requestId,
        slug,
        rawEvidence,
      }),
    };
  }

  return {
    ok: true,
    report: {
      reportType: normalizeBugReportType(raw.reportType),
      severity: normalizeSeverity(raw.severity),
      reporterMode,
      summary: summary ?? 'Bug report',
      expected,
      actual,
      repro,
      context,
      writeup: readTrimmedString(raw.writeup, MAX_TEXT_CHARS),
      userNotes: readTrimmedString(raw.userNotes, MAX_TEXT_CHARS),
      additionalContext: readTrimmedString(raw.additionalContext, MAX_TEXT_CHARS),
      slug,
      requestId,
      occurredAt,
      capturedAt: new Date().toISOString(),
      subsystemGuess: readTrimmedString(raw.subsystemGuess ?? raw.subsystem, 100),
      environment,
      documentContext: normalizeDocumentContext(raw, slug),
      questionsAsked: normalizeQuestionAnswers(raw.questionsAsked ?? raw.userAnswers),
      operatorTranscript: normalizeTranscript(raw.operatorTranscript ?? raw.agentTranscript ?? raw.conversationTranscript),
      rawEvidence,
      reporterEvents,
    },
  };
}

export function validateReportBugToolFollowUp(
  body: unknown,
  slugFromPath: string | null = null,
): BridgeBugReportFollowUpValidationResult {
  const raw = isRecord(body) ? body : {};
  const context = buildContextText(raw, true);
  const environment = normalizeEnvironment(raw);
  const reporterMode = inferReporterMode(raw, environment);
  const legacyReporterEvents = normalizeReporterEvents(raw.reporterEvents ?? raw.recentClientEvents ?? raw.clientEventSlice);
  const rawEvidenceInput = normalizeRawEvidence(raw.evidence);
  const rawEvidence = rawEvidenceInput.length > 0 ? rawEvidenceInput : rawEvidenceFromReporterEvents(legacyReporterEvents);
  const reporterEvents = rawEvidence.length > 0 ? reporterEventsFromRawEvidence(rawEvidence) : legacyReporterEvents;
  const slug = slugFromPath ?? normalizeSlug(raw) ?? extractSlugFromRawEvidence(rawEvidence);
  const requestId = readTrimmedString(raw.requestId, 300) ?? extractRequestIdFromRawEvidence(rawEvidence);
  const occurredAt = readIsoString(raw.occurredAt ?? raw.observedAt)
    ?? rawEvidence.find((entry) => entry.timestamp)?.timestamp
    ?? reporterEvents.find((entry) => entry.timestamp)?.timestamp
    ?? null;
  const hasContent = Boolean(
    context
      || rawEvidence.length > 0
      || reporterEvents.length > 0
      || requestId
      || slug
      || normalizeQuestionAnswers(raw.questionsAsked ?? raw.userAnswers).length > 0
      || normalizeTranscript(raw.operatorTranscript ?? raw.agentTranscript ?? raw.conversationTranscript).length > 0,
  );

  if (!hasContent) {
    return {
      ok: false,
      missingFields: ['follow_up_content'],
      suggestedQuestions: [MISSING_FIELD_QUESTIONS.follow_up_content],
      nextBestEvidence: buildNextBestEvidence({
        expected: null,
        context,
        requestId,
        slug,
        rawEvidence,
      }),
    };
  }

  return {
    ok: true,
    followUp: {
      reporterMode,
      context,
      writeup: readTrimmedString(raw.writeup, MAX_TEXT_CHARS),
      userNotes: readTrimmedString(raw.userNotes, MAX_TEXT_CHARS),
      additionalContext: readTrimmedString(raw.additionalContext, MAX_TEXT_CHARS),
      slug,
      requestId,
      occurredAt,
      capturedAt: new Date().toISOString(),
      subsystemGuess: readTrimmedString(raw.subsystemGuess ?? raw.subsystem, 100),
      environment,
      documentContext: normalizeDocumentContext(raw, slug),
      questionsAsked: normalizeQuestionAnswers(raw.questionsAsked ?? raw.userAnswers),
      operatorTranscript: normalizeTranscript(raw.operatorTranscript ?? raw.agentTranscript ?? raw.conversationTranscript),
      rawEvidence,
      reporterEvents,
    },
  };
}

export function validateBugReportSubmission(body: unknown): BugReportValidationResult {
  const raw = isRecord(body) ? body : {};
  const slug = normalizeSlug(raw);
  const requestId = readTrimmedString(raw.requestId, 300);
  const occurredAt = readIsoString(raw.occurredAt ?? raw.observedAt);
  const reportType = normalizeBugReportType(raw.reportType);
  const severityInput = readTrimmedString(raw.severity, 50);
  const severity = normalizeSeverity(raw.severity);
  const summary = readTrimmedString(raw.summary ?? raw.title);
  const expected = toMultilineText(raw.expected);
  const actual = toMultilineText(raw.actual);
  const repro = toMultilineText(raw.repro ?? raw.reproSteps);
  const context = buildContextText(raw);
  const environment = normalizeEnvironment(raw);
  const reporterMode = inferReporterMode(raw, environment);
  const subsystemGuess = readTrimmedString(raw.subsystemGuess ?? raw.subsystem, 100);
  const questionsAsked = normalizeQuestionAnswers(raw.questionsAsked ?? raw.userAnswers);
  const operatorTranscript = normalizeTranscript(raw.operatorTranscript ?? raw.agentTranscript ?? raw.conversationTranscript);
  const rawEvidence = normalizeRawEvidence(raw.evidence);
  const reporterEvents = rawEvidence.length > 0
    ? reporterEventsFromRawEvidence(rawEvidence)
    : normalizeReporterEvents(raw.reporterEvents ?? raw.recentClientEvents ?? raw.clientEventSlice);
  const normalizedRawEvidence = rawEvidence.length > 0 ? rawEvidence : rawEvidenceFromReporterEvents(reporterEvents);
  const capturedAt = new Date().toISOString();
  const missingFields: string[] = [];

  if (!summary) missingFields.push('summary');
  if (!expected) missingFields.push('expected');
  if (!actual) missingFields.push('actual');
  if (!repro) missingFields.push('repro');
  if (!severityInput) missingFields.push('severity');
  if (!environment.runtime || environment.runtime === 'unknown') missingFields.push('environment.runtime');
  if (!requestId && !slug) missingFields.push('requestId_or_slug');
  if (!requestId && !occurredAt) missingFields.push('occurredAt');

  if (missingFields.length > 0 || !summary || !expected || !actual || !repro) {
    return {
      ok: false,
      missingFields: uniqueStrings(missingFields),
      suggestedQuestions: uniqueStrings(
        [
          ...missingFields.map((field) => MISSING_FIELD_QUESTIONS[field]).filter(
            (question): question is string => typeof question === 'string' && question.length > 0,
          ),
          ...MODE_SUGGESTED_QUESTIONS[reporterMode],
        ],
      ),
    };
  }

  return {
    ok: true,
    report: {
      reportType,
      severity,
      reporterMode,
      summary,
      expected,
      actual,
      repro,
      context,
      writeup: readTrimmedString(raw.writeup, MAX_TEXT_CHARS),
      userNotes: readTrimmedString(raw.userNotes, MAX_TEXT_CHARS),
      additionalContext: readTrimmedString(raw.additionalContext, MAX_TEXT_CHARS),
      slug,
      requestId,
      occurredAt,
      capturedAt,
      subsystemGuess,
      environment,
      documentContext: normalizeDocumentContext(raw, slug),
      questionsAsked,
      operatorTranscript,
      rawEvidence: normalizedRawEvidence,
      reporterEvents,
    },
  };
}

export function validateBugReportFollowUp(body: unknown): BugReportFollowUpValidationResult {
  const raw = isRecord(body) ? body : {};
  const slug = normalizeSlug(raw);
  const requestId = readTrimmedString(raw.requestId, 300);
  const occurredAt = readIsoString(raw.occurredAt ?? raw.observedAt);
  const environment = normalizeEnvironment(raw);
  const reporterMode = inferReporterMode(raw, environment);
  const subsystemGuess = readTrimmedString(raw.subsystemGuess ?? raw.subsystem, 100);
  const questionsAsked = normalizeQuestionAnswers(raw.questionsAsked ?? raw.userAnswers);
  const operatorTranscript = normalizeTranscript(raw.operatorTranscript ?? raw.agentTranscript ?? raw.conversationTranscript);
  const rawEvidence = normalizeRawEvidence(raw.evidence);
  const reporterEvents = rawEvidence.length > 0
    ? reporterEventsFromRawEvidence(rawEvidence)
    : normalizeReporterEvents(raw.reporterEvents ?? raw.recentClientEvents ?? raw.clientEventSlice);
  const normalizedRawEvidence = rawEvidence.length > 0 ? rawEvidence : rawEvidenceFromReporterEvents(reporterEvents);
  const context = buildContextText(raw, true);
  const writeup = readTrimmedString(raw.writeup, MAX_TEXT_CHARS);
  const userNotes = readTrimmedString(raw.userNotes, MAX_TEXT_CHARS);
  const additionalContext = readTrimmedString(raw.additionalContext, MAX_TEXT_CHARS);
  const capturedAt = new Date().toISOString();

  const hasContent = Boolean(
    context
      || raw.followUp
      || writeup
      || userNotes
      || additionalContext
      || questionsAsked.length > 0
      || operatorTranscript.length > 0
      || reporterEvents.length > 0
      || requestId
      || slug,
  );

  if (!hasContent) {
    return {
      ok: false,
      missingFields: ['follow_up_content'],
      suggestedQuestions: [
        MISSING_FIELD_QUESTIONS.follow_up_content,
        ...MODE_SUGGESTED_QUESTIONS[reporterMode],
      ],
    };
  }

  return {
    ok: true,
    followUp: {
      reporterMode,
      context,
      writeup,
      userNotes,
      additionalContext,
      slug,
      requestId,
      occurredAt,
      capturedAt,
      subsystemGuess,
      environment,
      documentContext: normalizeDocumentContext(raw, slug),
      questionsAsked,
      operatorTranscript,
      rawEvidence: normalizedRawEvidence,
      reporterEvents,
    },
  };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function computeEvidenceWindow(input: {
  slug: string | null;
  occurredAt: string | null;
  capturedAt: string;
}): { from: string; to: string } | null {
  if (!input.slug) return null;
  const center = Date.parse(input.occurredAt ?? input.capturedAt);
  if (!Number.isFinite(center)) return null;
  return {
    from: new Date(center - SERVER_TRACE_LOOKBACK_MS).toISOString(),
    to: new Date(center + SERVER_TRACE_LOOKAHEAD_MS).toISOString(),
  };
}

function sanitizeLabelValue(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function normalizeServerIncidentEvents(rows: ServerIncidentEventRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    id: row.id,
    timestamp: row.created_at,
    requestId: row.request_id,
    slug: row.slug,
    subsystem: row.subsystem,
    level: row.level,
    eventType: row.event_type,
    message: row.message,
    data: parseJsonRecord(row.data_json),
  }));
}

function normalizeDocumentEvents(rows: DocumentEventRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    id: row.id,
    timestamp: row.created_at,
    revision: row.document_revision,
    type: row.event_type,
    actor: row.actor,
    data: parseJsonRecord(row.event_data),
  }));
}

function dedupeEventsById(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const deduped: Array<Record<string, unknown>> = [];
  for (const event of events) {
    const id = `${event.id ?? ''}:${event.timestamp ?? ''}:${event.eventType ?? event.type ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(event);
  }
  return deduped;
}

function dedupeReporterEvents(events: BugReportReporterEvent[]): BugReportReporterEvent[] {
  const seen = new Set<string>();
  const deduped: BugReportReporterEvent[] = [];
  for (const event of events) {
    const key = [
      event.timestamp ?? '',
      event.source,
      event.class,
      event.type,
      event.level ?? '',
      event.message ?? '',
      typeof event.data.requestId === 'string' ? event.data.requestId : '',
      typeof event.data.url === 'string' ? event.data.url : '',
    ].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

function getLevelPriority(level: string | null): number {
  if (level === 'error') return 0;
  if (level === 'warn') return 1;
  return 2;
}

function getReporterEventPriority(event: BugReportReporterEvent): number {
  const classPriority = REPORTER_EVENT_CLASS_PRIORITY[event.class];
  const requestBonus = typeof event.data.requestId === 'string' ? 0 : 1;
  const urlBonus = typeof event.data.url === 'string' ? 0 : 1;
  return (classPriority * 100) + (getLevelPriority(event.level) * 10) + requestBonus + urlBonus;
}

function compareIsoTimestampDescending(a: string | null, b: string | null): number {
  const left = a ? Date.parse(a) : 0;
  const right = b ? Date.parse(b) : 0;
  return right - left;
}

function prioritizeReporterEvents(events: BugReportReporterEvent[]): {
  reporterEvents: BugReportReporterEvent[];
  backgroundPollOmittedCount: number;
} {
  const deduped = dedupeReporterEvents(events);
  const highSignal = deduped.filter((event) => event.class !== 'background_poll');
  const selectedSource = highSignal.length > 0 ? highSignal : deduped;
  const backgroundPollOmittedCount = highSignal.length > 0
    ? deduped.length - highSignal.length
    : 0;
  const sorted = selectedSource
    .slice()
    .sort((left, right) => {
      const priorityDelta = getReporterEventPriority(left) - getReporterEventPriority(right);
      if (priorityDelta !== 0) return priorityDelta;
      return compareIsoTimestampDescending(left.timestamp, right.timestamp);
    })
    .slice(0, MAX_REPORTER_EVENTS);
  return { reporterEvents: sorted, backgroundPollOmittedCount };
}

function readStringField(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function readNumberField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseUrlPathname(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value, 'http://localhost').pathname;
  } catch {
    return value.startsWith('/') ? value : null;
  }
}

function derivePrimaryRequest(reporterEvents: BugReportReporterEvent[]): BugReportPrimaryRequest | null {
  for (const event of reporterEvents) {
    const method = readStringField(event.data.method);
    const url = readStringField(event.data.url);
    const requestId = readStringField(event.data.requestId);
    const status = readNumberField(event.data.status);
    const statusText = readStringField(event.data.statusText);
    if (!method && !url && !requestId && status === null) continue;
    return {
      requestId,
      method: method ? method.toUpperCase() : null,
      url,
      pathname: parseUrlPathname(url),
      status,
      statusText,
      source: event.source,
      eventType: event.type,
      message: event.message,
      timestamp: event.timestamp,
    };
  }
  return null;
}

function deriveRouteHint(primaryRequest: BugReportPrimaryRequest | null): string | null {
  if (!primaryRequest) return null;
  if (primaryRequest.method && primaryRequest.pathname) {
    return `${primaryRequest.method} ${primaryRequest.pathname}`;
  }
  return primaryRequest.pathname ?? primaryRequest.method ?? null;
}

function looksLikeIdSegment(segment: string): boolean {
  return /^[0-9a-f]{8,}$/i.test(segment) || /^[0-9a-f-]{8,}$/i.test(segment);
}

function deriveRouteTemplate(primaryRequest: BugReportPrimaryRequest | null): string | null {
  const pathname = primaryRequest?.pathname;
  if (!pathname) return null;
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  const templated = segments.map((segment, index) => {
    const previous = segments[index - 1] ?? '';
    if (previous === 'd') return ':slug';
    if (previous === 'documents') return ':slug';
    if (previous === 'agent' && index < segments.length - 1) return ':slug';
    if (looksLikeIdSegment(segment)) return ':id';
    return segment;
  });
  return `/${templated.join('/')}`;
}

function derivePrimaryError(
  reporterEvents: BugReportReporterEvent[],
  serverEvents: Array<Record<string, unknown>>,
): string | null {
  for (const event of reporterEvents) {
    if (event.class !== 'primary_failure' && event.level !== 'error') continue;
    const responseExcerpt = isRecord(event.data.responseExcerpt) ? event.data.responseExcerpt : null;
    const errorMessage = responseExcerpt
      ? readTrimmedString(responseExcerpt.error ?? responseExcerpt.message ?? responseExcerpt.code, 500)
      : null;
    const payloadMessage = readTrimmedString(event.data.text, 500);
    const message = errorMessage ?? payloadMessage ?? event.message;
    if (message) return message;
  }
  for (const event of serverEvents) {
    if (event.level !== 'error') continue;
    const message = typeof event.message === 'string' ? event.message.trim() : '';
    if (message) return truncateText(message, 500);
  }
  return null;
}

function inferSubsystemFromRouteHint(routeHint: string | null): string {
  if (!routeHint) return 'unknown';
  if (routeHint.includes('/api/agent/bug-reports') || routeHint.includes('/api/bridge/report_bug')) return 'agent_bug_reports';
  if (routeHint.includes('/bridge')) return 'bridge';
  if (routeHint.includes('/collab')) return 'collab';
  if (routeHint.includes('/api/documents/') || routeHint.includes('/api/agent/') || routeHint.includes('/d/')) return 'routes';
  return 'unknown';
}

function inferSubsystem(
  subsystemGuess: string | null,
  serverEvents: Array<Record<string, unknown>>,
  routeHint: string | null,
): string {
  const explicit = sanitizeLabelValue(subsystemGuess, '');
  if (explicit) return explicit;
  const counts = new Map<string, number>();
  for (const event of serverEvents) {
    const subsystem = typeof event.subsystem === 'string' ? event.subsystem : '';
    if (!subsystem || subsystem === 'http' || subsystem === 'agent_bug_reports') continue;
    counts.set(subsystem, (counts.get(subsystem) ?? 0) + 1);
  }
  let winner = 'unknown';
  let max = 0;
  for (const [key, count] of counts) {
    if (count > max) {
      winner = key;
      max = count;
    }
  }
  if (winner !== 'unknown') return winner;
  return inferSubsystemFromRouteHint(routeHint);
}

function deriveSuspectedFiles(inferredSubsystem: string, routeHint: string | null): string[] {
  const files: string[] = [];
  const add = (...paths: string[]) => {
    for (const candidate of paths) {
      if (!files.includes(candidate)) files.push(candidate);
    }
  };

  if (inferredSubsystem === 'bridge' || routeHint?.includes('/bridge')) {
    add('server/bridge.ts', 'server/ws.ts', 'src/bridge/share-client.ts');
  }
  if (inferredSubsystem === 'collab' || routeHint?.includes('/collab')) {
    add('server/collab.ts', 'server/ws.ts', 'src/bridge/collab-client.ts');
  }
  if (inferredSubsystem === 'agent_bug_reports' || routeHint?.includes('/api/agent/bug-reports') || routeHint?.includes('/api/bridge/report_bug')) {
    add('server/agent-routes.ts', 'server/bug-reporting.ts');
  }
  if (inferredSubsystem === 'routes' || routeHint?.includes('/api/documents/')) {
    add('server/routes.ts', 'src/bridge/share-client.ts', 'src/editor/index.ts');
  }
  if (routeHint?.includes('/api/agent/')) {
    add('server/agent-routes.ts');
  }
  if (routeHint?.includes('/snapshot')) {
    add('server/agent-snapshot.ts', 'server/share-web-routes.ts');
  }
  if (routeHint?.includes('/state') || routeHint?.includes('/d/')) {
    add('server/share-web-routes.ts');
  }

  return files.slice(0, MAX_SUSPECTED_FILES);
}

function buildLabels(report: NormalizedBugReport, inferredSubsystem: string): string[] {
  return uniqueStrings([
    'agent-report',
    report.reportType,
    `severity:${sanitizeLabelValue(report.severity, 'medium')}`,
    `runtime:${sanitizeLabelValue(String(report.environment.runtime || 'unknown'), 'unknown')}`,
    `subsystem:${sanitizeLabelValue(inferredSubsystem, 'unknown')}`,
    'status:new',
  ]);
}

function buildEvidenceForContext(input: {
  slug: string | null;
  requestId: string | null;
  occurredAt: string | null;
  capturedAt: string;
  subsystemGuess: string | null;
  rawEvidence: BugReportRawEvidence[];
  reporterEvents: BugReportReporterEvent[];
}): Omit<BugReportEvidenceBundle, 'report' | 'labels' | 'fixerBrief'> & { labels?: string[] } {
  const window = computeEvidenceWindow(input);
  const requestScopedEvents = input.requestId
    ? normalizeServerIncidentEvents(listServerIncidentEventsByRequestId(input.requestId, MAX_SERVER_INCIDENT_EVENTS))
    : [];
  const slugScopedEvents = input.slug && window
    ? normalizeServerIncidentEvents(listServerIncidentEventsInTimeRange(input.slug, window.from, window.to, MAX_SERVER_INCIDENT_EVENTS))
    : [];
  const serverIncidentEvents = dedupeEventsById([...requestScopedEvents, ...slugScopedEvents]).slice(0, MAX_SERVER_INCIDENT_EVENTS);
  const documentEvents = input.slug && window
    ? normalizeDocumentEvents(listDocumentEventsInTimeRange(input.slug, window.from, window.to).slice(0, MAX_DOCUMENT_EVENTS))
    : [];
  const prioritized = prioritizeReporterEvents(input.reporterEvents);
  const prioritizedRawEvidence = input.rawEvidence.filter((entry) => {
    if (prioritized.backgroundPollOmittedCount === 0) return true;
    return inferEvidenceEventClass(entry) !== 'background_poll';
  }).slice(0, MAX_RAW_EVIDENCE);
  const primaryRequest = derivePrimaryRequest(prioritized.reporterEvents);
  const routeHint = deriveRouteHint(primaryRequest);
  const routeTemplate = deriveRouteTemplate(primaryRequest);
  const inferredSubsystem = inferSubsystem(input.subsystemGuess, serverIncidentEvents, routeHint);
  const primaryError = derivePrimaryError(prioritized.reporterEvents, serverIncidentEvents);
  const suspectedFiles = deriveSuspectedFiles(inferredSubsystem, routeHint);
  return {
    selection: {
      requestId: input.requestId,
      slug: input.slug,
      timeWindow: window,
      usedRequestId: input.requestId !== null,
      usedSlugWindow: Boolean(input.slug && window),
    },
    inferredSubsystem,
    primaryRequest,
    routeHint,
    routeTemplate,
    primaryError,
    suspectedFiles,
    summary: {
      serverIncidentEventCount: serverIncidentEvents.length,
      documentEventCount: documentEvents.length,
      reporterEventCount: prioritized.reporterEvents.length,
      backgroundPollOmittedCount: prioritized.backgroundPollOmittedCount,
      requestIdMatched: input.requestId !== null && requestScopedEvents.length > 0,
      slugWindowMatched: Boolean(input.slug && window && (slugScopedEvents.length > 0 || documentEvents.length > 0)),
    },
    serverIncidentEvents,
    documentEvents,
    rawEvidence: prioritizedRawEvidence,
    reporterEvents: prioritized.reporterEvents,
    buildInfo: getBuildInfo(),
  };
}

export function buildBugReportEvidence(report: NormalizedBugReport): BugReportEvidenceBundle {
  const evidence = buildEvidenceForContext({
    slug: report.slug,
    requestId: report.requestId,
    occurredAt: report.occurredAt,
    capturedAt: report.capturedAt,
    subsystemGuess: report.subsystemGuess,
    rawEvidence: report.rawEvidence,
    reporterEvents: report.reporterEvents,
  });
  const fixerBrief = buildFixerBriefFromEvidence(report.summary, evidence, null, null);
  return {
    report,
    selection: evidence.selection,
    inferredSubsystem: evidence.inferredSubsystem,
    labels: buildLabels(report, evidence.inferredSubsystem),
    primaryRequest: evidence.primaryRequest,
    routeHint: evidence.routeHint,
    routeTemplate: evidence.routeTemplate,
    primaryError: evidence.primaryError,
    suspectedFiles: evidence.suspectedFiles,
    fixerBrief,
    summary: evidence.summary,
    serverIncidentEvents: evidence.serverIncidentEvents,
    documentEvents: evidence.documentEvents,
    rawEvidence: evidence.rawEvidence,
    reporterEvents: evidence.reporterEvents,
    buildInfo: evidence.buildInfo,
  };
}

export function buildBugReportFollowUpEvidence(followUp: NormalizedBugReportFollowUp): BugReportFollowUpEvidenceBundle {
  const evidence = buildEvidenceForContext({
    slug: followUp.slug,
    requestId: followUp.requestId,
    occurredAt: followUp.occurredAt,
    capturedAt: followUp.capturedAt,
    subsystemGuess: followUp.subsystemGuess,
    rawEvidence: followUp.rawEvidence,
    reporterEvents: followUp.reporterEvents,
  });
  const fixerBrief = buildFixerBriefFromEvidence(
    followUp.context ?? followUp.writeup ?? 'Bug follow-up',
    evidence,
    null,
    null,
  );
  return {
    followUp,
    selection: evidence.selection,
    inferredSubsystem: evidence.inferredSubsystem,
    primaryRequest: evidence.primaryRequest,
    routeHint: evidence.routeHint,
    routeTemplate: evidence.routeTemplate,
    primaryError: evidence.primaryError,
    suspectedFiles: evidence.suspectedFiles,
    fixerBrief,
    summary: evidence.summary,
    serverIncidentEvents: evidence.serverIncidentEvents,
    documentEvents: evidence.documentEvents,
    rawEvidence: evidence.rawEvidence,
    reporterEvents: evidence.reporterEvents,
    buildInfo: evidence.buildInfo,
  };
}

function formatEnvironment(environment: Record<string, unknown>): string {
  return Object.entries(environment)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim().length > 0)
    .map(([key, value]) => `- ${key}: ${String(value)}`)
    .join('\n');
}

function formatQuestions(questions: BugReportQuestionAnswer[]): string {
  if (questions.length === 0) return '_None provided_';
  return questions.map((entry) => `- Q: ${entry.question}\n  A: ${entry.answer}`).join('\n');
}

function formatTimeline(events: Array<Record<string, unknown>>): string {
  if (events.length === 0) return '_No matching server incident events were found._';
  return events.slice(0, MAX_TIMELINE_LINES).map((event) => {
    const timestamp = typeof event.timestamp === 'string' ? event.timestamp : 'unknown-time';
    const subsystem = typeof event.subsystem === 'string' ? event.subsystem : 'unknown';
    const level = typeof event.level === 'string' ? event.level : 'info';
    const eventType = typeof event.eventType === 'string' ? event.eventType : 'event';
    const message = typeof event.message === 'string' ? event.message : '';
    return `- ${timestamp} [${subsystem} ${level} ${eventType}] ${message}`;
  }).join('\n');
}

function formatTranscript(transcript: BugReportTranscriptEntry[]): string {
  if (transcript.length === 0) return '_None provided_';
  return transcript.map((entry) => `- ${entry.role}: ${entry.content}`).join('\n');
}

function formatPrimaryRequest(primaryRequest: BugReportPrimaryRequest | null): string {
  if (!primaryRequest) return '_Unavailable_';
  const method = primaryRequest.method ?? 'UNKNOWN';
  const pathname = primaryRequest.pathname ?? primaryRequest.url ?? 'unknown-path';
  const status = primaryRequest.status !== null ? String(primaryRequest.status) : 'unknown';
  const requestId = primaryRequest.requestId ? ` (requestId: ${primaryRequest.requestId})` : '';
  return `${method} ${pathname} -> ${status}${requestId}`;
}

function formatReporterEvents(events: BugReportReporterEvent[], backgroundPollOmittedCount: number): string {
  if (events.length === 0) return '_No reporter events were attached._';
  const lines = events.slice(0, MAX_TIMELINE_LINES).map((event) => {
    const message = event.message ? ` ${event.message}` : '';
    return `- ${event.timestamp ?? 'unknown-time'} [${event.source} ${event.class} ${event.level ?? 'info'} ${event.type}]${message}`;
  });
  if (backgroundPollOmittedCount > 0) {
    lines.push(`- _Omitted ${backgroundPollOmittedCount} background poll event(s) because higher-signal events were present._`);
  }
  return lines.join('\n');
}

function formatSuspectedFiles(suspectedFiles: string[]): string {
  if (suspectedFiles.length === 0) return '_No likely source files inferred yet._';
  return suspectedFiles.map((file) => `- ${file}`).join('\n');
}

export function buildFixerBriefFromEvidence(
  summary: string,
  evidence: {
    inferredSubsystem: string;
    suspectedFiles: string[];
    routeTemplate: string | null;
    primaryRequest: BugReportPrimaryRequest | null;
    primaryError: string | null;
  },
  issueNumber: number | null,
  issueUrl: string | null,
): BugReportFixerBrief {
  return {
    summary,
    likelySubsystem: evidence.inferredSubsystem,
    suspectedFiles: evidence.suspectedFiles,
    routeTemplate: evidence.routeTemplate,
    primaryRequest: evidence.primaryRequest,
    primaryError: evidence.primaryError,
    issueNumber,
    issueUrl,
  };
}

function truncateSerializable(value: unknown, depth: number = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) {
    if (depth >= 8) return `[array:${value.length}]`;
    return value.slice(0, 50).map((entry) => truncateSerializable(entry, depth + 1));
  }
  if (isRecord(value)) {
    if (depth >= 8) return `[object:${Object.keys(value).length}]`;
    const truncated: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 50)) {
      truncated[key] = truncateSerializable(entry, depth + 1);
    }
    return truncated;
  }
  if (typeof value === 'string') return truncateText(value, 4000);
  return value;
}

function buildIssueTitle(report: NormalizedBugReport): string {
  const prefix = report.reportType === 'performance' ? 'Agent performance report' : 'Agent bug report';
  return truncateText(`${prefix}: ${report.summary}`, 120);
}

function maybeSection(title: string, body: string | null): string[] {
  if (!body) return [];
  return [title, body, ''];
}

function buildIssueBody(evidence: BugReportEvidenceBundle): string {
  const { report, inferredSubsystem, selection, summary, primaryRequest, routeHint, routeTemplate, suspectedFiles, primaryError } = evidence;
  const environment = formatEnvironment(report.environment);
  const requestIdLine = report.requestId ? `- Request ID: ${report.requestId}` : '- Request ID: _Not provided_';
  const slugLine = report.slug ? `- Slug: ${report.slug}` : '- Slug: _Not provided_';
  const windowLine = selection.timeWindow
    ? `- Evidence window: ${selection.timeWindow.from} to ${selection.timeWindow.to}`
    : '- Evidence window: _Unavailable_';
  return [
    '## Summary',
    `- Type: ${report.reportType}`,
    `- Severity: ${report.severity}`,
    `- Runtime: ${String(report.environment.runtime)}`,
    `- Likely subsystem: ${inferredSubsystem}`,
    slugLine,
    requestIdLine,
    `- Occurred at: ${report.occurredAt ?? '_Not provided_'}`,
    `- Captured at: ${report.capturedAt}`,
    `- Primary request: ${formatPrimaryRequest(primaryRequest)}`,
    `- Route hint: ${routeHint ?? '_Unavailable_'}`,
    `- Route template: ${routeTemplate ?? '_Unavailable_'}`,
    `- Primary error: ${primaryError ?? '_Unavailable_'}`,
    `- Evidence counts: server=${summary.serverIncidentEventCount}, document=${summary.documentEventCount}, reporter=${summary.reporterEventCount}`,
    windowLine,
    '',
    '## Reported Problem',
    report.summary,
    '',
    ...maybeSection('## Context', report.context),
    ...maybeSection('## Expected', report.expected),
    ...maybeSection('## Actual', report.actual),
    ...maybeSection('## Reproduction', report.repro),
    '## Clarifying Answers',
    formatQuestions(report.questionsAsked),
    '',
    '## Operator Transcript',
    formatTranscript(report.operatorTranscript),
    '',
    '## Suspected Files',
    formatSuspectedFiles(suspectedFiles),
    '',
    '## Environment',
    environment || '_No additional environment metadata provided_',
    '',
    '## Prioritized Reporter Events',
    formatReporterEvents(evidence.reporterEvents, summary.backgroundPollOmittedCount),
    '',
    '## Recent Server Timeline',
    formatTimeline(evidence.serverIncidentEvents),
  ].join('\n');
}

function buildEvidenceComment(
  evidence: BugReportEvidenceBundle,
  appsignal: AppsignalCorrelation | null = null,
): string {
  const dashboardUrl = (process.env.PROOF_APPSIGNAL_DASHBOARD_URL || '').trim() || null;
  const { reporterEvents: _reporterEvents, ...reportWithoutEvents } = evidence.report;
  const sanitizedReport = {
    ...reportWithoutEvents,
    rawEvidence: evidence.rawEvidence,
  };
  const payload = {
    specVersion: BUG_REPORT_SPEC_VERSION,
    report: truncateSerializable(sanitizedReport),
    selection: truncateSerializable(evidence.selection),
    inferredSubsystem: evidence.inferredSubsystem,
    labels: evidence.labels,
    primaryRequest: truncateSerializable(evidence.primaryRequest),
    routeHint: evidence.routeHint,
    routeTemplate: evidence.routeTemplate,
    primaryError: evidence.primaryError,
    suspectedFiles: evidence.suspectedFiles,
    fixerBrief: evidence.fixerBrief,
    evidenceSummary: evidence.summary,
    buildInfo: evidence.buildInfo,
    appsignal: appsignal ? { ...appsignal, dashboardUrl } : null,
    serverIncidentEvents: truncateSerializable(evidence.serverIncidentEvents),
    documentEvents: truncateSerializable(evidence.documentEvents),
    rawEvidence: truncateSerializable(evidence.rawEvidence),
    reporterEvents: truncateSerializable(evidence.reporterEvents),
  };
  return [
    '### Evidence Bundle',
    '',
    ...(appsignal
      ? [
        `- AppSignal namespace: ${appsignal.namespace}`,
        `- AppSignal request ID: ${appsignal.requestId ?? '_Unavailable_'}`,
        `- AppSignal revision: ${appsignal.revision ?? '_Unavailable_'}`,
        `- AppSignal tags: ${appsignal.tags.length > 0 ? appsignal.tags.join(', ') : '_None_'}`,
        ...(dashboardUrl
          ? [`- AppSignal dashboard: ${dashboardUrl}`]
          : []),
        '',
      ]
      : []),
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}

function buildFollowUpComment(
  evidence: BugReportFollowUpEvidenceBundle,
  appsignal: AppsignalCorrelation | null = null,
): string {
  const dashboardUrl = (process.env.PROOF_APPSIGNAL_DASHBOARD_URL || '').trim() || null;
  const { followUp, primaryRequest, routeHint, routeTemplate, primaryError, suspectedFiles, summary } = evidence;
  const { reporterEvents: _reporterEvents, ...followUpWithoutEvents } = followUp;
  const sanitizedFollowUp = {
    ...followUpWithoutEvents,
    rawEvidence: evidence.rawEvidence,
  };
  const payload = {
    specVersion: BUG_REPORT_SPEC_VERSION,
    followUp: truncateSerializable(sanitizedFollowUp),
    selection: truncateSerializable(evidence.selection),
    inferredSubsystem: evidence.inferredSubsystem,
    primaryRequest: truncateSerializable(primaryRequest),
    routeHint,
    routeTemplate,
    primaryError,
    suspectedFiles,
    fixerBrief: evidence.fixerBrief,
    evidenceSummary: evidence.summary,
    buildInfo: evidence.buildInfo,
    appsignal: appsignal ? { ...appsignal, dashboardUrl } : null,
    serverIncidentEvents: truncateSerializable(evidence.serverIncidentEvents),
    documentEvents: truncateSerializable(evidence.documentEvents),
    rawEvidence: truncateSerializable(evidence.rawEvidence),
    reporterEvents: truncateSerializable(evidence.reporterEvents),
  };
  return [
    '### Follow-up Context',
    '',
    `- Request ID: ${followUp.requestId ?? '_Not provided_'}`,
    `- Slug: ${followUp.slug ?? '_Not provided_'}`,
    `- Occurred at: ${followUp.occurredAt ?? '_Not provided_'}`,
    `- Primary request: ${formatPrimaryRequest(primaryRequest)}`,
    `- Route hint: ${routeHint ?? '_Unavailable_'}`,
    `- Route template: ${routeTemplate ?? '_Unavailable_'}`,
    `- Primary error: ${primaryError ?? '_Unavailable_'}`,
    ...(appsignal
      ? [
        `- AppSignal namespace: ${appsignal.namespace}`,
        `- AppSignal request ID: ${appsignal.requestId ?? '_Unavailable_'}`,
        `- AppSignal revision: ${appsignal.revision ?? '_Unavailable_'}`,
        `- AppSignal tags: ${appsignal.tags.length > 0 ? appsignal.tags.join(', ') : '_None_'}`,
        ...(dashboardUrl
          ? [`- AppSignal dashboard: ${dashboardUrl}`]
          : []),
      ]
      : []),
    '',
    ...maybeSection('#### Context', followUp.context),
    '#### Clarifying Answers',
    formatQuestions(followUp.questionsAsked),
    '',
    '#### Operator Transcript',
    formatTranscript(followUp.operatorTranscript),
    '',
    '#### Suspected Files',
    formatSuspectedFiles(suspectedFiles),
    '',
    '#### Prioritized Reporter Events',
    formatReporterEvents(evidence.reporterEvents, summary.backgroundPollOmittedCount),
    '',
    '#### Recent Server Timeline',
    formatTimeline(evidence.serverIncidentEvents),
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}

function getGitHubConfig(): { token: string; owner: string; repo: string } {
  const token = process.env.PROOF_GITHUB_ISSUES_TOKEN?.trim() || '';
  if (!token) {
    throw new Error('PROOF_GITHUB_ISSUES_TOKEN is not configured');
  }
  return {
    token,
    owner: process.env.PROOF_GITHUB_ISSUES_OWNER?.trim() || DEFAULT_GITHUB_OWNER,
    repo: process.env.PROOF_GITHUB_ISSUES_REPO?.trim() || DEFAULT_GITHUB_REPO,
  };
}

async function githubApiRequestWithScheme(
  token: string,
  path: string,
  body: Record<string, unknown>,
  authorizationScheme: 'Bearer' | 'token',
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/vnd.github+json',
      authorization: `${authorizationScheme} ${token}`,
      'user-agent': 'proof-agent-bug-reporter',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify(body),
  });
}

function getGitHubTokenScheme(): 'Bearer' | 'token' | 'auto' {
  const raw = (process.env.PROOF_GITHUB_TOKEN_SCHEME || '').trim().toLowerCase();
  if (raw === 'bearer') return 'Bearer';
  if (raw === 'auto') return 'auto';
  return 'token';
}

async function githubApiRequest(
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const tokenScheme = getGitHubTokenScheme();
  if (tokenScheme !== 'auto') {
    return githubApiRequestWithScheme(token, path, body, tokenScheme);
  }

  const bearerResponse = await githubApiRequestWithScheme(token, path, body, 'Bearer');
  if (bearerResponse.status !== 401) return bearerResponse;
  await bearerResponse.text();
  return githubApiRequestWithScheme(token, path, body, 'token');
}

async function parseGitHubError(response: Response): Promise<string> {
  const text = await response.text();
  return parseGitHubErrorText(response.status, text);
}

function parseGitHubErrorText(status: number, text: string): string {
  try {
    const json = JSON.parse(text) as { message?: unknown };
    const message = typeof json.message === 'string' ? json.message : `GitHub request failed with status ${status}`;
    return text ? `${message}: ${text}` : message;
  } catch {
    return text || `GitHub request failed with status ${status}`;
  }
}

function isRetryableIssueCommentError(status: number, text: string): boolean {
  if (status !== 404 && status !== 422) return false;
  if (status === 404) return true;
  return /Could not resolve to a node with the global id/i.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function addGitHubIssueComment(
  issueNumber: number,
  body: string,
): Promise<void> {
  const { token, owner, repo } = getGitHubConfig();
  for (let attempt = 0; attempt < GITHUB_ISSUE_COMMENT_RETRY_ATTEMPTS; attempt += 1) {
    const commentResponse = await githubApiRequest(token, `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      body,
    });
    if (commentResponse.ok) return;

    const errorText = await commentResponse.text();
    const shouldRetry = attempt < GITHUB_ISSUE_COMMENT_RETRY_ATTEMPTS - 1
      && isRetryableIssueCommentError(commentResponse.status, errorText);
    if (shouldRetry) {
      await sleep(GITHUB_ISSUE_COMMENT_RETRY_DELAY_MS * (attempt + 1));
      continue;
    }
    throw new Error(parseGitHubErrorText(commentResponse.status, errorText));
  }
}

export async function createGitHubIssueForBugReport(
  evidence: BugReportEvidenceBundle,
): Promise<GitHubIssueCreateResult> {
  const { token, owner, repo } = getGitHubConfig();
  const createResponse = await githubApiRequest(token, `/repos/${owner}/${repo}/issues`, {
    title: buildIssueTitle(evidence.report),
    body: buildIssueBody(evidence),
    labels: evidence.labels,
  });
  if (!createResponse.ok) {
    throw new Error(await parseGitHubError(createResponse));
  }
  const created = await createResponse.json() as {
    number?: number;
    html_url?: string;
    url?: string;
  };
  if (typeof created.number !== 'number' || typeof created.html_url !== 'string' || typeof created.url !== 'string') {
    throw new Error('GitHub issue creation returned an unexpected payload');
  }

  try {
    await addGitHubIssueComment(
      created.number,
      buildEvidenceComment(evidence, buildAppsignalCorrelation({
        namespace: 'agent_bug_reports',
        routeTemplate: evidence.routeTemplate ?? null,
        subsystem: evidence.inferredSubsystem,
        issueNumber: created.number,
        issueUrl: created.html_url,
      })),
    );
  } catch (error) {
    const wrapped = error as Error & {
      issueNumber?: number;
      issueUrl?: string;
      issueApiUrl?: string;
    };
    wrapped.issueNumber = created.number;
    wrapped.issueUrl = created.html_url;
    wrapped.issueApiUrl = created.url;
    throw wrapped;
  }

  return {
    issueNumber: created.number,
    issueUrl: created.html_url,
    issueApiUrl: created.url,
    labels: evidence.labels,
  };
}

export async function appendGitHubBugReportFollowUp(
  issueNumber: number,
  evidence: BugReportFollowUpEvidenceBundle,
): Promise<void> {
  await addGitHubIssueComment(
    issueNumber,
    buildFollowUpComment(evidence, buildAppsignalCorrelation({
      namespace: 'agent_bug_reports',
      routeTemplate: evidence.routeTemplate ?? null,
      subsystem: evidence.inferredSubsystem,
      issueNumber,
    })),
  );
}
