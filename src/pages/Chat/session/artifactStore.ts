import { artifactByteSize, type Artifact, type ArtifactRuntime, type RegisterArtifactInput } from '../domain/artifacts';

/** Session-owned immutable results, shared by shell tools, presentation, and persistence. */
export class ArtifactStore implements ArtifactRuntime {
  private artifacts: Record<string, Artifact> = {};
  counter = 0;

  restore(artifacts: Record<string, Artifact>, counter?: number) {
    this.artifacts = compactArtifacts(JSON.parse(JSON.stringify(artifacts)));
    this.counter = Math.max(counter ?? 0, nextArtifactCounter(this.artifacts));
  }

  snapshot() {
    return { ...this.artifacts };
  }
  get(id: string) {
    return this.artifacts[id];
  }
  list() {
    return Object.values(this.artifacts).sort(compareArtifactsByCreatedAt);
  }

  register(input: RegisterArtifactInput): Artifact {
    const data = JSON.parse(JSON.stringify(input.data));
    const artifact: Artifact = {
      ...input,
      data,
      id: createArtifactId(++this.counter),
      createdAt: new Date().toISOString(),
      bytes: artifactByteSize(data),
    };
    if (artifact.bytes > MAX_SESSION_ARTIFACT_BYTES) {
      throw new Error(`Artifact exceeds ${MAX_SESSION_ARTIFACT_BYTES} bytes; narrow the query.`);
    }
    this.artifacts = compactArtifacts({ ...this.artifacts, [artifact.id]: artifact });
    return artifact;
  }
}

const MAX_SESSION_ARTIFACTS = 40;
const MAX_SESSION_ARTIFACT_BYTES = 8 * 1024 * 1024;

function createArtifactId(index: number) {
  return `artifact_${Math.max(1, Math.floor(index))}`;
}

export function nextArtifactCounter(artifacts: Record<string, Artifact>) {
  return Object.keys(artifacts).reduce((max, id) => {
    const match = /^artifact_(\d+)$/.exec(id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

export function compactArtifacts(artifacts: Record<string, Artifact>) {
  const sorted = Object.values(artifacts).sort(compareArtifactsByCreatedAt);
  const kept: Record<string, Artifact> = {};
  let totalBytes = 0;

  for (const artifact of sorted) {
    if (Object.keys(kept).length >= MAX_SESSION_ARTIFACTS) {
      break;
    }
    const artifactBytes = Math.max(0, artifact.bytes || artifactByteSize(artifact.data));
    if (totalBytes > 0 && totalBytes + artifactBytes > MAX_SESSION_ARTIFACT_BYTES) {
      continue;
    }
    kept[artifact.id] = {
      ...artifact,
      bytes: artifactBytes,
    };
    totalBytes += artifactBytes;
  }

  return kept;
}

function compareArtifactsByCreatedAt(left: Artifact, right: Artifact) {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}
