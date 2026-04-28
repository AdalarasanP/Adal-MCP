/**
 * CAPABILITY REGISTRY
 * ✅ Local writes: always allowed
 * 🔒 External writes: locked by default, unlockable per system
 */

export type ExternalSystem = "panorama" | "paloaltoApps" | "ise" | "firemon";

export interface ExternalCapability {
  read: boolean;
  write: boolean;
  unlockedBy?: string;
  unlockReason?: string;
  expiresAt?: number;
}

export const localCapabilities = {
  jira: true,
  word: true,
  excel: true,
  outlookDraft: true,
};

export const externalCapabilities: Record<ExternalSystem, ExternalCapability> = {
  panorama:     { read: true, write: false },
  paloaltoApps: { read: true, write: false },
  ise:          { read: true, write: false },
  firemon:      { read: true, write: false },
};

/**
 * Check if external write is allowed
 */
export function assertExternalWrite(system: ExternalSystem): void {
  const cap = externalCapabilities[system];

  if (!cap.write) {
    throw new Error(`WRITE_LOCKED: ${system} — unlock required`);
  }

  if (cap.expiresAt && Date.now() > cap.expiresAt) {
    cap.write = false;
    cap.unlockedBy = undefined;
    cap.unlockReason = undefined;
    cap.expiresAt = undefined;
    throw new Error(`WRITE_EXPIRED: ${system} — auto-relocked`);
  }
}

/**
 * Unlock external write (time-bound)
 */
export function unlockExternalWrite(
  system: ExternalSystem,
  reason: string,
  requestedBy: string,
  durationMinutes: number
): { expiresAt: string } {
  const cap = externalCapabilities[system];
  const expiresAt = Date.now() + durationMinutes * 60 * 1000;

  cap.write = true;
  cap.unlockedBy = requestedBy;
  cap.unlockReason = reason;
  cap.expiresAt = expiresAt;

  // Auto-relock
  setTimeout(() => {
    cap.write = false;
    cap.unlockedBy = undefined;
    cap.unlockReason = undefined;
    cap.expiresAt = undefined;
  }, durationMinutes * 60 * 1000);

  return { expiresAt: new Date(expiresAt).toISOString() };
}
