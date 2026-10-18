/**
 * Small helpers shared by the Worker, the gateway Durable Object, and the
 * session Durable Object. Everything here is pure or reads a single binding,
 * so it stays testable and free of OpenCode or Discord side effects.
 */

/** Read an integer from a text binding, clamped to a sane range. */
export function intFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
	const value = Number.parseInt(raw ?? "", 10)
	if (!Number.isFinite(value)) return fallback
	return Math.min(max, Math.max(min, value))
}
