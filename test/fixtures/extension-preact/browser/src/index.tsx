// The fixture's cards and pages in Preact, bundled by esbuild into one ES module. Each mount,
// dispose and Preact effect cleanup is counted on <html data-*>, and so is every CSP violation,
// for the browser check to read.
import type { BrowserExtension, CardMount, HostContext, PageMount } from "@paca/extension/browser";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

const counts = document.documentElement.dataset;
const bump = (key: string) => {
	counts[key] = String(Number(counts[key] ?? 0) + 1);
};
document.addEventListener("securitypolicyviolation", () => bump("fixtureCspViolations"));

/** State that a remount would lose, and an effect whose cleanup counts unmounts. */
function Counter() {
	const [count, setCount] = useState(0);
	useEffect(() => () => bump("counterCleanups"), []);
	// The style prop is a CSSOM write, which the CSP allows; style="" markup would not be.
	return (
		<button type="button" class="fixture-counter" style={{ borderWidth: "2px" }} onClick={() => setCount(count + 1)}>
			Count {count}
		</button>
	);
}

const counter: CardMount = (container) => {
	bump("counterMounts");
	render(<Counter />, container);
	return {
		dispose() {
			bump("counterDisposes");
			render(null, container);
		},
	};
};

/** Calls the fixture's echo operation through the host and shows the answer. */
function Demo({ context }: { context: HostContext }) {
	const [answer, setAnswer] = useState("Loading…");
	useEffect(() => {
		context.call("echo", { hello: "fixture" }).then(
			(value) => setAnswer(JSON.stringify(value)),
			(error: Error) => setAnswer(`Error: ${error.message}`),
		);
	}, []);
	return <p class="fixture-echo">{answer}</p>;
}

const demo: PageMount = (container, { context }) => {
	bump("demoMounts");
	render(<Demo context={context} />, container);
	return {
		dispose() {
			bump("demoDisposes");
			render(null, container);
		},
	};
};

export default { cards: { counter }, pages: { demo } } satisfies BrowserExtension;
