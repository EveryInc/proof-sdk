type EventProperties = Record<string, string | number | boolean | null | undefined>;

export type DocumentCreatedTelemetry = {
  slug: string;
  source: string;
  ownerId?: string | null;
  title?: string | null;
  shareState?: string | null;
  accessRole?: string | null;
  authMode?: string | null;
  authenticated?: boolean;
  contentChars?: number;
};

export function captureTelemetryEvent(
  _event: string,
  _distinctId: string,
  _properties: EventProperties = {},
): void {
}

export function captureDocumentCreatedTelemetry(_input: DocumentCreatedTelemetry): void {
}
