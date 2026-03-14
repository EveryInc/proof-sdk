import { listDocumentEventsInTimeRange, type DocumentEventRow } from './db.js';
import { getBuildInfo } from './build-info.js';
import { getRecentIncidentTraceEntries } from './incident-tracing.js';

export type BugReportType = 'bug' | 'performance' | 'ux';
export type BugReportSeverity = 'blocker' | 'high' | 'medium' | 'low';
export type BugReportReporterMode = 'api_only' | 'in_product_web' | 'human_assisted';
export type BugReportReporterEventSource = 'api' | 'client' | 'operator';
export type BugReportReporterEventClass = 'primary_failure' | 'related_write' | 'related_read' | 'background_poll' | 'diagnostic';
export type BugReportEvidenceKind = 'http_request' | 'http_response' | 'error' | 'console' | 'operator_note' | 'raw_json';

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

export type NormalizedBugReportFollowUp = Omit<NormalizedBugReport, 'reportType' | 'severity' | 'summary' | 'expected' | 'actual' | 'repro'>;

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

export type BugReportEvidenceBundle = {
  report: NormalizedBugReport;
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

export type BugReportValidationResult =
  | { ok: true; report: NormalizedBugReport }
  | { ok: false; missingFields: string[]; suggestedQuestions: string[] };

export type BugReportFollowUpValidationResult =
  | { ok: true; followUp: NormalizedBugReportFollowUp }
  | { ok: false; missingFields: string[]; suggestedQuestions: string[] };

const BUG_REPORT_SPEC_VERSION = '2026-03-14-proof-sdk';
const DEFAULT_GITHUB_OWNER = 'EveryInc';
const DEFAULT_GITHUB_REPO = 'proof-sdk';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asQuestionAnswers(value: unknown): BugReportQuestionAnswer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const question = asString(entry.question);
    const answer = asString(entry.answer);
    return question && answer ? [{ question, answer }] : [];
  });
}

function asTranscript(value: unknown): BugReportTranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const role = asString(entry.role);
    const content = asString(entry.content);
    return role && content ? [{ role, content }] : [];
  });
}

function asReporterEvents(value: unknown): BugReportReporterEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const type = asString(entry.type);
    if (!type) return [];
    const source = asString(entry.source) as BugReportReporterEventSource | null;
    const klass = asString(entry.class) as BugReportReporterEventClass | null;
    return [{
      timestamp: asString(entry.timestamp),
      source: source ?? 'api',
      class: klass ?? 'diagnostic',
      type,
      level: asString(entry.level),
      message: asString(entry.message),
      data: isRecord(entry.data) ? entry.data : {},
    }];
  });
}

function asRawEvidence(value: unknown): BugReportRawEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const kind = asString(entry.kind) as BugReportEvidenceKind | null;
    const source = asString(entry.source) as BugReportReporterEventSource | null;
    return kind ? [{
      timestamp: asString(entry.timestamp),
      kind,
      source: source ?? 'api',
      level: asString(entry.level),
      message: asString(entry.message),
      requestId: asString(entry.requestId),
      url: asString(entry.url),
      method: asString(entry.method),
      status: typeof entry.status === 'number' ? entry.status : null,
      text: asString(entry.text),
      data: isRecord(entry.data) ? entry.data : {},
      lines: Array.isArray(entry.lines) ? entry.lines.filter((line): line is string => typeof line === 'string') : [],
    }] : [];
  });
}

function inferRuntime(value: unknown): string {
  if (!isRecord(value)) return 'web';
  return asString(value.runtime) ?? 'web';
}

function normalizeBugReport(payload: Record<string, unknown>): NormalizedBugReport {
  const environment = isRecord(payload.environment) ? payload.environment : {};
  return {
    reportType: (asString(payload.reportType) as BugReportType | null) ?? 'bug',
    severity: (asString(payload.severity) as BugReportSeverity | null) ?? 'medium',
    reporterMode: (asString(payload.reporterMode) as BugReportReporterMode | null) ?? 'api_only',
    summary: asString(payload.summary) ?? asString(payload.writeup) ?? 'Bug report',
    expected: asString(payload.expected),
    actual: asString(payload.actual),
    repro: asString(payload.repro),
    context: asString(payload.context),
    writeup: asString(payload.writeup),
    userNotes: asString(payload.userNotes),
    additionalContext: asString(payload.additionalContext),
    slug: asString(payload.slug),
    requestId: asString(payload.requestId),
    occurredAt: asString(payload.occurredAt),
    capturedAt: new Date().toISOString(),
    subsystemGuess: asString(payload.subsystemGuess),
    environment: {
      ...environment,
      runtime: inferRuntime(environment),
    },
    documentContext: isRecord(payload.documentContext) ? payload.documentContext : {},
    questionsAsked: asQuestionAnswers(payload.questionsAsked),
    operatorTranscript: asTranscript(payload.operatorTranscript),
    rawEvidence: asRawEvidence(payload.rawEvidence),
    reporterEvents: asReporterEvents(payload.reporterEvents),
  };
}

function normalizeBugReportFollowUp(payload: Record<string, unknown>): NormalizedBugReportFollowUp {
  const base = normalizeBugReport(payload);
  return {
    reporterMode: base.reporterMode,
    context: base.context,
    writeup: base.writeup,
    userNotes: base.userNotes,
    additionalContext: base.additionalContext,
    slug: base.slug,
    requestId: base.requestId,
    occurredAt: base.occurredAt,
    capturedAt: base.capturedAt,
    subsystemGuess: base.subsystemGuess,
    environment: base.environment,
    documentContext: base.documentContext,
    questionsAsked: base.questionsAsked,
    operatorTranscript: base.operatorTranscript,
    rawEvidence: base.rawEvidence,
    reporterEvents: base.reporterEvents,
  };
}

function inferSubsystem(report: { subsystemGuess: string | null; rawEvidence: BugReportRawEvidence[]; reporterEvents: BugReportReporterEvent[] }): string {
  if (report.subsystemGuess) return report.subsystemGuess;
  const firstUrl = report.rawEvidence.find((entry) => entry.url)?.url ?? '';
  if (firstUrl.includes('/bridge/')) return 'agent_bridge';
  if (firstUrl.includes('/documents/')) return 'documents';
  const firstEventType = report.reporterEvents.find((entry) => entry.type)?.type ?? '';
  if (firstEventType.includes('collab')) return 'collab';
  return 'sdk';
}

function inferPrimaryRequest(
  rawEvidence: BugReportRawEvidence[],
  reporterEvents: BugReportReporterEvent[],
): BugReportPrimaryRequest | null {
  const evidence = rawEvidence.find((entry) => entry.kind === 'http_request' || entry.kind === 'http_response');
  if (evidence) {
    let pathname: string | null = null;
    if (evidence.url) {
      try {
        pathname = new URL(evidence.url, 'https://proof-sdk.local').pathname;
      } catch {
        pathname = evidence.url;
      }
    }
    return {
      requestId: evidence.requestId,
      method: evidence.method,
      url: evidence.url,
      pathname,
      status: evidence.status,
      statusText: null,
      source: evidence.source,
      eventType: evidence.kind,
      message: evidence.message,
      timestamp: evidence.timestamp,
    };
  }
  const event = reporterEvents.find((entry) => entry.class === 'primary_failure') ?? reporterEvents[0];
  if (!event) return null;
  return {
    requestId: null,
    method: null,
    url: null,
    pathname: null,
    status: null,
    statusText: null,
    source: event.source,
    eventType: event.type,
    message: event.message,
    timestamp: event.timestamp,
  };
}

function inferRouteHint(primaryRequest: BugReportPrimaryRequest | null): string | null {
  return primaryRequest?.pathname ?? null;
}

function inferSuspectedFiles(subsystem: string): string[] {
  if (subsystem === 'agent_bridge') return ['server/agent-routes.ts', 'src/bridge/share-client.ts'];
  if (subsystem === 'collab') return ['server/collab.ts', 'src/bridge/collab-client.ts'];
  return ['server/agent-routes.ts'];
}

function listRelatedDocumentEvents(slug: string | null, occurredAt: string | null): DocumentEventRow[] {
  if (!slug || !occurredAt) return [];
  const centerMs = Date.parse(occurredAt);
  if (!Number.isFinite(centerMs)) return [];
  const fromIso = new Date(centerMs - 5 * 60 * 1000).toISOString();
  const toIso = new Date(centerMs + 2 * 60 * 1000).toISOString();
  return listDocumentEventsInTimeRange(slug, fromIso, toIso);
}

function listRelatedIncidentEvents(requestId: string | null): Array<Record<string, unknown>> {
  const entries = getRecentIncidentTraceEntries(80);
  return entries.filter((entry) => !requestId || entry.requestId === requestId);
}

export function buildFixerBriefFromEvidence(
  summary: string,
  evidence: { inferredSubsystem: string; primaryRequest: BugReportPrimaryRequest | null; primaryError: string | null; suspectedFiles: string[]; routeTemplate: string | null },
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

function buildEvidenceBundleBase<T extends NormalizedBugReport | NormalizedBugReportFollowUp>(
  report: T,
): Omit<BugReportEvidenceBundle, 'report' | 'fixerBrief'> & Omit<BugReportFollowUpEvidenceBundle, 'followUp' | 'fixerBrief'> {
  const inferredSubsystem = inferSubsystem(report);
  const primaryRequest = inferPrimaryRequest(report.rawEvidence, report.reporterEvents);
  const routeHint = inferRouteHint(primaryRequest);
  const routeTemplate = routeHint;
  const primaryError = report.rawEvidence.find((entry) => entry.kind === 'error')?.message
    ?? report.reporterEvents.find((entry) => entry.class === 'primary_failure')?.message
    ?? null;
  const suspectedFiles = inferSuspectedFiles(inferredSubsystem);
  const documentEvents = listRelatedDocumentEvents(report.slug, report.occurredAt).map((entry) => ({
    id: entry.id,
    eventType: entry.event_type,
    actor: entry.actor,
    createdAt: entry.created_at,
  }));
  const serverIncidentEvents = listRelatedIncidentEvents(report.requestId);
  return {
    inferredSubsystem,
    labels: ['bug', `subsystem:${inferredSubsystem}`],
    primaryRequest,
    routeHint,
    routeTemplate,
    primaryError,
    suspectedFiles,
    summary: {
      serverIncidentEventCount: serverIncidentEvents.length,
      documentEventCount: documentEvents.length,
      reporterEventCount: report.reporterEvents.length,
      backgroundPollOmittedCount: 0,
      requestIdMatched: Boolean(report.requestId),
      slugWindowMatched: Boolean(report.slug && report.occurredAt),
    },
    serverIncidentEvents,
    documentEvents,
    rawEvidence: report.rawEvidence,
    reporterEvents: report.reporterEvents,
    buildInfo: getBuildInfo(),
  };
}

export function buildBugReportEvidence(report: NormalizedBugReport): BugReportEvidenceBundle {
  const base = buildEvidenceBundleBase(report);
  return {
    report,
    ...base,
    fixerBrief: buildFixerBriefFromEvidence(report.summary, base, null, null),
  };
}

export function buildBugReportFollowUpEvidence(followUp: NormalizedBugReportFollowUp): BugReportFollowUpEvidenceBundle {
  const base = buildEvidenceBundleBase(followUp);
  return {
    followUp,
    ...base,
    fixerBrief: buildFixerBriefFromEvidence(followUp.context ?? 'Bug follow-up', base, null, null),
  };
}

export function getBugReportSpec(): Record<string, unknown> {
  return {
    version: BUG_REPORT_SPEC_VERSION,
    requiredFields: ['summary'],
    supportedReporterModes: ['api_only', 'in_product_web', 'human_assisted'],
    guidance: [
      'Include summary plus any raw HTTP evidence you have.',
      'Include requestId and slug when available.',
      'Use reporterEvents for agent or client timelines.',
    ],
  };
}

export function validateBugReportSubmission(payload: unknown): BugReportValidationResult {
  if (!isRecord(payload)) {
    return {
      ok: false,
      missingFields: ['summary'],
      suggestedQuestions: ['What went wrong in one sentence?'],
    };
  }
  const report = normalizeBugReport(payload);
  const missingFields: string[] = [];
  if (!report.summary) missingFields.push('summary');
  return missingFields.length > 0
    ? {
      ok: false,
      missingFields,
      suggestedQuestions: ['What went wrong in one sentence?', 'Which route or request failed first?'],
    }
    : { ok: true, report };
}

export function validateBugReportFollowUp(payload: unknown): BugReportFollowUpValidationResult {
  if (!isRecord(payload)) {
    return {
      ok: false,
      missingFields: ['context'],
      suggestedQuestions: ['What new context or evidence should be attached to the issue?'],
    };
  }
  const followUp = normalizeBugReportFollowUp(payload);
  const hasContent = Boolean(followUp.context || followUp.writeup || followUp.userNotes || followUp.additionalContext || followUp.rawEvidence.length || followUp.reporterEvents.length);
  return hasContent
    ? { ok: true, followUp }
    : {
      ok: false,
      missingFields: ['context'],
      suggestedQuestions: ['What new context or evidence should be attached to the issue?'],
    };
}

function githubOwner(): string {
  return process.env.PROOF_GITHUB_ISSUES_OWNER?.trim() || DEFAULT_GITHUB_OWNER;
}

function githubRepo(): string {
  return process.env.PROOF_GITHUB_ISSUES_REPO?.trim() || DEFAULT_GITHUB_REPO;
}

function githubHeaders(): Record<string, string> {
  const token = process.env.PROOF_GITHUB_ISSUES_TOKEN?.trim();
  if (!token) throw new Error('PROOF_GITHUB_ISSUES_TOKEN is not configured');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'proof-sdk-bug-reporter',
  };
}

function renderIssueBody(evidence: BugReportEvidenceBundle): string {
  const lines = [
    `Summary: ${evidence.report.summary}`,
    `Severity: ${evidence.report.severity}`,
    `Reporter mode: ${evidence.report.reporterMode}`,
    `Subsystem: ${evidence.inferredSubsystem}`,
    '',
  ];
  if (evidence.report.expected) lines.push(`Expected: ${evidence.report.expected}`);
  if (evidence.report.actual) lines.push(`Actual: ${evidence.report.actual}`);
  if (evidence.report.repro) lines.push(`Repro: ${evidence.report.repro}`);
  if (evidence.routeHint) lines.push(`Route hint: ${evidence.routeHint}`);
  if (evidence.primaryError) lines.push(`Primary error: ${evidence.primaryError}`);
  if (evidence.report.requestId) lines.push(`Request ID: ${evidence.report.requestId}`);
  if (evidence.report.slug) lines.push(`Document slug: ${evidence.report.slug}`);
  return lines.join('\n');
}

export async function createGitHubIssueForBugReport(evidence: BugReportEvidenceBundle): Promise<GitHubIssueCreateResult> {
  const owner = githubOwner();
  const repo = githubRepo();
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: githubHeaders(),
    body: JSON.stringify({
      title: evidence.report.summary,
      body: renderIssueBody(evidence),
      labels: evidence.labels,
    }),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub issue creation failed: ${response.status} ${message}`);
  }
  const payload = await response.json() as { number: number; html_url: string; url: string };
  return {
    issueNumber: payload.number,
    issueUrl: payload.html_url,
    issueApiUrl: payload.url,
    labels: evidence.labels,
  };
}

export async function appendGitHubBugReportFollowUp(
  issueNumber: number,
  evidence: BugReportFollowUpEvidenceBundle,
): Promise<void> {
  const owner = githubOwner();
  const repo = githubRepo();
  const body = [
    'Additional bug report context',
    '',
    evidence.followUp.context ?? evidence.followUp.writeup ?? evidence.followUp.userNotes ?? 'See attached evidence.',
  ].join('\n');
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: githubHeaders(),
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub follow-up append failed: ${response.status} ${message}`);
  }
}
