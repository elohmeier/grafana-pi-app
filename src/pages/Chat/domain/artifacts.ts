export type ArtifactKind = 'json' | 'table' | 'dashboard' | 'image' | 'text';

export type ArtifactRef = {
  id: string;
  kind: ArtifactKind;
  title: string;
  toolName: string;
  createdAt: string;
  bytes: number;
  summary: string;
};

export type ArtifactPreview =
  | {
      type: 'json';
      data: unknown;
      truncated: boolean;
    }
  | {
      type: 'text';
      text: string;
      truncated: boolean;
    }
  | {
      type: 'image';
      mimeType: string;
      data: string;
    };

export type Artifact = ArtifactRef & {
  data: unknown;
  preview?: ArtifactPreview;
  mimeType?: string;
  toolDetails?: unknown;
};

export type RegisterArtifactInput = {
  kind: ArtifactKind;
  title: string;
  toolName: string;
  data: unknown;
  summary: string;
  bytes?: number;
  preview?: ArtifactPreview;
  mimeType?: string;
  toolDetails?: unknown;
};

export type ArtifactRuntime = {
  register: (artifact: RegisterArtifactInput) => Artifact;
  get: (id: string) => Artifact | undefined;
  list: () => Artifact[];
};

export function toArtifactRef(artifact: Artifact): ArtifactRef {
  const { id, kind, title, toolName, createdAt, bytes, summary } = artifact;
  return { id, kind, title, toolName, createdAt, bytes, summary };
}

export function artifactByteSize(value: unknown): number {
  return utf8ByteLength(formatArtifactValue(value));
}

function formatArtifactValue(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function utf8ByteLength(value: string) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).byteLength;
  }

  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}
