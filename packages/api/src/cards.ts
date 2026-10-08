// The bounds of a card a tool shows (`show`). They catch a package's mistakes before anything is
// stored: a package shapes its card to fit, and a card outside them fails the tool call.
import type { CardInput } from "@paca/extension";

export const CARD_DATA_MAX = 1024;
export const CARD_TEXT_MAX = 200;
export const CARDS_PER_CALL = 8;

function isJson(value: unknown, depth = 0): boolean {
	if (depth > 16) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((v) => isJson(v, depth + 1));
	return isPlainObject(value) && Object.values(value).every((v) => isJson(v, depth + 1));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** The card as stored, or an Error naming the bound it breaks. */
export function checkCard(card: CardInput, kinds: readonly string[]): { kind: string; data: string; fallback: string } {
	const fail = (message: string): never => {
		throw new Error(`card refused: ${message}`);
	};
	if (!isPlainObject(card)) fail("not an object");
	if (typeof card.kind !== "string" || !kinds.includes(card.kind)) fail(`kind ${JSON.stringify(card.kind)} is not declared in the package's browser.cards`);
	if (!isPlainObject(card.data) || !isJson(card.data)) fail("data must be a plain JSON object");
	const data = JSON.stringify(card.data);
	if (Buffer.byteLength(data) > CARD_DATA_MAX) fail(`data is over ${CARD_DATA_MAX} bytes`);
	const { text, url } = (isPlainObject(card.fallback) ? card.fallback : fail("fallback is missing")) as CardInput["fallback"];
	if (typeof text !== "string" || !text.trim() || text.length > CARD_TEXT_MAX) fail(`fallback.text must have 1 to ${CARD_TEXT_MAX} characters`);
	if (url !== undefined && (typeof url !== "string" || !URL.canParse(url) || new URL(url).protocol !== "https:")) fail("fallback.url must be an https: URL");
	return { kind: card.kind, data, fallback: JSON.stringify(url === undefined ? { text } : { text, url }) };
}
